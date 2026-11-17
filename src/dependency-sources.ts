import * as core from '@actions/core';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, posix } from 'path';
import { rcompare, satisfies, valid } from 'semver';

import { ArchiveLimits, extractTarGz } from './archive';
import { lockedPackages } from './lockfile';
import { ListOptions, listFiles, resolveInRoot } from './mcp-server';
import { cratesIo } from './registries/crates';
import { npmRegistry } from './registries/npm';
import { PublishedVersion, Registry, RegistryConfig, RegistryFetch } from './registries/types';
import { fetchOutcome, RelatedRepoPending, sharedCheckout, WAIT_SLACK_MS, writeMarker } from './related-repos';
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
/** The most bytes of lockfiles, manifests and registry settings one call reads in all. */
const MAX_MANIFEST_TOTAL_BYTES = 100 * 1024 * 1024;
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
  /** Set when the version names no registry host, so the registry is the one no file of the PR replaces. */
  hostAssumed?: true;
}

/** The lockfiles, manifests and registry settings of the checkout, and whether the walk that listed them stopped early. */
interface Listing {
  files: readonly string[];
  cut: boolean;
}

/** How many bytes one file of the checkout may hold, and how many a call has left to read. */
interface ReadBudget {
  each: number;
  left: number;
}

/** What the round record keeps of a package before its fetch starts, in `<marker>.from`. */
type PackageOrigin = Pick<RoundDependencySource, 'registry' | 'name' | 'version' | 'source' | 'file' | 'requirement'>;

/**
 * A package the PR uses that Manki does not read, recorded in the round record under `key`: `refused` when the code the
 * PR uses is not the registry's archive, else failed, such as when a requirement's versions could not be fetched.
 */
class UnreadPackage extends Error {
  constructor(message: string, readonly key: string, readonly origin: PackageOrigin, readonly refused: boolean) {
    super(message);
  }
}

/** The form of a version Manki puts in a package's key, a URL and a note, which a lockfile of the PR may not hold. */
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

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
 * Returns the version a fresh install picks for `range` among `versions`. That is `latest`, the version the registry
 * marks as the default, when it matches and is neither yanked nor deprecated. Otherwise it is the highest that matches
 * and was not yanked. A prerelease matches only a range that names one. A deprecated version is picked only when no
 * other one matches.
 */
export function pickVersion(versions: readonly PublishedVersion[], range: string, latest?: string): PublishedVersion | undefined {
  const matching = versions.filter(v => !v.yanked && valid(v.version) && satisfies(v.version, range));
  const current = matching.filter(v => !v.deprecated);
  const preferred = latest === undefined ? undefined : current.find(v => v.version === latest);
  return preferred ?? (current.length > 0 ? current : matching).sort((a, b) => rcompare(a.version, b.version))[0];
}

/** Returns a fetch that reaches only the hosts of `registry` and refuses redirects. Its requests end `timeoutMs` after the fetch is made. */
function registryFetch(registry: Registry, timeoutMs: number): RegistryFetch {
  const deadline = AbortSignal.timeout(timeoutMs);
  return (url, maxBytes, headers) => {
    if (!registry.origins.includes(new URL(url).origin)) return Promise.reject(new Error(`${url} is not on a host of ${registry.id}`));
    return fetchWhole(url, deadline, { maxBytes, noRedirects: true, deadlineMs: timeoutMs, ...(headers && { headers }) });
  };
}

