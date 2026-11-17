import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { gunzipSync } from 'zlib';

/** The most bytes a package archive may unpack to. */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

/** The most files a package archive may hold. */
export const MAX_ARCHIVE_FILES = 20_000;

const BLOCK = 512;

/** What `extractTarGz` wrote. */
export interface Extracted {
  files: number;
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

/** Returns the `path` of a pax extended header's records, each `<length> <key>=<value>\n`. */
function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    const length = Number(data.subarray(at, space).toString('utf8'));
    if (space < 0 || !Number.isInteger(length) || length <= 0) throw new Error('the archive has a broken pax header');
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    at += length;
  }
  return path;
}

/**
 * Returns the path inside the package of an archive entry, without the folder every package archive wraps its files in,
 * or `undefined` for that folder itself. Throws on an absolute path, a `..` segment, a backslash or a NUL, so a whole
 * archive that tries to write outside its folder is refused.
 */
function entryPath(name: string): string[] | undefined {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.includes('\0')) throw new Error(`the archive holds the path ${JSON.stringify(name)}, which leaves its folder`);
  const segments = name.split('/').filter(s => s !== '' && s !== '.');
  if (segments.includes('..')) throw new Error(`the archive holds the path ${JSON.stringify(name)}, which leaves its folder`);
  return segments.length > 1 ? segments.slice(1) : undefined;
}

/**
 * Unpacks the gzipped tar `archive` into the new folder `dest`. Writes only regular files and folders, never a link, a
 * device or a file mode, so nothing it writes can point outside `dest` or run. Drops the top folder every package archive
 * has. Throws, and the caller discards `dest`, when the archive unpacks to more than `maxBytes`, holds more than
 * `maxFiles` files, holds a path that leaves `dest`, or is not a tar archive.
 */
export function extractTarGz(archive: Buffer, dest: string, { maxBytes = MAX_UNPACKED_BYTES, maxFiles = MAX_ARCHIVE_FILES } = {}): Extracted {
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
  const result: Extracted = { files: 0, bytes: 0, skippedLinks: 0 };
  let longName: string | undefined;
  let paxName: string | undefined;
  for (let at = 0; at + BLOCK <= tar.length;) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every(b => b === 0)) break;
    if (!checksumHolds(header)) throw new Error('the archive has a header whose checksum does not match');
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = at + BLOCK;
    if (dataStart + size > tar.length) throw new Error('the archive ends inside a file');
    const data = tar.subarray(dataStart, dataStart + size);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      paxName = paxPath(data);
      continue;
    }
    if (type === 'g' || type === 'K') continue;
    const prefix = field(header, 345, 155);
    const name = longName ?? paxName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = paxName = undefined;
    const segments = entryPath(name);
    if (type === '1' || type === '2') {
      result.skippedLinks++;
      continue;
    }
    if (!segments || !['0', '7', '5'].includes(type)) continue;
    const target = join(root, ...segments);
    if (!target.startsWith(root + sep)) throw new Error(`the archive holds the path ${JSON.stringify(name)}, which leaves its folder`);
    if (type === '5') {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (++result.files > maxFiles) throw new Error(`the archive holds more than ${maxFiles} files`);
    result.bytes += size;
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, data, { mode: 0o644 });
  }
  return result;
}
