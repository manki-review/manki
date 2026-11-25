import * as core from '@actions/core';
import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, posix } from 'path';
import { rcompare, satisfies, valid } from 'semver';

import { ArchiveLimits, extractTarGz } from './archive';
import { lockedPackages, MAX_LOCKFILE_BYTES, MAX_LOCKFILES, MAX_LOCKFILES_TOTAL_BYTES } from './lockfile';
import { resolveInRoot } from './mcp-server';
import { cratesIo, ignoredMemberLockfiles } from './registries/crates';
import { npmRegistry } from './registries/npm';
import { shown } from './registries/shown';
import { PublishedVersion, Registry, RegistryConfig, RegistryFetch } from './registries/types';
import { DEPENDENCY_STATE, FETCH_TIMEOUT_MS, fetchOutcome, RelatedRepoPending, RetryableFetch, sharedCheckout, trackedFiles, WAIT_SLACK_MS, writeMarker } from './related-repos';
import { claimStep, STALE_TIMEOUT_MS } from './tool-steps';
import { fetchWhole, matchesIntegrity, TransientDownloadError } from './tool-install';
import { RoundDependencySource } from './types';
import { removedPathsOf, removedSubmodulesOf } from './workspace';

/** How many packages one round may fetch, over all its tool calls. */
export const MAX_PACKAGES_PER_ROUND = 10;

/** The registries a dependency's source is read from. Only their fixed hosts are ever contacted. */
export const REGISTRIES: readonly Registry[] = [cratesIo(), npmRegistry()];

/** The most bytes of a package archive as downloaded. `extractTarGz` caps what it unpacks to. */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
/** The most lockfiles, manifests and settings files of the checkout Manki lists. */
const MAX_LISTED = 20_000;
/** A path inside a committed install, such as `node_modules` or Yarn's cache, which a project runs in place of the registry's archive. */
const INSTALLED_COPY = /(?:^|\/)(?:node_modules|\.yarn\/cache)(?:\/|$)/;
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

/** The lockfiles, manifests and settings of the checkout, and why Manki cannot tell which code the PR runs from them, if it cannot. */
interface Listing {
  files: readonly string[];
  /** The tracked paths inside a committed install, such as `node_modules` or Yarn's cache. */
  installed: readonly string[];
  cut?: string;
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
  // A version reaches a key, a URL and a note, so only one spelled exactly as semver spells it is picked. `valid` drops build metadata.
  const matching = versions.filter(v => !v.yanked && valid(v.version) === v.version.replace(/\+.*$/, '') && VERSION.test(v.version) && satisfies(v.version, range));
  const current = matching.filter(v => !v.deprecated);
  const preferred = latest === undefined ? undefined : current.find(v => v.version === latest);
  return preferred ?? (current.length > 0 ? current : matching).sort((a, b) => rcompare(a.version, b.version))[0];
}

/**
 * Returns a fetch that reaches only the hosts of `registry` and refuses redirects. Its requests end when `deadline`
 * aborts, `timeoutMs` after the fetch is made unless given.
 */
function registryFetch(registry: Registry, timeoutMs: number, deadline = AbortSignal.timeout(timeoutMs)): RegistryFetch {
  return (url, maxBytes, headers) => {
    if (!registry.origins.includes(new URL(url).origin)) return Promise.reject(new Error(`${url} is not on a host of ${registry.id}`));
    return fetchWhole(url, deadline, { maxBytes, noRedirects: true, deadlineMs: timeoutMs, ...(headers && { headers }) });
  };
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

/** The most bytes of a symlink's target that Manki reads. */
const MAX_LINK_BYTES = 4096;

/**
 * Whether the symlink at `link`, relative to the checkout at `root`, points to one of `plainFiles`, the files git tracks
 * there that are no symlink. A checkout with `core.symlinks=false` holds the target as the text of a plain file.
 */
function linksToPlainFile(root: string, link: string, plainFiles: ReadonlySet<string>): boolean {
  try {
    const absolute = join(root, link);
    const stat = lstatSync(absolute);
    if (!stat.isSymbolicLink() && stat.size > MAX_LINK_BYTES) return false;
    const target = stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute, 'utf8');
    return !posix.isAbsolute(target) && plainFiles.has(posix.normalize(posix.join(posix.dirname(link), target)));
  } catch {
    return false;
  }
}