/** Keeps a path or requirement from the PR on one line and out of a code span's backticks. */
function shown(text: string): string {
  return text.replace(/[`\r\n\u2028\u2029]+/g, ' ');
}

/**
 * Reads a lockfile, manifest or registry setting of the checkout at `root` and takes its size from `budget`. Returns
 * `undefined` when it is larger than one file or the rest of the budget may be, or cannot be read.
 */
function readManifest(root: string, path: string, budget: ReadBudget): string | undefined {
  try {
    const { absolute } = resolveInRoot(root, path);
    const { size } = statSync(absolute);
    if (size > budget.each || size > budget.left) return undefined;
    budget.left -= size;
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether `dir` is `ancestor` or lies inside it, both as folders relative to the repository root. */
function within(dir: string, ancestor: string): boolean {
  return ancestor === '.' || dir === ancestor || dir.startsWith(`${ancestor}/`);
}

/**
 * Returns the version of `name` that the PR at `root`, with the files `listing` holds, uses. A version some lockfile of
 * the registry locks counts, from the registry's own source only. So does the version a fresh install picks for a
 * manifest's requirement, when no lockfile of the registry sits in the manifest's folder or above it. A version that
 * names no registry host, and a requirement, count only when no registry setting of the PR names another registry for
 * the package. With `version` set it must be one of those. Without it there must be only one. Throws, naming why, when
 * the PR does not use the package from the registry, uses another version, or uses several and `version` names none.
 */
async function resolveDependency(
  root: string, { files, cut }: Listing, registry: Registry, name: string, version: string | undefined, fetch: RegistryFetch, budget: ReadBudget,
): Promise<Resolved> {
  const label = `${registry.id}/${name}`;
  const unread: string[] = [];
  const read = (file: string): string | undefined => {
    const text = readManifest(root, file, budget);
    if (text === undefined) unread.push(file);
    return text;
  };
  const configs = files.filter(f => registry.configFiles.includes(posix.basename(f))).flatMap((file): RegistryConfig[] => {
    const text = read(file);
    return text === undefined ? [] : [{ file, text }];
  });
  const unreadConfig = unread[0];
  const otherRegistry = unreadConfig !== undefined ? `Manki could not read ${unreadConfig}, which can set it` : registry.otherRegistry(name, configs);
  const lockfiles = files.filter(f => registry.lockfiles.includes(posix.basename(f)));
  const lockDirs = lockfiles.map(f => posix.dirname(f));
  const locked = lockfiles.flatMap(file => {
    const text = read(file);
    if (text === undefined) return [];
    try {
      return lockedPackages(file, text).filter(p => registry.sameName(p.name, name)).map(p => ({ ...p, file }));
    } catch {
      unread.push(file);
      return [];
    }
  });
  const requirements = files
    .filter(f => registry.manifests.includes(posix.basename(f)) && !lockDirs.some(dir => within(posix.dirname(f), dir)))
    .flatMap(file => {
      const text = read(file);
      try {
        return text === undefined ? [] : registry.requirements(text, name).map(r => ({ ...r, file }));
      } catch {
        return [];
      }
    });
  // Why Manki does not read a locked entry: the code the PR uses there is not the archive the registry publishes.
  const refusalOf = (p: typeof locked[number]): string | undefined => {
    if (!VERSION.test(p.version)) return `${p.file} locks it at a version Manki does not read`;
    if (!registry.isRegistrySource(p.source)) return `${p.file} locks it from ${(p.source ?? 'this repository').slice(0, 200)}, not from ${registry.id}`;
    if (p.patched) return `${p.file} locks it with a patch applied, so the PR does not run the code ${registry.id} publishes`;
    if (!registry.namesHost(p.source) && otherRegistry !== undefined) return `it may come from another registry than ${registry.id}, since ${otherRegistry}`;
    return undefined;
  };
  const refuse = (key: string, reason: string, origin: PackageOrigin): never => {
    throw new UnreadPackage(`Manki does not read ${key}: ${shown(reason)}.`, key, origin, true);
  };
  const refuseLocked = (p: typeof locked[number]): never => {
    const valid = VERSION.test(p.version);
    return refuse(valid ? `${registry.id}/${p.name}@${p.version}` : label, refusalOf(p)!, { registry: registry.id, name: p.name, ...(valid && { version: p.version }), source: 'lockfile', file: p.file });
  };
  const fromRegistry = locked.filter(p => refusalOf(p) === undefined);
  const usable = otherRegistry === undefined ? requirements : [];
  const refusedVersion = version !== undefined && !fromRegistry.some(p => p.version === version) ? locked.find(p => p.version === version) : undefined;
  if (refusedVersion) refuseLocked(refusedVersion);
  if (fromRegistry.length === 0 && usable.length === 0) {
    if (locked.length > 0) refuseLocked(locked[0]);
    if (requirements.length > 0) {
      const { file, requirement } = requirements[0];
      refuse(label, `it may come from another registry than ${registry.id}, since ${otherRegistry}`, { registry: registry.id, name: requirements[0].name, source: 'requirement', file, requirement });
    }
    const notRead = unread.length > 0 ? ` Manki could not read ${unread.slice(0, 3).join(', ')}.` : '';
    const notListed = cut ? ' The checkout has more files than Manki lists, so it may have missed a lockfile or manifest.' : '';
    throw new Error(`${label} is not a dependency in the PR's manifests or lockfiles, so Manki does not read it.${notRead}${notListed}`);
  }
  const candidates: Array<Omit<Resolved, 'registry' | 'key' | 'name'>> = fromRegistry.map(p => ({
    version: p.version, source: 'lockfile' as const, file: p.file, ...(p.checksum && { checksum: p.checksum }), ...(!registry.namesHost(p.source) && { hostAssumed: true as const }),
  }));
  let own = fromRegistry[0]?.name ?? name;
  if (usable.length > 0 && !(version && candidates.some(c => c.version === version))) {
    const first = usable[0];
    let published: Awaited<ReturnType<Registry['published']>>;
    try {
      // The registry files a package under its own spelling, which the manifest holds and the call may not.
      published = await registry.published(first.name, fetch);
    } catch (error) {
      const origin: PackageOrigin = { registry: registry.id, name: first.name, source: 'requirement', file: first.file, requirement: first.requirement };
      throw new UnreadPackage(`Manki could not read the published versions of ${label} to resolve its requirement: ${error instanceof Error ? error.message : String(error)}`, `${registry.id}/${first.name}`, origin, false);
    }
    own = published.name;
    for (const { file, requirement } of usable) {
      const range = registry.range(requirement);
      const picked = range === undefined ? undefined : pickVersion(published.versions, range, published.latest);
      if (picked) candidates.push({ version: picked.version, source: 'requirement', file, requirement, checksum: picked.checksum, ...(registry.configFiles.length > 0 && { hostAssumed: true as const }) });
    }
  }
  const where = (c: typeof candidates[number]) => c.source === 'lockfile' ? `locked in ${c.file}` : `resolved from \`${shown(c.requirement!)}\` in ${c.file}`;
  if (candidates.length === 0) {
    throw new Error(`No published version of ${label} matches what the PR requires: ${usable.map(r => `\`${shown(r.requirement)}\` in ${r.file}`).join(', ')}.`);
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
  if (version !== undefined && !VERSION.test(version)) throw new Error(`${JSON.stringify(version)} is not a version.`);
  return { registry, name, ...(version !== undefined && { version }) };
}

/**
 * Records in the round's `stateDir` that the package of `unread` was not read, and why. Leaves the record alone when
 * another call holds the package's lock, since that call records its own outcome.
 */
function recordUnread(stateDir: string, unread: UnreadPackage): void {
  const marker = join(stateDir, encodeURIComponent(unread.key));
  try {
    writeFileSync(`${marker}.lock`, String(process.pid), { flag: 'wx' });
  } catch {
    return;
  }
  writeMarker(`${marker}.from`, JSON.stringify(unread.origin));
  if (unread.refused) writeFileSync(`${marker}.refused`, '');
  writeMarker(`${marker}.failed`, unread.message);
}

/** A package past the round's cap of packages. */
class PackageCapReached extends Error {}

/**
 * Takes one of the round's `maxPackages` places for the package at `marker`. Runs only in the call that holds the
 * package's lock, so a package takes one place however many calls ask for it, and a call that takes over a stopped
 * fetch reuses the place that fetch took. Throws `PackageCapReached` past the cap.
 */
function claimPackagePlace(stateDir: string, marker: string, maxPackages: number): void {
  let place = existsSync(`${marker}.place`) ? Number(readFileSync(`${marker}.place`, 'utf8')) : undefined;
  if (place === undefined) {
    const places = join(stateDir, 'package-places');
    mkdirSync(places, { recursive: true });
    place = claimStep(places);
    writeMarker(`${marker}.place`, String(place));
  }
  if (place > maxPackages) throw new PackageCapReached(`the round already read ${maxPackages} packages, the most one round reads`);
}

/** Downloads the archive of `resolved`, checks it against its checksum and unpacks it into a new folder under `stateDir`. */
async function fetchPackage(resolved: Resolved, stateDir: string, fetch: RegistryFetch, marker: string, maxArchiveBytes: number, archiveLimits: ArchiveLimits): Promise<string> {
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
    extractTarGz(archive, join(folder, 'source'), archiveLimits);
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
  /** The caps `extractTarGz` holds an archive to. */
  archiveLimits?: ArchiveLimits;
  /** The most bytes of one lockfile, manifest or registry setting, and of all those one call reads. */
  maxManifestBytes?: number;
  maxManifestTotalBytes?: number;
  /** What the walk of the checkout for lockfiles and manifests may keep and visit. */
  listLimits?: Pick<ListOptions, 'maxFiles' | 'maxWalked'>;
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
    archiveLimits = {}, maxManifestBytes = MAX_MANIFEST_BYTES, maxManifestTotalBytes = MAX_MANIFEST_TOTAL_BYTES, listLimits = {},
  }: DependencyLoaderOptions = {},
): (spec: string) => Promise<DependencyCheckout> {
  const wanted = new Set(registries.flatMap(r => [...r.manifests, ...r.lockfiles, ...r.configFiles]));
  let listing: Listing | undefined;
  return async spec => {
    const started = Date.now();
    const left = () => callLimitMs - (Date.now() - started);
    const { registry, name, version } = parseSpec(spec, registries);
    listing ??= listFiles(realpathSync(root), resolveInRoot(root, '.'), { ...listLimits, skipFolders: SKIPPED_FOLDERS, keep: file => wanted.has(file) });
    let resolved: Resolved;
    try {
      resolved = await resolveDependency(root, listing, registry, name, version, registryFetch(registry, timeoutMs), { each: maxManifestBytes, left: maxManifestTotalBytes });
    } catch (error) {
      if (error instanceof UnreadPackage) recordUnread(stateDir, error);
      throw error;
    }
    const { key, source, file, requirement } = resolved;
    const origin: PackageOrigin = { registry: registry.id, name: resolved.name, version: resolved.version, source, file, ...(requirement && { requirement }) };
    const marker = join(stateDir, encodeURIComponent(key));
    let dir: string;
    try {
      // The call limit counts from the start of the call, so the time spent resolving the version leaves less to wait.
      dir = await sharedCheckout(key, marker, { timeoutMs, callLimitMs: left() }, async () => {
        writeMarker(`${marker}.from`, JSON.stringify(origin));
        claimPackagePlace(stateDir, marker, maxPackages);
        // A fresh deadline, so a call that takes over a stopped fetch gets the whole time, within what the call has left.
        const fetch = registryFetch(registry, Math.max(0, Math.min(timeoutMs, left() - WAIT_SLACK_MS)));
        return { dir: await fetchPackage(resolved, stateDir, fetch, marker, maxArchiveBytes, archiveLimits), commit: '' };
      });
    } catch (error) {
      if (error instanceof RelatedRepoPending) throw new Error(`${key} ${error.message}`);
      if (error instanceof PackageCapReached) throw new Error(`Manki did not read ${key}: ${error.message}.`);
      throw new Error(`${key} could not be fetched, so it cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const from = source === 'lockfile'
      ? `the version \`${shown(file)}\` locks`
      : `the version a fresh install picks for the requirement \`${shown(requirement!)}\` in \`${shown(file)}\`, since no lockfile covers that manifest`;
    const host = resolved.hostAssumed ? ` No file of the PR sets another registry for it, so Manki read it from ${registry.id}.` : '';
    return { key, dir, note: `Manki read \`${key}\`, ${from}.${host} Cite its lines as \`${key}:path:line\`.` };
  };
}

