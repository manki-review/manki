import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { ReadEntry, UnpackSync } from 'tar';
import { gunzipSync } from 'zlib';

/** The most bytes a package archive may unpack to, headers included. */
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
/** The most files and folders an archive may create, counting each folder a file's path implies. */
const MAX_UNPACKED_ENTRIES = 20_000;
/** The most folders deep a path in an archive may lie. */
const MAX_PATH_DEPTH = 32;
/** The most bytes of a path in an archive. */
const MAX_PATH_BYTES = 1024;

/** The caps `extractTarGz` holds an archive to. */
export interface ArchiveLimits {
  maxBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
  maxPathBytes?: number;
}

/** What `extractTarGz` wrote. */
export interface Extracted {
  files: number;
  folders: number;
  bytes: number;
}

/** Shows the start of an archive's path in an error, since the path can be long. */
function quoted(name: string): string {
  return JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}...` : name);
}

/** Returns why Manki refuses the archive entry at `path`, or `undefined` for a plain file or folder inside the package. */
function refusal(path: string, entry: ReadEntry, maxDepth: number, maxPathBytes: number): string | undefined {
  if (entry.type !== 'File' && entry.type !== 'Directory') return `the archive holds ${quoted(path)} as a ${entry.type}, which is no plain file or folder`;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').includes('..')) return `the archive holds the path ${quoted(path)}, which leaves its folder`;
  // npm and crates.io archives hold canonical paths only, which the folder count below reads as node-tar writes them.
  const parts = (entry.type === 'Directory' && path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  if (parts.some(part => part === '' || part === '.')) return `the archive holds the path ${quoted(path)}, which is not canonical`;
  if (Buffer.byteLength(path) > maxPathBytes) return `the archive holds the path ${quoted(path)}, longer than ${maxPathBytes} bytes`;
  if (path.split('/').filter(Boolean).length > maxDepth + 1) return `the archive holds the path ${quoted(path)}, more than ${maxDepth} levels deep`;
  return undefined;
}

/**
 * Unpacks the gzipped tar `archive` into the new folder `dest` with node-tar, the reader npm itself uses, and drops the
 * top folder every package archive has. Refuses the whole archive when it holds anything but plain files and folders,
 * such as a link or a device, a path that leaves `dest`, or passes a cap of `limits`: the bytes it unpacks to, the files
 * and folders it creates, and the depth and length of a path. Writes no file mode, so nothing it writes can run. Throws,
 * and the caller discards `dest`, on a refusal or an archive node-tar cannot read.
 */
export function extractTarGz(archive: Buffer, dest: string, {
  maxBytes = MAX_UNPACKED_BYTES, maxEntries = MAX_UNPACKED_ENTRIES, maxDepth = MAX_PATH_DEPTH, maxPathBytes = MAX_PATH_BYTES,
}: ArchiveLimits = {}): Extracted {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`the archive unpacks to more than ${maxBytes / 1024 / 1024} MB`);
    throw new Error(`the archive is not gzip data: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = resolve(dest);
  mkdirSync(root);
  const result: Extracted = { files: 0, folders: 0, bytes: 0 };
  let refused: string | undefined;
  const folders = new Set<string>();
  const unpack = new UnpackSync({
    cwd: root, strip: 1, strict: true, preservePaths: false, preserveOwner: false, fmode: 0o644, dmode: 0o755,
    filter: (path, entry) => {
      const readEntry = entry as ReadEntry;
      refused ??= refusal(path, readEntry, maxDepth, maxPathBytes);
      if (refused) return false;
      // Without a mode of its own, an entry gets `fmode` or `dmode`, so no file is written to run.
      readEntry.mode = undefined;
      // Every folder an entry creates counts, whether the archive lists it or only a path implies it.
      const inside = path.replace(/\/$/, '').split('/').slice(1);
      const folderParts = readEntry.type === 'Directory' ? inside.length : inside.length - 1;
      for (let i = 1; i <= folderParts; i++) folders.add(inside.slice(0, i).join('/'));
      if (readEntry.type !== 'Directory') result.files++;
      result.folders = folders.size;
      result.bytes += readEntry.size;
      if (result.files + result.folders > maxEntries) refused = `the archive creates more than ${maxEntries} files and folders`;
      return !refused;
    },
  });
  try {
    unpack.end(tar);
  } catch (error) {
    // A refused entry can leave node-tar reading its data as the next header, so the refusal is the reason.
    throw new Error(refused ?? `the archive could not be unpacked: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (refused) throw new Error(refused);
  return result;
}
