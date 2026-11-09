import * as core from '@actions/core';
import * as github from '@actions/github';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { minimatch } from 'minimatch';

import { callTokenService } from './auth';
import { Finding, FindingSeverity, MemorySkipReason, SECURITY_TAG, UNBUILT_TAG, UNPROVEN_TAG } from './types';
import { redactSecrets, redactSecretsDeep } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;

export interface Suppression {
  id: string;
  pattern: string;
  file_glob?: string;
  reason: string;
  created_by: string;
  created_at: string;
  pr_ref: string;
  last_matched?: string;
}

export interface Learning {
  id: string;
  content: string;
  scope: 'repo' | 'global';
  /** The file the learning holds for. Unset holds for the whole repo. */
  path?: string;
  source: string;
  created_at: string;
  last_used?: string;
}

export interface RepoMemory {
  learnings: Learning[];
  suppressions: Suppression[];
}

/** The raw text of each memory file a review reads, or `null` for a missing file. */
interface MemoryTexts {
  learnings: string | null;
  suppressions: string | null;
  globalLearnings: string | null;
  globalConventions: string | null;
}

interface StoredFile {
  sha?: string;
  /** Decoded content, or `null` when the file is missing or too large to read. */
  text: string | null;
}

/** Where a repo's review memory lives. `file` names a file of the repo's own folder, such as `learnings.yml`. */
export interface MemoryStore {
  /** Names the memory repository in log lines. */
  readonly name: string;
  load(): Promise<MemoryTexts>;
  read(file: string): Promise<StoredFile>;
  /** Replaces `file`, read at `sha`. Returns `false` when the file changed since it was read. */
  write(file: string, content: string, sha: string | undefined, message: string): Promise<boolean>;
  /** Appends `lines` to `file`, creating it when missing. */
  append(file: string, lines: string[], message: string): Promise<void>;
}

/** Why a run may not use memory. `message` names the reason and the fix, for the log and the review body. */
export interface MemorySkip {
  reason: MemorySkipReason;
  message: string;
}

/** The token service refused a memory request with 403, so the run may not use memory. */
export class MemoryRefusedError extends Error {
  readonly skip: MemorySkip = {
    reason: 'refused',
    message: 'the token service refused memory for this run (HTTP 403). Check that the Manki service started the run, or use a memory repo of your own with `memory.repo` and `memory_repo_token`.',
  };

  constructor(endpoint: string) {
    super(`the token service answered 403 to \`/memory/${endpoint}\``);
    this.name = 'MemoryRefusedError';
  }
}

/** Whether `owner/repo` is private, from the event when it says, else from the API. A failed lookup counts as private. */
async function isPrivateRepo(octokit: Octokit, owner: string, repo: string): Promise<boolean> {
  const fromEvent: unknown = github.context.payload.repository?.private;
  if (typeof fromEvent === 'boolean') return fromEvent;
  try {
    return (await octokit.rest.repos.get({ owner, repo })).data.private;
  } catch (error) {
    core.warning(`Could not read whether ${owner}/${repo} is private, so it counts as private: ${error}`);
    return true;
  }
}

/** Why the private repo `owner/repo` may not keep memory in `memoryRepo`, read with `memoryOctokit`, or `undefined` when it may. */
async function privateMemoryRepoSkip(memoryOctokit: Octokit, memoryRepo: string, owner: string, repo: string): Promise<MemorySkip | undefined> {
  const [memoryOwner, memoryName] = memoryRepo.split('/');
  let data: { private: boolean; owner: { login: string } };
  try {
    ({ data } = await memoryOctokit.rest.repos.get({ owner: memoryOwner, repo: memoryName }));
  } catch (error) {
    core.info(`Could not read ${memoryRepo}: ${error}`);
    return { reason: 'memory_repo_unreadable', message: `\`memory_repo_token\` cannot read \`${memoryRepo}\`, so Manki cannot check that it is private. Give the token access to \`${memoryRepo}\`.` };
  }
  if (!data.private) {
    return { reason: 'memory_repo_public', message: `\`${memoryRepo}\` is not private, and a private repo keeps its memory only in a private memory repo. Make \`${memoryRepo}\` private, or set \`memory.repo\` to a private one.` };
  }
  if (data.owner.login.toLowerCase() !== owner.toLowerCase()) {
    return { reason: 'memory_repo_other_owner', message: `\`${memoryRepo}\` belongs to another owner than \`${owner}/${repo}\`. Set \`memory.repo\` to a private memory repo of \`${owner}\`.` };
  }
  return undefined;
}