/**
 * Returns each package a tool server of the round in `stateDir` tried to read: its version and where that came from,
 * and whether it was fetched, failed with the reason, was refused with the reason, or its archive did not match its
 * checksum. Warns about each one that was not read.
 */
export function dependencyOutcomes(stateDir: string): RoundDependencySource[] {
  const files = new Set(readdirSync(stateDir));
  return [...files].filter(f => f.endsWith('.from')).sort().map(f => {
    const key = decodeURIComponent(f.slice(0, -'.from'.length));
    const origin = JSON.parse(readFileSync(join(stateDir, f), 'utf8')) as PackageOrigin;
    const { status, reason, durationMs } = fetchOutcome(stateDir, files, key);
    // A refused package was never fetched, so it took no time.
    const refused = files.has(`${encodeURIComponent(key)}.refused`);
    const record: RoundDependencySource = {
      package: key, ...origin,
      status: files.has(`${encodeURIComponent(key)}.mismatch`) ? 'mismatch' : refused ? 'refused' : status === 'unused' ? 'failed' : status,
      ...(status === 'unused' ? { reason: 'the fetch never started' } : reason && { reason }),
      ...(durationMs !== undefined && !refused && { durationMs }),
    };
    if (record.status !== 'fetched') core.warning(`Could not read the dependency ${key}: ${record.reason ?? record.status}`);
    return record;
  });
}
