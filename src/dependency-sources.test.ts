import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { caseSensitiveFs, checksumMatches, dependencyLoader, DependencyLoaderOptions, dependencyOutcomes, pickVersion } from './dependency-sources';
import { cratesIo } from './registries/crates';
import { npmRegistry } from './registries/npm';
import { Registry } from './registries/types';
import { fetchedRelatedRepos } from './related-repos';
import { closePaths } from './workspace';
import { expectLinearTime, FakeRegistry, fakeRegistry, git, sha256Hex, sha512Integrity, tarGz } from './test-utils';

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
  // Each round sets up a git checkout of its own, and some tests run dozens of rounds.
  jest.setTimeout(30_000);
  let base: string;
  let server: FakeRegistry;
  let registries: Registry[];
  // The probe says no on macOS and Windows, so each round states the answer of the Linux runners.
  const caseSensitive = () => true;
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
    // `next` holds a higher version than `latest`, which npm installs first whenever it matches.
    const tagged = { 'dist-tags': { latest: '2.0.0', next: '2.1.0' }, versions: { '2.0.0': { dist: { integrity: sha512Integrity(PAD) } }, '2.1.0': { dist: { integrity: sha512Integrity(PAD) } } } };
    server = await fakeRegistry({
      '/index/de/mo/demo': index,
      ...Object.fromEntries(Object.entries(CRATES).map(([version, data]) => [`/dl/crates/demo/demo-${version}.crate`, data])),
      '/index/de/mo/demo_rs': JSON.stringify({ name: 'demo_rs', vers: '1.0.0', cksum: sha256Hex(CRATES['1.2.0']) }),
      '/dl/crates/demo_rs/demo_rs-1.0.0.crate': CRATES['1.2.0'],
      '/index/sl/ow/slow': { hang: true },
      // Build metadata is part of a published version, as for the crate `wasi`.
      '/index/1/w': ['0.10.0', '0.11.0+wasi-snapshot-preview1'].map(vers => JSON.stringify({ name: 'w', vers, cksum: sha256Hex(CRATES['1.2.0']) })).join('\n'),
      '/dl/crates/w/w-0.11.0%2Bwasi-snapshot-preview1.crate': CRATES['1.2.0'],
      '/index/ti/me/time': ['0.2.27', '0.3.47'].map(vers => JSON.stringify({ name: 'time', vers, cksum: sha256Hex(CRATES['1.2.0']) })).join('\n'),
      '/dl/crates/time/time-0.3.47.crate': CRATES['1.2.0'],
      '/npm/undeprecated': JSON.stringify({ name: 'undeprecated', versions: { '1.0.0': { dist: { integrity: sha512Integrity(PAD) } }, '1.1.0': { dist: { integrity: sha512Integrity(PAD) }, deprecated: '' } } }),
      '/npm/undeprecated/-/undeprecated-1.1.0.tgz': PAD,
      '/npm/left-pad': JSON.stringify({ name: 'left-pad', versions }),
      '/npm/left-pad/-/left-pad-1.2.0.tgz': PAD,
      '/npm/tagged': JSON.stringify({ name: 'tagged', ...tagged }),
      '/npm/tagged/-/tagged-2.0.0.tgz': PAD,
      '/npm/renamed': JSON.stringify({ name: 'other`pad', versions: { '1.0.0': { dist: { integrity: sha512Integrity(PAD) } } } }),
      '/npm/moved/-/moved-1.0.0.tgz': { redirect: '/npm/left-pad/-/left-pad-1.2.0.tgz' },
      '/npm/flaky/-/flaky-1.0.0.tgz': { failFirst: 503, body: PAD },
      // A scoped name is one path segment in the version list's URL, and two in the archive's.
      '/npm/@corp%2fpad': JSON.stringify({ name: '@corp/pad', versions: { '1.0.0': { dist: { integrity: sha512Integrity(PAD) } } } }),
      '/npm/@corp/pad/-/pad-1.0.0.tgz': PAD,
      '/npm/slowpad': { delayMs: 1000, body: JSON.stringify({ name: 'slowpad', versions: { '1.0.0': { dist: { integrity: sha512Integrity(PAD) } } } }) },
      '/npm/slowpad/-/slowpad-1.0.0.tgz': { delayMs: 1000, body: PAD },
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
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    return { repo, stateDir, load: dependencyLoader(repo, stateDir, { registries, caseSensitive, ...options }) };
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
    // The round's checks find the package among what it fetched, though its markers sit in a folder of their own.
    expect(fetchedRelatedRepos(stateDir).get('crates.io/demo@1.2.0')).toBe(dir);
    expect(dependencyOutcomes(stateDir)).toEqual([{
      package: 'crates.io/demo@1.2.0', registry: 'crates.io', name: 'demo', version: '1.2.0', source: 'lockfile', file: 'Cargo.lock', status: 'fetched', durationMs: expect.any(Number),
    }]);
  });

  it('reads no package on a file system that does not tell names apart by case or Unicode form, and records why', async () => {
    const files = { 'Cargo.lock': cargoLock([{ version: '1.2.0' }]), 'Cargo.toml': '[dependencies]\ndemo = "1"\n' };
    const probed: string[] = [];
    const { stateDir, load } = round(files, { caseSensitive: dir => (probed.push(dir), false) });
    const off = 'Manki does not read crates.io/demo: this run\'s file system does not tell apart names that differ only in case or Unicode form';
    await expect(load('crates.io/demo')).rejects.toThrow(off);
    await expect(load('npm/left-pad')).rejects.toThrow('Dependency reading is off for the run.');
    // The probe runs once per round, and no registry is contacted.
    expect(probed).toHaveLength(1);
    expect(server.requests).toEqual([]);
    expect(dependencyOutcomes(stateDir)).toEqual(expect.arrayContaining([expect.objectContaining({ package: 'crates.io/demo', status: 'refused', reason: expect.stringContaining(off) })]));
    // A probe that cannot be written counts as a file system that does not tell names apart.
    expect(caseSensitiveFs(join(base, 'missing'))).toBe(false);
  });

  it('refuses a package the PR does not use, and a version other than the one it uses, without contacting a registry', async () => {
    const { stateDir, load } = round({
      'Cargo.lock': cargoLock([{ version: '1.2.0' }]),
    });
    await expect(load('crates.io/serde')).rejects.toThrow('crates.io/serde is not a dependency in the PR\'s manifests or lockfiles, so Manki does not read it.');
    await expect(load('npm/left-pad')).rejects.toThrow('is not a dependency');
    await expect(load('crates.io/demo@1.2.5')).rejects.toThrow('The PR does not use crates.io/demo@1.2.5. Its lockfiles lock 1.2.0 in Cargo.lock.');
    await expect(load('pypi/demo')).rejects.toThrow('Name a dependency as crates.io/<name> or npm/<name>');
    await expect(load('crates.io/../demo')).rejects.toThrow('is not a package name of crates.io');
    expect(server.requests).toEqual([]);
    // Only the package the PR uses reaches the record, with the version it was named at refused as failed.
    expect(dependencyOutcomes(stateDir)).toEqual([expect.objectContaining({ package: 'crates.io/demo@1.2.5', source: 'lockfile', file: 'Cargo.lock', status: 'failed', reason: expect.stringContaining('does not use crates.io/demo@1.2.5') })]);
  });

  it('refuses a name its lockfiles lock at several versions unless the call names one, and one locked from another source', async () => {
    const { stateDir, load } = round({
      'Cargo.lock': cargoLock([{ version: '1.2.0' }]),
      'tools/Cargo.lock': cargoLock([{ version: '2.0.0' }]),
    });
    await expect(load('crates.io/demo@3.0.0')).rejects.toThrow('The PR does not use crates.io/demo@3.0.0.');
    await expect(load('crates.io/demo')).rejects.toThrow('Manki does not read crates.io/demo: its lockfiles lock several versions: 1.2.0 in Cargo.lock, 2.0.0 in tools/Cargo.lock. Name one as crates.io/demo@<version>.');
    // An earlier call naming a version the PR does not use leaves the refusal its own record.
    expect(dependencyOutcomes(stateDir)).toEqual([
      expect.objectContaining({ package: 'crates.io/demo@3.0.0', status: 'failed', reason: expect.stringContaining('does not use crates.io/demo@3.0.0') }),
      expect.objectContaining({ package: 'crates.io/demo', status: 'refused', reason: expect.stringContaining('several versions') }),
    ]);
    expect((await load('crates.io/demo@2.0.0')).note).toContain('the version `tools/Cargo.lock` locks');
    // Without a locked version that meets every requirement, naming one cannot help, so the refusal does not suggest it.
    const apart = round({
      'Cargo.lock': cargoLock([{ version: '1.2.0' }]), 'Cargo.toml': '[dependencies]\ndemo = "=1.2.0"\n',
      'tools/Cargo.lock': cargoLock([{ version: '2.0.0' }]), 'tools/Cargo.toml': '[dependencies]\ndemo = "2"\n',
    });
    await expect(apart.load('crates.io/demo')).rejects.toThrow(/several versions: 1\.2\.0 in Cargo\.lock, 2\.0\.0 in tools\/Cargo\.lock\.$/);
    // Cargo ignores the lockfile of a workspace member for the root's, but not one of a package the workspace excludes.
    const workspace = (manifest: string) => round({
      'Cargo.lock': cargoLock([{ version: '1.2.0' }]), 'Cargo.toml': manifest,
      'tools/Cargo.lock': cargoLock([{ version: '2.0.0' }]), 'tools/Cargo.toml': '[package]\nname = "tools"\n',
    });
    expect((await workspace('[workspace]\nmembers = ["t*"]\n').load('crates.io/demo')).note).toContain('the version `Cargo.lock` locks');
    await expect(workspace('[workspace]\nmembers = ["*"]\nexclude = ["tools"]\n').load('crates.io/demo')).rejects.toThrow('its lockfiles lock several versions');
    // A workspace with more members than Manki matches against leaves its members' lockfiles counted.
    const crowded = ['"tools"', ...Array.from({ length: 1000 }, (_, i) => `"m${i}"`)].join(', ');
    await expect(workspace(`[workspace]\nmembers = [${crowded}]\n`).load('crates.io/demo')).rejects.toThrow('its lockfiles lock several versions');
    const git = round({ 'Cargo.lock': cargoLock([{ version: '1.2.0', source: 'git+https://example.com/demo#abc' }]) });
    await expect(git.load('crates.io/demo')).rejects.toThrow('Manki does not read crates.io/demo: Cargo.lock locks it from git+https://example.com/demo#abc, not from crates.io.');
    expect(dependencyOutcomes(git.stateDir)).toEqual([expect.objectContaining({ package: 'crates.io/demo', version: '1.2.0', status: 'refused', reason: expect.stringContaining('not from crates.io') })]);
    // A related repository of the same name, such as `crates.io/demo`, keeps its markers apart from the package's.
    expect(readdirSync(git.stateDir)).toEqual(['dependencies']);
    // An entry from another source refuses the name, also next to one from crates.io, since a call site may use either.
    const both = round({ 'Cargo.lock': cargoLock([{ version: '1.2.0' }, { version: '2.0.0', source: 'git+https://example.com/demo#abc' }]) });
    await expect(both.load('crates.io/demo@1.2.0')).rejects.toThrow('Manki does not read crates.io/demo: Cargo.lock locks it from git+https://example.com/demo#abc');
  });

  it('refuses, and records as refused, a locked package whose code is not the archive the registry publishes', async () => {
    const entry = (key: string, resolution: string) => `"${key}":\n  version: 1.2.0\n  resolution: "${resolution}"\n  checksum: 10c0/abc\n  languageName: node\n  linkType: hard\n`;
    const berry = (resolution: string) => `__metadata:\n  version: 8\n  cacheKey: 10c0\n\n${entry('left-pad@npm:^1.0.0', resolution)}`;
    // Yarn keeps the plain `npm:` entry next to the patched one, and the patch refuses the name.
    const patch = 'left-pad@patch:left-pad@npm%3A1.2.0#~/.yarn/patches/left-pad.patch::version=1.2.0&hash=abc';
    const patched = round({ 'yarn.lock': `${berry('left-pad@npm:1.2.0')}\n${entry(patch.replace(/::.*$/, ''), patch)}` });
    await expect(patched.load('npm/left-pad')).rejects.toThrow('Manki does not read npm/left-pad: yarn.lock locks it with a patch applied, so the PR does not run the code npm publishes.');
    expect(dependencyOutcomes(patched.stateDir)).toEqual([{
      package: 'npm/left-pad', registry: 'npm', name: 'left-pad', version: '1.2.0', source: 'lockfile', file: 'yarn.lock', status: 'refused', reason: expect.stringContaining('with a patch applied'),
    }]);
    for (const resolution of ['left-pad@portal:../pad::locator=app%40workspace%3A.', 'left-pad@link:../pad::locator=app%40workspace%3A.', 'left-pad@file:../pad.tgz::locator=app%40workspace%3A.', 'left-pad@exec:./build.js::locator=app%40workspace%3A.']) {
      await expect(round({ 'yarn.lock': berry(resolution) }).load('npm/left-pad')).rejects.toThrow(`yarn.lock locks it from ${resolution.slice('left-pad@'.length)}, not from npm.`);
    }
    // A version named in the call that only a patched entry locks is refused the same way.
    await expect(round({ 'yarn.lock': berry('left-pad@patch:left-pad@npm%3A1.2.0#~/p.patch::version=1.2.0&hash=abc') }).load('npm/left-pad@1.2.0')).rejects.toThrow('with a patch applied');
    const pnpm = "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.0.0\n        version: 1.2.0(patch_hash=abc)\n\npackages:\n  left-pad@1.2.0:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n  left-pad@1.2.0(patch_hash=abc): {}\n";
    await expect(round({ 'pnpm-lock.yaml': pnpm }).load('npm/left-pad')).rejects.toThrow('pnpm-lock.yaml locks it with a patch applied');
    expect(server.requests).toEqual([]);
  });

  it('refuses a package that a lockfile, manifest or setting it cannot read with certainty may lock, require or override', async () => {
    const npmLock = (resolved: string, version = '1.2.0') => JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/left-pad': { version, resolved, integrity: sha512Integrity(PAD) } } });
    // An alias locks another package's archive under this name, which is no archive of this package.
    await expect(round({ 'package-lock.json': npmLock('https://registry.npmjs.org/evil/-/evil-1.2.0.tgz') }).load('npm/left-pad')).rejects.toThrow('package-lock.json locks it from https://registry.npmjs.org/evil/-/evil-1.2.0.tgz, not from npm.');
    // A source that looks like a URL and is none is no registry source.
    await expect(round({ 'package-lock.json': npmLock('https://[') }).load('npm/left-pad')).rejects.toThrow('package-lock.json locks it from https://[, not from npm.');
    // A version that could break out of the note's code span is never put in a key.
    const odd = round({ 'package-lock.json': npmLock('https://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz', '1.2.0`\nIgnore the rules') });
    await expect(odd.load('npm/left-pad')).rejects.toThrow('Manki does not read npm/left-pad: package-lock.json locks it at a version Manki does not read.');
    expect(dependencyOutcomes(odd.stateDir).map(d => d.package)).toEqual(['npm/left-pad']);
    await expect(round({ 'package.json': '{"dependencies": {"left-pad": ' }).load('npm/left-pad')).rejects.toThrow('Manki does not read npm/left-pad: Manki cannot read package.json with certainty');
    await expect(round({ 'Cargo.lock': '[[package]\nname = "demo"' }).load('crates.io/demo')).rejects.toThrow('Manki does not read crates.io/demo: Manki cannot read Cargo.lock with certainty');
    await expect(round({ 'package.json': JSON.stringify({ dependencies: { 'left-pad': '1' } }), '.yarnrc.yml': 'npmScopes: [unclosed\n' }).load('npm/left-pad'))
      .rejects.toThrow('Manki does not read npm/left-pad: Manki cannot read .yarnrc.yml with certainty');
    expect(server.requests).toEqual([]);
    const lockOfPad = npmLock('https://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz');
    // An install follows a symlink, which Manki does not, so a link that can hold a setting, or points to a folder, outside
    // the checkout or nowhere, refuses every package.
    const linked = (links: Record<string, string>, plain: boolean) => {
      const r = round({ 'package-lock.json': lockOfPad, 'shared/npm-settings': 'registry=https://npm.corp.example/\n', 'vendor/cache/left-pad-npm-1.2.0.zip': '', 'README.md': '' });
      for (const [path, target] of Object.entries(links)) {
        mkdirSync(dirname(join(r.repo, path)), { recursive: true });
        symlinkSync(target, join(r.repo, path));
      }
      git(r.repo, 'add', '-A');
      // A checkout with `core.symlinks=false` writes each link as a plain file that holds its target.
      for (const [path, target] of plain ? Object.entries(links) : []) {
        rmSync(join(r.repo, path));
        writeFileSync(join(r.repo, path), target);
      }
      return r;
    };
    for (const plain of [false, true]) {
      for (const [path, target] of [['web/.npmrc', '../shared/npm-settings'], ['.yarn/cache', '../vendor/cache'], ['lib', '../outside'], ['docs/gone.md', 'missing.md']]) {
        await expect(linked({ [path]: target }, plain).load('npm/left-pad')).rejects.toThrow(`Manki does not read npm/left-pad: the checkout holds ${path} as a symlink, which Manki does not follow`);
      }
      // A link to a plain file of the checkout, under a name Manki does not read, changes no install.
      expect((await linked({ 'docs/README.md': '../README.md' }, plain).load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
      // A link named `node_modules`, or a scope inside one, can hold any package below it.
      await expect(linked({ 'web/node_modules': '../README.md' }, plain).load('npm/left-pad')).rejects.toThrow('the checkout holds web/node_modules, a committed install');
      await expect(linked({ 'node_modules/@corp': '../README.md' }, plain).load('npm/@corp/pad')).rejects.toThrow('the checkout holds node_modules/@corp, a committed install');
    }
    // A submodule anywhere holds files Manki does not list, so it refuses every package.
    const withSubmodule = round({ 'package-lock.json': lockOfPad });
    git(withSubmodule.repo, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/lib`);
    await expect(withSubmodule.load('npm/left-pad')).rejects.toThrow('Manki does not read npm/left-pad: the checkout holds vendor/lib as a git submodule');
    // A manifest Manki cannot read may name the package in a spelling it misses, so it refuses the package.
    await expect(round({ 'a/Cargo.toml': '[dependencies]\nother = ', 'Cargo.lock': cargoLock([{ version: '1.2.0' }]) }).load('crates.io/demo')).rejects.toThrow('Manki cannot read a/Cargo.toml with certainty');
    // Any `package.json` can hold an install script, which changes every package, so one Manki cannot read refuses them all.
    await expect(round({ 'package-lock.json': lockOfPad, 'tools/package.json': '{"scripts": {"postinstall": ' }).load('npm/left-pad')).rejects.toThrow('Manki does not read npm/left-pad: Manki cannot read tools/package.json with certainty');
    // npm drops a byte order mark before it parses a manifest, and so does Manki.
    const bom = '\uFEFF';
    await expect(round({ 'package-lock.json': lockOfPad, 'package.json': `${bom}${JSON.stringify({ scripts: { postinstall: 'node fix.js' } })}` }).load('npm/left-pad')).rejects.toThrow('its `postinstall` script runs at install');
    const workspace = { 'package.json': `${bom}${JSON.stringify({ workspaces: ['web'] })}`, 'web/package.json': `${bom}${JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } })}` };
    expect((await round({ ...workspace, 'package-lock.json': lockOfPad }).load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
  });

  it('without a lockfile, reads the highest version a requirement allows that is not yanked, deprecated or a prerelease', async () => {
    const { stateDir, load } = round({
      'crates/a/Cargo.toml': '[package]\nname = "a"\n\n[dependencies.demo]\nversion = "1.2"\nfeatures = ["x"]\n',
      // A lockfile that does not lock the package leaves its requirement to decide.
      'tools/Cargo.toml': '[dependencies]\nother = { version = "2" }\n',
      'tools/Cargo.lock': '[[package]]\nname = "other"\nversion = "1.0.0"\n',
      'web/package.json': JSON.stringify({ devDependencies: { 'left-pad': '^1.0.0' } }),
    });
    const demo = await load('crates.io/demo');
    expect(demo.key).toBe('crates.io/demo@1.2.5');
    expect((await round({ 'Cargo.toml': '[dependencies]\nw = "0.11"\n' }).load('crates.io/w')).key).toBe('crates.io/w@0.11.0+wasi-snapshot-preview1');
    expect(demo.note).toBe('Manki read `crates.io/demo@1.2.5`, the version a fresh install picks for the requirement `1.2` in `crates/a/Cargo.toml`, since no committed lockfile locks it. No file of the PR sets another registry for it, so Manki read it from crates.io. Cite its lines as `crates.io/demo@1.2.5:path:line`.');
    const pad = await load('npm/left-pad');
    expect(pad.key).toBe('npm/left-pad@1.2.0');
    expect(pad.note).toContain('No file of the PR sets another registry for it, so Manki read it from npm.');
    expect(dependencyOutcomes(stateDir).map(({ package: name, source, file, requirement, status }) => ({ name, source, file, requirement, status }))).toEqual([
      { name: 'crates.io/demo@1.2.5', source: 'requirement', file: 'crates/a/Cargo.toml', requirement: '1.2', status: 'fetched' },
      { name: 'npm/left-pad@1.2.0', source: 'requirement', file: 'web/package.json', requirement: '^1.0.0', status: 'fetched' },
    ]);
  });

  it('looks a requirement up under the name the manifest spells, and prefers the version npm marks as `latest`', async () => {
    const { load } = round({ 'Cargo.toml': '[dependencies]\ndemo_rs = "1"\n', 'package.json': JSON.stringify({ dependencies: { tagged: '^2.0.0' } }) });
    expect((await load('crates.io/demo-rs')).key).toBe('crates.io/demo_rs@1.0.0');
    expect((await load('npm/tagged')).key).toBe('npm/tagged@2.0.0');
    expect(server.requests).toEqual(['/index/de/mo/demo_rs', '/dl/crates/demo_rs/demo_rs-1.0.0.crate', '/npm/tagged', '/npm/tagged/-/tagged-2.0.0.tgz']);
    // The registry's spelling of the name reaches the key, so one that is no valid name of the package is refused.
    await expect(round({ 'package.json': JSON.stringify({ dependencies: { renamed: '1' } }) }).load('npm/renamed')).rejects.toThrow('npm lists npm/renamed under a name Manki does not read.');
  });

  it('refuses a package that a registry setting of the PR may take from another registry', async () => {
    const berryLock = '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"left-pad@npm:^1.0.0":\n  version: 1.2.0\n  resolution: "left-pad@npm:1.2.0"\n  checksum: 10c0/abc\n  languageName: node\n  linkType: hard\n';
    const another = 'it may come from another registry than npm, since';
    const scopedRequired = { 'package.json': JSON.stringify({ dependencies: { '@corp/pad': '^1.0.0' } }) };
    // npm fetches an entry that names its public host from the registry the settings give, so that entry is refused too.
    const packageLock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/left-pad': { version: '1.2.0', resolved: `https://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz` } } });
    await expect(round({ 'package-lock.json': packageLock, '.npmrc': 'registry=https://npm.corp.example/\n' }).load('npm/left-pad')).rejects.toThrow(`${another} .npmrc sets the registry`);
    const berry = round({ 'yarn.lock': berryLock, '.yarnrc.yml': 'npmRegistryServer: "https://npm.corp.example"\n' });
    await expect(berry.load('npm/left-pad')).rejects.toThrow(`Manki does not read npm/left-pad: ${another} .yarnrc.yml sets the registry https://npm.corp.example.`);
    expect(dependencyOutcomes(berry.stateDir)).toEqual([expect.objectContaining({ package: 'npm/left-pad', status: 'refused' })]);
    const required = { 'web/package.json': JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }) };
    const npmrc = round({ ...required, '.npmrc': 'registry=https://npm.corp.example/\n' });
    await expect(npmrc.load('npm/left-pad')).rejects.toThrow(`Manki does not read npm/left-pad: ${another} .npmrc sets the registry`);
    expect(dependencyOutcomes(npmrc.stateDir)).toEqual([expect.objectContaining({ package: 'npm/left-pad', status: 'refused' })]);
    // Yarn 1 reads a `.yarnrc` with its own parser and `--registry` as a flag, so any registry line there refuses, even the public one.
    await expect(round({ ...required, 'web/.yarnrc': '"@corp:registry" "https://npm.corp.example"\nregistry "https://npm.corp.example"\n' }).load('npm/left-pad')).rejects.toThrow('web/.yarnrc sets `registry`, which Manki does not read with certainty in a Yarn 1 `.yarnrc`');
    for (const line of ['--registry "https://registry.npmjs.org/"', '--install.registry https://npm.corp.example', 'REGISTRY https://registry.yarnpkg.com', 'registry: "https://npm.corp.example"', 'registry:"https://npm.corp.example"', '"registry": https://npm.corp.example']) {
      await expect(round({ ...required, '.yarnrc': `${line}\n` }).load('npm/left-pad')).rejects.toThrow('which Manki does not read with certainty in a Yarn 1 `.yarnrc`');
    }
    // pnpm reads registries from its workspace settings too.
    await expect(round({ ...required, 'pnpm-workspace.yaml': 'registry: https://npm.corp.example/\n' }).load('npm/left-pad')).rejects.toThrow(`${another} pnpm-workspace.yaml sets the registry https://npm.corp.example/.`);
    await expect(round({ ...scopedRequired, 'pnpm-workspace.yaml': 'registries:\n  "@corp": https://npm.corp.example/\n' }).load('npm/@corp/pad')).rejects.toThrow(`${another} pnpm-workspace.yaml sets the registry https://npm.corp.example/ for @corp.`);
    await expect(round({ ...required, '.npmrc': 'REGISTRY=https://npm.corp.example/\n' }).load('npm/left-pad')).rejects.toThrow(`${another} .npmrc sets the registry`);
    // npm's `ini` drops single or double quotes around a key and any whitespace `trim` drops, and a comment after a value.
    for (const line of ["'registry' = https://npm.corp.example/", 'registry\v= https://npm.corp.example/', ' "registry"=https://npm.corp.example/ ; mirror']) {
      await expect(round({ ...required, '.npmrc': `${line}\n` }).load('npm/left-pad')).rejects.toThrow(`${another} .npmrc sets the registry https://npm.corp.example/.`);
    }
    await expect(round({ ...required, '.npmrc': "'package-lock' = false\n" }).load('npm/left-pad')).rejects.toThrow('.npmrc sets `package-lock`');
    await expect(round({ ...required, '.npmrc': 'x'.repeat(200) }, { maxManifestBytes: 100 }).load('npm/left-pad')).rejects.toThrow('Manki could not read .npmrc, which can change where packages come from, within its size limits.');
    // A line built to make a pattern backtrack is read in linear time.
    for (const [file, text] of [
      ['.npmrc', (n: number) => `"registry${'='.repeat(n)}\nregistry${' '.repeat(n)}=${' \\'.repeat(n)}a"b"c\n`],
      ['.yarnrc', (n: number) => `registry${' '.repeat(n)}a"b"c\n"registry${'='.repeat(n)}"\n`],
    ] as const) {
      await expectLinearTime(async (n) => {
        // The clock starts after `round` sets up the repository, so its `git` calls are not timed.
        const { load } = round({ ...required, [file]: text(n) });
        const started = performance.now();
        await expect(load('npm/left-pad')).rejects.toThrow(file === '.npmrc' ? `${another} ${file} sets the registry` : `${file} sets \`registry\``);
        return performance.now() - started;
      }, 100_000);
    }
    expect(server.requests).toEqual([]);

    const scoped = { 'package.json': JSON.stringify({ dependencies: { '@corp/pad': '^1.0.0' } }) };
    await expect(round({ ...scoped, '.npmrc': '@corp:registry=https://npm.corp.example/\n' }).load('npm/@corp/pad')).rejects.toThrow(`${another} .npmrc sets the registry https://npm.corp.example/ for @corp.`);
    expect(server.requests).toEqual([]);
    expect((await round(scoped).load('npm/@corp/pad')).key).toBe('npm/@corp/pad@1.0.0');
    expect(server.requests).toEqual(['/npm/@corp%2fpad', '/npm/@corp/pad/-/pad-1.0.0.tgz']);
    server.requests.length = 0;

    // Without such a setting, or with one for another scope only, the package is read from npm, checked against npm's checksum.
    expect((await round({ 'yarn.lock': berryLock }).load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
    expect((await round({ ...required, '.npmrc': '@corp:registry=https://npm.corp.example/\nregistry=https://registry.npmjs.org/\n' }).load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
  });

  it('refuses every package when `closed_paths` removed a file that can decide one, and reads it when only other files were removed', async () => {
    const berryLock = '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"left-pad@npm:^1.0.0":\n  version: 1.2.0\n  resolution: "left-pad@npm:1.2.0"\n  checksum: 10c0/abc\n  languageName: node\n  linkType: hard\n';
    const closed = async (files: Record<string, string>, patterns: string[]) => {
      const checkout = round({ 'yarn.lock': berryLock, 'Cargo.toml': '[dependencies]\ndemo = "1"\n', 'bench/cases/a.yml': 'case\n', ...files });
      await closePaths(checkout.repo, patterns);
      return checkout;
    };
    const removed = '`closed_paths` removed';
    // A closed setting that names another registry would otherwise read as absent, and npm's archive would be read.
    const npmrc = await closed({ '.npmrc': 'registry=https://npm.corp.example/\n' }, ['.npmrc']);
    await expect(npmrc.load('npm/left-pad')).rejects.toThrow(`Manki does not read npm/left-pad: ${removed} .npmrc from the checkout, and that path can decide which code the PR runs.`);
    expect(dependencyOutcomes(npmrc.stateDir)).toEqual([expect.objectContaining({ package: 'npm/left-pad', status: 'refused' })]);
    await expect((await closed({ 'Cargo.lock': cargoLock([{ version: '1.2.0' }]) }, ['*.lock'])).load('crates.io/demo')).rejects.toThrow(`${removed} Cargo.lock from`);
    await expect((await closed({ 'web/.yarnrc.yml': 'npmRegistryServer: "https://npm.corp.example"\n' }, ['web/**'])).load('npm/left-pad')).rejects.toThrow(`${removed} web/.yarnrc.yml from`);
    await expect((await closed({ '.cargo/config.toml': '[source.crates-io]\nreplace-with = "vendored"\n' }, ['.cargo'])).load('crates.io/demo')).rejects.toThrow(`${removed} .cargo/config.toml from`);
    // A committed copy the project runs in place of the archive refuses it too, closed as a file or as its folder.
    await expect((await closed({ 'node_modules/left-pad/index.js': 'patched\n' }, ['node_modules/**'])).load('npm/left-pad')).rejects.toThrow(`${removed} node_modules from`);
    await expect((await closed({ '.yarn/cache/left-pad-npm-1.2.0-abc.zip': 'zip\n' }, ['*.zip'])).load('npm/left-pad')).rejects.toThrow(`${removed} .yarn/cache from`);
    expect(server.requests).toEqual([]);

    // A closed submodule holds files no listing shows, so it refuses every package.
    const submodule = round({ 'yarn.lock': berryLock });
    git(submodule.repo, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/lib`);
    await closePaths(submodule.repo, ['vendor/**']);
    await expect(submodule.load('npm/left-pad')).rejects.toThrow(`Manki does not read npm/left-pad: ${removed} the git submodule vendor/lib from the checkout`);

    // Closing only files that decide no package leaves every package readable.
    const unrelated = await closed({}, ['bench/**']);
    expect((await unrelated.load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
    expect((await unrelated.load('crates.io/demo')).key).toBe('crates.io/demo@1.2.5');
    // A record of the closed paths that cannot be read may hide any of them, so it refuses every package.
    const unreadable = await closed({}, ['bench/**']);
    writeFileSync(join(unreadable.repo, '.git', 'manki-closed-paths.json'), '["bench/**"]');
    await expect(unreadable.load('npm/left-pad')).rejects.toThrow('Manki could not read which files `closed_paths` removed from the checkout');
  });

  it('reads a crate a plain `Cargo.toml` requires with no lockfile, and reads the forms of TOML it reads with certainty', async () => {
    const { load } = round({ 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ntime = "0.3"\n' });
    expect((await load('crates.io/time')).key).toBe('crates.io/time@0.3.47');
    const forms = [
      "[dependencies]\ndemo = '1.2'\n",
      '[dependencies]\n"d\\u0065mo" = "1.\\u0032"\n',
      '[dependencies]\ndemo.version = "1.2"\ndemo.features = [\n  "x", # a feature\n]\n',
      '[dependencies]\ndemo = "1.2" # don\'t bump\n',
      '[package]\ndescription = """\nUses [dependencies] and "demo = 2" \\\n  """"\nreadme = \'\'\'\nx\'\'\'\n[dependencies]\ndemo = "1.2"\n',
      "[target.'cfg(unix)'.dependencies]\ndemo = { version = \"1.2\", default-features = false }\n",
    ];
    for (const manifest of forms) expect((await round({ 'Cargo.toml': manifest }).load('crates.io/demo')).key).toBe('crates.io/demo@1.2.5');
    // Each operator of Cargo's requirements means what it means in Cargo, and a form Manki does not read is refused.
    for (const [requirement, version] of [['1.2.*', '1.2.5'], ['1.*', '1.2.5'], ['*', '2.0.0'], ['~1', '1.2.5'], ['~1.2.0', '1.2.5'], ['= 1.2.0', '1.2.0'], ['=1.2', '1.2.5'], ['>=1.2, <1.2.5', '1.2.0'], ['>1.2.0, <= 1.2.5', '1.2.5'], ['<2', '1.2.5'], ['^1.2.0', '1.2.5']]) {
      expect((await round({ 'Cargo.toml': `[dependencies]\ndemo = "${requirement}"\n` }).load('crates.io/demo')).key).toBe(`crates.io/demo@${version}`);
    }
    for (const requirement of ['1.*.*', '=1.2.*', '01.2', '1.2.x', 'x', '1.2 || 2', '>=1.2 <2', '1.2,']) {
      await expect(round({ 'Cargo.toml': `[dependencies]\ndemo = "${requirement}"\n` }).load('crates.io/demo')).rejects.toThrow(`Cargo.toml requires it as \`${requirement}\`, a form Manki does not read with certainty`);
    }
    for (const manifest of ['[dependencies]\ndemo = """1.2\n', '[dependencies]\ndemo = "1.2"\ndemo = "2"\n']) {
      await expect(round({ 'Cargo.toml': manifest }).load('crates.io/demo')).rejects.toThrow('Manki does not read crates.io/demo: Manki cannot read Cargo.toml with certainty: Invalid TOML document');
    }
    // A key that names an inherited property never reaches `Object.prototype`.
    for (const files of [{ 'Cargo.toml': '[__proto__]\npolluted = "x"\n[dependencies]\ndemo = "1.2"\n' }, { 'Cargo.toml': '[dependencies]\ndemo = "1.2"\n', '.cargo/config.toml': '[a.__proto__]\npolluted = "x"\n' }] as Array<Record<string, string>>) {
      await round(files).load('crates.io/demo').catch(() => undefined);
    }
    await round({ 'package.json': JSON.stringify({ dependencies: { 'left-pad': '1' } }), 'pnpm-workspace.yaml': '__proto__:\n  polluted: x\noverrides:\n  __proto__:\n    polluted: x\n' }).load('npm/left-pad');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Any manifest it cannot read refuses the crate, also beside a lockfile.
    const unrelated = { 'Cargo.toml': '[dependencies]\ndemo = "1.2"\n', 'other/Cargo.toml': '[package]\ndescription = "x" "y"\n' };
    await expect(round({ ...unrelated, 'Cargo.lock': cargoLock([{ version: '1.2.0' }]) }).load('crates.io/demo')).rejects.toThrow('Manki cannot read other/Cargo.toml with certainty: Invalid TOML document');
    await expect(round(unrelated).load('crates.io/demo')).rejects.toThrow('Manki cannot read other/Cargo.toml with certainty: Invalid TOML document');
  });

  it('refuses a package that a manifest or setting of the PR overrides, patches or replaces, also under a lockfile', async () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/left-pad': { version: '1.2.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz', integrity: sha512Integrity(PAD) } } });
    const manifest = (fields: object) => JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' }, ...fields });
    for (const [files, why] of [
      [{ 'package.json': manifest({ overrides: { parent: { 'left-pad': '1.0.0' } } }) }, 'package.json changes its code for an install: its `overrides` names it'],
      [{ 'package.json': manifest({ resolutions: { '**/left-pad': '1.0.0' } }) }, 'its `resolutions` names it'],
      [{ 'package.json': manifest({ pnpm: { overrides: { 'parent>left-pad@^1': '1.0.0' } } }) }, 'its `pnpm.overrides` names it'],
      [{ 'package.json': manifest({ pnpm: { patchedDependencies: { 'left-pad@1.2.0': 'patches/x.patch' } } }) }, 'its `pnpm.patchedDependencies` names it'],
      [{ 'package.json': manifest({}), 'pnpm-workspace.yaml': 'overrides:\n  left-pad: 1.0.0\n' }, 'pnpm-workspace.yaml overrides or patches it'],
      [{ 'package.json': manifest({}), '.pnpmfile.cjs': 'module.exports = {};\n' }, '.pnpmfile.cjs is a pnpm hook, which can change any package'],
      [{ 'package.json': manifest({}), 'patches/left-pad+1.2.0.patch': '' }, 'patches/left-pad+1.2.0.patch patches it after an install'],
      [{ 'package.json': manifest({}), 'patches/parent++left-pad+1.2.0.patch': '' }, 'patches/parent++left-pad+1.2.0.patch patches it'],
      [{ 'package.json': manifest({}), 'patches/@scope+parent+2.0.0++left-pad+1.2.0+001+fix.patch': '' }, 'patches it after an install'],
      [{ 'package.json': manifest({ patchedDependencies: { 'left-pad@1.2.0': 'patches/left-pad.patch' } }) }, 'its `patchedDependencies` names it'],
      [{ 'package.json': manifest({ scripts: { postinstall: 'node scripts/fix-modules.js' } }) }, 'its `postinstall` script runs at install and can change any installed package'],
      // The program behind a command's name can come from a dependency the PR picks, so no command passes by its name.
      [{ 'package.json': manifest({ scripts: { prepare: 'husky' } }) }, 'its `prepare` script runs at install'],
      [{ 'package.json': manifest({ scripts: { postinstall: 'patch-package' } }) }, 'its `postinstall` script runs at install'],
      [{ 'package.json': manifest({}), '.yarnrc.yml': 'plugins:\n  - path: .yarn/plugins/@yarnpkg/plugin-workspace-tools.cjs\n    spec: "@yarnpkg/plugin-workspace-tools"\n' }, '.yarnrc.yml sets `plugins`'],
      [{ 'package.json': manifest({}), 'packages/pad/package.json': JSON.stringify({ name: 'left-pad', version: '1.2.0' }) }, 'packages/pad/package.json changes its code for an install: it is a package of the checkout with that name'],
      [{ 'package.json': manifest({}), '.npmrc': 'package-lock=false\n' }, '.npmrc sets `package-lock`, so Manki cannot tell what an install runs or which lockfile it reads'],
      [{ 'package.json': manifest({}), '.npmrc': 'Package-Lock = false\n' }, '.npmrc sets `Package-Lock`'],
      [{ 'package.json': manifest({}), '.npmrc': 'pnpmfile = hooks/pnpm.cjs\n' }, '.npmrc sets `pnpmfile`'],
      [{ 'package.json': manifest({}), '.npmrc': 'lockfile-dir=../shared\n' }, '.npmrc sets `lockfile-dir`'],
      [{ 'package.json': manifest({}), '.yarnrc': '--install.no-lockfile true\n' }, '.yarnrc sets `--install.no-lockfile`'],
      [{ 'package.json': manifest({}), '.yarnrc': 'yarn-path ".yarn/releases/yarn-1.22.22.cjs"\n' }, '.yarnrc sets `yarn-path`'],
      [{ 'package.json': manifest({}), 'pnpm-workspace.yaml': 'pnpmfile: hooks.cjs\n' }, 'pnpm-workspace.yaml sets `pnpmfile`'],
      [{ 'package.json': manifest({}), 'pnpm-workspace.yaml': 'globalPnpmfile: hooks.cjs\n' }, 'pnpm-workspace.yaml sets `globalPnpmfile`'],
      [{ 'package.json': manifest({}), 'pnpm-workspace.yml': 'overrides:\n  left-pad: 1.0.0\n' }, 'pnpm-workspace.yml overrides or patches it'],
      [{ 'package.json': manifest({}), '.pnpmfile.js': 'module.exports = {};\n' }, '.pnpmfile.js is a pnpm hook'],
      [{ 'package.json': manifest({}), '.yarnrc.yml': 'lockfileFilename: other.lock\n' }, '.yarnrc.yml sets `lockfileFilename`'],
      [{ 'package.json': manifest({}), '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.5.0.cjs\n' }, '.yarnrc.yml sets `yarnPath`'],
      [{ 'package.json': manifest({ scripts: { 'pnpm:devPreinstall': 'node fix.js' } }) }, 'its `pnpm:devPreinstall` script runs at install'],
      [{ 'package.json': manifest({}), '.npmrc': 'shrinkwrap=false\n' }, '.npmrc sets `shrinkwrap`'],
      // npm reads `0` and `null` as off too, so any value but `true` turns the lockfile off.
      [{ 'package.json': manifest({}), '.npmrc': 'package-lock=0\n' }, '.npmrc sets `package-lock`'],
      [{ 'package.json': manifest({}), '.npmrc': 'lockfile=null\n' }, '.npmrc sets `lockfile`'],
      [{ 'package.json': manifest({}), 'pnpm-workspace.yaml': 'lockfile: 0\n' }, 'pnpm-workspace.yaml sets `lockfile`'],
      // Without pnpm's shared lockfile, each member of the workspace gets a lockfile of its own.
      [{ 'package.json': manifest({}), '.npmrc': 'shared-workspace-lockfile=false\n' }, '.npmrc sets `shared-workspace-lockfile`'],
      [{ 'package.json': manifest({}), 'pnpm-workspace.yaml': 'sharedWorkspaceLockfile: false\n' }, 'pnpm-workspace.yaml sets `sharedWorkspaceLockfile`'],
      [{ 'package.json': manifest({}), '.yarnrc.yml': 'cacheFolder: ./vendor/cache\n' }, '.yarnrc.yml sets `cacheFolder`'],
      [{ 'package.json': manifest({}), 'web/node_modules/left-pad/index.js': 'module.exports = 1;\n', 'web/package.json': manifest({}) }, 'the checkout holds web/node_modules/left-pad/index.js, a committed install, which the project can run in place of the archives npm publishes'],
      [{ 'package.json': manifest({}), '.yarn/cache/left-pad-npm-1.2.0-abc123-def456.zip': '' }, 'the checkout holds .yarn/cache/left-pad-npm-1.2.0-abc123-def456.zip, a committed install'],
      [{ 'package.json': manifest({}), '.yarnrc.yml': 'plugins:\n  - path: .yarn/plugins/fetch.cjs\n    spec: "https://example.com/fetch.js"\n' }, '.yarnrc.yml sets `plugins`'],
    ] as Array<[Record<string, string>, string]>) {
      await expect(round({ ...files, 'package-lock.json': lock }).load('npm/left-pad')).rejects.toThrow(why);
      const refused = round(files);
      await expect(refused.load('npm/left-pad')).rejects.toThrow(why);
      expect(dependencyOutcomes(refused.stateDir)).toEqual([expect.objectContaining({ package: 'npm/left-pad', status: 'refused' })]);
    }
    // A committed install of any package, in any folder, refuses every npm package, though crates stay readable.
    for (const path of ['tools/scripts/node_modules/other/index.js', 'lib/.yarn/cache/other-npm-1.0.0-abc.zip']) {
      await expect(round({ 'package.json': manifest({}), 'package-lock.json': lock, [path]: '' }).load('npm/left-pad')).rejects.toThrow(`the checkout holds ${path}, a committed install`);
    }
    expect((await round({ 'Cargo.lock': cargoLock([{ version: '1.2.0' }]), 'node_modules/other/index.js': '' }).load('crates.io/demo')).key).toBe('crates.io/demo@1.2.0');
    // An override or patch of another package, and a script that does not run at install, change nothing for this one.
    expect((await round({
      'package.json': manifest({ overrides: { 'left-pads': '1' }, resolutions: { 'other/left-pad-x': '1' }, scripts: { test: 'jest', build: 'tsc' } }),
      'patches/other+1.0.0.patch': '', 'patches/left-pad-extra+1.0.0.patch': '', 'patches/parent++left-pads+1.0.0.patch': '',
      '.npmrc': 'package-lock=true\n',
    }).load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');

    const cargo = '[dependencies]\ndemo = "1.2"\n';
    for (const [files, why] of [
      [{ 'Cargo.toml': `${cargo}\n[patch.crates-io]\ndemo = { path = "../demo" }\n` }, 'Cargo.toml changes its code for an install: its `[patch]` swaps the crate'],
      [{ 'Cargo.toml': `${cargo}\n[patch.crates-io.demo]\ngit = "https://example.com/demo"\n` }, 'its `[patch]` swaps the crate'],
      [{ 'Cargo.toml': `${cargo}\n[replace]\n"demo:1.2.5" = { path = "../demo" }\n` }, 'its `[replace]` swaps the crate'],
      [{ 'Cargo.toml': cargo, '.cargo/config.toml': '[patch.crates-io]\ndemo = { path = "../demo" }\n' }, '.cargo/config.toml patches the crate'],
      [{ 'Cargo.toml': cargo, '.cargo/config': '[source.crates-io]\nreplace-with = "vendored"\n[source.vendored]\ndirectory = "vendor"\n' }, '.cargo/config replaces the source of crates'],
      [{ 'Cargo.toml': cargo, '.cargo/config.toml': '[build]\nrustflags = "-C" "x"\n' }, 'Manki cannot read .cargo/config.toml with certainty'],
      [{ 'Cargo.toml': `${cargo}\n[patch.crates-io]\nforked = { package = "demo", path = "../demo" }\n` }, 'its `[patch]` swaps the crate'],
      [{ 'Cargo.toml': `${cargo}\n[replace]\n"https://github.com/rust-lang/crates.io-index#demo@1.2.5" = { path = "../demo" }\n` }, 'its `[replace]` swaps the crate'],
      [{ 'Cargo.toml': `${cargo}\n[replace]\n"https://example.com/#1.2.5" = { path = "../x" }\n` }, 'its `[replace]` swaps the crate'],
      [{ 'Cargo.toml': cargo, 'ws/.cargo/config.toml': 'paths = ["../demo"]\n' }, 'ws/.cargo/config.toml sets `paths`, which can change any crate'],
      [{ 'Cargo.toml': cargo, '.cargo/config.toml': 'include = "more.toml"\n' }, '.cargo/config.toml sets `include`'],
      [{ 'Cargo.toml': cargo, '.cargo/config.toml': '[source.crates-io]\nreplace_with = "mirror"\n' }, '.cargo/config.toml replaces the source of crates'],
      [{ 'Cargo.toml': cargo, '.cargo/config.toml': '[registry]\nindex = "https://mirror.example/index"\n' }, '.cargo/config.toml sets another index for crates.io'],
      [{ 'Cargo.toml': cargo, '.cargo/config': '[registries.crates-io]\nindex = "https://mirror.example/index"\n' }, '.cargo/config sets another index for crates.io'],
      [{ 'Cargo.toml': '[workspace]\nmembers = ["a"]\n\n[patch.crates-io]\ndemo = { path = "vendor/demo" }\n', 'a/Cargo.toml': cargo }, 'Cargo.toml changes its code for an install: its `[patch]` swaps the crate'],
      [{ 'Cargo.toml': '[dependencies]\ndemo = { version = "1.2", registry-index = "https://other.example/index" }\n' }, 'Cargo.toml does not take it from crates.io: its entry for the crate sets `registry-index`'],
      [{ 'Cargo.toml': '[dev_dependencies]\ndemo = { version = "1.2", registry = "corp" }\n' }, 'its entry for the crate sets `registry`'],
      [{ 'Cargo.toml': '[workspace.dependencies]\ndemo = { version = "1.2", path = "demo" }\n' }, 'its entry for the crate sets `path`'],
      [{ 'Cargo.toml': '[build-dependencies.demo]\nversion = "1.2"\nsource-url = "https://other.example"\n' }, 'its entry for the crate has the field `source-url`, which Manki does not know'],
    ] as Array<[Record<string, string>, string]>) {
      await expect(round({ ...files, 'Cargo.lock': cargoLock([{ version: '1.2.0' }]) }).load('crates.io/demo')).rejects.toThrow(why);
      await expect(round(files).load('crates.io/demo')).rejects.toThrow(why);
    }
    // Cargo's older spellings of the dependency tables count.
    expect((await round({ 'Cargo.toml': '[build_dependencies]\ndemo = { version = "1.2", default_features = false, features = ["x"] }\n' }).load('crates.io/demo')).key).toBe('crates.io/demo@1.2.5');
    for (const requirement of ['npm:other-pad@1.2.0', 'file:../pad', 'workspace:*', 'github:x/left-pad', 'latest']) {
      await expect(round({ 'package.json': JSON.stringify({ dependencies: { 'left-pad': requirement } }), 'package-lock.json': lock }).load('npm/left-pad'))
        .rejects.toThrow(`package.json does not take it from npm: its requirement \`${requirement}\` names no version from npm`);
    }
    expect((await round({ 'Cargo.toml': `${cargo}\n[patch.crates-io]\nother = { path = "../other" }\n\n[replace]\n"https://example.com/index#other:1.0.0" = { path = "x" }\n` }).load('crates.io/demo')).key).toBe('crates.io/demo@1.2.5');
  });

  it('reads the version a committed lockfile locks, else the one requirement of the manifests, and refuses what leaves it open', async () => {
    const required = (dir = '', requirement = '^1.0.0') => ({ [`${dir}package.json`]: JSON.stringify({ dependencies: { 'left-pad': requirement } }) });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/left-pad': { version: '1.2.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz', integrity: sha512Integrity(PAD) } } });
    // An install file Manki does not read, anywhere in the checkout, can decide what an install gets.
    for (const file of ['bun.lock', 'bun.lockb', 'bunfig.toml', 'deno.lock', 'deno.json', 'deno.jsonc', 'shrinkwrap.yaml', 'rush.json', 'vlt-lock.json', 'vlt.json', 'package.json5', 'package.yaml']) {
      const refused = round({ ...required(), [`tools/${file}`]: '' });
      await expect(refused.load('npm/left-pad')).rejects.toThrow(`Manki does not read npm/left-pad: the checkout holds tools/${file}, which Manki does not read and which can decide what an install gets.`);
      expect(dependencyOutcomes(refused.stateDir)).toEqual([expect.objectContaining({ package: 'npm/left-pad', status: 'refused' })]);
      await expect(round({ 'package-lock.json': lock, [file]: '' }).load('npm/left-pad')).rejects.toThrow(`the checkout holds ${file}`);
    }
    // A committed lockfile decides, in any folder, as long as its version meets every requirement a manifest states.
    expect((await round({ ...required('apps/web/'), 'tools/package-lock.json': lock }).load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
    expect((await round({ 'Cargo.toml': '[dependencies]\ndemo = "1"\n', 'a/Cargo.lock': cargoLock([{ version: '1.2.0' }]) }).load('crates.io/demo')).key).toBe('crates.io/demo@1.2.0');
    // An install drops a locked version a requirement no longer allows, as Cargo's caret default and npm's ranges read it.
    for (const [files, spec, requirement] of [
      [{ 'Cargo.toml': '[dependencies]\ndemo = "1.3"\n', 'Cargo.lock': cargoLock([{ version: '1.2.0' }]) }, 'crates.io/demo', '1.3'],
      [{ 'Cargo.toml': '[dependencies]\ndemo = "1.2"\n', 'a/Cargo.lock': cargoLock([{ version: '2.0.0' }]) }, 'crates.io/demo', '1.2'],
      [{ ...required('', '^2.0.0'), 'package-lock.json': lock }, 'npm/left-pad', '^2.0.0'],
    ] as Array<[Record<string, string>, string, string]>) {
      const stale = round(files);
      await expect(stale.load(spec)).rejects.toThrow(`requires it as \`${requirement}\`, which the locked version`);
      expect(dependencyOutcomes(stale.stateDir)).toEqual([expect.objectContaining({ status: 'refused', source: 'requirement', requirement })]);
    }
    await expect(round({ 'Cargo.toml': '[dependencies]\ndemo = "1.*.2"\n', 'Cargo.lock': cargoLock([{ version: '1.2.0' }]) }).load('crates.io/demo')).rejects.toThrow('requires it as `1.*.2`, a form Manki does not read with certainty');
    // The version a call names must meet every requirement too, also when another locked version does.
    const both = { 'Cargo.toml': '[dependencies]\ndemo = "2"\n', 'Cargo.lock': cargoLock([{ version: '1.2.0' }, { version: '2.0.0' }]) };
    const named = round(both);
    await expect(named.load('crates.io/demo')).rejects.toThrow('its lockfiles lock several versions');
    await expect(named.load('crates.io/demo@1.2.0')).rejects.toThrow('requires it as `2`, which the locked version 1.2.0 does not meet');
    // The refusal of the named version keeps its own record next to the refusal of the package as a whole.
    expect(dependencyOutcomes(named.stateDir)).toEqual([
      expect.objectContaining({ package: 'crates.io/demo@1.2.0', version: '1.2.0', source: 'requirement', status: 'refused', reason: expect.stringContaining('does not meet') }),
      expect.objectContaining({ package: 'crates.io/demo', status: 'refused', reason: expect.stringContaining('several versions') }),
    ]);
    expect((await round(both).load('crates.io/demo@2.0.0')).key).toBe('crates.io/demo@2.0.0');
    // One that does not lock the package leaves its requirement to decide.
    expect((await round({ 'Cargo.toml': '[dependencies]\ndemo = "1.2"\n', 'Cargo.lock': '[[package]]\nname = "other"\nversion = "1.0.0"\n' }).load('crates.io/demo')).key).toBe('crates.io/demo@1.2.5');
    // Without a lockfile, the manifests must state one requirement, though several may state it.
    expect((await round({ ...required(), ...required('web/') }).load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
    const several = round({ ...required(), ...required('web/', '~1.2.0') });
    await expect(several.load('npm/left-pad')).rejects.toThrow('the PR\'s manifests require it as `^1.0.0` in package.json, `~1.2.0` in web/package.json, and without a lockfile Manki cannot tell which an install follows.');
    expect(dependencyOutcomes(several.stateDir)).toEqual([expect.objectContaining({ package: 'npm/left-pad', source: 'requirement', status: 'refused' })]);
    await expect(round({ 'Cargo.toml': '[dependencies]\ndemo = "1.2"\n', 'a/Cargo.toml': '[dependencies]\ndemo = "1.3"\n' }).load('crates.io/demo')).rejects.toThrow('`1.2` in Cargo.toml, `1.3` in a/Cargo.toml');

    // A setting that changes what a fresh install picks refuses a requirement, and leaves a locked version alone.
    for (const [file, text] of [['.npmrc', 'before=2020-01-01\n'], ['.npmrc', 'resolution-mode=lowest-direct\n'], ['.npmrc', 'min-release-age=7\n'], ['.npmrc', 'tag=next\n'], ['.npmrc', 'minimum-release-age=1440\n'], ['pnpm-workspace.yaml', 'minimumReleaseAge: 1440\n'], ['.yarnrc.yml', 'npmMinimalAgeGate: 3d\n']]) {
      await expect(round({ ...required(), [file]: text }).load('npm/left-pad')).rejects.toThrow(`${file} sets \``);
      expect((await round({ ...required(), 'package-lock.json': lock, [file]: text }).load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
    }
    const cargo = (pkg: string) => `[package]\nname = "app"\n${pkg}\n[dependencies]\ndemo = "1.2"\n`;
    await expect(round({ 'Cargo.toml': cargo('edition = "2024"\nrust-version = "1.85"\n') }).load('crates.io/demo'))
      .rejects.toThrow('Cargo.toml sets `rust-version` and Cargo.toml lets Cargo pick by it, so a fresh install may pick an older version.');
    // The `rust-version` and the resolver that reads it can sit in different files of one workspace.
    await expect(round({ 'Cargo.toml': '[workspace]\nmembers = ["a"]\nresolver = "3"\n', 'a/Cargo.toml': cargo('rust-version = "1.80"\n') }).load('crates.io/demo')).rejects.toThrow('a/Cargo.toml sets `rust-version` and Cargo.toml lets');
    await expect(round({ 'Cargo.toml': cargo('rust-version = "1.80"\n'), '.cargo/config.toml': '[resolver]\nincompatible-rust-versions = "fallback"\n' }).load('crates.io/demo')).rejects.toThrow('and .cargo/config.toml lets Cargo pick by it');
    expect((await round({ 'Cargo.toml': cargo('edition = "2021"\nrust-version = "1.80"\n') }).load('crates.io/demo')).key).toBe('crates.io/demo@1.2.5');
  });

  it('resolves a package once per round, and takes an empty deprecation as none', async () => {
    const { repo, stateDir, load } = round({ 'package.json': JSON.stringify({ dependencies: { undeprecated: '^1.0.0' } }) });
    expect((await load('npm/undeprecated')).key).toBe('npm/undeprecated@1.1.0');
    await load('npm/undeprecated');
    // Another tool server of the round reuses the resolution and the fetched archive.
    await dependencyLoader(repo, stateDir, { registries, caseSensitive })('npm/undeprecated');
    expect(server.requests).toEqual(['/npm/undeprecated', '/npm/undeprecated/-/undeprecated-1.1.0.tgz']);
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

    const lockOf = (name: string) => ({ 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${name}`]: { version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity: sha512Integrity(PAD) } } }) });
    const moved = round(lockOf('moved'));
    await expect(moved.load('npm/moved')).rejects.toThrow('could not be fetched, so it cannot be read: download of');
    expect(server.requests).toEqual(['/dl/crates/demo/demo-1.2.0.crate', '/npm/moved/-/moved-1.0.0.tgz']);
    // A redirect is refused for the round, while a registry error that may pass leaves the package to a later call.
    await expect(moved.load('npm/moved')).rejects.toThrow('failed with HTTP 302');
    expect(server.requests).toHaveLength(2);
    const flaky = round(lockOf('flaky'));
    await expect(flaky.load('npm/flaky')).rejects.toThrow('failed with HTTP 503');
    expect(dependencyOutcomes(flaky.stateDir)).toEqual([expect.objectContaining({ package: 'npm/flaky@1.0.0', status: 'failed', reason: expect.stringContaining('failed with HTTP 503, and no later call fetched it') })]);
    expect((await flaky.load('npm/flaky')).key).toBe('npm/flaky@1.0.0');
    expect(dependencyOutcomes(flaky.stateDir)).toEqual([expect.objectContaining({ package: 'npm/flaky@1.0.0', status: 'fetched' })]);

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

    // A call that takes over the fetch of a tool server that stopped counts that package against the cap too.
    const other = round({ 'Cargo.lock': cargoLock([{ version: '1.2.0' }, { version: '2.0.0' }]) }, { maxPackages: 1 });
    await other.load('crates.io/demo@1.2.0');
    writeFileSync(join(other.stateDir, 'dependencies', `${encodeURIComponent('crates.io/demo@2.0.0')}.lock`), String(spawnSync('true').pid));
    await expect(other.load('crates.io/demo@2.0.0')).rejects.toThrow('the round already read 1 packages');
  });

  it('gives the fetch of an archive its own time, and keeps the whole call within its limit', async () => {
    const required = { 'package.json': JSON.stringify({ dependencies: { slowpad: '1' } }) };
    // The version list and the archive each take a second, longer together than the time one request may take.
    expect((await round(required, { timeoutMs: 1500 }).load('npm/slowpad')).key).toBe('npm/slowpad@1.0.0');

    // A slow version list leaves too little of the call for the archive's whole time, so the fetch waits for the next
    // call, which reuses the resolution and starts with the whole call ahead.
    const short = round(required, { timeoutMs: 1_500, callLimitMs: 4_000 });
    await expect(short.load('npm/slowpad')).rejects.toThrow('Manki resolved npm/slowpad@1.0.0, but this call has too little time left to fetch it. Name it again in your next call.');
    expect(dependencyOutcomes(short.stateDir)).toEqual([]);
    expect((await short.load('npm/slowpad')).key).toBe('npm/slowpad@1.0.0');

    // A fetch that runs out of time leaves the package to a later call, which fetches it with the whole time again.
    const locked = { 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/slowpad': { version: '1.0.0', resolved: 'https://registry.npmjs.org/slowpad/-/slowpad-1.0.0.tgz', integrity: sha512Integrity(PAD) } } }) };
    const timedOut = round(locked, { timeoutMs: 500 });
    await expect(timedOut.load('npm/slowpad')).rejects.toThrow('did not finish within 0.5 seconds');
    expect(dependencyOutcomes(timedOut.stateDir)).toEqual([expect.objectContaining({ package: 'npm/slowpad@1.0.0', status: 'failed', reason: expect.stringContaining('did not finish within 0.5 seconds, and no later call fetched it') })]);
    expect((await dependencyLoader(timedOut.repo, timedOut.stateDir, { registries, caseSensitive, timeoutMs: 1_500 })('npm/slowpad')).key).toBe('npm/slowpad@1.0.0');
    expect(dependencyOutcomes(timedOut.stateDir)).toEqual([expect.objectContaining({ package: 'npm/slowpad@1.0.0', status: 'fetched' })]);

    // A version list that could not be read in time is retried, and the round records only the read that followed.
    const unresolved = round(required, { timeoutMs: 300 });
    await expect(unresolved.load('npm/slowpad')).rejects.toThrow('could not read the published versions of npm/slowpad');
    expect(dependencyOutcomes(unresolved.stateDir)).toEqual([expect.objectContaining({ package: 'npm/slowpad', status: 'failed' })]);
    expect((await dependencyLoader(unresolved.repo, unresolved.stateDir, { registries, caseSensitive, timeoutMs: 1_500 })('npm/slowpad')).key).toBe('npm/slowpad@1.0.0');
    expect(dependencyOutcomes(unresolved.stateDir)).toEqual([expect.objectContaining({ package: 'npm/slowpad@1.0.0', status: 'fetched' })]);

    // Another tool server of this process holds the package and never finishes. The wait ends once the call, counted
    // from its start, reaches its limit less the slack, so the second spent on the version list counts.
    const waiting = round(required, { timeoutMs: 1_500, callLimitMs: 5_000 });
    writeFileSync(join(waiting.stateDir, 'dependencies', `${encodeURIComponent('npm/slowpad@1.0.0')}.lock`), String(process.pid));
    const started = Date.now();
    await expect(waiting.load('npm/slowpad')).rejects.toThrow('npm/slowpad@1.0.0 is not fetched yet');
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 60_000);

  it('holds each read of a registry and of the checkout to its cap', async () => {
    const slow = round({ 'Cargo.toml': '[dependencies]\nslow = "1"\n' }, { timeoutMs: 300 });
    await expect(slow.load('crates.io/slow')).rejects.toThrow('did not finish within 0.3 seconds');
    expect(dependencyOutcomes(slow.stateDir)).toEqual([expect.objectContaining({ package: 'crates.io/slow', status: 'failed', reason: expect.stringContaining('did not finish') })]);

    const small = [cratesIo({ index: `${server.origin}/index`, download: `${server.origin}/dl`, maxIndexBytes: 100 }), npmRegistry(`${server.origin}/npm`, 100)];
    await expect(round({ 'Cargo.toml': '[dependencies]\ndemo = "1"\n' }, { registries: small }).load('crates.io/demo')).rejects.toThrow('is larger than');
    await expect(round({ 'package.json': JSON.stringify({ dependencies: { 'left-pad': '1' } }) }, { registries: small }).load('npm/left-pad')).rejects.toThrow('is larger than');

    const lock = cargoLock([{ version: '1.2.0' }]);
    await expect(round({ 'Cargo.lock': lock }, { maxManifestBytes: 100 }).load('crates.io/demo')).rejects.toThrow('Manki could not read Cargo.lock, which can lock it, within its size limits.');
    const total = round({ 'a/Cargo.lock': '[[package]]\nname = "other"\nversion = "1.0.0"\n'.repeat(4), 'b/Cargo.lock': lock }, { maxManifestTotalBytes: lock.length + 50 });
    await expect(total.load('crates.io/demo')).rejects.toThrow('Manki could not read b/Cargo.lock, which can lock it');

    // Build output is never listed, and files that are no lockfile or manifest take no place in the listing.
    const apps = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`apps/f${i}.txt`, '']));
    const listed = round({ ...apps, 'target/Cargo.lock': lock, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/left-pad': { version: '1.2.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz', integrity: sha512Integrity(PAD) } } }) }, { maxListed: 1 });
    expect((await listed.load('npm/left-pad')).key).toBe('npm/left-pad@1.2.0');
    // Only Cargo builds into `target`, so an npm manifest there is the project's own and can refuse the package.
    const member = round({ 'packages/target/package.json': JSON.stringify({ name: 'left-pad' }), 'package.json': JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }) });
    await expect(member.load('npm/left-pad')).rejects.toThrow('packages/target/package.json');
    // A listing past its cap may have missed a lockfile or setting, so it refuses every package, also one a listed lockfile locks.
    const many = round({ 'a/Cargo.lock': lock, 'b/Cargo.lock': lock }, { maxListed: 1 });
    await expect(many.load('crates.io/demo@1.2.0')).rejects.toThrow('the checkout holds more than 1 lockfiles, manifests and settings files, the most Manki lists');
    expect(dependencyOutcomes(many.stateDir)).toEqual([expect.objectContaining({ package: 'crates.io/demo', status: 'refused' })]);
    // Past the lockfiles Manki reads of a checkout, one it does not read may lock the package.
    const locks = round(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`m${i}/Cargo.lock`, lock])));
    await expect(locks.load('crates.io/demo')).rejects.toThrow('Manki does not read crates.io/demo: the checkout holds 51 lockfiles, more than the 50 Manki reads.');
    // Only the files git tracks are the PR's, and a checkout git cannot list refuses every package.
    const untracked = round({});
    writeFileSync(join(untracked.repo, 'Cargo.lock'), lock);
    await expect(untracked.load('crates.io/demo')).rejects.toThrow('is not a dependency');
    rmSync(join(untracked.repo, '.git'), { recursive: true });
    const unlisted = dependencyLoader(untracked.repo, untracked.stateDir, { registries, caseSensitive });
    await expect(unlisted('crates.io/demo')).rejects.toThrow('Manki does not read crates.io/demo: Manki could not list the files of the checkout');
  });
});

describe('pickVersion', () => {
  it('picks what a fresh install picks', () => {
    const versions = [{ version: '1.0.0', checksum: 'a' }, { version: '1.1.0', checksum: 'b', deprecated: true as const }, { version: '1.2.0-rc.1', checksum: 'c' }];
    expect(pickVersion(versions, '^1.0.0')?.version).toBe('1.0.0');
    expect(pickVersion(versions.slice(1), '^1.0.0')?.version).toBe('1.1.0');
    expect(pickVersion(versions, '^1.2.0-rc.0')?.version).toBe('1.2.0-rc.1');
    expect(pickVersion([{ version: '1.0.0', checksum: 'a', yanked: true }], '^1.0.0')).toBeUndefined();
    // A version reaches the key only as semver spells it.
    expect(pickVersion([{ version: 'v1.0.0', checksum: 'a' }, { version: ' 1.0.1', checksum: 'b' }, { version: 'v1.0.2+b', checksum: 'c' }], '^1.0.0')).toBeUndefined();
    // Build metadata stays part of the version, and a version with it is picked like any other.
    expect(pickVersion([{ version: '0.10.0', checksum: 'a' }, { version: '0.11.0+wasi-snapshot-preview1', checksum: 'b' }], '>=0.10')?.version).toBe('0.11.0+wasi-snapshot-preview1');
    // The version marked `latest` wins when it matches and is not deprecated.
    const tagged = [...versions, { version: '1.3.0', checksum: 'd' }];
    expect(pickVersion(tagged, '^1.0.0', '1.0.0')?.version).toBe('1.0.0');
    expect(pickVersion(tagged, '^1.0.0', '1.1.0')?.version).toBe('1.3.0');
    expect(pickVersion(tagged, '^1.0.0', '2.0.0')?.version).toBe('1.3.0');
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
