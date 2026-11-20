import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
    const result = extractTarGz(tarGz([
      { name: 'package/', type: '5' },
      { name: 'package/lib/index.js', data: 'module.exports = 1;\n' },
      { name: 'package/bin/run.sh', data: '#!/bin/sh\n', mode: 0o755 },
      { name: 'ignored', type: 'x', data: '31 path=package/a-very-long.js\n' },
      { name: 'package/short.js', data: 'x' },
      // npm archives such as those of `@types` keep times after the NUL of the prefix field.
      { name: 'package/types.d.ts', data: 't', prefix: `${'\0'.repeat(131)}14566415320\x0014566415320` },
    ]), out);
    // The top folder is dropped, and `lib` and `bin` are implied by the paths of their files.
    expect(result).toEqual({ files: 4, folders: 2, bytes: 32 });
    expect(readFileSync(join(out, 'lib', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(readFileSync(join(out, 'a-very-long.js'), 'utf8')).toBe('x');
    expect(statSync(join(out, 'bin', 'run.sh')).mode & 0o111).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['a-very-long.js', 'bin', 'lib', 'types.d.ts']);
  });

  it.each([
    ['a symlink', [{ name: 'package/up', type: '2', linkname: '../../outside' }], 'as a SymbolicLink'],
    ['a hard link', [{ name: 'package/hard', type: '1', linkname: 'package/a' }], 'as a Link'],
    ['a device', [{ name: 'package/dev', type: '3' }], 'as a CharacterDevice'],
    ['a path with `..`', [{ name: 'package/../../evil.js', data: 'x' }], 'which leaves its folder'],
    ['an absolute path', [{ name: '/etc/evil', data: 'x' }], 'which leaves its folder'],
    ['a backslash path', [{ name: 'package\\..\\evil', data: 'x' }], 'which leaves its folder'],
    ['a path that starts with `./`', [{ name: './d1/a/b/file', data: 'x' }], 'which is not canonical'],
    ['a path with `.`', [{ name: 'package/./b', data: 'x' }], 'which is not canonical'],
    ['a path with an empty part', [{ name: 'package//b', data: 'x' }], 'which is not canonical'],
    // node-tar reads a file whose path ends in a slash as a folder, so its data is a broken header too.
    ['a file with a trailing slash', [{ name: 'package/b/', data: 'x' }], 'checksum failure'],
    ['a folder with two trailing slashes', [{ name: 'package/b//', type: '5' }], 'which is not canonical'],
    // node-tar reads a folder's size as 0, so data after it is a broken header, which strict mode refuses.
    ['a folder with data', [{ name: 'package/b/', type: '5', data: 'x' }], 'checksum failure'],
  ] as Array<[string, TarEntry[], string]>)('refuses an archive with %s', (_, entries, why) => {
    expect(() => extractTarGz(tarGz([{ name: 'package/a', data: 'x' }, ...entries]), dest())).toThrow(why);
    expect(existsSync(join(base, 'outside'))).toBe(false);
    expect(existsSync(join(base, 'evil.js'))).toBe(false);
  });

  it('refuses an archive past a cap', () => {
    const big = tarGz([{ name: 'package/zeros', data: Buffer.alloc(4 * 1024 * 1024) }]);
    expect(() => extractTarGz(big, dest(), { maxBytes: 1024 * 1024 })).toThrow('unpacks to more than 1 MB');
    expect(() => extractTarGz(big, dest(), { maxBytes: 8 * 1024 * 1024 })).not.toThrow();
    const files = tarGz(Array.from({ length: 4 }, (_, i) => ({ name: `package/f${i}`, data: 'x' })));
    expect(() => extractTarGz(files, dest(), { maxEntries: 3 })).toThrow('creates more than 3 files and folders');
    // Each folder a deep path implies counts, so few entries cannot create many folders.
    const implied = tarGz(Array.from({ length: 3 }, (_, i) => ({ name: `package/a${i}/b/c/d/file`, data: 'x' })));
    expect(() => extractTarGz(implied, dest(), { maxEntries: 10 })).toThrow('creates more than 10 files and folders');
    const shared = tarGz([{ name: 'package/a/x', data: '1' }, { name: 'package/a/', type: '5' }, { name: 'package/a/y', data: '2' }]);
    expect(extractTarGz(shared, dest(), { maxEntries: 3 })).toEqual({ files: 2, folders: 1, bytes: 2 });
    const deep = `package/${'d/'.repeat(5)}file`;
    expect(() => extractTarGz(tarGz([{ name: deep, data: 'x' }]), dest(), { maxDepth: 5 })).toThrow('more than 5 levels deep');
    expect(() => extractTarGz(tarGz([{ name: deep, data: 'x' }]), dest(), { maxDepth: 6 })).not.toThrow();
    expect(() => extractTarGz(tarGz([{ name: 'm'.repeat(60), prefix: `package/${'n'.repeat(60)}`, data: 'x' }]), dest(), { maxPathBytes: 100 })).toThrow('longer than 100 bytes');
  });

  it('refuses data that is no tar archive', () => {
    expect(() => extractTarGz(Buffer.from('not gzip'), dest())).toThrow('not gzip data');
  });
});
