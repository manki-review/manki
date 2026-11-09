import * as core from '@actions/core';
import { posix } from 'path';
import { isMap, isScalar, LineCounter, parseDocument } from 'yaml';

import { addedLines } from './diff';
import { DiffFile, ParsedDiff, StaticSignal } from './types';

/** The most characters the package lists of one PR take. A lockfile past it stays unread, so a person reviews it. */
const MAX_LIST_CHARS = 100_000;

/**
 * One entry of a lockfile: a package, or something only listed, such as a workspace project or the file's settings.
 * Every field Manki does not name here is kept in `fields`, flattened to `path: value` pairs, so no change goes unlisted.
 */
interface LockEntry {
  key?: string;
  /** Whether the suspicious-change checks apply. */
  isPackage: boolean;
  name: string;
  version: string;
  source?: string;
  checksum?: string;
  fields: Map<string, string>;
  /** Line in the file where the entry starts. */
  line?: number;
}

type Parser = (text: string) => LockEntry[];

const PARSERS: Readonly<Record<string, Parser>> = {
  'Cargo.lock': parseCargoLock,
  'package-lock.json': parseNpmLock,
  'npm-shrinkwrap.json': parseNpmLock,
  'yarn.lock': parseYarnLock,
  'pnpm-lock.yaml': parsePnpmLock,
};

type PackageFlag = 'source changed' | 'git source' | 'path source' | 'source does not name this package and version'
  | 'checksum changed without a version change' | 'downgrade';

export interface PackageChange {
  kind: 'added' | 'removed' | 'updated' | 'changed';
  name: string;
  oldVersion?: string;
  newVersion?: string;
  oldSource?: string;
  newSource?: string;
  /** The changes to the entry's other fields, one line each. */
  fields: string[];
  flags: PackageFlag[];
  /** An added line of the lockfile's diff inside the entry, or the line the entry starts at. */
  line?: number;
}

/** The package changes Manki read from one lockfile's diff. */
export interface LockfileDiff {
  path: string;
  /** The lockfile's own diff, which `exclude_paths` can leave out of the reviewed one. */
  file: DiffFile;
  changes: PackageChange[];
}

/** Whether Manki parses `path` into a package list. */
export function isParsedLockfile(path: string): boolean {
  return Object.hasOwn(PARSERS, posix.basename(path));
}

/**
 * Returns the package changes of each changed lockfile Manki parses. `heads` holds each lockfile at the PR head, and
 * the content before the PR is rebuilt from it by undoing the diff. A lockfile that is missing from `heads`, does not
 * match its diff, does not parse, or whose list runs past `MAX_LIST_CHARS` is left out, so it stays unread.
 */
