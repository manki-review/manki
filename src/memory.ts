import * as core from '@actions/core';
import * as github from '@actions/github';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { minimatch } from 'minimatch';

import { Finding, FindingSeverity } from './types';

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
 */
export function filterLearningsForFinding(learnings: Learning[], finding: Finding): Learning[] {
  const text = `${finding.title} ${finding.description}`.toLowerCase();
  const keywords = text.split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length >= 4);

  if (keywords.length === 0) return [];

  return learnings.filter(l => {
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
  const [owner, repo] = memoryRepo.split('/');
  const path = `${targetRepo}/suppressions.yml`;

  const existing = await fetchYamlFile<Suppression[]>(octokit, owner, repo, path) || [];
  existing.push(suppression);

  const content = stringifyYaml(existing);
  await writeFile(octokit, owner, repo, path, content, `Add suppression: ${suppression.pattern}`);
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
  const [owner, repo] = memoryRepo.split('/');
  const scope = learning.scope === 'global' ? '_global' : targetRepo;
  const path = `${scope}/learnings.yml`;

  const existing = await fetchYamlFile<Learning[]>(octokit, owner, repo, path) || [];
  existing.push(learning);

  const content = stringifyYaml(existing);
  await writeFile(octokit, owner, repo, path, content, `Add learning: ${learning.content.slice(0, 50)}`);
}

/** Appends `line` to `<targetRepo>/<file>` in the memory repo, creating the file when it is missing. */
export async function appendMemoryLine(
  octokit: Octokit,
  memoryRepo: string,
  targetRepo: string,
  file: string,
  line: string,
  message: string,
): Promise<void> {
  const [owner, repo] = memoryRepo.split('/');
  await writeFile(octokit, owner, repo, `${targetRepo}/${file}`, current => `${current ?? ''}${line}\n`, message);
}

/**
 * Remove a learning from the memory repo by case-insensitive substring match on content.
 */
export async function removeLearning(
  octokit: Octokit,
  memoryRepo: string,
  targetRepo: string,
  searchText: string,
): Promise<{ removed: Learning | null; remaining: number }> {
  const [owner, repo] = memoryRepo.split('/');
  const path = `${targetRepo}/learnings.yml`;

  const existing = await fetchYamlFile<Learning[]>(octokit, owner, repo, path) || [];
  const searchLower = searchText.toLowerCase();
  const index = existing.findIndex(l => l.content.toLowerCase().includes(searchLower));

  if (index === -1) {
    return { removed: null, remaining: existing.length };
  }

  const [removed] = existing.splice(index, 1);
  const content = stringifyYaml(existing);
  await writeFile(octokit, owner, repo, path, content, `Remove learning: ${removed.content.slice(0, 50)}`);

  return { removed, remaining: existing.length };
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
  const [owner, repo] = memoryRepo.split('/');
  const path = `${targetRepo}/suppressions.yml`;

  const existing = await fetchYamlFile<Suppression[]>(octokit, owner, repo, path) || [];
  const searchLower = searchPattern.toLowerCase();
  const index = existing.findIndex(s => s.pattern.toLowerCase().includes(searchLower));

  if (index === -1) {
    return { removed: null, remaining: existing.length };
  }

  const [removed] = existing.splice(index, 1);
  const content = stringifyYaml(existing);
  await writeFile(octokit, owner, repo, path, content, `Remove suppression: ${removed.pattern.slice(0, 50)}`);

  return { removed, remaining: existing.length };
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

/**
 * Writes `content` to `path`. An updater function is called with the file's current text on every
 * attempt, so a retry after a write conflict builds on the latest version.
 */
async function writeFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  content: string | ((current: string | null) => string),
  message: string,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { sha, text } = await fetchStoredFile(octokit, owner, repo, path);
    if (typeof content !== 'string' && sha && text === null) {
      throw new Error(`Cannot read ${path} to update it`);
    }
    const body = typeof content === 'string' ? content : content(text);

    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(body).toString('base64'),
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
