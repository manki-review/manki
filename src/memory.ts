import * as core from '@actions/core';
import * as github from '@actions/github';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { minimatch } from 'minimatch';

import { Finding, FindingSeverity } from './types';
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

/**
 * Load memory for a specific repo from the memory repository.
 * Returns combined repo-specific + global memory.
 */
export async function loadMemory(
  octokit: Octokit,
  memoryRepo: string,
  targetRepo: string,
): Promise<RepoMemory> {
  const [owner, repo] = memoryRepo.split('/');

  const [repoLearnings, repoSuppressions, globalLearnings, globalConventions] = await Promise.all([
    fetchYamlFile<Learning[]>(octokit, owner, repo, `${targetRepo}/learnings.yml`),
    fetchYamlFile<Suppression[]>(octokit, owner, repo, `${targetRepo}/suppressions.yml`),
    fetchYamlFile<Learning[]>(octokit, owner, repo, '_global/learnings.yml'),
    fetchTextFile(octokit, owner, repo, '_global/conventions.md'),
  ]);

  const learnings = [...(repoLearnings || []), ...(globalLearnings || [])];
  if (globalConventions) {
    learnings.push({
      id: 'global-conventions',
      content: globalConventions,
      scope: 'global',
      source: '_global/conventions.md',
      created_at: '',
    });
  }

  return {
    learnings,
    suppressions: repoSuppressions || [],
  };
}

