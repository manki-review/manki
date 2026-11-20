import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';

import { extractTarGz } from './archive';
import { TarEntry, tarGz } from './test-utils';

describe('extractTarGz', () => {
  let base: string;
  let n = 0;
  const dest = () => join(base, `out-${++n}`);

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'manki-archive-test-'));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('writes the files of a package without its top folder, as plain files that cannot run', () => {
    const out = dest();
    const pax = '31 path=package/a-very-long.js\n';
    const result = extractTarGz(tarGz([
      { name: 'package/', type: '5' },
      { name: 'package/lib/index.js', data: 'module.exports = 1;\n' },
      { name: 'package/bin/run.sh', data: '#!/bin/sh\n' },
      { name: 'ignored', type: 'x', data: pax },
      { name: 'package/short.js', data: 'x' },
    ]), out);
    // The top folder is dropped, and `lib` and `bin` are implied by the paths of their files.
    expect(result).toEqual({ files: 3, folders: 2, bytes: 31 });
    expect(readFileSync(join(out, 'lib', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(readFileSync(join(out, 'a-very-long.js'), 'utf8')).toBe('x');
    expect(statSync(join(out, 'bin', 'run.sh')).mode & 0o111).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['a-very-long.js', 'bin', 'lib']);
  });

  it('reads each entry as npm and Cargo read it: a pax size over the header\'s, and a path prefix only in a POSIX header', () => {
    const out = dest();
    // The header says the file is empty and the pax record says it holds the code, which is what an install unpacks.
    const code = 'module.exports = 1;\n';
    extractTarGz(tarGz([
      { name: 'p', type: 'x', data: `${`size=${code.length}`.length + 4} size=${code.length}\n` },
      { name: 'package/index.js', data: code, size: 0 },
      { name: 'package/b.js', data: 'b' },
      // A GNU header keeps times where POSIX keeps a prefix, so those bytes are no part of its path.
      { name: 'package/gnu.js', data: 'g', gnu: true, prefix: 'elsewhere' },
      { name: 'index.js', data: 'p', prefix: 'package/lib' },
      // npm archives such as those of `@types` keep times after the prefix's NUL, which both read up to that NUL.
      { name: 'package/types.d.ts', data: 't', prefix: `${'\0'.repeat(131)}14566415320\x0014566415320` },
      { name: 'package/c.js\0\0junk', data: 'c' },
    ]), out);
    expect(readFileSync(join(out, 'index.js'), 'utf8')).toBe(code);
    expect(readdirSync(out).sort()).toEqual(['b.js', 'c.js', 'gnu.js', 'index.js', 'lib', 'types.d.ts']);
    expect(readFileSync(join(out, 'lib', 'index.js'), 'utf8')).toBe('p');
  });

  // The tar of `entries` without its closing zero blocks.
  const entriesOf = (entries: TarEntry[]) => gunzipSync(tarGz(entries)).subarray(0, -1024);
  const file = (name: string): TarEntry => ({ name, data: 'x' });
  const header = (type: TarEntry['type'], data: string | Buffer, name = 'p'): TarEntry => ({ name, type, data });
  /** A pax record of `key` and `value`, with its length counted. */
  const record = (key: string, value: string | Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(` ${key}=`), Buffer.from(value), Buffer.from('\n')]);
    let length = body.length + 1;
    while (String(length).length + body.length !== length) length++;
    return Buffer.concat([Buffer.from(String(length)), body]);
  };
  const badCrc = (() => {
    const archive = tarGz([file('package/a')]);
    archive[archive.length - 8] ^= 1;
    return archive;
  })();
  // Each archive below is one that npm (node-tar) and Cargo (the tar crate) can read differently, so all of it is refused.
  it.each([
    ['an entry after a lone zero block', gzipSync(Buffer.concat([entriesOf([file('package/a')]), Buffer.alloc(512), gunzipSync(tarGz([file('package/b')]))])), 'data after a zero block'],
    ['a second gzip member', Buffer.concat([gzipSync(entriesOf([file('package/a')])), tarGz([file('package/b')])]), 'data after its gzip stream'],
    ['a gzip checksum that does not match', badCrc, 'does not match its gzip checksum'],
    ['a long name and then a pax path', [header('L', 'package/a\0'), header('x', record('path', 'package/b')), file('package/c')], 'two long-name or pax headers for one entry'],
    ['a pax path and then a long name', [header('x', record('path', 'package/b')), header('L', 'package/a\0'), file('package/c')], 'two long-name or pax headers for one entry'],
    ['a pax header and then a global one', [header('x', record('size', '1')), header('g', record('comment', 'c')), file('package/c')], 'two long-name or pax headers for one entry'],
    ['two pax headers', [header('x', record('size', '1')), header('x', record('size', '1')), file('package/a')], 'two long-name or pax headers for one entry'],
    ['a symlink', [{ name: 'package/up', type: '2', linkname: '../../outside' }], 'of type "2"'],
    ['a hard link', [{ name: 'package/hard', type: '1', linkname: 'package/a' }], 'of type "1"'],
    ['a contiguous file', [{ name: 'package/a', type: '7', data: 'x' }], 'of type "7"'],
    ['a long link name', [header('K', 'package/b\0'), file('package/a')], 'of type "K"'],
    ['a device', [{ name: 'package/dev', type: '3' }], 'of type "3"'],
    ['one file twice', [file('package/a'), file('package/a')], 'holds "a" twice'],
    ['one path from two top folders', [file('package/a'), file('other/a')], 'holds "a" twice'],
    ['a folder at the path of a file', [file('package/a'), { name: 'package/a/', type: '5' }], 'holds "a" twice'],
    ['a file at the path of a folder', [{ name: 'package/a/', type: '5' }, file('package/a')], 'holds "a" twice'],
    ['a file inside a file', [file('package/a'), file('package/a/b')], 'holds "a" as a file and as a folder'],
    ['one folder listed twice', [{ name: 'package/a/', type: '5' }, { name: 'package/a/', type: '5' }], 'holds "a" twice'],
    // node-tar keeps the bytes after a NUL that follow a line break, and the tar crate drops them.
    ['a name with a line break after its end', [file('package/a\0b\nc')], 'a path field with bytes after its end'],
    ['a prefix with a line break after its end', [{ name: 'a', data: 'x', prefix: 'package\0\u2028b' }], 'a path field with bytes after its end'],
    ['a long name with bytes after its end', [header('L', 'package/a\0b'), file('package/b')], 'a path field with bytes after its end'],
    ['a long name that is not UTF-8', [header('L', Buffer.from([...Buffer.from('package/a'), 0xff, 0])), file('package/b')], 'a path that is not UTF-8'],
    ['a pax header that is not UTF-8', [header('x', record('path', Buffer.from([...Buffer.from('package/a'), 0xff]))), file('package/b')], 'a pax header that is not UTF-8'],
    ['a pax value with a newline', [header('x', record('path', 'package/a\nb')), file('package/b')], 'whose "path" holds a newline'],
    ['a pax link target', [header('x', record('linkpath', 'package/b')), file('package/a')], 'a pax header that sets "linkpath"'],
    ['a pax sparse map', [header('x', record('GNU.sparse.major', '1')), file('package/a')], 'a pax header that sets "GNU.sparse.major"'],
    ['a file that names a link target', [{ name: 'package/a', data: 'x', linkname: 'package/b' }], 'a file or folder that names a link target'],
    ['a path with a `.` part', [file('./package/a')], 'with an empty or `.` part'],
    ['a path with an empty part', [file('package//a')], 'with an empty or `.` part'],
    ['a file whose path ends in a slash', [file('package/a/')], 'with an empty or `.` part'],
    ['a file outside the top folder', [file('top-level-file')], 'outside the folder every package archive has'],
    ['a pax size that is no decimal number', [header('x', '11 size=1x\n'), file('package/a')], 'a pax size that is no decimal number'],
    ['a pax length in hex', [header('x', '0xb size=1\n'), file('package/a')], 'a broken pax header'],
    ['a pax length with a sign', [header('x', '+12 size=12\n'), file('package/a')], 'a broken pax header'],
    ['a pax record that does not end on its newline', [header('x', '10 size=12'), file('package/a')], 'a broken pax header'],
    ['a pax key set twice', [header('x', '10 size=1\n10 size=2\n'), file('package/a')], 'sets "size" twice'],
    ['a global pax size', [header('g', record('size', '1')), file('package/a')], 'a global pax header that sets "size"'],
    ['a global pax path', [header('g', record('path', 'package/b')), file('package/a')], 'a global pax header that sets "path"'],
  ] as Array<[string, TarEntry[] | Buffer, string]>)('refuses %s', (_, archive, why) => {
    const out = dest();
    expect(() => extractTarGz(Buffer.isBuffer(archive) ? archive : tarGz(archive), out)).toThrow(why);
    expect(existsSync(join(base, 'outside'))).toBe(false);
  });

  it('refuses an archive with a path that leaves its folder', () => {
    for (const name of ['package/../../evil.js', '/etc/evil', 'package/..', 'C:/evil', 'package\\..\\evil']) {
      const out = dest();
      expect(() => extractTarGz(tarGz([{ name, data: 'x' }]), out)).toThrow('which leaves its folder');
      expect(existsSync(join(base, 'evil.js'))).toBe(false);
    }
  });

  it('refuses an archive that unpacks past its size cap', () => {
    const big = tarGz([{ name: 'package/zeros', data: Buffer.alloc(4 * 1024 * 1024) }]);
    // Zeros compress to almost nothing, so only the unpacked size shows the archive is too large.
    expect(big.length).toBeLessThan(64 * 1024);
    expect(() => extractTarGz(big, dest(), { maxBytes: 1024 * 1024 })).toThrow('unpacks to more than 1 MB');
    expect(() => extractTarGz(big, dest(), { maxBytes: 8 * 1024 * 1024 })).not.toThrow();
  });

  it('counts every file and folder it creates against one cap, a folder a file implies as well as one the archive lists', () => {
    const cap = 'creates more than 3 files and folders';
    const files = tarGz(Array.from({ length: 4 }, (_, i) => ({ name: `package/f${i}`, data: 'x' })));
    expect(() => extractTarGz(files, dest(), { maxEntries: 3 })).toThrow(cap);
    const listed = tarGz(Array.from({ length: 4 }, (_, i) => ({ name: `package/d${i}/`, type: '5' as const })));
    expect(() => extractTarGz(listed, dest(), { maxEntries: 3 })).toThrow(cap);
    const out = dest();
    expect(() => extractTarGz(tarGz([{ name: 'package/a/b/c/file', data: 'x' }]), out, { maxEntries: 3 })).toThrow(cap);
    expect(existsSync(join(out, 'a'))).toBe(false);
    // A folder listed after a file implied it, or implied by several files, counts once.
    const shared = tarGz([{ name: 'package/a/x', data: '1' }, { name: 'package/a/', type: '5' }, { name: 'package/a/y', data: '2' }]);
    expect(extractTarGz(shared, dest(), { maxEntries: 3 })).toEqual({ files: 2, folders: 1, bytes: 2 });
  });

  it('counts headers of every kind against a cap, also those that create nothing', () => {
    const kinds = tarGz([
      { name: 'pax', type: 'g', data: '12 comment=\n' },
      { name: 'package/dir/', type: '5' },
      { name: '././@LongLink', type: 'L', data: 'package/long.js\0' },
      { name: 'package/short', data: 'x' },
      { name: 'package/other', data: 'y' },
    ]);
    expect(() => extractTarGz(kinds, dest(), { maxHeaders: 4 })).toThrow('holds more than 4 entries');
    expect(extractTarGz(kinds, dest(), { maxHeaders: 5 })).toEqual({ files: 2, folders: 1, bytes: 2 });
  });

  it('refuses a path deeper or longer than its caps, and a long-name or pax header with more data than a path needs', () => {
    const deep = `package/${'d/'.repeat(5)}file`;
    expect(() => extractTarGz(tarGz([{ name: deep, data: 'x' }]), dest(), { maxDepth: 5 })).toThrow('more than 5 levels deep');
    expect(() => extractTarGz(tarGz([{ name: deep, data: 'x' }]), dest(), { maxDepth: 6 })).not.toThrow();
    const long = `package/${'n'.repeat(60)}/${'m'.repeat(60)}`;
    expect(() => extractTarGz(tarGz([{ name: '././@LongLink', type: 'L', data: `${long}\0` }, { name: 'short', data: 'x' }]), dest(), { maxPathBytes: 100 })).toThrow('longer than 100 bytes');
    const wide = `package/${'w'.repeat(256)}`;
    expect(() => extractTarGz(tarGz([{ name: 'p', type: 'x', data: `${wide.length + 10} path=${wide}\n` }, { name: 'short', data: 'x' }]), dest())).toThrow('with a name longer than 255');
    const padding = Buffer.alloc(2048, 'a');
    expect(() => extractTarGz(tarGz([{ name: 'p', type: 'x', data: Buffer.concat([Buffer.from('2061 comment='), padding.subarray(0, 2047), Buffer.from('\n')]) }, { name: 'package/x', data: 'x' }]), dest(), { maxHeaderData: 1024 }))
      .toThrow('long-name or pax header of more than 1024 bytes');
  });

  it('refuses data that is no tar archive', () => {
    expect(() => extractTarGz(Buffer.from('not gzip'), dest())).toThrow('not gzip data');
    const broken = tarGz([{ name: 'package/a', data: 'x' }]);
    expect(() => extractTarGz(Buffer.concat([broken.subarray(0, 20), Buffer.alloc(10)]), dest())).toThrow();
  });
});