export function readLockfileChanges(fullDiff: ParsedDiff, heads: ReadonlyMap<string, string>): LockfileDiff[] {
  const parsed: LockfileDiff[] = [];
  let chars = 0;
  for (const file of fullDiff.files.filter(f => isParsedLockfile(f.path))) {
    try {
      const head = file.changeType === 'deleted' ? '' : heads.get(file.path);
      if (head === undefined) throw new Error('it could not be read at the PR head');
      const parse = PARSERS[posix.basename(file.path)];
      const before = parseContent(parse, undoDiff(head, file));
      const after = parseContent(parse, head);
      const lockfile = { path: file.path, file, changes: diffEntries(before, after, file) };
      const size = formatLockfile(lockfile).length;
      if (chars + size > MAX_LIST_CHARS) throw new Error(`the package lists would pass ${MAX_LIST_CHARS} characters`);
      chars += size;
      parsed.push(lockfile);
    } catch (error) {
      core.info(`Lockfile ${file.path} stays unread: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return parsed;
}

/** Returns the package lists of `lockfiles` as plain text, one block per file, or an empty string when there is none. */
export function formatLockfileChanges(lockfiles: LockfileDiff[]): string {
  return lockfiles.map(formatLockfile).join('\n\n');
}

/** Returns one Manki alert per package change that needs a reason, on the lockfile line the change sits at. */
export function lockfileSignals(lockfiles: LockfileDiff[]): StaticSignal[] {
  return lockfiles.flatMap(({ path, changes }) => changes.filter(c => c.flags.length > 0).map((c): StaticSignal => ({
    tool: 'Manki', ruleId: 'lockfile-change', severity: 'warning', file: path, line: c.line ?? 1,
    message: `${describeChange(c)}: ${c.flags.join(', ')}. A lockfile change like this needs a reason the PR gives.`,
    source: 'lockfile',
  })));
}

function formatLockfile({ path, changes }: Pick<LockfileDiff, 'path' | 'changes'>): string {
  if (changes.length === 0) return `${clean(path)}\n  no package changes`;
  const lines = changes.flatMap(c => [
    `  ${describeChange(c)}${c.line ? ` (line ${c.line})` : ''}${c.flags.length > 0 ? ` [${c.flags.join(', ')}]` : ''}`,
    ...c.fields.map(f => `    ${clean(f)}`),
  ]);
  return [clean(path), ...lines].join('\n');
}

function describeChange(c: PackageChange): string {
  const words = (...parts: Array<string | undefined>) => parts.filter(Boolean).map(p => clean(p!)).join(' ');
  if (c.kind === 'added') return words('added', c.name, c.newVersion, c.newSource && `from ${c.newSource}`);
  if (c.kind === 'removed') return words('removed', c.name, c.oldVersion);
  const versions = c.kind === 'updated' ? `${c.oldVersion} -> ${c.newVersion}` : c.newVersion;
  const source = showSource(c) ? `, source ${clean(c.oldSource ?? 'none')} -> ${clean(c.newSource ?? 'none')}` : '';
  const checksum = c.flags.includes('checksum changed without a version change') ? ', checksum changed' : '';
  return words(c.kind, c.name, versions) + source + checksum;
}

function showSource(c: PackageChange): boolean {
  return c.flags.some(f => f !== 'downgrade' && f !== 'checksum changed without a version change');
}

/** Keeps a value from the PR on one line, so it cannot pose as another entry of the list. */
function clean(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

function parseContent(parse: Parser, text: string): LockEntry[] {
  return text.trim() ? parse(text) : [];
}

/** Rebuilds a file before `file`'s change from its content after it. Throws when `head` does not match the diff. */
function undoDiff(head: string, file: DiffFile): string {
  const headLines = head.split('\n');
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    // A hunk that adds no line starts after line `newStart`, any other one at it.
    const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    if (start < cursor || start > headLines.length) throw new Error('its diff does not match the file at the PR head');
    out.push(...headLines.slice(cursor, start));
    cursor = start;
    for (const line of hunk.content.split('\n')) {
      if (line.startsWith('\\')) continue;
      const text = line.slice(1);
      if (line.startsWith('-')) {
        out.push(text);
        continue;
      }
      if (headLines[cursor] !== text) throw new Error('its diff does not match the file at the PR head');
      if (!line.startsWith('+')) out.push(text);
      cursor++;
    }
  }
  out.push(...headLines.slice(cursor));
  return out.join('\n');
}

/** Pairs the entries of the two versions of a lockfile and returns what changed, sorted by name. */
function diffEntries(before: LockEntry[], after: LockEntry[], file: DiffFile): PackageChange[] {
  const old = keyed(before);
  const now = keyed(after);
  const pairs: Array<[LockEntry, LockEntry]> = [];
  const added: LockEntry[] = [];
  for (const [key, entry] of now) {
    const prior = old.get(key);
    if (!prior) added.push(entry);
    else if (differs(prior, entry)) pairs.push([prior, entry]);
  }
  const removed = [...old].filter(([key]) => !now.has(key)).map(([, entry]) => entry);
  // A version change moves an entry to a new key. Same-name entries are paired when both sides hold as many.
  const unpaired = { added: [] as LockEntry[], removed: [] as LockEntry[] };
  for (const name of new Set([...added, ...removed].map(e => e.name))) {
    const gone = removed.filter(e => e.name === name).sort(byVersion);
    const come = added.filter(e => e.name === name).sort(byVersion);
    if (gone.length === come.length) gone.forEach((e, i) => pairs.push([e, come[i]]));
    else {
      unpaired.removed.push(...gone);
      unpaired.added.push(...come);
    }
  }
  const lineIn = entryLines(after, file);
  const changes: PackageChange[] = [
    ...pairs.map(([b, a]) => changeOf(b, a, lineIn(a))),
    ...unpaired.added.map((a): PackageChange => ({
      kind: 'added', name: a.name, newVersion: a.version, newSource: a.source, fields: fieldChanges(new Map(), a.fields), flags: a.isPackage ? sourceFlags(a) : [], line: lineIn(a),
    })),
    ...unpaired.removed.map((b): PackageChange => ({ kind: 'removed', name: b.name, oldVersion: b.version, oldSource: b.source, fields: [], flags: [] })),
  ];
  return changes.sort((x, y) => x.name.localeCompare(y.name) || (x.line ?? 0) - (y.line ?? 0));
}

/** Keys each entry by its own key or its name and version, and tells apart two that share one by their source. */
function keyed(entries: LockEntry[]): Map<string, LockEntry> {
  const map = new Map<string, LockEntry>();
  for (const entry of entries) {
    let key = entry.key ?? `${entry.name}@${entry.version}`;
    if (map.has(key)) key = `${key} ${entry.source ?? ''}`;
    if (map.has(key)) throw new Error(`it lists ${key} twice`);
    map.set(key, entry);
  }
  return map;
}

function differs(a: LockEntry, b: LockEntry): boolean {
  return a.name !== b.name || a.version !== b.version || a.source !== b.source || a.checksum !== b.checksum
    || a.fields.size !== b.fields.size || [...a.fields].some(([k, v]) => b.fields.get(k) !== v);
}

function byVersion(a: LockEntry, b: LockEntry): number {
  return compareVersions(a.version, b.version) ?? a.version.localeCompare(b.version);
}

/** Returns where each entry of `entries` shows in `file`'s diff: its first added line, else the line it starts at. */
function entryLines(entries: LockEntry[], file: DiffFile): (entry: LockEntry) => number | undefined {
  const added = [...addedLines(file).keys()];
  const starts = entries.map(e => e.line).filter((l): l is number => l !== undefined).sort((a, b) => a - b);
  return (entry) => {
    if (entry.line === undefined) return undefined;
    const next = starts.find(l => l > entry.line!) ?? Infinity;
    return added.find(l => l >= entry.line! && l < next) ?? entry.line;
  };
}

function changeOf(b: LockEntry, a: LockEntry, line: number | undefined): PackageChange {
  return {
    kind: b.version === a.version ? 'changed' : 'updated',
    name: a.name,
    oldVersion: b.version,
    newVersion: a.version,
    oldSource: b.source,
    newSource: a.source,
    fields: fieldChanges(b.fields, a.fields),
    flags: a.isPackage && b.isPackage ? changeFlags(b, a) : [],
    line,
  };
}

function changeFlags(b: LockEntry, a: LockEntry): PackageFlag[] {
  const flags: PackageFlag[] = [];
  if (b.source !== a.source) {
    if (sourceOrigin(b.source) !== sourceOrigin(a.source)) flags.push('source changed');
    flags.push(...sourceFlags(a));
  }
  if (b.version === a.version && b.checksum !== undefined && b.checksum !== a.checksum) flags.push('checksum changed without a version change');
  if ((compareVersions(a.version, b.version) ?? 0) < 0) flags.push('downgrade');
  return flags;
}

/** Flags a source no registry vouches for: a git repository, a path, or a tarball URL that names another package. */
function sourceFlags(entry: LockEntry): PackageFlag[] {
  const kind = sourceKind(entry.source);
  if (kind === 'git') return ['git source'];
  if (kind === 'path') return ['path source'];
  if (entry.source && /^https?:\/\//i.test(entry.source) && !namesTarball(entry.source, entry.name, entry.version)) return ['source does not name this package and version'];
  return [];
}

const GIT_SOURCE = /^(?:git[+:]|git@|github:|gitlab:|bitbucket:)|\.git(?:[#?]|$)|codeload\.github\.com|#commit=/i;

/** A missing source or one inside the repository is `local`, such as a Cargo workspace member or an npm workspace link. */
function sourceKind(source: string | undefined): 'registry' | 'git' | 'path' | 'local' {
  if (source === undefined || source.startsWith('workspace:')) return 'local';
  if (GIT_SOURCE.test(source)) return 'git';
  if (/^(?:file|link|portal|patch):|^\.\.(?:\/|$)|^\//.test(source)) return 'path';
  return /^[a-z][\w+.-]*:/i.test(source) || source === 'npm' || source === 'registry' ? 'registry' : 'local';
}

/** The part of a source that names where packages come from: the repository of a git source, the host of a URL. */
function sourceOrigin(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (sourceKind(source) === 'git') return source.replace(/[#?].*$/, '');
  return /^https?:\/\/[^/]+/i.exec(source)?.[0].toLowerCase() ?? source;
}

/** Whether a registry tarball URL names `name` and `version`, as `<registry>/<name>/-/<name>-<version>.tgz` does. */
function namesTarball(source: string, name: string, version: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(new URL(source).pathname);
  } catch {
    return false;
  }
  return path.includes(`/${name}/-/`) && path.endsWith(`/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`);
}

/** Compares two versions by semver order, or returns `undefined` when either is not a version. */
function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string) => /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return undefined;
  const na = pa[1].split('.').map(Number);
  const nb = pb[1].split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
  }
  // A prerelease comes before its release.
  if (!pa[2] || !pb[2]) return (pa[2] ? -1 : 0) + (pb[2] ? 1 : 0);
  const ia = pa[2].split('.');
  const ib = pb[2].split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined || ib[i] === undefined) return ia[i] === undefined ? -1 : 1;
    if (ia[i] === ib[i]) continue;
    const numeric = /^\d+$/.test(ia[i]) && /^\d+$/.test(ib[i]);
    return numeric ? Number(ia[i]) - Number(ib[i]) : ia[i].localeCompare(ib[i]);
  }
  return 0;
}

function fieldChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const shown = (key: string, value: string) => value ? `${key} = ${value}` : key;
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(key => {
    const b = before.get(key);
    const a = after.get(key);
    if (b === a) return [];
    if (b === undefined) return [`added ${shown(key, a!)}`];
    if (a === undefined) return [`removed ${shown(key, b)}`];
    return [`changed ${key}: ${b} -> ${a}`];
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optional(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

/** Flattens `value` to `path: value` pairs. A list item becomes a key of its own, so a list compares as a set. */
function flatten(value: unknown, prefix = '', into = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (isObject(item) || Array.isArray(item)) flatten(item, `${prefix}[${i}]`, into);
      else into.set(`${prefix} ${JSON.stringify(item)}`, '');
    });
  } else if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) into.set(prefix, '{}');
    for (const [key, item] of entries) flatten(item, prefix ? `${prefix}.${key}` : key, into);
  } else {
    into.set(prefix, String(value));
  }
  return into;
}

function settingsEntry(fields: Map<string, string>): LockEntry {
  return { key: '(lockfile)', isPackage: false, name: 'lockfile settings', version: '', fields };
}

function take(fields: Map<string, string>, key: string): string | undefined {
  const value = fields.get(key);
  fields.delete(key);
  return value;
}

const TOML_KEY_VALUE = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/;
const TOML_STRING = /"(?:[^"\\]|\\.)*"/g;

/** Parses a `Cargo.lock`: top-level keys and `[[package]]` tables. Any other table or syntax throws. */
function parseCargoLock(text: string): LockEntry[] {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const settings = settingsEntry(new Map());
  const packages: Array<{ fields: Map<string, string>; line: number }> = [];
  let table = settings.fields;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '[[package]]') {
      packages.push({ fields: new Map(), line: i + 1 });
      table = packages.at(-1)!.fields;
      continue;
    }
    const match = TOML_KEY_VALUE.exec(line);
    if (!match) throw new Error(`line ${i + 1} is not a key and value`);
    let value = match[2];
    while (value.startsWith('[') && !value.trimEnd().endsWith(']')) {
      if (++i >= lines.length) throw new Error('a list does not end');
      value += `\n${lines[i]}`;
    }
    for (const [key, item] of tomlValue(match[1], value.trim())) {
      if (table.has(key)) throw new Error(`line ${i + 1} repeats ${key}`);
      table.set(key, item);
    }
  }
  return [settings, ...packages.map(({ fields, line }): LockEntry => {
    const name = take(fields, 'name');
    const version = take(fields, 'version');
    if (!name || !version) throw new Error(`the package at line ${line} has no name or version`);
    return { isPackage: true, name, version, source: take(fields, 'source'), checksum: take(fields, 'checksum'), fields, line };
  })];
}

function tomlValue(key: string, raw: string): Array<[string, string]> {
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) return [[key, JSON.parse(raw) as string]];
  if (/^(?:-?\d+|true|false)$/.test(raw)) return [[key, raw]];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const body = raw.slice(1, -1);
    if (body.replace(TOML_STRING, '').replace(/[\s,]/g, '')) throw new Error(`${key} holds more than strings`);
    return (body.match(TOML_STRING) ?? []).map(item => [`${key} ${item}`, '']);
  }
  throw new Error(`${key} has a value Manki does not read`);
}

/** Parses a `package-lock.json` or `npm-shrinkwrap.json` with a `packages` map, as npm 7 and later write. */
function parseNpmLock(text: string): LockEntry[] {
  const lock: unknown = JSON.parse(text);
  if (!isObject(lock) || !isObject(lock.packages)) throw new Error('it has no `packages` map, which npm 7 and later write');
  // npm 7 and later ignore the legacy `dependencies` map when `packages` is there, and only keep it in step with it.
  const { packages, dependencies: _legacy, ...rest } = lock;
  const lines = npmPackageLines(text);
  return [settingsEntry(flatten(rest)), ...Object.entries(packages).map(([key, value]): LockEntry => {
    if (!isObject(value)) throw new Error(`${key} is not an object`);
    const { name, version, resolved, integrity, ...other } = value;
    const installed = key.lastIndexOf('node_modules/');
    return {
      key,
      // An entry outside `node_modules` is the project or one of its workspaces.
      isPackage: installed >= 0,
      name: optional(name) ?? (installed >= 0 ? key.slice(installed + 'node_modules/'.length) : key || '(root project)'),
      version: optional(version) ?? '',
      source: optional(resolved),
      checksum: optional(integrity),
      fields: flatten(other),
      line: lines.get(key),
    };
  })];
}

/** Returns the line of each key of the `packages` map, which npm writes one level deeper than `packages`, at any indent. */
function npmPackageLines(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  const all = text.split('\n');
  const open = all.findIndex(line => /^\s+"packages": \{/.test(line));
  if (open < 0) return lines;
  const indent = /^\s+/.exec(all[open])![0];
  const child = indent.repeat(2);
  for (let i = open + 1; i < all.length && all[i].trimEnd().replace(/,$/, '') !== `${indent}}`; i++) {
    const key = all[i].startsWith(child) ? /^"((?:[^"\\]|\\.)*)":/.exec(all[i].slice(child.length)) : null;
    if (key) lines.set(JSON.parse(`"${key[1]}"`) as string, i + 1);
  }
  return lines;
}

/** Parses a `yarn.lock`: the YAML of Yarn 2 and later, or the format of Yarn 1. */
function parseYarnLock(text: string): LockEntry[] {
  return /^__metadata:/m.test(text) ? parseYarnBerryLock(text) : parseYarnV1Lock(text);
}

const YARN_TOKEN = String.raw`("(?:[^"\\]|\\.)*"|[^\s"]+)`;
const YARN_PAIR = new RegExp(`^${YARN_TOKEN}\\s+${YARN_TOKEN}$`);

function parseYarnV1Lock(text: string): LockEntry[] {
  const unquote = (token: string) => token.startsWith('"') ? JSON.parse(token) as string : token;
  const entries: LockEntry[] = [];
  let entry: LockEntry | undefined;
  let block: string | undefined;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      if (!line.endsWith(':')) throw new Error(`line ${i + 1} is not an entry`);
      const specs = line.slice(0, -1).split(/,\s*/).map(unquote);
      entry = { isPackage: true, name: packageName(specs[0]), version: '', fields: new Map([['requested', specs.join(', ')]]), line: i + 1 };
      entries.push(entry);
      block = undefined;
      return;
    }
    if (!entry) throw new Error(`line ${i + 1} is outside any entry`);
    if (indent === 2 && line.endsWith(':')) {
      block = unquote(line.slice(0, -1));
      return;
    }
    const pair = YARN_PAIR.exec(line);
    if (!pair || !(indent === 2 || (indent === 4 && block))) throw new Error(`line ${i + 1} is not a key and value`);
    const [key, value] = [unquote(pair[1]), unquote(pair[2])];
    if (indent === 4) {
      entry.fields.set(`${block}.${key}`, value);
      return;
    }
    block = undefined;
    if (key === 'version') entry.version = value;
    else if (key === 'resolved') entry.source = value;
    else if (key === 'integrity') entry.checksum = value;
    else entry.fields.set(key, value);
  });
  for (const e of entries) {
    if (!e.version) throw new Error(`the entry at line ${e.line} has no version`);
    // Lockfiles older than `integrity` keep the checksum in the fragment of `resolved`.
    e.checksum ??= e.source?.split('#')[1];
  }
  return entries;
}

/** Returns the package name of `name@range`, which can start with a scope such as `@types/node@^20`. */
function packageName(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  if (at <= 0) throw new Error(`${spec} names no package`);
  return spec.slice(0, at);
}

function parseYarnBerryLock(text: string): LockEntry[] {
  const { data, lines } = readYaml(text);
  const { __metadata, ...packages } = data;
  const topLines = lines();
  return [settingsEntry(flatten({ __metadata })), ...Object.entries(packages).map(([key, value]): LockEntry => {
    if (!isObject(value)) throw new Error(`${key} is not a map`);
    const { version, resolution, checksum, ...other } = value;
    const resolved = String(resolution ?? '');
    const name = packageName(resolved);
    const ref = resolved.slice(name.length + 1);
    return {
      isPackage: !ref.startsWith('workspace:'),
      name,
      version: optional(version) ?? '',
      source: ref.startsWith('npm:') ? 'npm' : ref,
      checksum: optional(checksum),
      fields: flatten({ requested: key, ...other }),
      line: topLines.get(key),
    };
  })];
}

/** Parses a `pnpm-lock.yaml`. A snapshot's fields join the package it is a snapshot of. */
function parsePnpmLock(text: string): LockEntry[] {
  const { data, lines } = readYaml(text);
  const { packages = {}, snapshots = {}, importers = {}, ...rest } = data;
  if (!isObject(packages) || !isObject(snapshots) || !isObject(importers)) throw new Error('`packages`, `snapshots` or `importers` is not a map');
  const oldKeys = Number.parseFloat(String(rest.lockfileVersion)) < 6;
  const packageLines = lines('packages');
  const importerLines = lines('importers');
  const byKey = new Map<string, LockEntry>();
  for (const [key, value] of Object.entries(packages)) {
    if (!isObject(value)) throw new Error(`${key} is not a map`);
    const { resolution, version, name, ...other } = value;
    const { integrity, tarball, repo, commit, directory, type: _type, ...resolutionRest } = isObject(resolution) ? resolution : {};
    const fromKey = pnpmPackageKey(key, oldKeys);
    const entry: LockEntry = {
      key,
      isPackage: true,
      name: optional(name) ?? fromKey.name,
      version: optional(version) ?? fromKey.version,
      source: optional(tarball) ?? (repo !== undefined ? `git+${String(repo)}#${String(commit)}` : directory !== undefined ? `file:${String(directory)}` : 'registry'),
      checksum: optional(integrity),
      fields: flatten({ ...other, ...(Object.keys(resolutionRest).length > 0 && { resolution: resolutionRest }) }),
      line: packageLines.get(key),
    };
    if (!entry.name) throw new Error(`${key} names no package`);
    byKey.set(key, entry);
  }
  for (const [key, value] of Object.entries(snapshots)) {
    const base = key.replace(/\(.*$/, '');
    const entry = byKey.get(base);
    if (!entry) throw new Error(`the snapshot ${key} has no package`);
    for (const [field, item] of flatten(value, `snapshot${key.slice(base.length)}`)) entry.fields.set(field, item);
  }
  const projects = Object.entries(importers).map(([path, value]): LockEntry => ({
    key: `importer ${path}`, isPackage: false, name: `importer ${path}`, version: '', fields: flatten(value), line: importerLines.get(path),
  }));
  return [settingsEntry(flatten(rest)), ...projects, ...byKey.values()];
}