/**
 * Returns the version of `name` that the PR at `root`, with the files `listing` holds, uses, but only when Manki is
 * certain which code the PR runs. It is the version a committed lockfile of the registry locks, but not a `Cargo.lock`
 * of a workspace member, which Cargo ignores. Without one, it is the newest published version that the one requirement
 * of the PR's manifests allows. With `version` set it must be that
 * version, or one of those the lockfiles lock. Refuses the package, recorded as refused, when the listing was cut, the
 * checkout holds a committed install or an install file Manki does not read, a file that can lock, require or override
 * it could not be read with certainty, a setting may take it from another registry or changes the lockfile, a manifest
 * overrides or patches it or takes it from elsewhere, a lockfile locks it from another source, with a patch or at
 * several versions, a manifest states a requirement that the locked version does not meet, or the manifests state several
 * requirements, one Manki does not read, or one a fresh install may not meet with the newest version. Throws, naming why, when the PR does not use the package or another version.
 */
async function resolveDependency(
  root: string, { files, installed, cut }: Listing, registry: Registry, name: string, version: string | undefined, fetch: RegistryFetch, budget: ReadBudget,
): Promise<Resolved> {
  const label = `${registry.id}/${name}`;
  // Each reason passes the PR's own text, such as a path or a source, through `shown`, as the registries' reasons do.
  const refuse = (reason: string, origin: Partial<PackageOrigin> = {}, key = label): never => {
    throw new UnreadPackage(`Manki does not read ${label}: ${reason}.`, key, { registry: registry.id, name, ...origin }, true);
  };
  const certain = <T>(file: string, parse: () => T): T => {
    try {
      return parse();
    } catch (error) {
      return refuse(`Manki cannot read ${shown(file)} with certainty: ${shown(error instanceof Error ? error.message : String(error))}`, { file });
    }
  };
  if (cut) refuse(cut);
  const read = (file: string, what: string): string => readManifest(root, file, budget) ?? refuse(`Manki could not read ${shown(file)}, which can ${what}, within its size limits`, { file });

  const copy = registry.installedCopy(installed);
  if (copy) refuse(`the checkout holds ${shown(copy)}, a committed install, which the project can run in place of the archives ${registry.id} publishes`);
  const unreadInstall = files.find(f => registry.unreadInstallFiles.includes(posix.basename(f)));
  if (unreadInstall) refuse(`the checkout holds ${shown(unreadInstall)}, which Manki does not read and which can decide what an install gets`, { file: unreadInstall });
  const configs = files.filter(f => registry.isConfigFile(f)).map((file): RegistryConfig => ({ file, text: read(file, 'change where packages come from') }));
  for (const config of configs) {
    const overridden = certain(config.file, () => registry.overriddenBy(name, [config]));
    if (overridden) refuse(overridden, { file: config.file });
  }
  const otherRegistry = registry.otherRegistry(name, configs);
  if (otherRegistry) refuse(`it may come from another registry than ${registry.id}, since ${otherRegistry}`);

  const manifests = files.filter(f => registry.manifests.includes(posix.basename(f))).map((file): RegistryConfig => ({ file, text: read(file, 'require or override it') }));
  const requirements = manifests.flatMap(({ file, text }) => {
    const { requirements: stated, overridden, otherSource } = certain(file, () => registry.manifest(text, name));
    if (overridden) refuse(`${shown(file)} changes its code for an install: ${overridden}`, { file });
    if (otherSource) refuse(`${shown(file)} does not take it from ${registry.id}: ${otherSource}`, { file });
    return stated.map(r => ({ ...r, file }));
  });

  const lockfiles = files.filter(f => registry.lockfiles.includes(posix.basename(f)));
  // A lockfile past the cap may lock the package too, so the listing cannot settle it.
  if (lockfiles.length > MAX_LOCKFILES) refuse(`the checkout holds ${lockfiles.length} lockfiles, more than the ${MAX_LOCKFILES} Manki reads`);
  const texts = new Map(manifests.map(({ file, text }) => [file, text]));
  const ignored = ignoredMemberLockfiles([...lockfiles, ...texts.keys()], file => texts.get(file));
  const locked = lockfiles.filter(f => !ignored.has(f)).flatMap(file => {
    const text = read(file, 'lock it');
    return certain(file, () => lockedPackages(file, text)).filter(p => registry.sameName(p.name, name)).map(p => ({ ...p, file }));
  });
  // A committed lockfile decides: each entry of the name must be the registry's archive, and all must agree.
  if (locked.length > 0) {
    for (const p of locked) {
      const reason = !VERSION.test(p.version) ? `${shown(p.file)} locks it at a version Manki does not read`
        : !registry.isRegistrySource(p.source, p.name, p.version) ? `${shown(p.file)} locks it from ${shown((p.source ?? 'this repository').slice(0, 200))}, not from ${registry.id}`
          : p.patched ? `${shown(p.file)} locks it with a patch applied, so the PR does not run the code ${registry.id} publishes`
            : undefined;
      if (reason) refuse(reason, { ...(VERSION.test(p.version) && { version: p.version }), source: 'lockfile', file: p.file });
    }
    const where = locked.map(p => `${p.version} in ${shown(p.file)}`).join(', ');
    const chosen = version === undefined ? locked[0] : locked.find(p => p.version === version);
    // A version the PR does not use is recorded under its own key, so it never holds the package's record.
    if (!chosen) throw new UnreadPackage(`The PR does not use ${label}@${version}. Its lockfiles lock ${where}.`, `${label}@${version}`, { registry: registry.id, name, source: 'lockfile', file: locked[0].file }, false);
    if (version === undefined && locked.some(p => p.version !== chosen.version)) {
      // Naming a version helps only when one of them meets every requirement a manifest states.
      const meetsAll = (v: string) => requirements.every(r => { const range = registry.range(r.requirement); return range !== undefined && satisfies(v, range); });
      const hint = locked.some(p => meetsAll(p.version)) ? `. Name one as ${label}@<version>` : '';
      refuse(`its lockfiles lock several versions: ${where}${hint}`, { source: 'lockfile', file: chosen.file });
    }
    // An install drops a locked version that a manifest's requirement no longer allows, so the lockfile is stale for it.
    // A refusal of a named version is recorded under its own key, so a refusal of the package as a whole keeps its record.
    const key = version === undefined ? label : `${label}@${version}`;
    for (const { file, requirement } of requirements) {
      const range = registry.range(requirement);
      const origin = { version: chosen.version, source: 'requirement' as const, file, requirement };
      if (range === undefined) refuse(`${shown(file)} requires it as \`${shown(requirement)}\`, a form Manki does not read with certainty`, origin, key);
      if (!satisfies(chosen.version, range!)) refuse(`${shown(file)} requires it as \`${shown(requirement)}\`, which the locked version ${chosen.version} does not meet`, origin, key);
    }
    return {
      registry, name: chosen.name, version: chosen.version, key: `${registry.id}/${chosen.name}@${chosen.version}`, source: 'lockfile', file: chosen.file,
      ...(chosen.checksum && { checksum: chosen.checksum }), ...(!registry.namesHost(chosen.source) && { hostAssumed: true as const }),
    };
  }

  // Without a lockfile, a direct dependency with one requirement gets the newest version that requirement allows.
  if (requirements.length === 0) throw new Error(`${label} is not a dependency in the PR's manifests or lockfiles, so Manki does not read it.`);
  const first = requirements[0];
  const origin = { name: first.name, source: 'requirement' as const, file: first.file, requirement: first.requirement };
  const unread = (message: string, key = label) => new UnreadPackage(message, key, { registry: registry.id, ...origin }, false);
  const distinct = [...new Set(requirements.map(r => r.requirement.trim()))];
  if (distinct.length > 1) {
    refuse(`the PR's manifests require it as ${requirements.map(r => `\`${shown(r.requirement)}\` in ${shown(r.file)}`).join(', ')}, and without a lockfile Manki cannot tell which an install follows`, origin);
  }
  const range = registry.range(first.requirement);
  if (range === undefined) refuse(`${shown(first.file)} requires it as \`${shown(first.requirement)}\`, a form Manki does not read with certainty`, origin);
  const fresh = certain(first.file, () => registry.freshPick([...configs, ...manifests]));
  if (typeof fresh === 'string') refuse(fresh, origin);
  let published: Awaited<ReturnType<Registry['published']>>;
  try {
    // The registry files a package under its own spelling, which the manifest holds and the call may not.
    published = await registry.published(first.name, fetch);
  } catch (error) {
    throw new UnreadPackage(`Manki could not read the published versions of ${label} to resolve its requirement: ${error instanceof Error ? error.message : String(error)}`, `${registry.id}/${first.name}`, { registry: registry.id, ...origin }, false);
  }
  // The registry's spelling of the name reaches the key and the note, so it must be a name of the same package.
  if (!registry.validName(published.name) || !registry.sameName(published.name, first.name)) throw unread(`${registry.id} lists ${label} under a name Manki does not read.`);
  const picked = pickVersion(published.versions, range!, published.latest);
  if (!picked) throw unread(`No published version of ${label} matches what the PR requires: \`${shown(first.requirement)}\` in ${shown(first.file)}.`);
  const older = typeof fresh === 'function' ? fresh(picked) : undefined;
  if (older) refuse(older, origin);
  if (version !== undefined && version !== picked.version) throw unread(`The PR does not use ${label}@${version}. It uses ${picked.version} (resolved from \`${shown(first.requirement)}\` in ${shown(first.file)}).`, `${label}@${version}`);
  return {
    registry, name: published.name, version: picked.version, key: `${registry.id}/${published.name}@${picked.version}`,
    source: 'requirement', file: first.file, requirement: first.requirement, checksum: picked.checksum, hostAssumed: true,
  };
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
  let stated = resolved.source === 'lockfile' ? shown(resolved.file) : registry.id;
  if (!checksum) {
    checksum = (await registry.published(name, fetch)).versions.find(v => v.version === version)?.checksum;
    stated = registry.id;
  }
  if (!readableChecksum(checksum)) throw new Error(`neither ${shown(resolved.file)} nor ${registry.id} states a checksum Manki can check the archive of ${key} against`);
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
  /** The most lockfiles, manifests and settings files of the checkout Manki lists. */
  maxListed?: number;
  /** Whether the file system of `dir` tells apart names that differ only in case or Unicode form. */
  caseSensitive?: (dir: string) => boolean;
}

