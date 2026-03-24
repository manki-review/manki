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

export interface Pattern {
  id: string;
  finding_title: string;
  occurrences: number;
  repos: string[];
  first_seen: string;
  last_seen: string;
  escalated: boolean;
}

export interface RepoMemory {
  learnings: Learning[];
  suppressions: Suppression[];
  patterns: Pattern[];
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

  const [repoLearnings, repoSuppressions, repoPatterns, globalLearnings, globalConventions] = await Promise.all([
    fetchYamlFile<Learning[]>(octokit, owner, repo, `${targetRepo}/learnings.yml`),
    fetchYamlFile<Suppression[]>(octokit, owner, repo, `${targetRepo}/suppressions.yml`),
    fetchYamlFile<Pattern[]>(octokit, owner, repo, `${targetRepo}/patterns.yml`),
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
    patterns: repoPatterns || [],
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
const SUPPRESSIBLE_SEVERITIES: ReadonlySet<FindingSeverity> = new Set<FindingSeverity>(['suggestion', 'question']);

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
  const truncated = value.length > MAX_MEMORY_FIELD_LENGTH
    ? value.slice(0, MAX_MEMORY_FIELD_LENGTH) + '...'
    : value;
  return truncated;
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

/**
 * Update a pattern tracker in the memory repo.
 */
export async function updatePattern(
  octokit: Octokit,
  memoryRepo: string,
  targetRepo: string,
  findingTitle: string,
  repoName: string,
): Promise<Pattern | null> {
  const [owner, repo] = memoryRepo.split('/');
  const path = `${targetRepo}/patterns.yml`;

  const existing = await fetchYamlFile<Pattern[]>(octokit, owner, repo, path) || [];

  const normalized = findingTitle.toLowerCase().trim();
  let pattern = existing.find(p => p.finding_title === normalized);

  if (pattern) {
    pattern.occurrences++;
    pattern.last_seen = new Date().toISOString().split('T')[0];
    if (!pattern.repos.includes(repoName)) {
      pattern.repos.push(repoName);
    }
    if (pattern.occurrences >= 5 && !pattern.escalated) {
      pattern.escalated = true;
      core.info(`Pattern "${findingTitle}" escalated — seen ${pattern.occurrences} times`);
    }
  } else {
    pattern = {
      id: `pat-${Date.now()}`,
      finding_title: normalized,
      occurrences: 1,
      repos: [repoName],
      first_seen: new Date().toISOString().split('T')[0],
      last_seen: new Date().toISOString().split('T')[0],
      escalated: false,
    };
    existing.push(pattern);
  }

  const content = stringifyYaml(existing);
  await writeFile(octokit, owner, repo, path, content, `Update pattern: ${findingTitle.slice(0, 50)}`);

  return pattern;
}

async function getFileSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    if ('sha' in data) {
      return data.sha;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_MAX_RETRIES = 3;

async function writeFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const sha = await getFileSha(octokit, owner, repo, path);

    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64'),
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