/**
 * Opens `owner/repo`'s memory for the run on PR or issue `pr`. Returns nothing when memory is off, the store, or why
 * the run may not use memory, which is also logged as a warning. A public repo uses `memory.repo` with
 * `memory_repo_token`, or else the central memory repository through the token service. A private repo never uses the
 * central one, and uses `memory.repo` only when the API shows it is private and has the same owner.
 */
export async function openMemoryStore(
  octokit: Octokit, memory: { enabled: boolean; repo: string } | undefined, owner: string, repo: string, pr: number,
): Promise<{ store?: MemoryStore; skip?: MemorySkip }> {
  if (!memory?.enabled) return {};
  const skipped = (skip: MemorySkip) => {
    core.warning(`Memory is skipped: ${skip.message}`);
    return { skip };
  };
  const token = core.getInput('memory_repo_token');
  const isPrivate = await isPrivateRepo(octokit, owner, repo);
  if (memory.repo) {
    if (!token) {
      const fix = isPrivate ? '' : ', or remove `memory.repo` to use the central memory';
      return skipped({ reason: 'no_token', message: `\`memory.repo\` is \`${memory.repo}\` but \`memory_repo_token\` is not set. Pass a token that writes \`${memory.repo}\` in \`memory_repo_token\`${fix}.` });
    }
    const memoryOctokit = github.getOctokit(token);
    const skip = isPrivate ? await privateMemoryRepoSkip(memoryOctokit, memory.repo, owner, repo) : undefined;
    return skip ? skipped(skip) : { store: repoMemoryStore(memoryOctokit, memory.repo, repo) };
  }
  if (isPrivate) {
    return skipped({ reason: 'private_repo', message: 'this repo is private, and the central memory repository keeps only public repos\' memory. Set `memory.repo` to a private memory repo of the same owner, and pass `memory_repo_token`.' });
  }
  if (token) core.warning('`memory_repo_token` is set without `memory.repo`, so it is unused and memory comes from the central memory repository. Set `memory.repo` to keep using your own memory repository, such as `<owner>/review-memory`.');
  return { store: serviceMemoryStore(owner, repo, pr) };
}

/** The memory in the folder `folder` of `memoryRepo`, read and written with `octokit`. */
function repoMemoryStore(octokit: Octokit, memoryRepo: string, folder: string): MemoryStore {
  const [owner, repo] = memoryRepo.split('/');
  const get = (path: string) => fetchStoredFile(octokit, owner, repo, path);
  const store: MemoryStore = {
    name: memoryRepo,
    async load() {
      const [learnings, suppressions, globalLearnings, globalConventions] = await Promise.all(
        [`${folder}/learnings.yml`, `${folder}/suppressions.yml`, '_global/learnings.yml', '_global/conventions.md'].map(async path => (await get(path)).text),
      );
      return { learnings, suppressions, globalLearnings, globalConventions };
    },
    read: file => get(`${folder}/${file}`),
    async write(file, content, sha, message) {
      try {
        await octokit.rest.repos.createOrUpdateFileContents({
          owner, repo, path: `${folder}/${file}`, message, content: Buffer.from(content).toString('base64'), sha,
        });
        return true;
      } catch (error: unknown) {
        if ((error as { status?: number }).status === 409) return false;
        throw error;
      }
    },
    append: (file, lines, message) => updateFile(store, file, current => ({ content: `${current ?? ''}${lines.map(line => `${line}\n`).join('')}`, message })),
  };
  return store;
}

type ServiceFile = { text?: unknown; sha?: unknown } | null | undefined;

/** The file in a `/memory/read` reply. A file with a sha but no text is one that exists and could not be read. */
function serviceFile(file: ServiceFile): StoredFile {
  return typeof file?.sha === 'string' ? { sha: file.sha, text: typeof file.text === 'string' ? file.text : null } : { text: null };
}

