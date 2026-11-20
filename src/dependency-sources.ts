import * as core from '@actions/core';
import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, posix } from 'path';
import { rcompare, satisfies, valid } from 'semver';

import { ArchiveLimits, extractTarGz } from './archive';
import { lockedPackages, MAX_LOCKFILE_BYTES, MAX_LOCKFILES, MAX_LOCKFILES_TOTAL_BYTES } from './lockfile';
import { resolveInRoot } from './mcp-server';
import { cratesIo } from './registries/crates';
import { npmRegistry } from './registries/npm';
import { shown } from './registries/shown';
import { PublishedVersion, Registry, RegistryConfig, RegistryFetch } from './registries/types';
import { DEPENDENCY_STATE, FETCH_TIMEOUT_MS, fetchOutcome, RelatedRepoPending, RetryableFetch, sharedCheckout, trackedFiles, WAIT_SLACK_MS, writeMarker } from './related-repos';
import { claimStep, STALE_TIMEOUT_MS } from './tool-steps';
import { fetchWhole, matchesIntegrity, TransientDownloadError } from './tool-install';
import { RoundDependencySource } from './types';
import { removedPathsOf } from './workspace';

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

/** Whether `dir` is `ancestor` or lies inside it, both as folders relative to the repository root. */
function within(dir: string, ancestor: string): boolean {
  return ancestor === '.' || dir === ancestor || dir.startsWith(`${ancestor}/`);
}

/** Whether `text` may name the package `name`: it holds the name in any case, with `-` and `_` alike, or an escape that could spell it. */
function mayName(text: string, name: string): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/-/g, '_');
  return text.includes('\\') || plain(text).includes(plain(name));
}

/**
 * Returns the version of `name` that the PR at `root`, with the files `listing` holds, uses, but only when Manki is
 * certain which code the PR runs. A version some lockfile of the registry locks counts. So does the version a fresh
 * install picks for a manifest's requirement, when no lockfile of the registry sits in the manifest's folder or above
 * it. With `version` set it must be one of those. Without it there must be only one. Refuses the package, recorded as
 * refused, when the listing was cut, a file that can lock, require or override it could not be read with certainty,
 * any lockfile locks it from another source or with a patch, any manifest or setting overrides or patches it, a
 * setting may take it from another registry, a manifest that requires it sits beside an install file Manki does not
 * read or under a lockfile that does not lock it, or a fresh install may pick another version than the highest.
 * Throws, naming why, when the PR does not use the package, uses another version, or uses several and `version` names
 * none.
 */
