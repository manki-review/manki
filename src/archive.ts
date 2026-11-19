import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { crc32, inflateRawSync } from 'zlib';

/** The most bytes a package archive may unpack to, headers included. */
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
/** The most files and folders an archive may create, counting each folder a file's path implies. */
const MAX_UNPACKED_ENTRIES = 20_000;
/** The most tar headers an archive may hold, of every kind: files, folders, links, and pax and long-name headers. */
const MAX_HEADERS = 50_000;
/** The most folders deep a path in an archive may lie. */
const MAX_PATH_DEPTH = 32;
/** The most bytes of a path in an archive, and of one name in it. */
const MAX_PATH_BYTES = 1024;
const MAX_NAME_BYTES = 255;
/** The most bytes of a long-name or pax header's data, which only states a path or attributes. */
const MAX_HEADER_DATA_BYTES = 64 * 1024;

const BLOCK = 512;

/** The caps `extractTarGz` holds an archive to. */
export interface ArchiveLimits {
  maxBytes?: number;
  /** Files and folders created, explicit or implied by a file's path. */
  maxEntries?: number;
  maxHeaders?: number;
  maxDepth?: number;
  maxPathBytes?: number;
  maxHeaderData?: number;
}

/** What `extractTarGz` wrote. */
export interface Extracted {
  files: number;
  folders: number;
  bytes: number;
}

/** Reads a NUL-terminated field of a tar header. */
function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
}

/**
 * Reads a path field of a tar header or a long-name header's data. Refuses bytes after its NUL, which node-tar keeps
 * past a newline and Cargo drops, and bytes that are no UTF-8, which Cargo writes as they are and npm replaces.
 */
function pathField(data: Buffer, start: number, length: number): string {
  const raw = data.subarray(start, start + length);
  const end = raw.indexOf(0);
  const text = raw.subarray(0, end < 0 ? raw.length : end);
  if (end >= 0 && raw.subarray(end).some(b => b !== 0)) throw new Error('the archive has a path field with bytes after its end');
  if (!isUtf8(text)) throw new Error('the archive has a path that is not UTF-8');
  return text.toString('utf8');
}

function isUtf8(data: Buffer): boolean {
  return Buffer.from(data.toString('utf8')).equals(data);
}

/** Reads an octal number field of a tar header. The base-256 form, for sizes over 8 GB, is refused. */
function octal(header: Buffer, start: number, length: number): number {
  if (header[start] & 0x80) throw new Error('the archive has a size in base-256 form');
  const text = field(header, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('the archive has a broken header');
  return text ? parseInt(text, 8) : 0;
}

/** Whether the header's checksum matches its bytes, read with the checksum field as spaces. */
function checksumHolds(header: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === octal(header, 148, 8);
}

/**
 * Returns the records of a pax extended header, each `<length> <key>=<value>\n`, by key. Throws on anything tar readers
 * resolve differently: a key set twice, a value with a newline, which node-tar splits records on, data that is no
 * UTF-8, and a link target or a GNU sparse map, which describe no plain file.
 */
function paxRecords(data: Buffer): Map<string, string> {
  if (!isUtf8(data)) throw new Error('the archive has a pax header that is not UTF-8');
  const records = new Map<string, string>();
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    // npm and Cargo read the length as decimal digits only, and a record that does not end in a newline where it says.
    const digits = space < 0 ? '' : data.subarray(at, space).toString('latin1');
    const length = /^\d{1,15}$/.test(digits) ? Number(digits) : 0;
    if (length <= space - at + 1 || at + length > data.length || data[at + length - 1] !== 0x0a) throw new Error('the archive has a broken pax header');
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq < 0) throw new Error('the archive has a broken pax header');
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1);
    if (records.has(key)) throw new Error(`the archive has a pax header that sets ${quoted(key)} twice`);
    if (value.includes('\n')) throw new Error(`the archive has a pax header whose ${quoted(key)} holds a newline`);
    if (key === 'linkpath' || key.startsWith('GNU.sparse.')) throw new Error(`the archive has a pax header that sets ${quoted(key)}`);
    records.set(key, value);
    at += length;
  }
  return records;
}

/** The magic and version of a POSIX ustar header. A GNU header keeps other fields where POSIX keeps a path's prefix. */
const USTAR_MAGIC = Buffer.from('ustar\x0000', 'latin1');

