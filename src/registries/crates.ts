import { minimatch } from 'minimatch';
import { posix } from 'path';
import { validRange } from 'semver';
import { parse } from 'smol-toml';

import { shown } from './shown';
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
const DEPENDENCY_TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies', 'dev_dependencies', 'build_dependencies'];

/** The fields of a dependency entry that take the crate from somewhere other than crates.io. */
const OTHER_SOURCES = ['path', 'git', 'registry', 'registry-index', 'registry_index'];

/** The other fields of a dependency entry Manki knows, none of which changes where the crate comes from. */
const ENTRY_FIELDS = new Set(['version', 'features', 'optional', 'default-features', 'default_features', 'package', 'public', 'artifact', 'lib', 'target', 'branch', 'tag', 'rev']);

type TomlTable = Record<string, unknown>;

/** Returns `value` when it is a TOML table, else an empty one. */
function tableOf(value: unknown): TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) ? value as TomlTable : {};
}

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
  const renamed = tableOf(entry).package;
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
 * Returns what a `Cargo.toml` says of the crate `name`: each requirement it states from crates.io, and whether
 * `[patch]` or `[replace]` swaps the crate. An entry that inherits from `[workspace.dependencies]` is stated there.
 * One from a path, a git repository or another registry, or with a field Manki does not know, sets `otherSource`.
 */