async function resolveDependency(
  root: string, { files, installed, cut }: Listing, registry: Registry, name: string, version: string | undefined, fetch: RegistryFetch, budget: ReadBudget,
): Promise<Resolved> {
  const label = `${registry.id}/${name}`;
  // Each reason passes the PR's own text, such as a path or a source, through `shown`, as the registries' reasons do.
  const refuse = (reason: string, origin: Partial<PackageOrigin> = {}): never => {
    throw new UnreadPackage(`Manki does not read ${label}: ${reason}.`, label, { registry: registry.id, name, ...origin }, true);
  };
  const uncertain = (file: string, error: unknown): never => refuse(`Manki cannot read ${shown(file)} with certainty: ${shown(error instanceof Error ? error.message : String(error))}`, { file });
  if (cut) refuse(cut);
  const read = (file: string, what: string): string => readManifest(root, file, budget) ?? refuse(`Manki could not read ${shown(file)}, which can ${what}, within its size limits`, { file });
  // A file that does not parse refuses the package, unless `ifUnrelated` is given and the file cannot name it.
  const certain = <T>(file: string, text: string, parse: () => T, ifUnrelated?: T): T => {
    try {
      return parse();
    } catch (error) {
      return ifUnrelated !== undefined && !mayName(text, name) ? ifUnrelated : uncertain(file, error);
    }
  };

  const configs = files.filter(f => registry.isConfigFile(f)).map((file): RegistryConfig => ({ file, text: read(file, 'change where packages come from') }));
  for (const config of configs) {
    // A setting can change every package without naming one, so one Manki cannot read refuses any package.
    let overridden: string | undefined;
    try {
      overridden = registry.overriddenBy(name, [config]);
    } catch (error) {
      uncertain(config.file, error);
    }
    if (overridden) refuse(overridden, { file: config.file });
  }
  const otherRegistry = registry.otherRegistry(name, configs);

  // An install file Manki does not read, such as a `bun.lock`, can decide the packages of its folder tree. A lockfile
  // above it can lock the packages of that tree too, so it counts for a lockfile in either direction.
  const unreadInstall = files.filter(f => registry.unreadInstallFiles.includes(posix.basename(f)));
  const copy = registry.installedCopy(installed, name);
  if (copy) refuse(`the checkout holds ${shown(copy)}, which the project runs in place of the archive ${registry.id} publishes`);
  const unreadIn = (dir: string, below = false) => unreadInstall.find(f => within(dir, posix.dirname(f)) || (below && within(posix.dirname(f), dir)));
  const lockfiles = files.filter(f => registry.lockfiles.includes(posix.basename(f)));
  // A lockfile past the cap may lock the package too, so the listing cannot settle it.
  if (lockfiles.length > MAX_LOCKFILES) refuse(`the checkout holds ${lockfiles.length} lockfiles, more than the ${MAX_LOCKFILES} Manki reads`);
  const locked = lockfiles.flatMap(file => {
    const text = read(file, 'lock it');
    return certain(file, text, () => lockedPackages(file, text), []).filter(p => registry.sameName(p.name, name)).map(p => ({ ...p, file }));
  });
  // Any entry of the name whose code is not the registry's archive refuses the name, since a call site may use it.
  for (const p of locked) {
    const reason = !VERSION.test(p.version) ? `${shown(p.file)} locks it at a version Manki does not read`
      : !registry.isRegistrySource(p.source, p.name, p.version) ? `${shown(p.file)} locks it from ${shown((p.source ?? 'this repository').slice(0, 200))}, not from ${registry.id}`
        : p.patched ? `${shown(p.file)} locks it with a patch applied, so the PR does not run the code ${registry.id} publishes`
          // npm and Yarn fetch an entry that names the public registry from the one the settings give, so the host proves nothing.
          : otherRegistry !== undefined ? `it may come from another registry than ${registry.id}, since ${otherRegistry}`
            : unreadIn(posix.dirname(p.file), true) !== undefined ? `${shown(p.file)} locks it, and ${shown(unreadIn(posix.dirname(p.file), true)!)}, which Manki does not read, can decide what an install there gets`
              : undefined;
    if (reason) refuse(reason, { ...(VERSION.test(p.version) && { version: p.version }), source: 'lockfile', file: p.file });
  }

  const manifests = files.filter(f => registry.manifests.includes(posix.basename(f))).map((file): RegistryConfig => ({ file, text: read(file, 'require or override it') }));
  const texts = new Map([...configs, ...manifests].map(({ file, text }) => [file, text]));
  // Whether the manifest in `dir` belongs to the project of `lockfile`: always when it sits beside it, and else only as
  // a provable member of that project's workspace.
  const belongs = (lockfile: string, dir: string, file: string): boolean => {
    if (posix.dirname(lockfile) === dir) return true;
    try {
      return registry.isWorkspaceMember(lockfile, dir, path => texts.get(path));
    } catch (error) {
      return uncertain(file, error);
    }
  };
  const requirements = manifests.flatMap(({ file, text }) => {
    const { requirements: stated, overridden, otherSource, lockedElsewhere } = certain(file, text, () => registry.manifest(text, name), registry.manifestsChangeAll ? undefined : { requirements: [] });
    if (overridden) refuse(`${shown(file)} changes its code for an install: ${overridden}`, { file });
    if (otherSource) refuse(`${shown(file)} does not take it from ${registry.id}: ${otherSource}`, { file });
    if (stated.length === 0) return [];
    const dir = posix.dirname(file);
    const origin = { name: stated[0].name, source: 'requirement' as const, file, requirement: stated[0].requirement };
    const installFile = unreadIn(dir);
    if (installFile) refuse(`${shown(file)} requires it, and ${shown(installFile)}, which Manki does not read, can decide what an install there gets`, origin);
    // A manifest under a lockfile takes its versions from the nearest one, but only as part of that lockfile's project.
    // A lockfile further up that also counts it as a member leaves Manki unsure which of the two an install reads.
    // By depth, since the root's `.` is as long as a one-letter folder.
    const depth = (lockfile: string) => (posix.dirname(lockfile) === '.' ? 0 : posix.dirname(lockfile).split('/').length);
    const covering = lockfiles.filter(f => within(dir, posix.dirname(f))).sort((a, b) => depth(b) - depth(a));
    if (covering.length > 0) {
      const nearest = posix.dirname(covering[0]);
      // Each lockfile there must count the manifest, since Manki cannot tell which of them an install reads.
      const own = covering.filter(f => posix.dirname(f) === nearest);
      const outside = own.find(f => !belongs(f, dir, file));
      if (outside) refuse(`${shown(file)} requires it, and Manki cannot tell that it belongs to the project ${shown(outside)} locks`, origin);
      const further = covering.find(f => posix.dirname(f) !== nearest && belongs(f, dir, file));
      if (further) refuse(`${shown(file)} requires it, and both ${shown(own[0])} and ${shown(further)} can lock that manifest's versions`, origin);
      const lockedHere = locked.filter(p => own.includes(p.file));
      if (lockedHere.length === 0) refuse(`${shown(file)} requires it, but ${shown(own[0])}, which locks that manifest's versions, does not lock it`, origin);
      // An install drops a locked version the requirement no longer allows, so the lockfile does not show what it gets.
      for (const { requirement } of stated) {
        const range = registry.range(requirement);
        if (range === undefined) refuse(`${shown(file)} requires it as \`${shown(requirement)}\`, a form Manki does not read with certainty`, { ...origin, requirement });
        if (!lockedHere.some(p => satisfies(p.version, range!))) refuse(`${shown(file)} requires it as \`${shown(requirement)}\`, which no version ${shown(own[0])} locks meets`, { ...origin, requirement });
      }
      return [];
    }
    if (lockedElsewhere) refuse(`${shown(file)} requires it, but ${lockedElsewhere}`, origin);
    return stated.map(r => ({ ...r, file }));
  });
  if (requirements.length > 0) {
    const { file, requirement } = requirements[0];
    const origin = { name: requirements[0].name, source: 'requirement' as const, file, requirement };
    if (otherRegistry !== undefined) refuse(`it may come from another registry than ${registry.id}, since ${otherRegistry}`, origin);
    const unread = requirements.find(r => registry.range(r.requirement) === undefined);
    if (unread) refuse(`${shown(unread.file)} requires it as \`${shown(unread.requirement)}\`, a form Manki does not read with certainty`, { ...origin, file: unread.file, requirement: unread.requirement });
    let fresh: string | undefined;
    try {
      fresh = registry.freshPick([...configs, ...manifests]);
    } catch (error) {
      refuse(`Manki cannot tell which version a fresh install picks: ${shown(error instanceof Error ? error.message : String(error))}`, origin);
    }
    if (fresh) refuse(fresh, origin);
  }
  if (locked.length === 0 && requirements.length === 0) throw new Error(`${label} is not a dependency in the PR's manifests or lockfiles, so Manki does not read it.`);

  const candidates: Array<Omit<Resolved, 'registry' | 'key' | 'name'>> = locked.map(p => ({
    version: p.version, source: 'lockfile' as const, file: p.file, ...(p.checksum && { checksum: p.checksum }), ...(!registry.namesHost(p.source) && { hostAssumed: true as const }),
  }));
  let own = locked[0]?.name ?? name;
  if (requirements.length > 0 && !(version && candidates.some(c => c.version === version))) {
    const first = requirements[0];
    let published: Awaited<ReturnType<Registry['published']>>;
    try {
      // The registry files a package under its own spelling, which the manifest holds and the call may not.
      published = await registry.published(first.name, fetch);
    } catch (error) {
      const origin: PackageOrigin = { registry: registry.id, name: first.name, source: 'requirement', file: first.file, requirement: first.requirement };
      throw new UnreadPackage(`Manki could not read the published versions of ${label} to resolve its requirement: ${error instanceof Error ? error.message : String(error)}`, `${registry.id}/${first.name}`, origin, false);
    }
    // The registry's spelling of the name reaches the key and the note, so it must be a name of the same package.
    if (!registry.validName(published.name) || !registry.sameName(published.name, first.name)) throw new Error(`${registry.id} lists ${label} under a name Manki does not read.`);
    own = published.name;
    for (const { file, requirement } of requirements) {
      const range = registry.range(requirement);
      const picked = range === undefined ? undefined : pickVersion(published.versions, range, published.latest);
      if (picked) candidates.push({ version: picked.version, source: 'requirement', file, requirement, checksum: picked.checksum, hostAssumed: true });
    }
  }
  const where = (c: typeof candidates[number]) => c.source === 'lockfile' ? `locked in ${shown(c.file)}` : `resolved from \`${shown(c.requirement!)}\` in ${shown(c.file)}`;
  if (candidates.length === 0) {
    throw new Error(`No published version of ${label} matches what the PR requires: ${requirements.map(r => `\`${shown(r.requirement)}\` in ${shown(r.file)}`).join(', ')}.`);
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
    try {
      removed = removedPathsOf(root);
    } catch {
      return refused('Manki could not read which files `closed_paths` removed from the checkout, so it cannot tell which code the PR runs');
    }
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
      : `the version a fresh install picks for the requirement \`${shown(requirement!)}\` in \`${shown(file)}\`, since no lockfile covers that manifest`;
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