/** The memory the token service keeps for `owner/repo` in the central memory repository, for the run on `pr`. */
function serviceMemoryStore(owner: string, repo: string, pr: number): MemoryStore {
  const call = async (endpoint: string, body: object) => {
    const response = await callTokenService(`memory/${endpoint}`, { owner, repo, pr, ...body });
    if (!response) throw new Error('the run has no OIDC token for the token service');
    if (response.status === 403) throw new MemoryRefusedError(endpoint);
    return response;
  };
  const failed = (endpoint: string, status: number) => new Error(`the token service answered ${status} to \`/memory/${endpoint}\``);
  const read = async () => {
    const response = await call('read', {});
    if (!response.ok) throw failed('read', response.status);
    return (response.data ?? {}) as { repo?: Record<string, ServiceFile>; global?: Record<string, ServiceFile> };
  };
  return {
    name: 'the central memory',
    async load() {
      const { repo: own, global } = await read();
      return {
        learnings: serviceFile(own?.['learnings.yml']).text,
        suppressions: serviceFile(own?.['suppressions.yml']).text,
        globalLearnings: serviceFile(global?.['learnings.yml']).text,
        globalConventions: serviceFile(global?.['conventions.md']).text,
      };
    },
    read: async file => serviceFile((await read()).repo?.[file]),
    async write(file, content, sha, message) {
      const response = await call('write', { file, content, sha: sha ?? null, message });
      if (response.status === 409) return false;
      if (!response.ok) throw failed('write', response.status);
      return true;
    },
    async append(file, lines, message) {
      const response = await call('append', { file, lines, message });
      if (!response.ok) throw failed('append', response.status);
    },
  };
}

