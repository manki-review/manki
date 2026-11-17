import * as core from '@actions/core';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, posix } from 'path';
import { rcompare, satisfies, valid } from 'semver';

import { extractTarGz } from './archive';
import { lockedPackages } from './lockfile';
import { listFiles, resolveInRoot } from './mcp-server';
import { cratesIo } from './registries/crates';
import { npmRegistry } from './registries/npm';
import { PublishedVersion, Registry, RegistryFetch } from './registries/types';
import { fetchOutcome, RelatedRepoPending, sharedCheckout } from './related-repos';
import { claimStep, STALE_TIMEOUT_MS } from './tool-steps';
import { fetchWhole, matchesIntegrity } from './tool-install';
import { RoundDependencySource } from './types';

/** How many packages one round may fetch, over all its tool calls. */
export const MAX_PACKAGES_PER_ROUND = 10;

/** The registries a dependency's source is read from. Only their fixed hosts are ever contacted. */
export const REGISTRIES: readonly Registry[] = [cratesIo(), npmRegistry()];

/** The most bytes of a package archive as downloaded. `extractTarGz` caps what it unpacks to. */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
/** The most bytes of a lockfile or manifest Manki reads for a package's version. A lockfile can run to several MB. */
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;
/** How long resolving and fetching one package may take. A tool call must end before `STALE_TIMEOUT_MS`. */
const FETCH_TIMEOUT_MS = 60_000;
/** Folders of installed packages or build output, whose lockfiles and manifests are not the PR's own. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'target', '.git']);
const SRI_ALGORITHMS = ['sha512', 'sha384', 'sha256', 'sha1'];

/** A package version the PR uses, and where that version comes from. */
interface Resolved {
  registry: Registry;
  /** The package's name as its registry spells it. */
  name: string;
  version: string;
  /** The package as `<registry>/<name>@<version>`, which names it in a citation and in the round record. */
  key: string;
  source: 'lockfile' | 'requirement';
  /** The lockfile or manifest the version comes from, relative to the repository root. */
  file: string;
  requirement?: string;
  /** The checksum the lockfile or the registry states for the archive. */
  checksum?: string;
}

/** What the round record keeps of a package before its fetch starts, in `<marker>.from`. */
type PackageOrigin = Pick<RoundDependencySource, 'registry' | 'name' | 'version' | 'source' | 'file' | 'requirement'>;

/** A failure to resolve a requirement's version from the registry, recorded like a failed fetch. */
class UnresolvedPackage extends Error {
  constructor(message: string, readonly origin: PackageOrigin) {
    super(message);
  }
}

/**
 * Whether `data` matches `checksum`: a hex SHA-256 as `Cargo.lock` and the crates.io index state, a hex SHA-1 as an
 * older `yarn.lock` states, or a Subresource Integrity value, of which the strongest algorithm decides. Returns
 * `undefined` for a checksum in no form Manki reads, such as the cache checksum of Yarn 2 and later.
 */
export function checksumMatches(data: Buffer, checksum: string): boolean | undefined {
  if (/^[0-9a-f]{64}$/i.test(checksum)) return createHash('sha256').update(data).digest('hex') === checksum.toLowerCase();
  if (/^[0-9a-f]{40}$/i.test(checksum)) return createHash('sha1').update(data).digest('hex') === checksum.toLowerCase();
  const values = checksum.trim().split(/\s+/).filter(v => /^(sha512|sha384|sha256|sha1)-[A-Za-z0-9+/]+=*$/.test(v));
  const strongest = SRI_ALGORITHMS.find(alg => values.some(v => v.startsWith(`${alg}-`)));
  return strongest === undefined ? undefined : values.filter(v => v.startsWith(`${strongest}-`)).some(v => matchesIntegrity(data, v));
}

/** Whether `checksumMatches` reads `checksum`. */
function readableChecksum(checksum: string | undefined): checksum is string {
  return checksum !== undefined && checksumMatches(Buffer.alloc(0), checksum) !== undefined;
}

/**
 * Returns the version a fresh install picks for `range` among `versions`: the highest that matches and was not yanked.
 * A prerelease matches only a range that names one. A deprecated version is picked only when no other one matches.
 */
export function pickVersion(versions: readonly PublishedVersion[], range: string): PublishedVersion | undefined {
  const matching = versions.filter(v => !v.yanked && valid(v.version) && satisfies(v.version, range));
  const current = matching.filter(v => !v.deprecated);
  return (current.length > 0 ? current : matching).sort((a, b) => rcompare(a.version, b.version))[0];
}

