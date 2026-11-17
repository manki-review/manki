import { validRange } from 'semver';

import { PublishedVersion, Registry } from './types';

/** The hosts of crates.io: its sparse index, and the host its archives are served from. */
const CRATES_IO = { index: 'https://index.crates.io', download: 'https://static.crates.io' };

/** The sources a `Cargo.lock` names crates.io by, through its git index or its sparse index. */
const CRATES_IO_SOURCES = ['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/'];

/** The most bytes of a crate's index file. The largest list thousands of versions in a few MB. */
const MAX_INDEX_BYTES = 20 * 1024 * 1024;

/** The tables of a `Cargo.toml` that list dependencies, such as `[dependencies]` or `[target.'cfg(unix)'.dev-dependencies]`. */
const DEPENDENCY_TABLE = /^(?:target\.(?:'[^']*'|"[^"]*"|[^.]+)\.|workspace\.)?(?:dev-|build-)?dependencies$/;

const normalize = (name: string): string => name.toLowerCase().replace(/-/g, '_');

/** Returns the path of a crate's file in the crates.io index, which files a crate by the length and start of its name. */
function indexPath(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

/** Reads a TOML key, bare or quoted. */
function tomlKey(raw: string): string {
  const key = raw.trim();
  return /^".*"$|^'.*'$/.test(key) ? key.slice(1, -1) : key;
}

/** Reads the string value of `key` in an inline table such as `{ version = "1", features = ["x"] }`. */
function inlineString(table: string, key: string): string | undefined {
  return new RegExp(`(?:^|[{,\\s])${key}\\s*=\\s*"([^"]*)"`).exec(table)?.[1];
}

/**
 * Returns each dependency a `Cargo.toml` states with a version requirement, as the crate's name and the requirement.
 * A dependency from a path, a git repository or another registry has none from crates.io, and one that inherits its
 * entry from `[workspace.dependencies]` is stated there. Reads the forms Cargo writes: `name = "1.0"`, an inline table,
 * and a `[dependencies.name]` table. Anything else is left out, so a dependency it cannot read has no requirement.
 */
function cargoRequirements(text: string): Array<{ name: string; requirement: string }> {
  const found: Array<{ name: string; requirement: string }> = [];
  let table = '';
  let single: { key: string; fields: string[] } | undefined;
  const add = (key: string, fields: string) => {
    if (/(?:^|[{,\s])(?:path|git|registry|workspace)\s*=/.test(fields)) return;
    const requirement = inlineString(fields, 'version');
    if (requirement !== undefined) found.push({ name: inlineString(fields, 'package') ?? key, requirement });
  };
  const endSingle = () => {
    if (single) add(single.key, ` ${single.fields.join(', ')}`);
    single = undefined;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#[^"']*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^[\]]+)\]$/.exec(line);
    if (header) {
      endSingle();
      table = header[1].replace(/\s+/g, '');
      const dotted = /^(.*dependencies)\.("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)$/.exec(table);
      if (dotted && DEPENDENCY_TABLE.test(dotted[1])) single = { key: tomlKey(dotted[2]), fields: [] };
      continue;
    }
    if (line.startsWith('[')) {
      endSingle();
      table = '';
      continue;
    }
    if (single) {
      single.fields.push(line);
      continue;
    }
    if (!DEPENDENCY_TABLE.test(table)) continue;
    const pair = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].trim();
    if (/^"[^"]*"$/.test(value)) found.push({ name: tomlKey(pair[1]), requirement: value.slice(1, -1) });
    else if (value.startsWith('{')) add(tomlKey(pair[1]), value);
  }
  endSingle();
  return found;
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

/**
 * crates.io, the registry of Rust crates. A `.cargo/config.toml` can replace its source with a mirror or a vendored
 * copy, but those hold the same crates, and `Cargo.lock` binds each to its crates.io checksum. A crate of another
 * registry names it in `Cargo.toml` and is left out by `cargoRequirements`.
 */
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
    configFiles: [],
    otherRegistry: () => undefined,
    requirements: (text, name) => cargoRequirements(text).filter(d => normalize(d.name) === normalize(name)),
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
