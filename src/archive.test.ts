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
    expect(result).toEqual({ files: 3, bytes: 31, skippedLinks: 0 });
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

  it('refuses an archive that unpacks past its size cap or holds too many files', () => {
    const big = tarGz([{ name: 'package/zeros', data: Buffer.alloc(4 * 1024 * 1024) }]);
    // Zeros compress to almost nothing, so only the unpacked size shows the archive is too large.
    expect(big.length).toBeLessThan(64 * 1024);
    expect(() => extractTarGz(big, dest(), { maxBytes: 1024 * 1024 })).toThrow('unpacks to more than 1 MB');
    const many = tarGz(Array.from({ length: 4 }, (_, i) => ({ name: `package/f${i}`, data: 'x' })));
    expect(() => extractTarGz(many, dest(), { maxFiles: 3 })).toThrow('more than 3 files');
  });

  it('refuses data that is no tar archive', () => {
    expect(() => extractTarGz(Buffer.from('not gzip'), dest())).toThrow('not gzip data');
    const broken = tarGz([{ name: 'package/a', data: 'x' }]);
    expect(() => extractTarGz(Buffer.concat([broken.subarray(0, 20), Buffer.alloc(10)]), dest())).toThrow();
  });
});