/**
 * Whether the file system of `dir` tells apart names that differ only in case or Unicode form, as Linux does and
 * macOS and Windows by default do not. A probe that cannot be written counts as no.
 */
export function caseSensitiveFs(dir: string): boolean {
  let probe: string | undefined;
  try {
    probe = mkdtempSync(join(dir, 'case-'));
    writeFileSync(join(probe, 'a\u00e9'), '');
    return !existsSync(join(probe, 'A\u00e9')) && !existsSync(join(probe, 'ae\u0301'));
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
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
    archiveLimits = {}, maxManifestBytes = MAX_LOCKFILE_BYTES, maxManifestTotalBytes = MAX_LOCKFILES_TOTAL_BYTES, maxListed = MAX_LISTED,
    caseSensitive = caseSensitiveFs,
  }: DependencyLoaderOptions = {},
): (spec: string) => Promise<DependencyCheckout> {
  // A folder of its own, so a package's markers never meet a related repository's of the same name.
  stateDir = dependencyState(stateDir);
  mkdirSync(stateDir, { recursive: true });
  // A folder named like one registry's build output, such as `target`, is an ordinary folder to the others.
  const isRead = (path: string) => registries.some(r => ([...r.manifests, ...r.lockfiles, ...r.unreadInstallFiles].includes(posix.basename(path)) || r.isConfigFile(path))
    && !(r.buildFolder !== undefined && path.split('/').includes(r.buildFolder)));
  // Only files git tracks count, since only those are the PR's.
  let listing: Promise<Listing> | undefined;
  const listed = (): Promise<Listing> => listing ??= trackedFiles(root, [], []).then((all): Listing => {
    const refused = (cut: string): Listing => ({ files: [], installed: [], cut });
    if (!all) return refused('Manki could not list the files of the checkout, so it cannot tell which code the PR runs');
    // `closed_paths` deletes files from the checkout and its index, so a closed lockfile, setting or committed copy looks absent.
    let removed: string[];
    let removedSubmodules: string[];
    try {
      removed = removedPathsOf(root);
      removedSubmodules = removedSubmodulesOf(root);
    } catch {
      return refused('Manki could not read which files `closed_paths` removed from the checkout, so it cannot tell which code the PR runs');
    }
    if (removedSubmodules.length > 0) return refused(`\`closed_paths\` removed the git submodule ${shown(removedSubmodules[0])} from the checkout, whose files Manki does not list, so it cannot tell which code the PR runs`);
    const closed = removed.find(path => isRead(path) || INSTALLED_COPY.test(path));
    if (closed) return refused(`\`closed_paths\` removed ${shown(closed)} from the checkout, and that path can decide which code the PR runs`);
    // A submodule holds files the checkout does not list, such as a lockfile, a setting or a whole package.
    const submodule = all.find(f => f.submodule);
    if (submodule) return refused(`the checkout holds ${shown(submodule.path)} as a git submodule, whose files Manki does not list, so it cannot tell which code the PR runs`);
    const installed = all.filter(f => INSTALLED_COPY.test(f.path)).map(f => f.path);
    // The files of a committed `node_modules` only show whether it holds the package, so they are neither read nor counted.
    const tracked = all.filter(f => !f.path.split('/').includes('node_modules'));
    // An install follows a symlink, which can hold a lockfile, a setting or a whole folder of them where Manki does not look.
    const plainFiles = new Set(tracked.filter(f => !f.symlink).map(f => f.path));
    const link = tracked.find(f => f.symlink && (isRead(f.path) || !linksToPlainFile(root, f.path, plainFiles)));
    if (link) return refused(`the checkout holds ${shown(link.path)} as a symlink, which Manki does not follow, so it cannot tell which code the PR runs`);
    const files = [...plainFiles].filter(isRead);
    return files.length > maxListed
      ? { files, installed, cut: `the checkout holds more than ${maxListed} lockfiles, manifests and settings files, the most Manki lists, so it cannot tell which code the PR runs` }
      : { files, installed };
  });
  // A resolution reads every lockfile and manifest and can fetch a version list, so the round does it once per name.
  const resolutions = join(stateDir, 'resolutions');
  const resolving = new Map<string, Promise<Resolved>>();
  const resolve = (spec: string, registry: Registry, name: string, version: string | undefined): Promise<Resolved> => {
    const cached = join(resolutions, `${encodeURIComponent(spec)}.json`);
    if (existsSync(cached)) return Promise.resolve({ ...(JSON.parse(readFileSync(cached, 'utf8')) as Omit<Resolved, 'registry'>), registry });
    const pending = resolving.get(spec) ?? listed()
      .then(listing => resolveDependency(root, listing, registry, name, version, registryFetch(registry, timeoutMs), { each: maxManifestBytes, left: maxManifestTotalBytes }))
      .then(resolved => {
        const { registry: _registry, ...kept } = resolved;
        mkdirSync(resolutions, { recursive: true });
        writeMarker(cached, JSON.stringify(kept));
        return resolved;
      }, (error: unknown) => {
        // A registry that failed may answer the next call, so a failure is not kept.
        resolving.delete(spec);
        throw error;
      });
    resolving.set(spec, pending);
    return pending;
  };
  // Names in a package or a checkout that differ only in case or Unicode form would land on one file, so a package
  // could read as other code than it holds. Such a file system turns dependency reading off for the run.
  let sensitive: boolean | undefined;
  return async spec => {
    const started = Date.now();
    const left = () => callLimitMs - (Date.now() - started);
    const { registry, name, version } = parseSpec(spec, registries);
    let resolved: Resolved;
    try {
      sensitive ??= caseSensitive(stateDir);
      if (!sensitive) {
        throw new UnreadPackage(
          `Manki does not read ${registry.id}/${name}: this run's file system does not tell apart names that differ only in case or Unicode form, so files of a package could overwrite each other. Dependency reading is off for the run.`,
          `${registry.id}/${name}`, { registry: registry.id, name }, true,
        );
      }
      resolved = await resolve(spec, registry, name, version);
    } catch (error) {
      if (error instanceof UnreadPackage) recordUnread(stateDir, error);
      throw error;
    }
    const { key, source, file, requirement } = resolved;
    const origin: PackageOrigin = { registry: registry.id, name: resolved.name, version: resolved.version, source, file, ...(requirement && { requirement }) };
    const marker = join(stateDir, encodeURIComponent(key));
    // The fetch gets its own whole time. When a slow resolution left too little of the call for it, the next call
    // fetches, since the round keeps the resolution.
    if (!existsSync(`${marker}.done`) && left() - WAIT_SLACK_MS < timeoutMs) {
      throw new Error(`Manki resolved ${key}, but this call has too little time left to fetch it. Name it again in your next call.`);
    }
    let dir: string;
    try {
      // The call limit counts from the start of the call, so the time spent resolving the version leaves less to wait.
      dir = await sharedCheckout(key, marker, { timeoutMs, callLimitMs: left() }, async () => {
        writeMarker(`${marker}.from`, JSON.stringify(origin));
        claimPackagePlace(stateDir, marker, maxPackages);
        // A fresh deadline, so a call that takes over a stopped fetch gets the whole time, within what the call has left.
        const deadline = AbortSignal.timeout(Math.max(0, Math.min(timeoutMs, left() - WAIT_SLACK_MS)));
        try {
          return { dir: await fetchPackage(resolved, stateDir, registryFetch(registry, timeoutMs, deadline), marker, maxArchiveBytes, archiveLimits), commit: '' };
        } catch (error) {
          // Running out of time, or a registry error that may pass, says nothing about the package, so a later call may try again.
          throw deadline.aborted || error instanceof TransientDownloadError ? new RetryableFetch(error instanceof Error ? error.message : String(error)) : error;
        }
      });
    } catch (error) {
      if (error instanceof RelatedRepoPending) throw new Error(`${key} ${error.message}`);
      if (error instanceof PackageCapReached) throw new Error(`Manki did not read ${key}: ${error.message}.`);
      throw new Error(`${key} could not be fetched, so it cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const from = source === 'lockfile'
      ? `the version \`${shown(file)}\` locks`
      : `the version a fresh install picks for the requirement \`${shown(requirement!)}\` in \`${shown(file)}\`, since no committed lockfile locks it`;
    const host = resolved.hostAssumed ? ` No file of the PR sets another registry for it, so Manki read it from ${registry.id}.` : '';
    return { key, dir, note: `Manki read \`${key}\`, ${from}.${host} Cite its lines as \`${key}:path:line\`.` };
  };
}

/** The folder of the round's `stateDir` that holds the markers, resolutions and archives of its dependencies. */
function dependencyState(stateDir: string): string {
  return join(stateDir, DEPENDENCY_STATE);
}

/**
 * Returns each package a tool server of the round in `stateDir` tried to read: its version and where that came from,
 * and whether it was fetched, failed with the reason, was refused with the reason, or its archive did not match its
 * checksum. Warns about each one that was not read. A package whose versions could not be fetched to resolve it, and
 * that a later call read, shows only as read.
 */
export function dependencyOutcomes(roundStateDir: string): RoundDependencySource[] {
  const stateDir = dependencyState(roundStateDir);
  if (!existsSync(stateDir)) return [];
  const files = new Set(readdirSync(stateDir));
  const records = [...files].filter(f => f.endsWith('.from')).sort().map(f => {
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
    return record;
  });
  const read = records.filter(r => r.status === 'fetched');
  const sameName = (a: RoundDependencySource, b: RoundDependencySource) => a.registry === b.registry && (REGISTRIES.find(r => r.id === a.registry)?.sameName(a.name, b.name) ?? a.name === b.name);
  return records.filter(record => {
    // Only a failure to resolve has no version, and a later call that read the package outdates it.
    const outdated = record.status === 'failed' && record.version === undefined && read.some(r => sameName(r, record));
    if (!outdated && record.status !== 'fetched') core.warning(`Could not read the dependency ${record.package}: ${record.reason ?? record.status}`);
    return !outdated;
  });
}