/** Parses a YAML list, or returns an empty one for a missing or malformed file. */
function parseYamlList<T>(text: string | null): T[] {
  if (text === null) return [];
  try {
    const parsed: unknown = parseYaml(text);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

/** Loads the repo's learnings and suppressions, with the global learnings and conventions. */
export async function loadMemory(store: MemoryStore): Promise<RepoMemory> {
  const texts = await store.load();
  const learnings = [...parseYamlList<Learning>(texts.learnings), ...parseYamlList<Learning>(texts.globalLearnings)];
  if (texts.globalConventions) {
    learnings.push({
      id: 'global-conventions',
      content: texts.globalConventions,
      scope: 'global',
      source: '_global/conventions.md',
      created_at: '',
    });
  }

  return {
    learnings,
    suppressions: parseYamlList<Suppression>(texts.suppressions),
  };
}

/** Severities that are allowed to be suppressed by stored suppressions. */
const SUPPRESSIBLE_SEVERITIES: ReadonlySet<FindingSeverity> = new Set<FindingSeverity>(['warning', 'suggestion', 'nitpick']);

/**
 * Splits the judge's findings into the ones stored suppressions hide and the rest.
 * A blocker, a security finding at any severity and a tool alert are never hidden. Neither is a blocker posted as a
 * warning because it cited no proof (`UNPROVEN_TAG`) or claims a build failure CI does not report (`UNBUILT_TAG`), nor a
 * finding a refutation checked.
 */
export function applySuppressions(
  findings: Finding[],
  suppressions: Suppression[],
): { kept: Finding[]; suppressed: Finding[] } {
  const kept: Finding[] = [];
  const suppressed: Finding[] = [];

  for (const finding of findings) {
    const lowered = [UNPROVEN_TAG, UNBUILT_TAG].some(tag => finding.tags?.includes(tag)) || !!(finding.refutation ?? finding.pairRefutation);
    if (!SUPPRESSIBLE_SEVERITIES.has(finding.severity) || finding.tags?.includes(SECURITY_TAG) || lowered || finding.toolSource) {
      kept.push(finding);
      continue;
    }

    const match = suppressions.find(s => matchesSuppression(finding, s));
    if (match) {
      core.info(`Suppressed finding "${finding.title}" — matched suppression "${match.id}": ${match.reason}`);
      suppressed.push({ ...finding, suppressedBy: match.id });
    } else {
      kept.push(finding);
    }
  }

  return { kept, suppressed };
}

/** Whether a suppression `pattern` hides a finding titled `title`, regardless of its file. */
export function patternMatchesTitle(pattern: string, title: string): boolean {
  const patternLower = pattern.toLowerCase();
  return patternLower.length >= 3 && title.toLowerCase().includes(patternLower);
}

export function matchesSuppression(finding: Finding, suppression: Suppression): boolean {
  if (!patternMatchesTitle(suppression.pattern, finding.title)) {
    return false;
  }

  if (suppression.file_glob && finding.file) {
    if (!minimatch(finding.file, suppression.file_glob, { matchBase: true })) {
      return false;
    }
  }

  return true;
}

const MAX_MEMORY_FIELD_LENGTH = 500;

/**
 * Sanitize a memory field by truncating to a reasonable length.
 * Prompt injection is mitigated by wrapping output in data boundaries
 * rather than trying to filter patterns (which is easily bypassed).
 */
export function sanitizeMemoryField(value: string): string {
  let sanitized = value.length > MAX_MEMORY_FIELD_LENGTH
    ? value.slice(0, MAX_MEMORY_FIELD_LENGTH) + '...'
    : value;
  // Escape angle brackets to prevent XML-style boundary injection
  sanitized = sanitized.replace(/</g, '\uFF1C').replace(/>/g, '\uFF1E');
  return sanitized;
}

/**
 * Sanitize text before embedding it into a prompt context.
 * Replaces angle brackets with fullwidth equivalents to prevent XML-style tag
 * injection, and strips backticks to avoid breaking fenced code block delimiters.
 */
export function sanitizeForPromptEmbed(text: string): string {
  return text
    .replace(/`/g, "'")
    .replace(/</g, '\uFF1C')
    .replace(/>/g, '\uFF1E');
}

/**
 * Build a context string from memory to inject into reviewer prompts. With `paths`, a learning for one path appears
 * only when that path is among them.
 */
export function buildMemoryContext(memory: RepoMemory, paths?: ReadonlySet<string>): string {
  const learnings = paths ? memory.learnings.filter(l => !l.path || paths.has(l.path)) : memory.learnings;
  if (learnings.length === 0 && memory.suppressions.length === 0) {
    return '';
  }

  const parts: string[] = [];

  if (learnings.length > 0) {
    parts.push('## Review Memory — Learnings\n');
    parts.push('The following learnings have been recorded from previous reviews. Consider them when reviewing:\n');
    for (const learning of learnings) {
      parts.push(`- ${sanitizeMemoryField(learning.content)}`);
    }
  }

  if (memory.suppressions.length > 0) {
    parts.push('\n## Review Memory — Suppressions\n');
    parts.push('The repository marked these patterns as intended. Leave out a warning, suggestion or nitpick that matches one, but report a blocker or a security issue even when it matches:\n');
    for (const s of memory.suppressions) {
      const scope = s.file_glob ? ` (files matching ${s.file_glob})` : '';
      parts.push(`- "${sanitizeMemoryField(s.pattern)}"${scope}: ${sanitizeMemoryField(s.reason)}`);
    }
  }

  return `<review-memory>\n${parts.join('\n')}\n</review-memory>`;
}

/**
 * Filter learnings to those relevant to a specific finding,
 * matching by keyword overlap between the finding and learning content.
 * A learning for one path applies only to findings on that path.
 */
export function filterLearningsForFinding(learnings: Learning[], finding: Finding): Learning[] {
  const text = `${finding.title} ${finding.description}`.toLowerCase();
  const keywords = text.split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length >= 4);

  if (keywords.length === 0) return [];

  return learnings.filter(l => {
    if (l.path && l.path !== finding.file) return false;
    const contentLower = l.content.toLowerCase();
    return keywords.some(kw => contentLower.includes(kw));
  });
}

/**
 * Filter suppressions to those that match a specific finding.
 */
export function filterSuppressionsForFinding(suppressions: Suppression[], finding: Finding): Suppression[] {
  return suppressions.filter(s => matchesSuppression(finding, s));
}

/** Adds `suppression` to the repo's suppressions. */
export async function writeSuppression(store: MemoryStore, suppression: Suppression): Promise<void> {
  await updateYamlList<Suppression>(store, 'suppressions.yml', items => {
    items.push(suppression);
    return `Add suppression: ${suppression.pattern}`;
  });
}

/** Adds `learning` to the repo's learnings. Global learnings are edited by hand, so none is written here. */
export async function writeLearning(store: MemoryStore, learning: Learning): Promise<void> {
  await updateYamlList<Learning>(store, 'learnings.yml', items => {
    items.push(learning);
    return `Add learning: ${learning.content}`;
  });
}

/** Appends `entry` as a JSON line to the repo's `file`, creating the file when it is missing. Secret values are redacted before serializing. */
export async function appendMemoryLine(store: MemoryStore, file: string, entry: unknown, message: string): Promise<void> {
  await store.append(file, [JSON.stringify(redactSecretsDeep(entry))], commitMessage(message));
}

/**
 * Remove a learning from the memory repo by its id, or by case-insensitive substring match on content.
 */
export async function removeLearning(store: MemoryStore, searchText: string): Promise<{ removed: Learning | null; remaining: number }> {
  const searchLower = searchText.toLowerCase();
  return removeFromYamlList<Learning>(
    store,
    'learnings.yml',
    l => l.id.toLowerCase() === searchLower || l.content.toLowerCase().includes(searchLower),
    l => `Remove learning: ${l.content}`,
  );
}

/**
 * Remove a suppression from the memory repo by case-insensitive substring match on pattern.
 */
export async function removeSuppression(store: MemoryStore, searchPattern: string): Promise<{ removed: Suppression | null; remaining: number }> {
  const searchLower = searchPattern.toLowerCase();
  return removeFromYamlList<Suppression>(
    store,
    'suppressions.yml',
    s => s.pattern.toLowerCase().includes(searchLower),
    s => `Remove suppression: ${s.pattern}`,
  );
}

/** Removes the first item matching `matches` from the YAML list in `file`. */
async function removeFromYamlList<T>(
  store: MemoryStore,
  file: string,
  matches: (item: T) => boolean,
  message: (removed: T) => string,
): Promise<{ removed: T | null; remaining: number }> {
  let removed: T | null = null;
  let remaining = 0;
  await updateYamlList<T>(store, file, items => {
    const index = items.findIndex(matches);
    removed = index === -1 ? null : items.splice(index, 1)[0];
    remaining = items.length;
    return removed === null ? null : message(removed);
  });
  return { removed, remaining };
}

/**
 * Edits the YAML list in `file`. `edit` changes the list in place and returns the commit message, or `null` to leave
 * the file as it is. It runs again on fresh content after a write conflict. Secret values are redacted from each
 * string before serializing, since a memory repo can be public.
 */
async function updateYamlList<T>(store: MemoryStore, file: string, edit: (items: T[]) => string | null): Promise<void> {
  await updateFile(store, file, current => {
    const items = (current === null ? null : parseYaml(current) as T[] | null) ?? [];
    const message = edit(items);
    return message === null ? null : { content: stringifyYaml(redactSecretsDeep(items)), message };
  });
}

async function fetchStoredFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<StoredFile> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    if (!('sha' in data)) return { text: null };
    const text = 'content' in data && data.encoding === 'base64'
      ? Buffer.from(data.content, 'base64').toString('utf-8')
      : null;
    return { sha: data.sha, text };
  } catch {
    return { text: null };
  }
}

const MAX_WRITE_ATTEMPTS = 3;
const MAX_MESSAGE_LENGTH = 72;

/** Redacts the commit message before shortening it, so no part of a secret is published. */
function commitMessage(message: string): string {
  return redactSecrets(message).slice(0, MAX_MESSAGE_LENGTH);
}

interface FileUpdate {
  content: string;
  message: string;
}

/**
 * Writes the result of `update` to `file`. `update` gets the file's current text on every attempt, so a retry after a
 * write conflict builds on the latest version. It returns `null` to skip the write. Throws once every attempt met a conflict.
 */
async function updateFile(store: MemoryStore, file: string, update: (current: string | null) => FileUpdate | null): Promise<void> {
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const { sha, text } = await store.read(file);
    if (sha && text === null) {
      throw new Error(`Cannot read ${file} to update it`);
    }
    const next = update(text);
    if (!next) return;
    if (await store.write(file, next.content, sha, commitMessage(next.message))) return;
    if (attempt < MAX_WRITE_ATTEMPTS) core.info(`Write conflict on ${file} in ${store.name}, retrying (attempt ${attempt + 1}/${MAX_WRITE_ATTEMPTS})`);
  }
  throw new Error(`${file} in ${store.name} changed during each of ${MAX_WRITE_ATTEMPTS} attempts, so the change was not saved`);
}
