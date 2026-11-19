import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { gunzipSync } from 'zlib';

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
  /** Symbolic and hard links in the archive. None is ever created. */
  skippedLinks: number;
}

/** Reads a NUL-terminated field of a tar header. */
function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
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
 * Returns the records of a pax extended header, each `<length> <key>=<value>\n`, by key. Throws on a key set twice,
 * which tar readers resolve differently.
 */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    const length = Number(data.subarray(at, space).toString('utf8'));
    if (space < 0 || !Number.isInteger(length) || length <= 0) throw new Error('the archive has a broken pax header');
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq < 0) throw new Error('the archive has a broken pax header');
    const key = record.slice(0, eq);
    if (records.has(key)) throw new Error(`the archive has a pax header that sets ${quoted(key)} twice`);
    records.set(key, record.slice(eq + 1));
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
 * archive that tries to write outside its folder is refused. Throws as well on a path deeper or longer than the caps.
 */
function entryPath(name: string, maxDepth: number, maxPathBytes: number): string[] | undefined {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.includes('\0')) throw new Error(`the archive holds the path ${quoted(name)}, which leaves its folder`);
  const segments = name.split('/').filter(s => s !== '' && s !== '.');
  if (segments.includes('..')) throw new Error(`the archive holds the path ${quoted(name)}, which leaves its folder`);
  if (Buffer.byteLength(name) > maxPathBytes || segments.some(s => Buffer.byteLength(s) > MAX_NAME_BYTES)) throw new Error(`the archive holds the path ${quoted(name)}, longer than ${maxPathBytes} bytes or with a name longer than ${MAX_NAME_BYTES}`);
  if (segments.length > maxDepth + 1) throw new Error(`the archive holds the path ${quoted(name)}, more than ${maxDepth} levels deep`);
  return segments.length > 1 ? segments.slice(1) : undefined;
}

/**
 * Unpacks the gzipped tar `archive` into the new folder `dest`. Writes only regular files and folders, never a link, a
 * device or a file mode, so nothing it writes can point outside `dest` or run. Drops the top folder every package archive
 * has. Throws, and the caller discards `dest`, when the archive is not a tar archive, holds a path that leaves `dest`,
 * or passes any cap of `limits`: the bytes it unpacks to, the files and folders it creates, its headers of any kind, the
 * depth and length of a path, and the data of a long-name or pax header.
 */
export function extractTarGz(archive: Buffer, dest: string, {
  maxBytes = MAX_UNPACKED_BYTES, maxEntries = MAX_UNPACKED_ENTRIES, maxHeaders = MAX_HEADERS, maxDepth = MAX_PATH_DEPTH,
  maxPathBytes = MAX_PATH_BYTES, maxHeaderData = MAX_HEADER_DATA_BYTES,
}: ArchiveLimits = {}): Extracted {
  let tar: Buffer;
  try {
    // The tar holds a header per file besides the file bytes, so the files themselves stay within the cap too.
    tar = gunzipSync(archive, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`the archive unpacks to more than ${maxBytes / 1024 / 1024} MB`);
    throw new Error(`the archive is not gzip data: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = resolve(dest);
  mkdirSync(root);
  const result: Extracted = { files: 0, folders: 0, bytes: 0, skippedLinks: 0 };
  const folders = new Set<string>();
  const count = (): void => {
    if (result.files + result.folders > maxEntries) throw new Error(`the archive creates more than ${maxEntries} files and folders`);
  };
  // Counts every folder of `segments` not created yet, so a folder a file's path implies counts like one the archive lists.
  const addFolders = (segments: string[]): void => {
    for (let i = 1; i <= segments.length; i++) {
      const folder = segments.slice(0, i).join('/');
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
    if (header.every(b => b === 0)) break;
    if (++headers > maxHeaders) throw new Error(`the archive holds more than ${maxHeaders} entries`);
    if (!checksumHolds(header)) throw new Error('the archive has a header whose checksum does not match');
    const type = String.fromCharCode(header[156] || 0x30);
    const extension = 'LKxg'.includes(type);
    // A pax `size` replaces the header's for the entry it describes, as npm and Cargo read it.
    const paxSize = extension ? undefined : pax?.get('size');
    if (paxSize !== undefined && !/^\d{1,15}$/.test(paxSize)) throw new Error('the archive has a pax size that is no decimal number');
    const size = paxSize !== undefined ? Number(paxSize) : octal(header, 124, 12);
    if (extension && size > maxHeaderData) throw new Error(`the archive has a long-name or pax header of more than ${maxHeaderData} bytes`);
    const dataStart = at + BLOCK;
    if (dataStart + size > tar.length) throw new Error('the archive ends inside a file');
    const data = tar.subarray(dataStart, dataStart + size);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    // Tar readers differ on a second header of a kind for one entry, and on a global one that sets a path or size.
    if ((type === 'L' && longName !== undefined) || (type === 'x' && pax !== undefined)) throw new Error('the archive has two long-name or pax headers for one entry');
    if (type === 'L') {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      pax = paxRecords(data);
      continue;
    }
    if (type === 'g') {
      const set = ['path', 'size'].find(key => paxRecords(data).has(key));
      if (set) throw new Error(`the archive has a global pax header that sets ${quoted(set)}`);
      continue;
    }
    if (type === 'K') continue;
    const prefix = header.subarray(257, 265).equals(USTAR_MAGIC) ? field(header, 345, 155) : '';
    const name = longName ?? pax?.get('path') ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = pax = undefined;
    const segments = entryPath(name, maxDepth, maxPathBytes);
    if (type === '1' || type === '2') {
      result.skippedLinks++;
      continue;
    }
    if (!segments || !['0', '7', '5'].includes(type)) continue;
    const target = join(root, ...segments);
    if (!target.startsWith(root + sep)) throw new Error(`the archive holds the path ${JSON.stringify(name)}, which leaves its folder`);
    if (type === '5') {
      addFolders(segments);
      mkdirSync(target, { recursive: true });
      continue;
    }
    addFolders(segments.slice(0, -1));
    result.files++;
    count();
    result.bytes += size;
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, data, { mode: 0o644 });
  }
  return result;
}
