import { validRange } from 'semver';

import { parseTomlSubset, tableOf, TomlTable } from './toml';
import { ManifestFacts, PublishedVersion, Registry, Requirement } from './types';

/** The hosts of crates.io: its sparse index, and the host its archives are served from. */
const CRATES_IO = { index: 'https://index.crates.io', download: 'https://static.crates.io' };

/** The sources a `Cargo.lock` names crates.io by, through its git index or its sparse index. */
const CRATES_IO_SOURCES = ['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/'];

/** The most bytes of a crate's index file. The largest list thousands of versions in a few MB. */
const MAX_INDEX_BYTES = 20 * 1024 * 1024;

const normalize = (name: string): string => name.toLowerCase().replace(/-/g, '_');

/** The tables of a manifest that list dependencies, each under one of these names. */
const DEPENDENCY_TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies'];

/** Returns the path of a crate's file in the crates.io index, which files a crate by the length and start of its name. */
function indexPath(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

/** Returns each dependency table of a parsed `Cargo.toml`: the plain ones, those of each target, and the workspace's. */
function dependencyTables(manifest: TomlTable): TomlTable[] {
  const of = (table: TomlTable) => DEPENDENCY_TABLES.map(name => tableOf(table[name]));
  return [...of(manifest), ...Object.values(tableOf(manifest.target)).flatMap(target => of(tableOf(target))), tableOf(tableOf(manifest.workspace).dependencies)];
}

/** The crate an entry of a dependency or `[patch]` table names: its `package` when it renames one, else its key. */
function crateOf(key: string, entry: unknown): string {
  const renamed = tableOf(entry as TomlTable).package;
  return typeof renamed === 'string' ? renamed : key;
}

/**
 * Returns what a `Cargo.toml` says of the crate `name`: each requirement it states from crates.io, and whether
 * `[patch]` or `[replace]` swaps the crate. A dependency from a path, a git repository or another registry has no
 * requirement from crates.io, and one that inherits its entry from `[workspace.dependencies]` is stated there.
 */
function cargoManifest(text: string, name: string): ManifestFacts {
  const manifest = parseTomlSubset(text);
  const requirements = dependencyTables(manifest).flatMap(table => Object.entries(table).flatMap(([key, entry]): Requirement[] => {
    if (normalize(crateOf(key, entry)) !== normalize(name)) return [];
    if (typeof entry === 'string') return [{ name: key, requirement: entry }];
    const fields = tableOf(entry);
    if (['path', 'git', 'registry', 'workspace'].some(field => Object.hasOwn(fields, field)) || typeof fields.version !== 'string') return [];
    return [{ name: crateOf(key, entry), requirement: fields.version }];
  }));
  const patched = Object.values(tableOf(manifest.patch)).some(source => Object.entries(tableOf(source)).some(([key, entry]) => normalize(crateOf(key, entry)) === normalize(name)));
  // A `[replace]` key names a crate and its version, as `name:1.0.0`.
  const replaced = Object.keys(tableOf(manifest.replace)).some(key => normalize(key.split(':')[0]) === normalize(name));
  return { requirements, ...((patched || replaced) && { overridden: `its \`[${patched ? 'patch' : 'replace'}]\` swaps the crate` }) };
}

/**
 * Turns a Cargo requirement into an npm semver range. A bare version means `^` in Cargo and the exact version in npm,
 * and Cargo joins its parts with commas where npm uses spaces.
 */
function cargoRange(requirement: string): string | undefined {
  const parts = requirement.split(',').map(p => p.trim());
  if (parts.some(p => !p)) return undefined;
  const range = parts.map(p => (/^\d/.test(p) ? `^${p}` : p)).join(' ');
  return validRange(range) ? range : undefined;
}

/** The Cargo config files of a checkout, which can patch a crate or replace the source of every crate. */
const CARGO_CONFIGS = /(?:^|\/)\.cargo\/config(?:\.toml)?$/;

/** crates.io, the registry of Rust crates. A crate of another registry names it in `Cargo.toml`, so it states no requirement from crates.io. */
export function cratesIo({ index = CRATES_IO.index, download = CRATES_IO.download, maxIndexBytes = MAX_INDEX_BYTES } = {}): Registry {
  return {
    id: 'crates.io',
    origins: [new URL(index).origin, new URL(download).origin],
    manifests: ['Cargo.toml'],
    lockfiles: ['Cargo.lock'],
    validName: name => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name),
    sameName: (a, b) => normalize(a) === normalize(b),
    isRegistrySource: source => source !== undefined && CRATES_IO_SOURCES.includes(source),
    namesHost: () => true,
    isConfigFile: path => CARGO_CONFIGS.test(path),
    otherRegistry: () => undefined,
    overriddenBy(name, configs) {
      for (const { file, text } of configs) {
        const config = parseTomlSubset(text);
        // A replaced source serves every crate from elsewhere, such as a vendored folder whose files can differ.
        if (Object.values(tableOf(config.source)).some(source => Object.hasOwn(tableOf(source), 'replace-with'))) return `${file} replaces the source of crates`;
        if (cargoManifest(text, name).overridden) return `${file} patches the crate`;
      }
      return undefined;
    },
    manifest: cargoManifest,
    range: cargoRange,
    async published(name, fetch) {
      const lines = (await fetch(`${index}/${indexPath(name)}`, maxIndexBytes)).toString('utf8').split('\n').filter(Boolean);
      let own = name;
      const versions = lines.flatMap((line): PublishedVersion[] => {
        const entry = JSON.parse(line) as { name?: unknown; vers?: unknown; cksum?: unknown; yanked?: unknown };
        if (typeof entry.vers !== 'string' || typeof entry.cksum !== 'string') return [];
        if (typeof entry.name === 'string') own = entry.name;
        return [{ version: entry.vers, checksum: entry.cksum, ...(entry.yanked === true && { yanked: true as const }) }];
      });
      return { name: own, versions };
    },
    archiveUrl: (name, version) => `${download}/crates/${encodeURIComponent(name)}/${encodeURIComponent(`${name}-${version}`)}.crate`,
  };
}