/** Reads the name and version from a `packages` key: `/name/1.0.0_peer` before lockfile version 6, `name@1.0.0(peer)` from it on. */
function pnpmPackageKey(key: string, oldKeys: boolean): { name: string; version: string } {
  const bare = key.replace(/^\//, '');
  if (oldKeys) {
    const slash = bare.lastIndexOf('/');
    return slash > 0 ? { name: bare.slice(0, slash), version: bare.slice(slash + 1).replace(/_.*$/, '') } : { name: '', version: '' };
  }
  const base = bare.replace(/\(.*$/, '');
  const at = base.indexOf('@', base.startsWith('@') ? 1 : 0);
  return at > 0 ? { name: base.slice(0, at), version: base.slice(at + 1) } : { name: '', version: '' };
}

/** Parses a YAML document whose top level is a map, and returns the line of each key of a top-level map. Aliases throw. */
function readYaml(text: string): { data: Record<string, unknown>; lines: (section?: string) => Map<string, number> } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true });
  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);
  const data: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!isObject(data)) throw new Error('its top level is not a map');
  const lines = (section?: string) => {
    const node = section === undefined ? doc.contents : doc.get(section, true);
    if (!isMap(node)) return new Map<string, number>();
    return new Map(node.items.flatMap(pair => isScalar(pair.key) && pair.key.range
      ? [[String(pair.key.value), lineCounter.linePos(pair.key.range[0]).line] as [string, number]]
      : []));
  };
  return { data, lines };
}
