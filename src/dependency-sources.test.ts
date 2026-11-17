import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { checksumMatches, dependencyLoader, DependencyLoaderOptions, dependencyOutcomes, pickVersion } from './dependency-sources';
import { cratesIo } from './registries/crates';
import { npmRegistry } from './registries/npm';
import { Registry } from './registries/types';
import { FakeRegistry, fakeRegistry, sha256Hex, sha512Integrity, tarGz } from './test-utils';

const crate = (version: string) => tarGz([{ name: `demo-${version}/src/lib.rs`, data: `pub const VERSION: &str = "${version}";\n` }]);
const CRATES = { '1.2.0': crate('1.2.0'), '1.2.5': crate('1.2.5'), '2.0.0': crate('2.0.0') };
const PAD = tarGz([{ name: 'package/index.js', data: 'module.exports = pad;\n' }]);
const CRATES_IO_SOURCE = 'registry+https://github.com/rust-lang/crates.io-index';

/** A `Cargo.lock` that locks `demo` at each of `versions`, from crates.io unless `source` names another place. */
function cargoLock(versions: Array<{ version: string; checksum?: string; source?: string }>): string {
  return versions.map(({ version, checksum, source = CRATES_IO_SOURCE }) =>
    `[[package]]\nname = "demo"\nversion = "${version}"\nsource = "${source}"\nchecksum = "${checksum ?? sha256Hex(CRATES[version as keyof typeof CRATES])}"\n`).join('\n');
}

