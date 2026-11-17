import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { extractTarGz } from './archive';
import { tarGz } from './test-utils';

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
      { name: 'top-level-file', data: 'no folder' },
    ]), out);
    // The top folder is dropped, and `lib` and `bin` are implied by the paths of their files.
    expect(result).toEqual({ files: 3, folders: 2, bytes: 31, skippedLinks: 0 });
    expect(readFileSync(join(out, 'lib', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(readFileSync(join(out, 'a-very-long.js'), 'utf8')).toBe('x');
    expect(statSync(join(out, 'bin', 'run.sh')).mode & 0o111).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['a-very-long.js', 'bin', 'lib']);
  });

  it('refuses an archive with a path that leaves its folder', () => {
    for (const name of ['package/../../evil.js', '/etc/evil', 'package/..', 'C:/evil', 'package\\..\\evil']) {
      const out = dest();
      expect(() => extractTarGz(tarGz([{ name, data: 'x' }]), out)).toThrow('which leaves its folder');
      expect(existsSync(join(base, 'evil.js'))).toBe(false);
    }
  });

  it('never creates a symlink or a hard link, wherever it points', () => {
    const out = dest();
    const result = extractTarGz(tarGz([
      { name: 'package/up', type: '2', linkname: '../../outside' },
      { name: 'package/abs', type: '2', linkname: '/etc/passwd' },
      { name: 'package/hard', type: '1', linkname: '/etc/passwd' },
      { name: 'package/up/through.js', data: 'x' },
    ]), out);
    expect(result.skippedLinks).toBe(3);
    for (const name of ['abs', 'hard']) expect(existsSync(join(out, name))).toBe(false);
    // The file meant to land behind the link is written into a real folder inside the package.
    expect(lstatSync(join(out, 'up')).isDirectory()).toBe(true);
    expect(existsSync(join(base, 'outside'))).toBe(false);
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
    // A folder listed again, or implied by several files, counts once.
    const shared = tarGz([{ name: 'package/a/', type: '5' }, { name: 'package/a/', type: '5' }, { name: 'package/a/x', data: '1' }, { name: 'package/a/y', data: '2' }]);
    expect(extractTarGz(shared, dest(), { maxEntries: 3 })).toEqual({ files: 2, folders: 1, bytes: 2, skippedLinks: 0 });
  });

  it('counts headers of every kind against a cap, also those that create nothing', () => {
    const kinds = tarGz([
      { name: 'pax', type: 'g', data: '12 comment=\n' },
      { name: 'package/link', type: '2', linkname: 'x' },
      { name: 'package/dev', type: '3' },
      { name: '././@LongLink', type: 'L', data: 'package/long.js\0' },
      { name: 'package/short', data: 'x' },
    ]);
    expect(() => extractTarGz(kinds, dest(), { maxHeaders: 4 })).toThrow('holds more than 4 entries');
    expect(extractTarGz(kinds, dest(), { maxHeaders: 5 })).toEqual({ files: 1, folders: 0, bytes: 1, skippedLinks: 1 });
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
