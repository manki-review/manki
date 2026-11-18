import { validRange } from 'semver';

import { shown } from './shown';
import { parseTomlSubset, tableOf, TomlTable } from './toml';
import { ManifestFacts, PublishedVersion, Registry, RegistryConfig, Requirement } from './types';

/** The hosts of crates.io: its sparse index, and the host its archives are served from. */
const CRATES_IO = { index: 'https://index.crates.io', download: 'https://static.crates.io' };

/** The sources a `Cargo.lock` names crates.io by, through its git index or its sparse index. */
const CRATES_IO_SOURCES = ['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/'];

/** The most bytes of a crate's index file. The largest list thousands of versions in a few MB. */
const MAX_INDEX_BYTES = 20 * 1024 * 1024;

const normalize = (name: string): string => name.toLowerCase().replace(/-/g, '_');

/** The Cargo config files of a checkout, which can patch a crate or replace the source of every crate. */
const CARGO_CONFIGS = /(?:^|\/)\.cargo\/config(?:\.toml)?$/;

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

const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Returns the crate a `[replace]` key names, or `undefined` when Manki cannot tell. The key is a package ID spec:
 * `name`, `name:version` or `name@version`, optionally after a source URL and `#`, or a URL whose last segment is the
 * name, followed by `#version`.
 */
function replacedCrate(spec: string): string | undefined {
  const hash = spec.lastIndexOf('#');
  const fragment = spec.slice(hash + 1);
  const named = /^[0-9]/.test(fragment) && hash >= 0 ? spec.slice(0, hash).split('/').at(-1) ?? '' : fragment.split(/[:@]/)[0];
  return CRATE_NAME.test(named) ? named : undefined;
}

/**
 * Returns what a `Cargo.toml` says of the crate `name`: each requirement it states from crates.io, whether `[patch]`
 * or `[replace]` swaps the crate, whether a `rust-version` can make a fresh install pick an older version, and whether
 * a workspace root elsewhere locks its versions. A dependency from a path, a git repository or another registry has no
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
  const replacedNames = Object.keys(tableOf(manifest.replace)).map(replacedCrate);
  const replaced = replacedNames.some(crate => crate === undefined || normalize(crate) === normalize(name));
  const root = tableOf(manifest.package).workspace;
  return {
    requirements,
    ...((patched || replaced) && { overridden: `its \`[${patched ? 'patch' : 'replace'}]\` swaps the crate` }),
    ...(typeof root === 'string' && { lockedElsewhere: 'its `package.workspace` names a workspace root elsewhere, whose lockfile decides its versions' }),
  };
}

/**
 * Returns which of `files` lets Cargo pick an older version than the highest a requirement allows: a `rust-version`
 * together with the resolver that honours it, from edition 2024, `resolver = "3"` or a Cargo config's
 * `incompatible-rust-versions`. The setting and the `rust-version` can sit in different manifests of one workspace.
 */
function cargoFreshPick(files: readonly RegistryConfig[]): string | undefined {
  let rustVersion: string | undefined;
  let resolver: string | undefined;
  for (const { file, text } of files) {
    let toml: TomlTable;
    try {
      toml = parseTomlSubset(text);
    } catch (error) {
      throw new Error(`Manki cannot read ${file} with certainty: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (CARGO_CONFIGS.test(file)) {
      if (Object.hasOwn(tableOf(toml.resolver), 'incompatible-rust-versions')) resolver ??= file;
      continue;
    }
    const pkg = tableOf(toml.package);
    const workspace = tableOf(toml.workspace);
    const shared = tableOf(workspace.package);
    if (Object.hasOwn(pkg, 'rust-version') || Object.hasOwn(shared, 'rust-version')) rustVersion ??= file;
    if ([pkg.edition, shared.edition].includes('2024') || [pkg.resolver, workspace.resolver].includes('3')) resolver ??= file;
  }
  return rustVersion && resolver ? `${shown(rustVersion)} sets \`rust-version\` and ${shown(resolver)} lets Cargo pick by it, so a fresh install may pick an older version` : undefined;
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

/** crates.io, the registry of Rust crates. A crate of another registry names it in `Cargo.toml`, so it states no requirement from crates.io. */
export function cratesIo({ index = CRATES_IO.index, download = CRATES_IO.download, maxIndexBytes = MAX_INDEX_BYTES } = {}): Registry {
  return {
    id: 'crates.io',
    origins: [new URL(index).origin, new URL(download).origin],
    manifests: ['Cargo.toml'],
    lockfiles: ['Cargo.lock'],
    validName: name => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name),
    sameName: (a, b) => normalize(a) === normalize(b),
    unreadInstallFiles: [],
    isRegistrySource: source => source !== undefined && CRATES_IO_SOURCES.includes(source),
    namesHost: () => true,
    isConfigFile: path => CARGO_CONFIGS.test(path),
    otherRegistry: () => undefined,
    overriddenBy(name, configs) {
      for (const { file, text } of configs) {
        const config = parseTomlSubset(text);
        // A replaced source serves every crate from elsewhere, such as a vendored folder whose files can differ.
        if (Object.values(tableOf(config.source)).some(source => Object.hasOwn(tableOf(source), 'replace-with'))) return `${shown(file)} replaces the source of crates`;
        // `paths` builds local copies of any crate they hold, and `include` reads settings from another file.
        const key = ['paths', 'include'].find(k => Object.hasOwn(config, k));
        if (key) return `${shown(file)} sets \`${key}\`, which can change any crate`;
        if (cargoManifest(text, name).overridden) return `${shown(file)} patches the crate`;
      }
      return undefined;
    },
    freshPick: cargoFreshPick,
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