function cargoManifest(text: string, name: string): ManifestFacts {
  const manifest = parse(text);
  let otherSource: string | undefined;
  const requirements = dependencyTables(manifest).flatMap(table => Object.entries(table).flatMap(([key, entry]): Requirement[] => {
    if (normalize(crateOf(key, entry)) !== normalize(name)) return [];
    if (typeof entry === 'string') return [{ name: key, requirement: entry }];
    const fields = tableOf(entry);
    if (Object.hasOwn(fields, 'workspace')) return [];
    const source = OTHER_SOURCES.find(field => Object.hasOwn(fields, field));
    const unknown = Object.keys(fields).find(field => !OTHER_SOURCES.includes(field) && !ENTRY_FIELDS.has(field));
    if (source || unknown || typeof fields.version !== 'string') {
      otherSource ??= source ? `its entry for the crate sets \`${source}\``
        : unknown ? `its entry for the crate has the field \`${shown(unknown)}\`, which Manki does not know` : 'its entry for the crate states no version';
      return [];
    }
    return [{ name: crateOf(key, entry), requirement: fields.version }];
  }));
  const patched = Object.values(tableOf(manifest.patch)).some(source => Object.entries(tableOf(source)).some(([key, entry]) => normalize(crateOf(key, entry)) === normalize(name)));
  const replacedNames = Object.keys(tableOf(manifest.replace)).map(replacedCrate);
  const replaced = replacedNames.some(crate => crate === undefined || normalize(crate) === normalize(name));
  return {
    requirements,
    ...(otherSource && { otherSource }),
    ...((patched || replaced) && { overridden: `its \`[${patched ? 'patch' : 'replace'}]\` swaps the crate` }),
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
      toml = parse(text);
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

/** How Cargo's `glob` crate matches the `members` of a workspace: no braces, no extglobs, and `*` matches a leading dot. */
const MEMBER_GLOB = { dot: true, nobrace: true, noext: true, nonegate: true, nocomment: true };

/**
 * Returns the `Cargo.lock` files of `files`, the files git tracks, that Cargo ignores: each one in the folder of a member
 * of a workspace whose root holds a `Cargo.lock` of its own, which every member builds against. `read` returns the text
 * of a tracked `Cargo.toml`, or `undefined` when it cannot be read. A lockfile Manki cannot place for certain is kept.
 */
export function ignoredMemberLockfiles(files: readonly string[], read: (path: string) => string | undefined): Set<string> {
  const tracked = new Set(files);
  // The `[workspace]` table of each manifest: `null` without a manifest or without the table, `undefined` when unread.
  const workspaces = new Map<string, TomlTable | null | undefined>();
  const workspaceIn = (dir: string): TomlTable | null | undefined => {
    const manifest = posix.join(dir, 'Cargo.toml');
    if (!tracked.has(manifest)) return null;
    if (!workspaces.has(manifest)) workspaces.set(manifest, workspaceTable(read(manifest)));
    return workspaces.get(manifest);
  };
  return new Set(files.filter(file => {
    if (posix.basename(file) !== 'Cargo.lock') return false;
    const member = posix.dirname(file);
    // The nearest manifest up from the lockfile with a `[workspace]` decides. One that excludes the folder can leave it
    // to a workspace further up, so the lockfile is kept.
    for (let dir = member; ; dir = posix.dirname(dir)) {
      const workspace = workspaceIn(dir);
      if (workspace === undefined) return false;
      if (workspace !== null) return dir !== member && tracked.has(posix.join(dir, 'Cargo.lock')) && isMember(workspace, dir, member);
      if (dir === '.') return false;
    }
  }));
}

/** Returns the `[workspace]` table of a manifest's `text`, `null` when it has none, or `undefined` when it cannot be read. */
function workspaceTable(text: string | undefined): TomlTable | null | undefined {
  if (text === undefined) return undefined;
  try {
    const { workspace } = parse(text);
    if (workspace === undefined) return null;
    return tableOf(workspace) === workspace ? workspace as TomlTable : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the folder `member` is a member of the workspace with the `[workspace]` table `workspace` in the folder `root`:
 * a pattern of its `members` matches the folder and no path of its `exclude` holds it. Both are relative to `root`.
 */
function isMember(workspace: TomlTable, root: string, member: string): boolean {
  const paths = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(p => typeof p === 'string' && !p.includes('\\') && !posix.isAbsolute(p))
    ? value.map(p => posix.join(root, p as string).replace(/\/+$/, ''))
    : undefined;
  const members = paths(workspace.members ?? []);
  const excluded = paths(workspace.exclude ?? []);
  if (!members || !excluded) return false;
  return !excluded.some(path => member === path || member.startsWith(`${path}/`)) && members.some(pattern => minimatch(member, pattern, MEMBER_GLOB));
}

/**
 * One comparator of a Cargo requirement: an optional operator, then a version of one to three parts, where only a full
 * version may carry a prerelease and build. A number has no leading zero. Each quantified part ends at a character
 * the next one cannot match, so a match takes linear time.
 */
const CARGO_COMPARATOR = /^(\^|~|=|>=|<=|>|<)?[ \t]*(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*|\*)(?:\.(0|[1-9][0-9]*|\*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?)?)?$/;

/**
 * Turns one Cargo comparator into the npm range with the same meaning, or `undefined` for a form Manki does not read
 * with certainty. A bare version means `^` in Cargo and the exact version in npm. A wildcard such as `1.2.*` means
 * `1.2.x` in both, and only a bare one is read. Each operator on a partial version, such as `~1`, `=1.2` or `>1.2`,
 * means the same in npm as in Cargo.
 */
function cargoComparator(text: string): string | undefined {
  if (text === '*') return '*';
  const parts = CARGO_COMPARATOR.exec(text);
  if (!parts) return undefined;
  const [, operator, major, minor, patch, pre = '', build = ''] = parts;
  const wildcard = minor === '*' || patch === '*';
  if (wildcard) {
    // Only `1.*` and `1.2.*` are read: a wildcard after a number, with no operator and nothing after it.
    if (operator || (minor === '*' && patch !== undefined) || pre || build) return undefined;
    return minor === '*' ? `${major}.x` : `${major}.${minor}.x`;
  }
  const version = [major, minor, patch].filter(p => p !== undefined).join('.') + pre + build;
  return `${operator ?? '^'}${version}`;
}

/**
 * Turns a Cargo requirement into an npm semver range, or `undefined` when any of its comparators is a form Manki does
 * not read with certainty. Cargo joins comparators with commas where npm uses spaces.
 */
function cargoRange(requirement: string): string | undefined {
  const parts = requirement.split(',').map(p => cargoComparator(p.trim()));
  if (parts.some(p => p === undefined)) return undefined;
  const range = parts.join(' ');
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
    buildFolder: 'target',
    installedCopy: () => undefined,
    isRegistrySource: source => source !== undefined && CRATES_IO_SOURCES.includes(source),
    namesHost: () => true,
    isConfigFile: path => CARGO_CONFIGS.test(path),
    otherRegistry: () => undefined,
    overriddenBy(name, configs) {
      for (const { file, text } of configs) {
        const config = parse(text);
        // A replaced source serves every crate from elsewhere, such as a vendored folder whose files can differ.
        if (Object.values(tableOf(config.source)).some(source => ['replace-with', 'replace_with'].some(k => Object.hasOwn(tableOf(source), k)))) return `${shown(file)} replaces the source of crates`;
        // `registry.index` and a `crates-io` entry of `[registries]` point crates.io itself at another index.
        if (Object.hasOwn(tableOf(config.registry), 'index') || Object.hasOwn(tableOf(config.registries), 'crates-io')) return `${shown(file)} sets another index for crates.io`;
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