/** Shows the start of an archive's path in an error, since the path can be long. */
function quoted(name: string): string {
  return JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}...` : name);
}

/**
 * Returns the path inside the package of an archive entry, without the folder every package archive wraps its files in,
 * or `undefined` for that folder itself. Throws on an absolute path, a `..` segment, a backslash or a NUL, so a whole
 * archive that tries to write outside its folder is refused. Throws as well on a path deeper or longer than the caps,
 * on an empty or `.` segment, which npm strips before the top folder and Cargo after it, and on a file that is the top
 * folder itself or ends in `/`.
 */
function entryPath(name: string, folder: boolean, maxDepth: number, maxPathBytes: number): string[] | undefined {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.includes('\0')) throw new Error(`the archive holds the path ${quoted(name)}, which leaves its folder`);
  const segments = (folder && name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (segments.includes('..')) throw new Error(`the archive holds the path ${quoted(name)}, which leaves its folder`);
  if (segments.some(s => s === '' || s === '.')) throw new Error(`the archive holds the path ${quoted(name)}, with an empty or \`.\` part that tar readers resolve differently`);
  if (!folder && segments.length < 2) throw new Error(`the archive holds the file ${quoted(name)} outside the folder every package archive has`);
  if (Buffer.byteLength(name) > maxPathBytes || segments.some(s => Buffer.byteLength(s) > MAX_NAME_BYTES)) throw new Error(`the archive holds the path ${quoted(name)}, longer than ${maxPathBytes} bytes or with a name longer than ${MAX_NAME_BYTES}`);
  if (segments.length > maxDepth + 1) throw new Error(`the archive holds the path ${quoted(name)}, more than ${maxDepth} levels deep`);
  return segments.length > 1 ? segments.slice(1) : undefined;
}

/**
 * Returns the tar the gzip `archive` holds, at most `maxBytes` of it. Refuses data after the first gzip member, since
 * Cargo reads only that one and npm reads every member.
 */