async function fetchYamlFile<T>(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<T | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    if ('content' in data && data.encoding === 'base64') {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return parseYaml(content) as T;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchTextFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    if ('content' in data && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

/** Severities that are allowed to be suppressed by stored suppressions. */
const SUPPRESSIBLE_SEVERITIES: ReadonlySet<FindingSeverity> = new Set<FindingSeverity>(['warning', 'suggestion', 'nitpick']);

/**
 * Filter findings against stored suppressions.
 * Returns findings that are NOT suppressed.
 * Blocking-severity findings are never suppressed.
 */
export function applySuppressions(
  findings: Finding[],
  suppressions: Suppression[],
): { kept: Finding[]; suppressed: Finding[] } {
  const kept: Finding[] = [];
  const suppressed: Finding[] = [];

  for (const finding of findings) {
    if (!SUPPRESSIBLE_SEVERITIES.has(finding.severity)) {
      kept.push(finding);
      continue;
    }

    const match = suppressions.find(s => matchesSuppression(finding, s));
    if (match) {
      core.info(`Suppressed finding "${finding.title}" — matched suppression "${match.id}": ${match.reason}`);
      suppressed.push(finding);
    } else {
      kept.push(finding);
    }
  }

  return { kept, suppressed };
}

export function matchesSuppression(finding: Finding, suppression: Suppression): boolean {
  const titleLower = finding.title.toLowerCase();
  const patternLower = suppression.pattern.toLowerCase();

  if (!patternLower || patternLower.length < 3) {
    return false;
  }

  if (!titleLower.includes(patternLower)) {
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
 * Build a context string from memory to inject into reviewer prompts.
 */
export function buildMemoryContext(memory: RepoMemory): string {
  if (memory.learnings.length === 0 && memory.suppressions.length === 0) {
    return '';
  }

  const parts: string[] = [];

  if (memory.learnings.length > 0) {
    parts.push('## Review Memory — Learnings\n');
    parts.push('The following learnings have been recorded from previous reviews. Consider them when reviewing:\n');
    for (const learning of memory.learnings) {
      parts.push(`- ${sanitizeMemoryField(learning.content)}`);
    }
  }

  if (memory.suppressions.length > 0) {
    parts.push('\n## Review Memory — Suppressions\n');
    parts.push('The following patterns are intentional and should NOT be flagged:\n');
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

/**
 * Write a suppression to the memory repo.
 */
export async function writeSuppression(
  octokit: Octokit,
  memoryRepo: string,
  targetRepo: string,
  suppression: Suppression,
): Promise<void> {
  await updateYamlList<Suppression>(octokit, memoryRepo, `${targetRepo}/suppressions.yml`, items => {
    items.push(suppression);
    return `Add suppression: ${suppression.pattern}`;
  });
}

/**
 * Write a learning to the memory repo.
 */
export async function writeLearning(
  octokit: Octokit,
  memoryRepo: string,
  targetRepo: string,
  learning: Learning,
): Promise<void> {
  const scope = learning.scope === 'global' ? '_global' : targetRepo;
  await updateYamlList<Learning>(octokit, memoryRepo, `${scope}/learnings.yml`, items => {
    items.push(learning);
    return `Add learning: ${learning.content}`;
  });
}

/** Appends `entry` as a JSON line to `<targetRepo>/<file>` in the memory repo, creating the file when it is missing. Secret values are redacted before serializing. */
export async function appendMemoryLine(
  octokit: Octokit,
  memoryRepo: string,
  targetRepo: string,
  file: string,
  entry: unknown,
  message: string,
): Promise<void> {
  const [owner, repo] = memoryRepo.split('/');
  const line = JSON.stringify(redactSecretsDeep(entry));
  await writeFile(octokit, owner, repo, `${targetRepo}/${file}`, current => ({ content: `${current ?? ''}${line}\n`, message }));
}

/**
 * Remove a learning from the memory repo by its id, or by case-insensitive substring match on content.
 */
export async function removeLearning(
  octokit: Octokit,
  memoryRepo: string,
  targetRepo: string,
  searchText: string,
): Promise<{ removed: Learning | null; remaining: number }> {
  const searchLower = searchText.toLowerCase();
  return removeFromYamlList<Learning>(
    octokit,
    memoryRepo,
    `${targetRepo}/learnings.yml`,
    l => l.id.toLowerCase() === searchLower || l.content.toLowerCase().includes(searchLower),
    l => `Remove learning: ${l.content}`,
  );
}

/**
 * Remove a suppression from the memory repo by case-insensitive substring match on pattern.
 */
export async function removeSuppression(
  octokit: Octokit,
  memoryRepo: string,
  targetRepo: string,
  searchPattern: string,
): Promise<{ removed: Suppression | null; remaining: number }> {
  const searchLower = searchPattern.toLowerCase();
  return removeFromYamlList<Suppression>(
    octokit,
    memoryRepo,
    `${targetRepo}/suppressions.yml`,
    s => s.pattern.toLowerCase().includes(searchLower),
    s => `Remove suppression: ${s.pattern}`,
  );
}

/** Removes the first item matching `matches` from the YAML list at `path`. */
async function removeFromYamlList<T>(
  octokit: Octokit,
  memoryRepo: string,
  path: string,
  matches: (item: T) => boolean,
  message: (removed: T) => string,
): Promise<{ removed: T | null; remaining: number }> {
  let removed: T | null = null;
  let remaining = 0;
  await updateYamlList<T>(octokit, memoryRepo, path, items => {
    const index = items.findIndex(matches);
    removed = index === -1 ? null : items.splice(index, 1)[0];
    remaining = items.length;
    return removed === null ? null : message(removed);
  });
  return { removed, remaining };
}

/**
 * Edits the YAML list at `path` in the memory repo. `edit` changes the list in place and returns
 * the commit message, or `null` to leave the file as it is. It runs again on fresh content after a
 * write conflict. Secret values are redacted from each string before serializing, since a memory repo can be public.
 */
async function updateYamlList<T>(
  octokit: Octokit,
  memoryRepo: string,
  path: string,
  edit: (items: T[]) => string | null,
): Promise<void> {
  const [owner, repo] = memoryRepo.split('/');
  await writeFile(octokit, owner, repo, path, current => {
    const items = (current === null ? null : parseYaml(current) as T[] | null) ?? [];
    const message = edit(items);
    return message === null ? null : { content: stringifyYaml(redactSecretsDeep(items)), message };
  });
}

interface StoredFile {
  sha?: string;
  /** Decoded content, or `null` when the file is missing or too large for the contents API to inline. */
  text: string | null;
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

const DEFAULT_MAX_RETRIES = 3;
const MAX_MESSAGE_LENGTH = 72;

interface FileUpdate {
  content: string;
  message: string;
}

/**
 * Writes the result of `update` to `path`. `update` gets the file's current text on every attempt,
 * so a retry after a write conflict builds on the latest version. It returns `null` to skip the write.
 * The commit message is redacted before it is shortened, so no part of a secret is published.
 */
async function writeFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  update: (current: string | null) => FileUpdate | null,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { sha, text } = await fetchStoredFile(octokit, owner, repo, path);
    if (sha && text === null) {
      throw new Error(`Cannot read ${path} to update it`);
    }
    const next = update(text);
    if (!next) return;

    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message: redactSecrets(next.message).slice(0, MAX_MESSAGE_LENGTH),
        content: Buffer.from(next.content).toString('base64'),
        sha,
      });
      return;
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (status === 409 && attempt < maxRetries - 1) {
        core.info(`Write conflict on ${path}, retrying (attempt ${attempt + 2}/${maxRetries})`);
        continue;
      }
      throw error;
    }
  }
}