describe('dependencyLoader', () => {
  let base: string;
  let server: FakeRegistry;
  let registries: Registry[];
  let n = 0;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'manki-dependency-test-'));
    const index = [
      { name: 'demo', vers: '1.2.0', cksum: sha256Hex(CRATES['1.2.0']) },
      { name: 'demo', vers: '1.2.5', cksum: sha256Hex(CRATES['1.2.5']) },
      { name: 'demo', vers: '1.3.0', cksum: sha256Hex(CRATES['1.2.0']), yanked: true },
      { name: 'demo', vers: '1.4.0-beta.1', cksum: sha256Hex(CRATES['1.2.0']) },
      { name: 'demo', vers: '2.0.0', cksum: sha256Hex(CRATES['2.0.0']) },
    ].map(line => JSON.stringify(line)).join('\n');
    const versions = {
      '1.2.0': { dist: { integrity: sha512Integrity(PAD) } },
      '1.3.0': { dist: { integrity: sha512Integrity(PAD) }, deprecated: 'use 1.2.0' },
      '1.4.0-rc.1': { dist: { integrity: sha512Integrity(PAD) } },
    };
    server = await fakeRegistry({
      '/index/de/mo/demo': index,
      ...Object.fromEntries(Object.entries(CRATES).map(([version, data]) => [`/dl/crates/demo/demo-${version}.crate`, data])),
      '/npm/left-pad': JSON.stringify({ name: 'left-pad', versions }),
      '/npm/left-pad/-/left-pad-1.2.0.tgz': PAD,
      '/npm/moved/-/moved-1.0.0.tgz': { redirect: '/npm/left-pad/-/left-pad-1.2.0.tgz' },
    });
    registries = [cratesIo({ index: `${server.origin}/index`, download: `${server.origin}/dl` }), npmRegistry(`${server.origin}/npm`)];
  });
  afterAll(async () => {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  });
  beforeEach(() => {
    server.requests.length = 0;
  });

  /** Returns a checkout holding `files`, a fresh state folder for its round, and a loader for both. */
  function round(files: Record<string, string>, options: DependencyLoaderOptions = {}) {
    const dir = join(base, `round-${++n}`);
    const repo = join(dir, 'repo');
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    mkdirSync(repo, { recursive: true });
    return { stateDir, load: dependencyLoader(repo, stateDir, { registries, ...options }) };
  }

  it('reads the version a lockfile locks, and records where that version came from', async () => {
    const { stateDir, load } = round({ 'Cargo.lock': cargoLock([{ version: '1.2.0' }]), 'Cargo.toml': '[dependencies]\ndemo = "1"\n' });
    const { key, dir, note } = await load('crates.io/demo');
    expect(key).toBe('crates.io/demo@1.2.0');
    expect(readFileSync(join(dir, 'src', 'lib.rs'), 'utf8')).toContain('"1.2.0"');
    expect(note).toBe('Manki read `crates.io/demo@1.2.0`, the version `Cargo.lock` locks. Cite its lines as `crates.io/demo@1.2.0:path:line`.');
    // The lockfile states the checksum, so only the archive is fetched.
    expect(server.requests).toEqual(['/dl/crates/demo/demo-1.2.0.crate']);
    expect((await load('crates.io/demo@1.2.0')).dir).toBe(dir);
    expect(server.requests).toHaveLength(1);
    expect(dependencyOutcomes(stateDir)).toEqual([{
      package: 'crates.io/demo@1.2.0', registry: 'crates.io', name: 'demo', version: '1.2.0', source: 'lockfile', file: 'Cargo.lock', status: 'fetched', durationMs: expect.any(Number),
    }]);
  });

  it('refuses a package the PR does not use, and a version other than the one it uses, without contacting a registry', async () => {
    const { stateDir, load } = round({
      'Cargo.lock': cargoLock([{ version: '1.2.0' }]),
      // An installed package's own manifest is not the PR's.
      'node_modules/x/package.json': '{"dependencies": {"left-pad": "1"}}',
    });
    await expect(load('crates.io/serde')).rejects.toThrow('crates.io/serde is not a dependency in the PR\'s manifests or lockfiles, so Manki does not read it.');
    await expect(load('npm/left-pad')).rejects.toThrow('is not a dependency');
    await expect(load('crates.io/demo@1.2.5')).rejects.toThrow('The PR does not use crates.io/demo@1.2.5. It uses 1.2.0 (locked in Cargo.lock).');
    await expect(load('pypi/demo')).rejects.toThrow('Name a dependency as crates.io/<name> or npm/<name>');
    await expect(load('crates.io/../demo')).rejects.toThrow('is not a package name of crates.io');
    expect(server.requests).toEqual([]);
    expect(dependencyOutcomes(stateDir)).toEqual([]);
  });

  it('asks for a version when the PR uses several, and refuses one locked from another source', async () => {
    const { load } = round({
      'Cargo.lock': cargoLock([{ version: '1.2.0' }]),
      'tools/Cargo.lock': cargoLock([{ version: '2.0.0' }]),
    });
    await expect(load('crates.io/demo')).rejects.toThrow('The PR uses several versions of crates.io/demo: 1.2.0 (locked in Cargo.lock), 2.0.0 (locked in tools/Cargo.lock). Name one as crates.io/demo@<version>.');
    expect((await load('crates.io/demo@2.0.0')).note).toContain('the version `tools/Cargo.lock` locks');
    const git = round({ 'Cargo.lock': cargoLock([{ version: '1.2.0', source: 'git+https://example.com/demo#abc' }]) });
    await expect(git.load('crates.io/demo')).rejects.toThrow('crates.io/demo is locked in Cargo.lock from git+https://example.com/demo#abc, not from crates.io');
  });

  it('without a lockfile, reads the highest version a requirement allows that is not yanked, deprecated or a prerelease', async () => {
    const { stateDir, load } = round({
      'crates/a/Cargo.toml': '[package]\nname = "a"\n\n[dependencies.demo]\nversion = "1.2"\nfeatures = ["x"]\n',
      // A manifest under a lockfile's folder takes its version from that lockfile, which does not lock `demo`.
      'tools/Cargo.toml': '[dependencies]\ndemo = { version = "2" }\n',
      'tools/Cargo.lock': '[[package]]\nname = "other"\nversion = "1.0.0"\n',
      'web/package.json': JSON.stringify({ devDependencies: { 'left-pad': '^1.0.0' } }),
    });
    const demo = await load('crates.io/demo');
    expect(demo.key).toBe('crates.io/demo@1.2.5');
    expect(demo.note).toContain('the highest version that the requirement `1.2` in `crates/a/Cargo.toml` allows');
    expect((await load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
    expect(dependencyOutcomes(stateDir).map(({ package: name, source, file, requirement, status }) => ({ name, source, file, requirement, status }))).toEqual([
      { name: 'crates.io/demo@1.2.5', source: 'requirement', file: 'crates/a/Cargo.toml', requirement: '1.2', status: 'fetched' },
      { name: 'npm/left-pad@1.2.0', source: 'requirement', file: 'web/package.json', requirement: '^1.0.0', status: 'fetched' },
    ]);
  });

  it('records a checksum that does not match, and never fetches that package again in the round', async () => {
    const { stateDir, load } = round({ 'Cargo.lock': cargoLock([{ version: '1.2.0', checksum: sha256Hex(CRATES['2.0.0']) }]) });
    const refused = 'crates.io/demo@1.2.0 could not be fetched, so it cannot be read: the archive of crates.io/demo@1.2.0 does not match the checksum Cargo.lock states for it';
    await expect(load('crates.io/demo')).rejects.toThrow(refused);
    await expect(load('crates.io/demo')).rejects.toThrow(refused);
    expect(server.requests).toEqual(['/dl/crates/demo/demo-1.2.0.crate']);
    expect(dependencyOutcomes(stateDir)).toEqual([expect.objectContaining({ package: 'crates.io/demo@1.2.0', status: 'mismatch', reason: expect.stringContaining('does not match the checksum') })]);
  });

  it('refuses an archive over its size cap, a redirect and a host outside the registry', async () => {
    const lock = { 'Cargo.lock': cargoLock([{ version: '1.2.0' }]) };
    const small = round(lock, { maxArchiveBytes: 100 });
    await expect(small.load('crates.io/demo')).rejects.toThrow('is larger than');
    expect(dependencyOutcomes(small.stateDir)).toEqual([expect.objectContaining({ status: 'failed', reason: expect.stringContaining('is larger than') })]);

    const movedLock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/moved': { version: '1.0.0', resolved: 'https://registry.npmjs.org/moved/-/moved-1.0.0.tgz', integrity: sha512Integrity(PAD) } } });
    await expect(round({ 'package-lock.json': movedLock }).load('npm/moved')).rejects.toThrow('could not be fetched');
    expect(server.requests).toEqual(['/dl/crates/demo/demo-1.2.0.crate', '/npm/moved/-/moved-1.0.0.tgz']);

    const elsewhere = { ...registries[0], archiveUrl: () => 'http://127.0.0.2:1/demo.crate' };
    await expect(round(lock, { registries: [elsewhere] }).load('crates.io/demo')).rejects.toThrow('http://127.0.0.2:1/demo.crate is not on a host of crates.io');
  });

  it('reads at most the cap of packages per round, and records the one it refused', async () => {
    const { stateDir, load } = round({ 'Cargo.lock': cargoLock([{ version: '1.2.0' }, { version: '2.0.0' }]) }, { maxPackages: 1 });
    await load('crates.io/demo@1.2.0');
    // The package already read takes no second place.
    await load('crates.io/demo@1.2.0');
    await expect(load('crates.io/demo@2.0.0')).rejects.toThrow('Manki did not read crates.io/demo@2.0.0: the round already read 1 packages');
    expect(dependencyOutcomes(stateDir).map(d => [d.package, d.status])).toEqual([['crates.io/demo@1.2.0', 'fetched'], ['crates.io/demo@2.0.0', 'failed']]);
  });
});