/** Returns a fetch that reaches only the hosts of `registry`, refuses redirects and ends when `deadline` aborts. */
function registryFetch(registry: Registry, deadline: AbortSignal, timeoutMs: number): RegistryFetch {
  return (url, maxBytes, headers) => {
    if (!registry.origins.includes(new URL(url).origin)) return Promise.reject(new Error(`${url} is not on a host of ${registry.id}`));
    return fetchWhole(url, deadline, { maxBytes, noRedirects: true, deadlineMs: timeoutMs, ...(headers && { headers }) });
  };
}

/** Keeps a path or requirement from the PR on one line and out of a code span's backticks. */
function shown(text: string): string {
  return text.replace(/[`\r\n\u2028\u2029]+/g, ' ');
}

/** Reads a lockfile or manifest of the checkout at `root`, or returns `undefined` when it is too large or cannot be read. */
function readManifest(root: string, path: string): string | undefined {
  try {
    const { absolute } = resolveInRoot(root, path);
    return statSync(absolute).size > MAX_MANIFEST_BYTES ? undefined : readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether `dir` is `ancestor` or lies inside it, both as folders relative to the repository root. */
function within(dir: string, ancestor: string): boolean {
  return ancestor === '.' || dir === ancestor || dir.startsWith(`${ancestor}/`);
}

/**
 * Returns the version of `name` that the PR at `root`, with the files `files`, uses. A version some lockfile of the
 * registry locks counts, from the registry's own source only. So does the version a fresh install picks for a manifest's
 * requirement, when no lockfile of the registry sits in the manifest's folder or above it. With `version` set it must be
 * one of those. Without it there must be only one. Throws, naming why, when the PR does not use the package from the
 * registry, uses another version, or uses several and `version` names none.
 */
export async function resolveDependency(
  root: string, files: readonly string[], registry: Registry, name: string, version: string | undefined, fetch: RegistryFetch,
): Promise<Resolved> {
  const label = `${registry.id}/${name}`;
  const lockfiles = files.filter(f => registry.lockfiles.includes(posix.basename(f)));
  const lockDirs = lockfiles.map(f => posix.dirname(f));
  const unread: string[] = [];
  const locked = lockfiles.flatMap(file => {
    const text = readManifest(root, file);
    try {
      if (text === undefined) throw new Error('unread');
      return lockedPackages(file, text).filter(p => registry.sameName(p.name, name)).map(p => ({ ...p, file }));
    } catch {
      unread.push(file);
      return [];
    }
  });
  const requirements = files
    .filter(f => registry.manifests.includes(posix.basename(f)) && !lockDirs.some(dir => within(posix.dirname(f), dir)))
    .flatMap(file => {
      const text = readManifest(root, file);
      try {
        return text === undefined ? [] : registry.requirements(text, name).map(requirement => ({ file, requirement }));
      } catch {
        return [];
      }
    });
  const fromRegistry = locked.filter(p => registry.isRegistrySource(p.source));
  if (fromRegistry.length === 0 && requirements.length === 0) {
    const other = locked[0];
    if (other) throw new Error(`${label} is locked in ${other.file} from ${other.source ?? 'this repository'}, not from ${registry.id}, the only place Manki reads it from.`);
    const notRead = unread.length > 0 ? ` Manki could not read ${unread.slice(0, 3).join(', ')}.` : '';
    throw new Error(`${label} is not a dependency in the PR's manifests or lockfiles, so Manki does not read it.${notRead}`);
  }
  const candidates: Array<Omit<Resolved, 'registry' | 'key' | 'name'>> = fromRegistry
    .map(p => ({ version: p.version, source: 'lockfile' as const, file: p.file, ...(p.checksum && { checksum: p.checksum }) }));
  let own = fromRegistry[0]?.name ?? name;
  if (requirements.length > 0 && !(version && candidates.some(c => c.version === version))) {
    const first = requirements[0];
    let published: Awaited<ReturnType<Registry['published']>>;
    try {
      published = await registry.published(name, fetch);
    } catch (error) {
      const origin: PackageOrigin = { registry: registry.id, name, source: 'requirement', file: first.file, requirement: first.requirement };
      throw new UnresolvedPackage(`Manki could not read the published versions of ${label} to resolve its requirement: ${error instanceof Error ? error.message : String(error)}`, origin);
    }
    own = published.name;
    for (const { file, requirement } of requirements) {
      const range = registry.range(requirement);
      const picked = range === undefined ? undefined : pickVersion(published.versions, range);
      if (picked) candidates.push({ version: picked.version, source: 'requirement', file, requirement, checksum: picked.checksum });
    }
  }
  const where = (c: typeof candidates[number]) => c.source === 'lockfile' ? `locked in ${c.file}` : `resolved from \`${shown(c.requirement!)}\` in ${c.file}`;
  if (candidates.length === 0) {
    throw new Error(`No published version of ${label} matches what the PR requires: ${requirements.map(r => `\`${shown(r.requirement)}\` in ${r.file}`).join(', ')}.`);
  }
  const versions = [...new Set(candidates.map(c => c.version))];
  const chosen = version !== undefined ? candidates.find(c => c.version === version) : versions.length === 1 ? candidates[0] : undefined;
  if (!chosen) {
    const used = candidates.map(c => `${c.version} (${where(c)})`).join(', ');
    throw new Error(version !== undefined
      ? `The PR does not use ${label}@${version}. It uses ${used}.`
      : `The PR uses several versions of ${label}: ${used}. Name one as ${label}@<version>.`);
  }
  return { registry, name: own, ...chosen, key: `${registry.id}/${own}@${chosen.version}` };
}

/** Returns the registry, package name and version a `dependency` argument names, as `<registry>/<name>` with an optional `@<version>`. */
function parseSpec(spec: string, registries: readonly Registry[]): { registry: Registry; name: string; version?: string } {
  const registry = registries.find(r => spec.startsWith(`${r.id}/`));
  if (!registry) throw new Error(`Name a dependency as ${registries.map(r => `${r.id}/<name>`).join(' or ')}, since Manki reads dependencies from those registries only.`);
  const rest = spec.slice(registry.id.length + 1);
  const at = rest.lastIndexOf('@');
  const [name, version] = at > 0 ? [rest.slice(0, at), rest.slice(at + 1)] : [rest, undefined];
  if (!registry.validName(name)) throw new Error(`${JSON.stringify(name)} is not a package name of ${registry.id}.`);
  if (version !== undefined && !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) throw new Error(`${JSON.stringify(version)} is not a version.`);
  return { registry, name, ...(version !== undefined && { version }) };
}

/** Writes `text` to `path` through a rename, so a reader never sees it half written. */
function writeWhole(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** Records in the round's `stateDir` that `key` could not be read, and why, unless an outcome is already recorded. */
function recordFailure(stateDir: string, key: string, origin: PackageOrigin, reason: string): void {
  const marker = join(stateDir, encodeURIComponent(key));
  if (existsSync(`${marker}.done`) || existsSync(`${marker}.failed`)) return;
  writeWhole(`${marker}.from`, JSON.stringify(origin));
  try {
    writeFileSync(`${marker}.lock`, String(process.pid), { flag: 'wx' });
  } catch { /* another call holds it, and its outcome is kept below */ }
  writeWhole(`${marker}.failed`, reason);
}

/** Downloads the archive of `resolved`, checks it against its checksum and unpacks it into a new folder under `stateDir`. */
async function fetchPackage(resolved: Resolved, stateDir: string, fetch: RegistryFetch, marker: string, maxArchiveBytes: number): Promise<string> {
  const { registry, name, version, key } = resolved;
  let checksum = readableChecksum(resolved.checksum) ? resolved.checksum : undefined;
  let stated = resolved.source === 'lockfile' ? resolved.file : registry.id;
  if (!checksum) {
    checksum = (await registry.published(name, fetch)).versions.find(v => v.version === version)?.checksum;
    stated = registry.id;
  }
  if (!readableChecksum(checksum)) throw new Error(`neither ${resolved.file} nor ${registry.id} states a checksum Manki can check the archive of ${key} against`);
  const archive = await fetch(registry.archiveUrl(name, version), maxArchiveBytes);
  if (!checksumMatches(archive, checksum)) {
    writeFileSync(`${marker}.mismatch`, '');
    throw new Error(`the archive of ${key} does not match the checksum ${stated} states for it, so Manki does not read it`);
  }
  const packages = join(stateDir, 'packages');
  mkdirSync(packages, { recursive: true });
  const folder = mkdtempSync(join(packages, 'package-'));
  try {
    extractTarGz(archive, join(folder, 'source'));
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw new Error(`the archive of ${key} could not be unpacked: ${error instanceof Error ? error.message : String(error)}`);
  }
  return join(folder, 'source');
}

export interface DependencyLoaderOptions {
  registries?: readonly Registry[];
  /** Time limit for resolving and fetching one package. */
  timeoutMs?: number;
  /** How long one call of the loader may take. Defaults to `STALE_TIMEOUT_MS`, the limit of a tool call. */
  callLimitMs?: number;
  maxPackages?: number;
  /** The most bytes of an archive as downloaded. */
  maxArchiveBytes?: number;
}

/** A package a tool call reads, with the note that tells the model which version it is and where that comes from. */
export interface DependencyCheckout {
  key: string;
  dir: string;
  note: string;
}

/**
 * Returns a function that reads the dependency a tool call names, such as `crates.io/time` or `npm/@types/node@20.1.0`,
 * for the PR checked out at `root`, and resolves with its folder. The version is the one `resolveDependency` finds in the
 * PR's own lockfiles and manifests, never one the call alone names. Each package is fetched at most once per round, by
 * the first tool server that asks, and the round's `stateDir` records how each fared. A round fetches at most
 * `maxPackages` packages. Nothing in a package is run: its archive is only checked against its checksum and unpacked.
 */
export function dependencyLoader(
  root: string, stateDir: string,
  {
    registries = REGISTRIES, timeoutMs = FETCH_TIMEOUT_MS, callLimitMs = STALE_TIMEOUT_MS, maxPackages = MAX_PACKAGES_PER_ROUND, maxArchiveBytes = MAX_ARCHIVE_BYTES,
  }: DependencyLoaderOptions = {},
): (spec: string) => Promise<DependencyCheckout> {
  let files: string[] | undefined;
  return async spec => {
    const { registry, name, version } = parseSpec(spec, registries);
    files ??= listFiles(realpathSync(root), resolveInRoot(root, '.')).files.filter(f => !f.split('/').some(segment => SKIPPED_FOLDERS.has(segment)));
    const deadline = AbortSignal.timeout(timeoutMs);
    const fetch = registryFetch(registry, deadline, timeoutMs);
    let resolved: Resolved;
    try {
      resolved = await resolveDependency(root, files, registry, name, version, fetch);
    } catch (error) {
      if (error instanceof UnresolvedPackage) recordFailure(stateDir, `${registry.id}/${name}`, error.origin, error.message);
      throw error;
    }
    const { key, source, file, requirement } = resolved;
    const origin: PackageOrigin = { registry: registry.id, name: resolved.name, version: resolved.version, source, file, ...(requirement && { requirement }) };
    const marker = join(stateDir, encodeURIComponent(key));
    if (!existsSync(`${marker}.lock`)) {
      const slots = join(stateDir, 'package-slots');
      mkdirSync(slots, { recursive: true });
      if (claimStep(slots) > maxPackages) {
        const reason = `the round already read ${maxPackages} packages, the most one round reads`;
        recordFailure(stateDir, key, origin, reason);
        throw new Error(`Manki did not read ${key}: ${reason}.`);
      }
      if (!existsSync(`${marker}.from`)) writeWhole(`${marker}.from`, JSON.stringify(origin));
    }
    let dir: string;
    try {
      dir = await sharedCheckout(key, marker, { timeoutMs, callLimitMs }, async () => ({ dir: await fetchPackage(resolved, stateDir, fetch, marker, maxArchiveBytes), commit: '' }));
    } catch (error) {
      if (error instanceof RelatedRepoPending) throw new Error(`${key} ${error.message}`);
      throw new Error(`${key} could not be fetched, so it cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const from = source === 'lockfile'
      ? `the version \`${shown(file)}\` locks`
      : `the highest version that the requirement \`${shown(requirement!)}\` in \`${shown(file)}\` allows, since no lockfile covers that manifest`;
    return { key, dir, note: `Manki read \`${key}\`, ${from}. Cite its lines as \`${key}:path:line\`.` };
  };
}

/**
 * Returns each package a tool server of the round in `stateDir` tried to read: its version and where that came from,
 * and whether it was fetched, failed with the reason, or its archive did not match its checksum. Warns about each one
 * that could not be read.
 */
export function dependencyOutcomes(stateDir: string): RoundDependencySource[] {
  const files = new Set(readdirSync(stateDir));
  return [...files].filter(f => f.endsWith('.from')).sort().map(f => {
    const key = decodeURIComponent(f.slice(0, -'.from'.length));
    const origin = JSON.parse(readFileSync(join(stateDir, f), 'utf8')) as PackageOrigin;
    const { status, reason, durationMs } = fetchOutcome(stateDir, files, key);
    const record: RoundDependencySource = {
      package: key, ...origin,
      status: files.has(`${encodeURIComponent(key)}.mismatch`) ? 'mismatch' : status === 'unused' ? 'failed' : status,
      ...(status === 'unused' ? { reason: 'the fetch never started' } : reason && { reason }),
      ...(durationMs !== undefined && { durationMs }),
    };
    if (record.status !== 'fetched') core.warning(`Could not read the dependency ${key}: ${record.reason ?? record.status}`);
    return record;
  });
}