function gunzipOne(archive: Buffer, maxBytes: number): Buffer {
  const broken = new Error('the archive is not gzip data');
  if (archive.length < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b || archive[2] !== 8 || archive[3] & 0xe0) throw broken;
  const flags = archive[3];
  let at = 10;
  if (flags & 0x04) at += 2 + archive.readUInt16LE(at);
  for (const flag of [0x08, 0x10]) {
    if (!(flags & flag)) continue;
    const end = archive.indexOf(0, at);
    if (end < 0) throw broken;
    at = end + 1;
  }
  if (flags & 0x02) at += 2;
  if (at > archive.length) throw broken;
  let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    inflated = inflateRawSync(archive.subarray(at), { info: true, maxOutputLength: maxBytes } as object) as unknown as typeof inflated;
  } catch (error) {
    if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`the archive unpacks to more than ${maxBytes / 1024 / 1024} MB`);
    throw new Error(`the archive is not gzip data: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { buffer: tar, engine } = inflated;
  const trailer = at + engine.bytesWritten;
  if (trailer + 8 > archive.length) throw broken;
  if (archive.readUInt32LE(trailer) !== crc32(tar) || archive.readUInt32LE(trailer + 4) !== tar.length % 2 ** 32) throw new Error('the archive does not match its gzip checksum');
  if (trailer + 8 < archive.length) throw new Error('the archive holds data after its gzip stream, which Cargo does not read and npm does');
  return tar;
}

/**
 * Unpacks the gzipped tar `archive` into the new folder `dest`. Reads only what npm (node-tar) and Cargo (the tar crate)
 * read the same way: regular files and folders, each path once, with pax and GNU long-name headers. Refuses every
 * other archive whole, such as one with a link, a device, a second header for one entry, or an entry after a zero block.
 * Writes no file mode, so nothing it writes can point outside `dest` or run. Drops the top folder every package archive
 * has. Throws, and the caller discards `dest`, when the archive is not a tar archive, holds a path that leaves `dest`,
 * or passes any cap of `limits`: the bytes it unpacks to, the files and folders it creates, its headers of any kind, the
 * depth and length of a path, and the data of a long-name or pax header.
 */
export function extractTarGz(archive: Buffer, dest: string, {
  maxBytes = MAX_UNPACKED_BYTES, maxEntries = MAX_UNPACKED_ENTRIES, maxHeaders = MAX_HEADERS, maxDepth = MAX_PATH_DEPTH,
  maxPathBytes = MAX_PATH_BYTES, maxHeaderData = MAX_HEADER_DATA_BYTES,
}: ArchiveLimits = {}): Extracted {
  // The tar holds a header per file besides the file bytes, so the files themselves stay within the cap too.
  const tar = gunzipOne(archive, maxBytes);
  const root = resolve(dest);
  mkdirSync(root);
  const result: Extracted = { files: 0, folders: 0, bytes: 0 };
  const folders = new Set<string>();
  const files = new Set<string>();
  const listedFolders = new Set<string>();
  const count = (): void => {
    if (result.files + result.folders > maxEntries) throw new Error(`the archive creates more than ${maxEntries} files and folders`);
  };
  // Counts every folder of `segments` not created yet, so a folder a file's path implies counts like one the archive lists.
  const addFolders = (segments: string[]): void => {
    for (let i = 1; i <= segments.length; i++) {
      const folder = segments.slice(0, i).join('/');
      if (files.has(folder)) throw new Error(`the archive holds ${quoted(folder)} as a file and as a folder`);
      if (folders.has(folder)) continue;
      folders.add(folder);
      result.folders++;
      count();
    }
  };
  let headers = 0;
  let longName: string | undefined;
  let pax: Map<string, string> | undefined;
  for (let at = 0; at + BLOCK <= tar.length;) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every(b => b === 0)) {
      // node-tar ends only at a second zero block, and the tar crate at the first.
      if (tar.subarray(at).some(b => b !== 0)) throw new Error('the archive has data after a zero block');
      break;
    }
    if (++headers > maxHeaders) throw new Error(`the archive holds more than ${maxHeaders} entries`);
    if (!checksumHolds(header)) throw new Error('the archive has a header whose checksum does not match');
    const type = String.fromCharCode(header[156] || 0x30);
    if (!'05Lxg'.includes(type)) throw new Error(`the archive holds an entry of type ${quoted(type)}, which is no plain file or folder`);
    const extension = 'Lxg'.includes(type);
    // node-tar lets the later of two headers for one entry win and the tar crate a long name, and both apply a pax size to the next header.
    if (extension && (longName !== undefined || pax !== undefined)) throw new Error('the archive has two long-name or pax headers for one entry');
    // A pax `size` replaces the header's for the entry it describes, as npm and Cargo read it.
    const paxSize = extension ? undefined : pax?.get('size');
    if (paxSize !== undefined && !/^\d{1,15}$/.test(paxSize)) throw new Error('the archive has a pax size that is no decimal number');
    const size = paxSize !== undefined ? Number(paxSize) : octal(header, 124, 12);
    if (extension && size > maxHeaderData) throw new Error(`the archive has a long-name or pax header of more than ${maxHeaderData} bytes`);
    const dataStart = at + BLOCK;
    if (dataStart + size > tar.length) throw new Error('the archive ends inside a file');
    const data = tar.subarray(dataStart, dataStart + size);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = pathField(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      pax = paxRecords(data);
      continue;
    }
    if (type === 'g') {
      // A global header applies to every later entry in node-tar and to none in the tar crate.
      const set = ['path', 'size'].find(key => paxRecords(data).has(key));
      if (set) throw new Error(`the archive has a global pax header that sets ${quoted(set)}`);
      continue;
    }
    // node-tar skips a file or folder that names a link target, and reads its data as the next header.
    if (header.subarray(157, 257).some(b => b !== 0)) throw new Error('the archive has a file or folder that names a link target');
    const prefix = header.subarray(257, 265).equals(USTAR_MAGIC) ? pathField(header, 345, 155) : '';
    const name = longName ?? pax?.get('path') ?? (prefix ? `${prefix}/${pathField(header, 0, 100)}` : pathField(header, 0, 100));
    longName = pax = undefined;
    const segments = entryPath(name, type === '5', maxDepth, maxPathBytes);
    if (!segments) continue;
    const path = segments.join('/');
    // node-tar writes over a path the archive held before, and the tar crate can fail on it.
    if (files.has(path) || listedFolders.has(path) || (type === '0' && folders.has(path))) throw new Error(`the archive holds ${quoted(path)} twice`);
    const target = join(root, ...segments);
    if (!target.startsWith(root + sep)) throw new Error(`the archive holds the path ${JSON.stringify(name)}, which leaves its folder`);
    if (type === '5') {
      listedFolders.add(path);
      addFolders(segments);
      mkdirSync(target, { recursive: true });
      continue;
    }
    addFolders(segments.slice(0, -1));
    files.add(path);
    result.files++;
    count();
    result.bytes += size;
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, data, { mode: 0o644 });
  }
  return result;
}