describe('pickVersion', () => {
  it('picks what a fresh install picks', () => {
    const versions = [{ version: '1.0.0', checksum: 'a' }, { version: '1.1.0', checksum: 'b', deprecated: true as const }, { version: '1.2.0-rc.1', checksum: 'c' }];
    expect(pickVersion(versions, '^1.0.0')?.version).toBe('1.0.0');
    expect(pickVersion(versions.slice(1), '^1.0.0')?.version).toBe('1.1.0');
    expect(pickVersion(versions, '^1.2.0-rc.0')?.version).toBe('1.2.0-rc.1');
    expect(pickVersion([{ version: '1.0.0', checksum: 'a', yanked: true }], '^1.0.0')).toBeUndefined();
  });
});

describe('checksumMatches', () => {
  it('reads hex digests and Subresource Integrity, and nothing else', () => {
    const data = Buffer.from('archive');
    expect(checksumMatches(data, sha256Hex(data))).toBe(true);
    expect(checksumMatches(data, sha512Integrity(data))).toBe(true);
    expect(checksumMatches(data, `${sha512Integrity(Buffer.from('other'))} sha1-${Buffer.alloc(20).toString('base64')}`)).toBe(false);
    expect(checksumMatches(data, '10c0/abcdef')).toBeUndefined();
  });
});
