import { createHash } from 'crypto';
import { createRequire } from 'module';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { assertWritesAllowed } from './abort';
import { DEFAULT_NOTES, loadConfig } from './config';
import { AgentProgressEntry, leftOutUnproven, BinaryFile, CHECK_STATUSES, ConfigSource, DashboardData, DisprovedFinding, FOLLOW_UP_TAG, Finding, PRE_EXISTING_TAG, Refutation, RefutationOutcome, FINDING_CATEGORIES, FINDING_EFFORTS, FindingFingerprintEntry, FindingSeverity, ParsedDiff, RelatedRelation, RelatedWork, ReviewMetadata, ReviewResult, PostedPlace, RoundContext, RoundOutcome, RoundUsage, ReviewConfig, ReviewVerdict, RoundDiffExcludedFile, StaticSignal, VALID_PR_TYPES, VerdictTraceEntry, TestGuide, isBlockingSeverity, isSecurityFinding, canLeaveOut, UNPOSTED_REASONS } from './types';
import { isLineInDiff } from './diff';
import { issueBox } from './issue-box';
import { codeTokensFromDiff, highlightCode } from './highlight';
import { citedLine, findPriorThreadId } from './finding-fingerprint';
import type { PreviousFinding } from './recap';
import { cellGrade, findingKey, isDisprovedRaise, isGradeCell, isNote, MAX_AGENT_RETRIES, outcomeOf, SEVERITY_ORDER, threadBlocks } from './types';
import { hiddenCharacters, safeTruncate, sanitizeHtmlCommentJson, sanitizeTokens, withMarkers } from './utils';
import { formatReviewRecord, omitBulkyDiagnostics } from './review-record';
import { latestLimits } from './providers/instrumentation';
import type { LimitUsage } from './providers/types';
import { parseSettingsBlock, SETTINGS_MARKER, SettingsView, stripSettingsBlock, withSettingsBlock } from './settings';

type Octokit = ReturnType<typeof github.getOctokit>;

interface IssueComment {
  id: number;
  body?: string | null;
  user?: { login?: string | null; type?: string } | null;
  updated_at: string;
  reactions?: { eyes?: number };
}

const BOT_LOGIN = 'manki-review[bot]';

/** The logins Manki's comments and reviews can carry on this repo, in REST form (`<slug>[bot]`). */
interface BotIdentity {
  logins: readonly string[];
}

/** Whether `login` is one of `bot`'s logins. GraphQL reports a bot as `<slug>`, REST as `<slug>[bot]`, so both match. */
function isBotLogin(bot: BotIdentity, login: string | null | undefined): boolean {
  if (!login) return false;
  return bot.logins.includes(login) || bot.logins.includes(`${login}[bot]`);
}

/** Whether a REST `user` is one of `bot`'s accounts. REST reports a bot as `<slug>[bot]`, so only an exact login matches. */
function isBotUser(bot: BotIdentity, user: { login?: string | null } | null | undefined): boolean {
  return !!user?.login && bot.logins.includes(user.login);
}

const permissionLookups = new WeakMap<Octokit, Map<string, Promise<string>>>();

/**
 * Returns the repo permission of `login`: `admin`, `write`, `read` or `none`. `author_association` cannot tell,
 * since an org member with read access shows as `MEMBER` and a private org member with write access as `NONE`.
 * Each client caches its answers, so a run asks once per login. A failed lookup counts as `none`.
 */
function repoPermission(octokit: Octokit, owner: string, repo: string, login: string): Promise<string> {
  let lookups = permissionLookups.get(octokit);
  if (!lookups) {
    lookups = new Map();
    permissionLookups.set(octokit, lookups);
  }
  const key = `${owner}/${repo}/${login.toLowerCase()}`;
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = (async () => {
      try {
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login });
        return data.permission;
      } catch (error) {
        core.warning(`Could not read the repo permission of ${login}, treating it as none: ${error}`);
        return 'none';
      }
    })();
    lookups.set(key, lookup);
  }
  return lookup;
}

async function isRepoAdmin(octokit: Octokit, owner: string, repo: string, login: string): Promise<boolean> {
  return await repoPermission(octokit, owner, repo, login) === 'admin';
}

/** Whether `login` can push to the repo. A `maintain` role reads as `write`. */
async function hasWriteAccess(octokit: Octokit, owner: string, repo: string, login: string): Promise<boolean> {
  return ['admin', 'write'].includes(await repoPermission(octokit, owner, repo, login));
}

const BOT_MARKER = '<!-- manki-bot -->';
const REVIEW_COMPLETE_MARKER = '<!-- manki-review-complete -->';
/** Marks a pause notice, whose settings block offers Review again. */
const PAUSE_NOTICE_MARKER = '<!-- manki-paused -->';
/** Marks the approval auto-approve posts. It stays in the body after GitHub dismisses the review. */
const AUTO_APPROVE_MARKER = '<!-- manki-auto-approve -->';
const CANCELLED_MARKER = '<!-- manki-review-cancelled -->';
/** Marks a review that is no verdict on its commit, such as a round no model finished, so auto-approve never builds on it. */
const NO_VERDICT_MARKER = '<!-- manki-no-verdict -->';
/** Marks a review after which only a person can approve, such as one with unread files, whatever its verdict, so auto-approve never does. */
const HELD_FOR_PERSON_MARKER = '<!-- manki-held-for-person -->';
const VERSION_MARKER_PREFIX = '<!-- manki-version:';
/** Holds the id of the progress comment the run posted, for the post step. */
const PROGRESS_STATE_KEY = 'manki_progress_comment';

const MANKI_VERSION: string = (() => {
  try {
    return (createRequire(__filename)('../package.json') as { version: string }).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();
const VERSION_MARKER = `${VERSION_MARKER_PREFIX} ${MANKI_VERSION} -->`;
const BOT_MARKERS = [BOT_MARKER, VERSION_MARKER];
const REVIEW_FAILED_LINE = '🔴 **Review failed**';
const REVIEW_INCOMPLETE_LINE = '⏸️ **Review incomplete:**';

const VERSION_MARKER_REGEX = /<!-- manki-version:\s*([^\s]+)\s*-->/;

function extractVersionFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(VERSION_MARKER_REGEX);
  return match ? match[1] : null;
}

// Covers all standard HTML elements including `base` (can inject a base URL that hijacks relative links)
const HTML_TAGS = 'a|abbr|address|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|math|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp|script|section|select|slot|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr';
// The `[^>]*` in these regexes is anchored by a literal `>`, so backtracking is
// linear. If no `>` exists, the unclosed-tag regex below handles that case
// separately (anchored to end-of-string). Not a ReDoS concern for our input.
const HTML_TAG_REGEX = new RegExp(`<\\/?(${HTML_TAGS})(?:\\s[^>]*)?\\s*\\/?>`, 'gi');
const HTML_UNCLOSED_TAG_REGEX = new RegExp(`<\\/?(${HTML_TAGS})(?:\\s[^>]*)?$`, 'gim');

/**
 * Fetch the raw diff for a PR.
 */
export async function fetchPRDiff(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  return data as unknown as string;
}

/** Returns the PR's current head SHA, or `undefined` when the lookup fails or returns none. */
export async function fetchHeadSha(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    if (!data.head?.sha) core.warning('Head SHA lookup returned no sha, proceeding');
    return data.head?.sha || undefined;
  } catch (error) {
    core.warning(`Head SHA lookup failed, proceeding: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

const MERGEABLE_ATTEMPTS = 3;
const MERGEABLE_RETRY_MS = 1500;

/** Why an approval was posted as a comment instead, or `false` when it was not held. */
export type ApprovalHeld = false | 'conflict' | 'draft' | 'config' | 'unread';

/** The changed files no model reads: those `exclude_paths` drops, and those with no code to read, such as binaries. */
export interface SkippedFiles {
  excluded: RoundDiffExcludedFile[];
  binary: BinaryFile[];
}

/** The config file that holds an approval because it does not load: the base branch's, or the PR's own copy. */
export type ConfigHold = 'base' | 'head';

/**
 * Why Manki holds an approval right now: the PR is a draft, it conflicts with `baseRef`, a config file did not load, or no
 * model read some of its files.
 */
export type ApprovalHold = { reason: 'draft' } | { reason: 'conflict'; baseRef: string } | { reason: 'config'; file: ConfigHold } | { reason: 'unread'; skipped: SkippedFiles };

/**
 * Returns why an approval must be held, read from the PR as it is now, or `undefined` when it may be posted.
 * Retries while GitHub has not computed whether the PR conflicts with its base. When the PR can't be read,
 * `draftWhenUnread` decides whether it counts as a draft.
 */
export async function fetchApprovalHold(octokit: Octokit, owner: string, repo: string, prNumber: number, draftWhenUnread = false): Promise<ApprovalHold | undefined> {
  for (let attempt = 1; attempt <= MERGEABLE_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise(resolve => setTimeout(resolve, MERGEABLE_RETRY_MS));
    try {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      if (data.draft) return { reason: 'draft' };
      if (data.mergeable === false || data.mergeable_state === 'dirty') return { reason: 'conflict', baseRef: data.base.ref };
      if (data.mergeable !== null) return undefined;
    } catch (error) {
      core.warning(`Mergeable lookup failed, proceeding: ${error instanceof Error ? error.message : error}`);
      return draftWhenUnread ? { reason: 'draft' } : undefined;
    }
  }
  core.info(`GitHub has not computed whether PR #${prNumber} conflicts with its base, proceeding`);
  return undefined;
}

/** Returns the line that says a round requests changes because the round records of `reviews` could not be read while a thread is open. */
export function unreadRecordsLine(reviews: readonly string[]): string {
  const named = reviews.map((url, i) => `[review ${i + 1}](${url})`).join(', ');
  return `**Approval withheld:** an earlier review record could not be read${named ? ` (${named})` : ''}, so Manki cannot tell how serious the open threads are and does not approve while one is open. Once a maintainer has checked and resolved them, the next review can approve.`;
}

/** Returns the judge's summary of a round an unread round record kept from approving, labelled as no reason it blocks. */
export function withheldSummary(summary: string): string {
  const text = sanitizeMarkdown(summary.trim());
  return text ? `**Summary:** ${asSentence(text)}` : '';
}

/** Returns the line that says why Manki does not approve. */
export function approvalHoldLine(hold: ApprovalHold): string {
  if (hold.reason === 'draft') return '**Approval held:** this PR is a draft. Mark it ready for review, and Manki reviews it again.';
  if (hold.reason === 'config') {
    return hold.file === 'base'
      ? '**Approval held:** the config file on the base branch could not be read or does not load, so Manki reviewed with the defaults.'
      : '**Approval held:** this PR\'s copy of the config file does not load or could not be read. Fix it and push, and Manki reviews the new commit.';
  }
  if (hold.reason === 'unread') return `**Approval held:** no model read some of the files this PR changes, so a person needs to approve it.\n\n${formatSkippedFiles(hold.skipped)}`;
  return `**Approval held:** this PR conflicts with \`${sanitizeFilePath(hold.baseRef)}\`. Rebase it, and Manki reviews the result.`;
}

const MAX_UNREVIEWED_LINES = 50;

/**
 * Returns the notice for a diff no model reads: each skipped file and why, and what the static analyzers found on them.
 * Long lists are cut at `MAX_UNREVIEWED_LINES` entries.
 */
export function formatUnreviewedNotice(shortSha: string, skipped: SkippedFiles, signals: StaticSignal[]): string {
  const found = signals.map(s => `- ${inline(`${s.file}:${s.line}`)}: ${inline([s.tool, s.ruleId].filter(Boolean).join(' '))}: ${inline(s.message)}`);
  const files = formatSkippedFiles(skipped);
  return [
    `**Not reviewed** at \`${shortSha}\`: no model read this PR, since Manki skips every file it changes. A person needs to review it.`,
    ...(files ? [files] : []),
    ...(found.length > 0 ? [`**Static analysis on the skipped files:**\n${cutList(found)}`] : []),
  ].join('\n\n');
}

const SKIPPED_REASON: Record<NonNullable<BinaryFile['kind']> | 'binary', string> = {
  binary: 'no lines to read, such as a binary, a rename, a mode change or an empty file',
  lfs: 'a Git LFS pointer, so only its hash changed and no model read the content',
  submodule: 'a submodule bump, so only its commit changed and no model read the code',
};

/** Lists each skipped file and why, or returns an empty string when there is none. */
function formatSkippedFiles(skipped: SkippedFiles): string {
  const list = skippedFileList(skipped);
  return list ? `**Skipped files:**\n${list}` : '';
}

/** Lists each skipped file and why, one per line, or returns an empty string when there is none. */
function skippedFileList({ excluded, binary }: SkippedFiles): string {
  return cutList([
    ...excluded.map(f => `- ${inline(f.path)}: matches ${inline(f.matchedPattern)} in \`exclude_paths\``),
    ...binary.map(f => `- ${inline(f.path)}: ${SKIPPED_REASON[f.kind ?? 'binary']}`),
  ]);
}

function cutList(lines: string[]): string {
  return [...lines.slice(0, MAX_UNREVIEWED_LINES), ...(lines.length > MAX_UNREVIEWED_LINES ? [`- and ${lines.length - MAX_UNREVIEWED_LINES} more`] : [])].join('\n');
}

/** Shows text from the PR, such as a file name or tool output, as inline code on one line. */
function inline(text: string): string {
  return `\`${sanitizeFilePath(sanitizeMarkdown(text))}\``;
}

/** Thrown when the PR head moved past the commit under review, so the review must post no verdict. */
export class SupersededError extends Error {
  constructor(readonly reviewedSha: string, readonly headSha: string) {
    super(`The PR head moved from ${reviewedSha.slice(0, 7)} to ${headSha.slice(0, 7)}`);
    this.name = 'SupersededError';
  }
}

/** Throws `SupersededError` when the PR head is no longer `commitSha`. A failed lookup lets the review go on. */
export async function assertHeadUnchanged(octokit: Octokit, owner: string, repo: string, prNumber: number, commitSha: string): Promise<void> {
  const headSha = await fetchHeadSha(octokit, owner, repo, prNumber);
  if (headSha && headSha !== commitSha) throw new SupersededError(commitSha, headSha);
}

/**
 * Fetch the unified diff between two commits via GitHub's compare API, which
 * diffs `head` against its merge base with `base`. Used to ground the judge's
 * per-thread evaluation in actual code changes since the prior review round,
 * distinguishing real fixes from no-op pushes (force-pushed rebases, branch
 * resets) where every open thread should remain unresolved. Returns an empty string when `base === head` or when the
 * comparison yields a non-string payload. Throws on API failure so the caller
 * can distinguish "no changes" (empty string) from "unknown" (caught error,
 * leaves the diff undefined upstream).
 */
export async function fetchInterRoundDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string> {
  if (!base || !head || base === head) return '';
  try {
    const { data } = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base,
      head,
      mediaType: { format: 'diff' },
    });
    const diff = data as unknown as string;
    return typeof diff === 'string' ? diff : '';
  } catch (error) {
    core.debug(`Failed to fetch inter-round diff ${base}..${head}: ${error}`);
    throw error;
  }
}

/**
 * Returns the shas of the commits `head` adds on top of `base`, oldest first, when they form one line of history. Returns
 * none when `head` does not descend from `base`, as after a rebase, or when a merge brought in commits of another branch.
 */
export async function fetchCommitsSince(octokit: Octokit, owner: string, repo: string, base: string, head: string): Promise<string[]> {
  const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base, head, per_page: 100 });
  const linear = data.status === 'ahead' && data.commits.length === data.total_commits && data.commits.every(c => c.parents.length === 1);
  return linear ? data.commits.map(c => c.sha) : [];
}

/** Returns the unified diff of commit `sha` against its parent. */
export async function fetchCommitDiff(octokit: Octokit, owner: string, repo: string, sha: string): Promise<string> {
  const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: sha, mediaType: { format: 'diff' } });
  return data as unknown as string;
}

/**
 * Returns the full blob sha of each file `head` changes against its merge base with `base`, by path. GitHub lists at most
 * 300 files for a comparison, so a path past that is missing from the map.
 */
export async function fetchBlobShas(octokit: Octokit, owner: string, repo: string, base: string, head: string): Promise<Map<string, string>> {
  const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base, head, per_page: 1 });
  return new Map((data.files ?? []).flatMap(f => (f.sha ? [[f.filename, f.sha] as const] : [])));
}

/**
 * Fetch the config file content from the repo.
 */
export async function fetchConfigFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  configPath: string,
): Promise<string | null> {
  return readConfigFile(octokit, owner, repo, ref, configPath).catch(() => null);
}

/** Returns a config file's content at `ref`, or null when it does not exist. Throws when it cannot be read. */
export async function readConfigFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  configPath: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: configPath, ref });
    if ('content' in data && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    // A file over 1 MB comes back without its content.
    if (!Array.isArray(data) && data.type === 'file') throw new Error(`${configPath} is too large to read`);
    return null;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

/** Whether the base branch config could not be read or loaded. */
export function configFailed(source: ConfigSource): boolean {
  return source === 'base_unreadable' || source === 'base_invalid';
}

/**
 * Returns the config file that holds the round's approval: the base branch's when it could not be read or loaded, else the
 * PR's own when `brokenOwnCopy` says the PR changed it and it does not load. A PR that only predates the base's copy
 * holds nothing.
 */
export function brokenConfig(source: ConfigSource, brokenOwnCopy: boolean): ConfigHold | undefined {
  if (configFailed(source)) return 'base';
  return brokenOwnCopy ? 'head' : undefined;
}

/**
 * Loads the base branch's config, which `read` returns. One that cannot be read or does not load gives the defaults,
 * with the source saying why, so the change that fixes it is still reviewed. `describe` words the error in the warning.
 */
export async function loadBaseConfig(
  read: () => Promise<string | null>,
  configPath: string,
  describe: (error: unknown) => string,
): Promise<{ config: ReviewConfig; source: ConfigSource }> {
  const fallBack = (source: ConfigSource, problem: string, error: unknown) => {
    core.warning(`${problem} ${configPath} on the base branch, reviewing with the defaults and no approval: ${describe(error)}`);
    return { config: loadConfig(undefined), source };
  };
  let content: string | null;
  try {
    content = await read();
  } catch (error) {
    return fallBack('base_unreadable', 'Could not read', error);
  }
  try {
    const config = loadConfig(content ?? undefined, configPath);
    return { config, source: config.review ? 'base' : 'builtin' };
  } catch (error) {
    return fallBack('base_invalid', 'Could not load', error);
  }
}

const MAX_RESOLVE_DEPTH = 3;

/** Reads a repository's files at one commit. */
export interface RepoFiles {
  /** Returns a file's content, or null when no file is at `path`. Throws when it cannot be read. */
  read(path: string): Promise<string | null>;
  /** Returns the path of every file in the tree. */
  list(): Promise<string[]>;
}

export function githubRepoFiles(octokit: Octokit, owner: string, repo: string, ref: string): RepoFiles {
  return {
    read: (path) => readConfigFile(octokit, owner, repo, ref, path),
    list: async () => {
      const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: ref, recursive: 'true' });
      return data.tree.filter(e => e.type === 'blob' && e.path).map(e => e.path!);
    },
  };
}

/** Returns the directory part of a repo path, or an empty string for a root file. */
function dirOf(path: string): string {
  return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
}

// An inline markdown link to a `.md` file, with an optional `#anchor` or title after the path.
const MARKDOWN_LINK_RE = /\]\(\s*<?([^\s()<>#?]+\.md)(?:[#?][^\s()<>]*)?>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * Returns the repo paths of the `.md` files that `line`, in a file under `basePath`, links to. A URL, a path with `..`
 * and a path that does not decode are left out. A path starting with `/` is relative to the repo root.
 */
function markdownLinks(line: string, basePath: string): string[] {
  return [...line.matchAll(MARKDOWN_LINK_RE)].flatMap(([, target]) => {
    let path: string;
    try {
      path = decodeURIComponent(target);
    } catch {
      return [];
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.includes('..')) return [];
    const parts = path.startsWith('/') ? path.split('/') : [...basePath.split('/'), ...path.split('/')];
    const resolved = parts.filter(part => part && part !== '.').join('/');
    return resolved ? [resolved] : [];
  });
}

/**
 * Resolve `@path/to/file.md` references in instruction file content by reading
 * the referenced files from the repo and inlining their content. Adds to `links`
 * the `.md` files each read file links to with a markdown link.
 */
async function resolveReferences(
  files: RepoFiles,
  content: string,
  basePath: string,
  links: string[] = [],
  depth: number = 0,
): Promise<string> {
  if (depth >= MAX_RESOLVE_DEPTH) {
    return content;
  }

  const lines = content.split('\n');
  const resolvedLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^@(\S+\.md)\s*$/);
    if (!match) {
      links.push(...markdownLinks(line, basePath));
      resolvedLines.push(line);
      continue;
    }

    const filePath = match[1];
    if (filePath.includes('..')) {
      resolvedLines.push(line);
      continue;
    }

    const resolvedPath = basePath ? `${basePath}/${filePath}` : filePath;
    const fileContent = await files.read(resolvedPath).catch(() => null);
    if (fileContent === null) {
      resolvedLines.push(line);
      resolvedLines.push(`<!-- Could not resolve reference: ${filePath} -->`);
      continue;
    }
    resolvedLines.push((await resolveReferences(files, fileContent, dirOf(resolvedPath), links, depth + 1)).trimEnd());
  }

  return resolvedLines.join('\n');
}

const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'];
const ROOT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'CONTRIBUTING.md'];
const MAX_INSTRUCTIONS_CHARS = 30_000;

/** An instruction file as the prompts print it: its path in the repo and its text, with `@file` references inlined. */
export interface InstructionFile {
  path: string;
  text: string;
}

/** The repository context the prompts print, and the instruction files in it. */
export interface RepoContext {
  text: string;
  files: InstructionFile[];
  /** The file cut at `MAX_INSTRUCTIONS_CHARS`. Files after it were left out. */
  cut?: string;
}

/** Returns the repo description and the instruction files `buildRepoContext` reads at `ref`. */
export async function fetchRepoContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  changedPaths: string[],
): Promise<RepoContext> {
  const context = await buildRepoContext(githubRepoFiles(octokit, owner, repo, ref), changedPaths);
  const parts = [context.text].filter(Boolean);
  try {
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    if (repoData.description) {
      parts.unshift(`Repository: ${repoData.full_name}\nDescription: ${repoData.description}`);
    }
  } catch {
    // Skip
  }
  return { ...context, text: parts.join('\n\n---\n\n') };
}

/**
 * Returns the `AGENTS.md` and `CLAUDE.md` files nearest above each changed file, nearest first, then those at the root
 * and the root `CONTRIBUTING.md`, then the `.md` files they link to, breadth first. A path appears once, and so do files
 * with the same content after `@file` resolution. The file that crosses `MAX_INSTRUCTIONS_CHARS` is cut, and farther
 * files are left out.
 */
export async function buildRepoContext(files: RepoFiles, changedPaths: string[]): Promise<RepoContext> {
  const queue = [...await findNearestInstructionFiles(files, changedPaths), ...ROOT_INSTRUCTION_FILES].map(path => ({ path, depth: 0 }));
  const queued = new Set(queue.map(({ path }) => path));

  const parts: string[] = [];
  const loaded: InstructionFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let cut: string | undefined;
  for (const { path, depth } of queue) {
    const file = await readInstructionFile(files, path);
    if (file === null || !file.content.trim() || seen.has(file.content.trim())) continue;
    seen.add(file.content.trim());
    if (depth < MAX_RESOLVE_DEPTH) {
      for (const link of file.links.filter(link => !queued.has(link))) {
        queued.add(link);
        queue.push({ path: link, depth: depth + 1 });
      }
    }
    const heading = `## ${path}\n\n`;
    const part = safeTruncate(heading + file.content, MAX_INSTRUCTIONS_CHARS - total);
    parts.push(part);
    loaded.push({ path, text: part.slice(heading.length) });
    total += heading.length + file.content.length;
    if (total > MAX_INSTRUCTIONS_CHARS) {
      core.warning(`Repo instructions reached ${MAX_INSTRUCTIONS_CHARS} characters: cut ${path} and skipped any farther files, so the review does not see their rules`);
      cut = path;
      break;
    }
  }
  return { text: parts.join('\n\n---\n\n'), files: loaded, ...(cut && { cut }) };
}

/** Returns each name's nearest subdirectory file above any changed file, deepest first. */
async function findNearestInstructionFiles(files: RepoFiles, changedPaths: string[]): Promise<string[]> {
  if (changedPaths.length === 0) return [];

  let treePaths: string[];
  try {
    treePaths = await files.list();
  } catch {
    core.debug('Could not fetch repo tree for subdirectory instruction files');
    return [];
  }

  const existing = new Set(
    treePaths
      .filter(p => INSTRUCTION_FILE_NAMES.some(name => p.endsWith(`/${name}`)))
      .filter(p => !ROOT_INSTRUCTION_FILES.includes(p)),
  );
  if (existing.size === 0) return [];

  const found = new Set<string>();
  for (const changedPath of changedPaths) {
    for (const name of INSTRUCTION_FILE_NAMES) {
      let dir = dirOf(changedPath);
      while (dir) {
        const candidate = `${dir}/${name}`;
        if (existing.has(candidate)) {
          found.add(candidate);
          break;
        }
        dir = dirOf(dir);
      }
    }
  }

  const depth = (path: string) => path.split('/').length;
  return [...found].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

/**
 * Returns the file's content with `@file` references inlined and the `.md` files it links to, or null when it can't be
 * read.
 */
async function readInstructionFile(files: RepoFiles, path: string): Promise<{ content: string; links: string[] } | null> {
  try {
    const content = await files.read(path);
    if (content === null) return null;
    const links: string[] = [];
    return { content: await resolveReferences(files, content, dirOf(path), links), links };
  } catch (error) {
    core.warning(`Could not read instruction file ${path}: ${error}`);
    return null;
  }
}

/**
 * Build text status lines showing review progress across phases.
 */
export const INDENT = '&nbsp;&nbsp;&nbsp;&nbsp;';

function renderAgentLines(agents: AgentProgressEntry[]): string {
  return agents.map(a => {
    const name = sanitizeMarkdown(a.name);
    if (a.status === 'done') {
      return `${INDENT}✅ ${name}: ${countOf(a.findingCount ?? 0, 'finding')} (${formatDuration(a.durationMs ?? 0)})`;
    }
    if (a.status === 'failed') {
      if (a.retryCount && a.retryCount > 0) {
        return `${INDENT}🔴 ${name}: failed after ${a.retryCount + 1} attempts (${formatDuration(a.durationMs ?? 0)})`;
      }
      return `${INDENT}🔴 ${name}: failed (${formatDuration(a.durationMs ?? 0)})`;
    }
    if (a.status === 'retrying') {
      if (a.retryCount != null) {
        return `${INDENT}⚠️ ${name}: retrying (${a.retryCount + 1}/${MAX_AGENT_RETRIES + 1})`;
      }
      return `${INDENT}⚠️ ${name}: retrying`;
    }
    if (a.status === 'reviewing') {
      return `${INDENT}⏳ ${name}`;
    }
    return `${INDENT}○ ${name}`;
  }).join('\n');
}

/** Formats a duration such as `850ms`, `45s`, `4m 12s` or `1h 2m`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function validPrTypeOrNull(prType: string): string | null {
  return VALID_PR_TYPES.has(prType) ? prType : null;
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function sanitizeEffort(v: string): string {
  return VALID_EFFORTS.has(v) ? v : 'unknown';
}

function renderSeverityBreakdown(severities: Record<string, number>): string {
  return SEVERITY_ORDER
    .filter(s => (severities[s] ?? 0) > 0)
    .map(s => `${severities[s]} ${s}`)
    .join(' · ');
}

function reviewHeading(routing: DashboardData['routing']): string {
  if (!routing) return 'Review';
  const route = [routing.class, routing.group].filter((part): part is string => Boolean(part)).join(' · ');
  return `Review (${sanitizeMarkdown(route)})`;
}

function preJudgeDrops(data: DashboardData): string {
  const repeats = (data.staticDedupCount ?? 0) + (data.llmDedupCount ?? 0);
  return [
    ...(repeats > 0 ? [countOf(repeats, 'dropped as a repeat of an earlier resolved finding', 'dropped as repeats of earlier resolved findings')] : []),
  ].join(', ');
}

export function buildDashboard(data: DashboardData): string {
  const agents = data.agentProgress;
  const review = reviewHeading(data.routing);
  const hasAgentProgress = !!(agents && agents.length > 0);
  const sections: string[] = [];

  if (data.phase !== 'complete') {
    sections.push('**Review in progress**');
  }

  const plannerLines: string[] = [];
  if (data.phase === 'planning') {
    plannerLines.push(`**Planner**`);
    plannerLines.push(`${INDENT}analyzing...`);
  } else if (data.plannerInfo) {
    const prType = validPrTypeOrNull(data.plannerInfo.prType);
    const plannerDur = data.plannerDurationMs != null ? ` (${formatDuration(data.plannerDurationMs)})` : '';
    plannerLines.push(`**Planner**${plannerDur}`);
    const summaryParts = [
      ...(prType ? [prType] : []),
      `${data.lineCount} lines`,
      `${data.plannerInfo.agentCount} agents`,
    ];
    plannerLines.push(`${INDENT}${summaryParts.join(' · ')}`);
    plannerLines.push(`${INDENT}judge effort: ${sanitizeEffort(data.plannerInfo.judgeEffort)}`);
  } else {
    const plannerDur = data.plannerDurationMs != null ? ` (${formatDuration(data.plannerDurationMs)})` : '';
    plannerLines.push(`**Planner**${plannerDur}`);
    plannerLines.push(`${INDENT}${data.lineCount} lines · ${data.agentCount} agents`);
    if (data.judgeEffort) plannerLines.push(`${INDENT}judge effort: ${sanitizeEffort(data.judgeEffort)}`);
    if (data.heuristicFallback) {
      plannerLines.push(`${INDENT}_(planner heuristic fallback used)_`);
    }
  }
  sections.push(plannerLines.join('\n'));

  const reviewLines: string[] = [];
  if (data.phase === 'planning') {
    reviewLines.push(`**Review**`);
    reviewLines.push(`${INDENT}pending`);
  } else if (data.phase === 'started') {
    if (hasAgentProgress) {
      const done = agents.filter(a => a.status === 'done' || a.status === 'failed' || a.status === 'retrying').length;
      reviewLines.push(`**${review}:** ${done}/${agents.length} agents complete`);
      reviewLines.push(renderAgentLines(agents));
    } else {
      reviewLines.push(`**${review}**`);
      reviewLines.push(`${INDENT}reviewing with ${data.agentCount} agents...`);
    }
  } else {
    reviewLines.push(`**${review}:** ${countOf(data.rawFindingCount ?? 0, 'finding')}`);
    if (hasAgentProgress) {
      reviewLines.push(renderAgentLines(agents));
    }
  }
  const sameEffort = data.routing?.deeperSameEffort;
  if (sameEffort) {
    reviewLines.push(`${INDENT}_(the deeper review adds no effort for ${sameEffort.map(sanitizeMarkdown).join(', ')}: the model receives no more effort than without it)_`);
  }
  sections.push(reviewLines.join('\n'));

  const judgeLines: string[] = [];
  if (data.phase === 'planning' || data.phase === 'started') {
    judgeLines.push(`**Judge**`);
    judgeLines.push(`${INDENT}pending`);
  } else if (data.phase === 'reviewed') {
    judgeLines.push(`**Judge**`);
    const drops = preJudgeDrops(data);
    judgeLines.push(`${INDENT}evaluating ${data.judgeInputCount ?? data.rawFindingCount ?? 0} findings${drops ? ` (${drops})` : ''}...`);
  } else {
    const judgeDur = data.judgeDurationMs != null ? ` (${formatDuration(data.judgeDurationMs)})` : '';
    judgeLines.push(`**Judge:** ${data.keptCount ?? 0} kept · ${data.droppedCount ?? 0} dropped${judgeDur}`);
    if (data.keptSeverities) {
      const breakdown = renderSeverityBreakdown(data.keptSeverities);
      if (breakdown) judgeLines.push(`${INDENT}kept: ${breakdown}`);
    }
    if (data.droppedSeverities) {
      const breakdown = renderSeverityBreakdown(data.droppedSeverities);
      if (breakdown) judgeLines.push(`${INDENT}dropped: ${breakdown}`);
    }
    const drops = preJudgeDrops(data);
    if (drops) judgeLines.push(`${INDENT}before the judge: ${drops}`);
    if (data.suppressionCount) judgeLines.push(`${INDENT}suppressed by memory: ${data.suppressionCount}`);
    if (data.testNitSuppressedCount != null && data.testNitSuppressedCount > 0) {
      judgeLines.push(`${INDENT}suppressed: ${data.testNitSuppressedCount} test-only note${data.testNitSuppressedCount === 1 ? '' : 's'} (round ≥2 throttle)`);
    }
  }
  sections.push(judgeLines.join('\n'));

  return sections.join('\n\n');
}

/**
 * Post a "review in progress" comment on the PR.
 * Returns the comment ID so we can update/delete it later.
 */
export async function postProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  dashboard?: DashboardData,
  settings?: SettingsView,
): Promise<number> {
  const body = withSettingsBlock(withMarkers(
    dashboard ? buildDashboard(dashboard) : '**Review started**',
    ...BOT_MARKERS,
  ), settings);

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  core.saveState(PROGRESS_STATE_KEY, String(data.id));
  return data.id;
}

/**
 * Edits progress comment `commentId` to `body`, ending it with the settings block for `settings` when given.
 * The block keeps the boxes ticked on the live comment, since a writer can tick one while the run edits it,
 * and stays off a live comment that has none.
 */
async function editProgressComment(
  octokit: Octokit, owner: string, repo: string, commentId: number, body: string, settings?: SettingsView,
): Promise<void> {
  if (settings) {
    try {
      const { data } = await octokit.rest.issues.getComment({ owner, repo, comment_id: commentId });
      const live = parseSettingsBlock(data.body ?? '');
      // A comment without the block lost it to a newer progress comment, which keeps the only one.
      settings = live && { ...settings, ticked: live.ticked };
    } catch (error) {
      core.warning(`Failed to read the ticked settings boxes, rendering them from the PR state: ${error instanceof Error ? error.message : error}`);
    }
  }
  await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: withSettingsBlock(body, settings) });
}

/** Posts the comment that shows an auto-approve is running. The post step marks it cancelled when the run stops early. */
export async function postAutoApproveProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number> {
  const body = withMarkers('**Auto-approving:** no findings remain.', ...BOT_MARKERS);
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  core.saveState(PROGRESS_STATE_KEY, String(data.id));
  return data.id;
}

/** Deletes the auto-approve progress comment once the run posted its result, which is the record. */
export async function deleteAutoApproveProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
): Promise<void> {
  try {
    await octokit.rest.issues.deleteComment({ owner, repo, comment_id: commentId });
  } catch (error) {
    core.warning(`Failed to delete the auto-approve progress comment: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Transition a progress comment to a terminal failure state that names the
 * failed `action` and the reason, with tokens redacted. Uses `CANCELLED_MARKER`
 * so the post step leaves the comment alone.
 */
export async function markProgressCommentFailed(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  action: 'Review' | 'Auto-approve',
  reason: string,
  settings?: SettingsView,
): Promise<void> {
  const body = withMarkers(
    `🔴 **${action} failed:** ${safeTruncate(sanitizeMarkdown(sanitizeTokens(String(reason))), 300)}`,
    ...BOT_MARKERS,
    CANCELLED_MARKER,
  );
  try {
    await editProgressComment(octokit, owner, repo, commentId, body, settings);
  } catch (error) {
    core.warning(`Failed to mark ${action.toLowerCase()} comment as failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Transition a progress comment to a terminal state that says a push to `headSha` superseded
 * the review of `reviewedSha`. With `reviewPosted`, it says the review was posted but replaced no earlier one.
 * When both SHAs match, it says a later review of that commit posted its verdict.
 * Uses `CANCELLED_MARKER` so the post step leaves the comment alone.
 */
export async function markProgressCommentSuperseded(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  { reviewedSha, headSha }: Pick<SupersededError, 'reviewedSha' | 'headSha'>,
  reviewPosted = false,
): Promise<void> {
  const outcome = reviewPosted
    ? `The review of \`${reviewedSha.slice(0, 7)}\` was posted, and the earlier reviews stay until the new commit is reviewed.`
    : `No verdict was posted for \`${reviewedSha.slice(0, 7)}\`.`;
  const line = reviewedSha === headSha
    ? `**Review superseded** by a later review of \`${headSha.slice(0, 7)}\`, which posted its verdict.`
    : `**Review superseded** by the new commit \`${headSha.slice(0, 7)}\`. ${outcome}`;
  const body = withMarkers(
    line,
    ...BOT_MARKERS,
    CANCELLED_MARKER,
  );
  try {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
  } catch (error) {
    core.warning(`Failed to mark review comment as superseded: ${error instanceof Error ? error.message : error}`);
  }
}

/** Formats `seconds` since the Unix epoch as a UTC minute, such as `2026-11-12 14:00 UTC`. */
function formatResetTime(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatLimitWindow(limit: LimitUsage): string {
  return `${limit.window} ${limit.usedPercent}%${limit.resetsAt != null ? ` (resets ${formatResetTime(limit.resetsAt)})` : ''}`;
}

const LIMIT_WARNING_THRESHOLDS = [90, 80, 70];
const LIMIT_WARNING_BAND = 2;

/**
 * A red box naming each account window at 90% used or more, or at most `LIMIT_WARNING_BAND` points past the 70 or 80% mark, with the highest mark it reached.
 * The band keeps the box to the first reviews after a lower mark is crossed, instead of every review until the window resets.
 * Unset when no window qualifies.
 */
function formatLimitWarning(limits: readonly LimitUsage[]): string | undefined {
  const lines = [...limits].sort((a, b) => b.usedPercent - a.usedPercent).flatMap(limit => {
    const mark = LIMIT_WARNING_THRESHOLDS.find(t => limit.usedPercent >= t);
    if (mark === undefined) return [];
    if (mark !== LIMIT_WARNING_THRESHOLDS[0] && limit.usedPercent > mark + LIMIT_WARNING_BAND) return [];
    const resets = limit.resetsAt != null ? ` It resets ${formatResetTime(limit.resetsAt)}.` : '';
    return [`**${limit.account} has used ${limit.usedPercent}% of its ${limit.window} limit**, past the ${mark}% mark.${resets}`];
  });
  if (lines.length === 0) return undefined;
  return `> [!CAUTION]\n${[...lines, 'Once a limit is used up, reviews on that account stop until it resets.'].map(line => `> ${line}`).join('\n>\n')}`;
}

/**
 * Freeze the progress comment as an audit log with the final dashboard
 * and optional review metadata (config, judge decisions, recap, timing).
 * Without `metadata` the comment reads as failed, and a later verdict marks it superseded.
 * Throws the abort reason once GitHub writes are stopped.
 */
export async function updateProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  dashboard: DashboardData,
  metadata?: ReviewMetadata,
  settings?: SettingsView,
): Promise<void> {
  const took = dashboard.totalDurationMs != null ? ` in ${formatDuration(dashboard.totalDurationMs)}` : '';
  const parts: string[] = [
    `${metadata ? '✅ **Review complete**' : REVIEW_FAILED_LINE}${took}`,
    '',
    buildDashboard({ ...dashboard, phase: 'complete' }),
  ];

  if (metadata) {
    parts.push('');
    parts.push('<details>');
    parts.push('<summary>Review metadata</summary>');
    parts.push('');

    parts.push('**Config:**');
    parts.push(`- Models: reviewer=${metadata.config.reviewerModel}, judge=${metadata.config.judgeModel}`);
    parts.push(`- Triage: ${metadata.config.triage}`);
    parts.push(`- Team: ${metadata.config.teamAgents.map(sanitizeMarkdown).join(', ')}`);
    parts.push(`- Memory: ${metadata.config.memoryEnabled ? `enabled (${metadata.config.memoryRepo})` : 'disabled'}`);
    parts.push('');

    if (metadata.limits && metadata.limits.length > 0) {
      parts.push('**Account limits:**');
      for (const account of new Set(metadata.limits.map(l => l.account))) {
        parts.push(`- ${account}: ${metadata.limits.filter(l => l.account === account).map(formatLimitWindow).join(', ')}`);
      }
      parts.push('');
    }

    if (metadata.judgeDecisions.length > 0) {
      parts.push('**Judge decisions:**');
      for (const d of metadata.judgeDecisions) {
        const outcome = d.listed ? 'Not finished' : d.kept ? 'Kept' : d.unpostedReason ? `Not listed, ${UNPOSTED_REASONS[d.unpostedReason]}` : 'Dropped';
        parts.push(`- ${outcome}: "${sanitizeMarkdown(d.title)}" (${d.severity}): "${sanitizeMarkdown(d.reasoning)}"`);
      }
      parts.push('');
    }


    parts.push('**Timing:**');
    parts.push(`- Parse: ${(metadata.timing.parseMs / 1000).toFixed(1)}s`);
    parts.push(`- Review agents: ${(metadata.timing.reviewMs / 1000).toFixed(1)}s`);
    parts.push(`- Judge: ${(metadata.timing.judgeMs / 1000).toFixed(1)}s`);
    parts.push(`- Total: ${(metadata.timing.totalMs / 1000).toFixed(1)}s`);
    parts.push('');
    parts.push('</details>');
  }

  assertWritesAllowed();
  await editProgressComment(
    octokit, owner, repo, commentId,
    withMarkers(truncateBody(parts.join('\n')), ...BOT_MARKERS, REVIEW_COMPLETE_MARKER),
    settings,
  );
}

/** Whether `body` is a progress comment whose review failed or ended incomplete. */
function isFailedProgress(body: string): boolean {
  return body.startsWith(REVIEW_FAILED_LINE) || body.startsWith('🔴 **Review failed:**');
}

/**
 * Update the progress comment with just a dashboard (no final result yet).
 */
export async function updateProgressDashboard(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  dashboard: DashboardData,
  settings?: SettingsView,
): Promise<void> {
  await editProgressComment(
    octokit, owner, repo, commentId,
    withMarkers(buildDashboard(dashboard), ...BOT_MARKERS),
    settings,
  );
}

/**
 * Dismiss the bot's reviews in `state`, `CHANGES_REQUESTED` by default, on this PR, except `keepReviewId` and any
 * review on `keepCommit`. Call it only after the new review is posted, so a failed run leaves the merge
 * block in place. A failed dismissal only warns, since the new review already stands.
 * Throws the abort reason once GitHub writes are stopped.
 */
export async function dismissPreviousReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  keepReviewId?: number,
  state: 'CHANGES_REQUESTED' | 'APPROVED' = 'CHANGES_REQUESTED',
  keepCommit?: string,
): Promise<void> {
  assertWritesAllowed();
  let reviews;
  try {
    reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
  } catch (error) {
    core.warning(`Failed to dismiss previous reviews: ${error instanceof Error ? error.message : error}`);
    return;
  }

  for (const review of reviews) {
    const onKeptCommit = keepCommit !== undefined && review.commit_id === keepCommit;
    if (review.id !== keepReviewId && !onKeptCommit && review.body?.includes(BOT_MARKER) && review.state === state) {
      assertWritesAllowed();
      try {
        await octokit.rest.pulls.dismissReview({
          owner,
          repo,
          pull_number: prNumber,
          review_id: review.id,
          message: 'Superseded by new review',
        });
        core.info(`Dismissed previous review #${review.id}`);
      } catch (e) {
        // A repository ruleset can restrict who may dismiss reviews, and the stale review then stays in force.
        core.warning(`Could not dismiss the previous review #${review.id}, it still ${state === 'APPROVED' ? 'approves' : 'requests changes'}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

function countOf(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatStatsOneLiner(context: RoundContext, reviewTimeMs: number): string {
  const sev = context.findings.severityCounts;
  const breakdown = SEVERITY_ORDER
    .filter(s => s !== 'ignore' && (sev[s] ?? 0) > 0)
    .map(s => countOf(sev[s], s))
    .join(', ');
  const time = Math.round(reviewTimeMs / 1000);
  return `<!-- manki-stats: ${countOf(context.findings.count, 'finding')} (${breakdown || 'none'}), ${countOf(context.diff.lines, 'line')}, ${time}s -->`;
}

const REVIEW_BODY_BUDGET = 60000;

/** The most of the review body the round record may take, so the verdict and findings still show. */
const MAX_RECORD_CHARS = REVIEW_BODY_BUDGET - 10000;

/**
 * Returns the hidden stats line and round record that end a review. The record is plain JSON when
 * it fits in `room` characters, and compressed otherwise. A record over `MAX_RECORD_CHARS` even
 * compressed is posted without its bulky diagnostics, and the full record goes to the log. The raw
 * findings and the uses outside the diff are kept in short form while that fits.
 */
function formatRecordTrailer(context: RoundContext, reviewTimeMs: number, room: number): string {
  const stats = `\n\n${formatStatsOneLiner(context, reviewTimeMs)}\n`;
  const record = formatReviewRecord(context, room - stats.length);
  if (stats.length + record.length <= MAX_RECORD_CHARS) return `${stats}${record}`;

  core.warning(`The round record takes ${record.length} characters even compressed, so the review carries it without per-file and per-finding diagnostics. The full record follows in the log.`);
  core.info(formatReviewRecord(context));
  let slim = '';
  for (const keepTraces of [true, false]) {
    slim = formatReviewRecord(omitBulkyDiagnostics(context, keepTraces), room - stats.length);
    if (stats.length + slim.length <= MAX_RECORD_CHARS) return `${stats}${slim}`;
  }
  throw new Error(`The round record takes ${slim.length} characters even without its diagnostics, too many for a review body`);
}

/** The icon that opens a finding comment or a finding listed in the review body. */
const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  blocker: '🚫',
  warning: '⚠️',
  note: '✨',
  ignore: '⚪',
};

/** Shown under the title of a finding whose `checkStatus` is `unconfirmed`. */
const UNCONFIRMED_NOTE = '_Manki could not confirm this, so please check it._';

function trustNote(finding: Finding): string | undefined {
  return finding.checkStatus === 'unconfirmed' ? UNCONFIRMED_NOTE : undefined;
}

/** Non-blocking findings posted as line comments per review. The rest go in the body list. A note is never one of them. */
const MAX_NON_BLOCKING_INLINE = 5;

/** Whether a warning was deferred as a follow-up. */
function isFollowUp(finding: Finding): boolean {
  return !!finding.tags?.includes(FOLLOW_UP_TAG);
}

function isPreExisting(finding: Finding): boolean {
  return !!finding.tags?.includes(PRE_EXISTING_TAG);
}

/** Whether a finding is posted as a thread. A pre-existing one is only when it still blocks, as a security finding does. */
function isBlockingFinding(finding: Finding): boolean {
  if (isPreExisting(finding)) return finding.severity === 'blocker';
  return isBlockingSeverity(finding.severity) && !isFollowUp(finding);
}

function isOnChangedLine(finding: Finding, diff: ParsedDiff): boolean {
  const diffFile = finding.file ? diff.files.find(df => df.path === finding.file) : undefined;
  return !!diffFile && isLineInDiff(diffFile, finding.line);
}

function inlineCode(text: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = '`'.repeat(longestRun + 1);
  return longestRun > 0 ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`;
}

/** Returns the URL of `line` in `file` at the reviewed commit, or of the lines `line` to `end` when `end` is past `line`. */
type LineLink = (file: string, line: number, end?: number) => string;

function repoUrl(serverUrl: string, owner: string, repo: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/${owner}/${repo}`;
}

function buildLineLink(owner: string, repo: string, commitSha: string, serverUrl: string): LineLink {
  return (file, line, end = line) => `${repoUrl(serverUrl, owner, repo)}/blob/${commitSha}/${file.split('/').map(encodeURIComponent).join('/')}${line > 0 ? `#L${line}${end > line ? `-L${end}` : ''}` : ''}`;
}

const WHAT_GOES_WRONG_LABEL = '**What goes wrong:**';
const WHY_LABEL = '**Why:**';
const FIX_LABEL = '**Fix:**';

/** The most of a fix the review body shows, so one long line cannot crowd out the rest of the review. */
const MAX_BODY_FIX_CHARS = 600;

/** Renders a code fix for the body: prose on one line, or text and fenced code blocks. */
function formatBodyFix(fix: string, file: string): string {
  const parts = splitFix(safeTruncate(fix, MAX_BODY_FIX_CHARS), file);
  if (parts.every(p => p.kind === 'prose')) return sanitizeMarkdown(parts.map(p => p.lines.join(' ')).join(' '));
  return renderFixParts(parts, file);
}

/**
 * Splits `text` after its first sentences: at most `maxSentences`, and fewer when they would pass `maxLength`.
 * The first sentence is always kept, truncated when it alone passes `maxLength`. A code fence ends the lead.
 */
function splitLead(text: string, maxSentences: number, maxLength: number): { lead: string; rest: string } {
  const trimmed = text.trim();
  const fenceAt = trimmed.search(/`{3}|~{3}/);
  const prose = fenceAt === -1 ? trimmed : trimmed.slice(0, fenceAt);
  // Odd entries are the whitespace between sentences, so joining a slice keeps the original spacing.
  const parts = prose.trimEnd().split(/(?<=[.!?])(\s+)/);
  let end = 1;
  while (end + 1 < parts.length && (end + 1) / 2 < maxSentences && parts.slice(0, end + 2).join('').length <= maxLength) end += 2;
  const lead = parts.slice(0, end).join('');
  const rest = trimmed.slice(lead.length).trim();
  if (lead.length <= maxLength) return { lead, rest };
  return { lead: safeTruncate(lead, maxLength), rest: trimmed };
}

function findingLocation(finding: Pick<Finding, 'file' | 'line'>): string {
  return `${sanitizeFilePath(finding.file)}${finding.line > 0 ? `:${finding.line}` : ''}`;
}

/**
 * Returns `description` under its label: what goes wrong for a blocking severity, why it is worth changing for the rest.
 * The label goes on its own line above a list, heading or quote, whose marker would show as text after it.
 */
function labelDescription(finding: Finding, description: string): string {
  const label = isBlockingSeverity(finding.severity) ? WHAT_GOES_WRONG_LABEL : WHY_LABEL;
  return `${label}${/^(?:[-*+]\s|#{1,6}\s|>|\d+[.)]\s)/.test(description) ? '\n\n' : ' '}${description}`;
}

/** Returns the `trustNote` and what goes wrong, as listed under a finding in the review body. */
function formatFindingDescription(finding: Finding): string[] {
  const note = trustNote(finding);
  const lines = note ? [note] : [];
  const description = sanitizeMarkdown(finding.description).trim();
  if (description) lines.push(labelDescription(finding, description));
  return lines;
}

/** One part of the fold under a finding. `open` is how the part shows when it is the only one. */
interface FoldPart { label: string; text: string; open?: string }

const HOW_TO_FIX_LABEL = 'How to fix it';

/** Returns the fix of `finding`: its `howToFix`, then `code`, a rendering of its `suggestedFix`. */
function fixPart(finding: Finding, code?: string): FoldPart | undefined {
  const text = [finding.howToFix?.trim() && sanitizeMarkdown(finding.howToFix.trim()), code].filter(Boolean).join('\n\n');
  if (!text) return undefined;
  return { label: HOW_TO_FIX_LABEL, text, open: `${FIX_LABEL}${text.includes('\n') ? '\n\n' : ' '}${text}` };
}

/** Returns the fix of a finding listed in the review body: a diff against the flagged line when it fits, or the code as written. */
function bodyFixPart(finding: Finding, files: ReadonlyMap<string, readonly string[]>): FoldPart | undefined {
  const code = finding.suggestedFix?.trim() ? formatFixDiff(finding, files) ?? formatBodyFix(finding.suggestedFix, finding.file) : undefined;
  return fixPart(finding, code);
}

/** Changed lines up to which a code fix in the review body shows as a diff against the flagged line. */
const MAX_DIFF_FIX_LINES = 10;

/**
 * Returns a small code fix as a `diff` block: the flagged line at the reviewed commit, then the code that replaces it.
 * Returns none for a prose fix, a fix that says where its code goes, a fix whose flagged line was not read, and a diff
 * over `MAX_DIFF_FIX_LINES` changed lines or `MAX_BODY_FIX_CHARS`, such as one on a minified file.
 */
function formatFixDiff(finding: Finding, files: ReadonlyMap<string, readonly string[]>): string | undefined {
  const parts = finding.suggestedFix?.trim() ? splitFix(finding.suggestedFix, finding.file) : [];
  const original = finding.line > 0 ? files.get(finding.file)?.[finding.line - 1] : undefined;
  if (parts.length !== 1 || parts[0].kind !== 'code' || original === undefined) return undefined;
  const fix = parts[0].lines;
  const diff = [`-${original}`, ...fix.map(line => `+${line}`)].join('\n');
  if (fix.length + 1 > MAX_DIFF_FIX_LINES || diff.length > MAX_BODY_FIX_CHARS || PLACEMENT_COMMENT_RE.test(fix[0])) return undefined;
  return fenceText(diff, 'diff');
}

/** Renders a finding listed in the review body: title, link to the line, what goes wrong, then its fold. */
function formatFindingBlock(finding: Finding, links: CodeLinks, offerIssue = false): string {
  const lines = [formatFindingHeader(finding), `**${sanitizeMarkdown(finding.title)}**`];
  if (finding.file) lines.push(`[${inlineCode(findingLocation(finding))}](${links.linkTo(finding.file, finding.line)})`);
  const fold = formatFold(bodyFixPart(finding, links.files), '', checksSection(finding, links, 'flagged'));
  const block = [...lines, ...formatFindingDescription(finding), ...(fold ? [fold] : [])].join('\n');
  return offerIssue ? `${block}\n\n${issueBoxFor(finding)}` : block;
}

/**
 * Renders inline Markdown as HTML on one line, for a `<summary>`, which GitHub does not parse as Markdown.
 * Keeps code spans and bold.
 */
function inlineHtml(markdown: string): string {
  return markdown
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/(`+)\s?(.+?)\s?\1|\*\*(.+?)\*\*/g, (_, _ticks, code, bold) => (code !== undefined ? `<code>${code}</code>` : `<b>${bold}</b>`));
}

/** Heads the findings on code an earlier round already reviewed. */
const MISSED_EARLIER = 'Missed by an earlier review';

/** Lines shown on each side of the flagged line in a finding's code preview. */
const PREVIEW_CONTEXT = 2;

/**
 * Renders a finding listed in the review body as a closed fold. Its summary holds the title, the header line and
 * the location. Inside are what goes wrong, a permalink to the flagged lines, which GitHub shows as code, then the
 * parts of `formatFold` under their labels, with the finding's `checkStatus` in a line of its own after the fix. The file's lines keep the permalink inside it, since GitHub shows a range
 * past the end as a bare link.
 */
function formatFindingFold(finding: Finding, links: CodeLinks, offerIssue = false): string {
  const { linkTo, files } = links;
  const location = finding.file ? ` · <a href="${linkTo(finding.file, finding.line)}"><code>${inlineHtml(findingLocation(finding))}</code></a>` : '';
  const summary = `<summary>${SEVERITY_EMOJI[finding.severity]} <b>${inlineHtml(sanitizeMarkdown(finding.title))}</b><br><sub>${inlineHtml(formatFindingHeader(finding))}${location}</sub></summary>`;
  const last = files.get(finding.file)?.length;
  // A diff already shows the flagged line, so the fold previews it only without one.
  const preview = !formatFixDiff(finding, files) && finding.file && finding.line > 0 && (last === undefined || finding.line <= last)
    ? [linkTo(finding.file, Math.max(1, finding.line - PREVIEW_CONTEXT), Math.min(last ?? finding.line, finding.line + PREVIEW_CONTEXT))]
    : [];
  const checks = checksSection(finding, links, 'flagged');
  const fix = bodyFixPart(finding, files);
  const parts = [...(fix ? [labelledPart(fix)] : []), ...(checks.status ? [`**How this was checked:** ${checks.status}`] : []), ...checks.parts.map(labelledPart)];
  const fold = `<details>\n${summary}\n\n${[...formatFindingDescription(finding), ...preview, ...parts].join('\n\n')}\n\n</details>`;
  // The box goes right under the fold, so it shows without opening it.
  return offerIssue ? `${fold}\n\n${issueBoxFor(finding)}` : fold;
}

/** Returns one list of the review body: a heading, an optional intro, then one fold per finding. */
function formatFindingSection(heading: string, folds: string[], intro?: string, level = '####'): string | null {
  if (folds.length === 0) return null;
  return [`${level} ${heading}`, ...(intro ? [level === '####' ? `<sub>${intro}</sub>` : intro] : []), ...folds].join('\n\n');
}

/** Returns the warnings carried from earlier rounds as one short list, a line each with the round that listed it first. A warning without `currentLine` shows only its file. */
function formatCarriedWarnings(carried: FindingFingerprintEntry[]): string | null {
  const lines = carried.map(e => `${formatTraceEntry({ file: e.fingerprint.file, line: e.currentLine ?? 0, title: e.title ?? '' })} (round ${e.raisedIn})`);
  return formatFindingSection(`Earlier warnings, code unchanged · ${formatSeverityCounts(carried)}`, lines.length > 0 ? [lines.join('\n')] : [], carried.length === 1
    ? 'An earlier round listed it, and this round did not raise it again. The line it points at still reads the same, so it stays listed. It doesn\'t block.'
    : 'An earlier round listed these, and this round did not raise them again. The line each points at still reads the same, so they stay listed. None of them blocks.', '###');
}

/**
 * Returns the findings listed in the review body in one section per origin, each headed by its counts per severity:
 * found this round (just "Findings" on a first round), still open from an earlier round's body, one section per round,
 * missed by an earlier review, and pre-existing, which a pre-existing finding stays in even when it restates one.
 */
function formatOriginSections(findings: Finding[], links: CodeLinks, followUp: boolean): string[] {
  const isEarlier = (f: Finding): f is Finding & { raisedIn: number } => f.origin === 'earlier' && f.raisedIn !== undefined && !isPreExisting(f);
  const earlier = findings.filter(isEarlier);
  const rest = findings.filter(f => !isEarlier(f));
  const missed = rest.filter(f => !isPreExisting(f) && f.origin === 'reviewed');
  const preExisting = rest.filter(isPreExisting);
  const rounds = [...new Set(earlier.map(f => f.raisedIn))].sort((a, b) => a - b);
  const groups: Array<[string, Finding[], string?]> = [
    [followUp ? 'Found this round' : 'Findings', rest.filter(f => !isPreExisting(f) && f.origin !== 'reviewed')],
    ...rounds.map((round): [string, Finding[], string] => {
      const listed = earlier.filter(f => f.raisedIn === round);
      return [`Still open from round ${round}`, listed, listed.length === 1
        ? `Round ${round} listed it, and this round finds it again.`
        : `Round ${round} listed these, and this round finds them again.`];
    }),
    [MISSED_EARLIER, missed, missed.length === 1
      ? 'It sits on lines an earlier round already reviewed, so it doesn\'t block this PR.'
      : 'These sit on lines an earlier round already reviewed, so none of them block this PR.'],
    ['Pre-existing', preExisting, preExisting.length === 1
      ? 'It sits on code this PR did not change, so it doesn\'t block. If it is a blocker, it is listed as a warning.'
      : 'These sit on code this PR did not change, so none of them block. A blocker among them is listed as a warning.'],
  ];
  return groups.flatMap(([title, listed, intro]) => {
    const bySeverity = [...listed].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    const section = formatFindingSection(`${title} · ${formatSeverityCounts(listed)}`, bySeverity.map(f => formatFindingFold(f, links, true)), intro, '###');
    return section ? [section] : [];
  });
}

/**
 * Posts each comment as a file-level review thread and returns the findings GitHub refused.
 * The create-review endpoint does not document `subject_type` on its comments, so these
 * go through the single-comment endpoint.
 */
async function postFileLevelComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  comments: Array<{ path: string; body: string; finding: Finding }>,
): Promise<Finding[]> {
  const refused: Finding[] = [];
  for (const c of comments) {
    try {
      await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitSha,
        path: c.path,
        body: c.body,
        subject_type: 'file',
      });
    } catch (error) {
      core.warning(`Could not post file-level comment on ${c.path}: ${error instanceof Error ? error.message : error}`);
      refused.push(c.finding);
    }
  }
  return refused;
}

const AGREED_ANSWER_RE = /^\**Agreed\./;

/** Returns the findings of the closed threads where Manki's latest answer agreed to leave them for later work. */
function agreedFollowUps(threads: PreviousFinding[]): Finding[] {
  return threads.flatMap(t => (t.answer && AGREED_ANSWER_RE.test(t.answer) && t.severity !== 'unknown' && !t.fixed
    && (t.status === 'resolved' || t.status === 'auto-resolved')
    ? [{ severity: t.severity, title: t.title, file: t.file, line: t.line, description: t.description ?? '', ...(t.suggestedFix && { suggestedFix: t.suggestedFix }), ...(t.howToFix && { howToFix: t.howToFix }), reviewers: [] }]
    : []));
}

/** Returns Manki's reply in an answered thread when the problem of `findings` came back and the code there got worse. */
export function formatFoundAgainReply(findings: Finding[]): string {
  return formatReplyListing('This came up again, and the code here is worse than when this thread was answered.', findings);
}

/** Returns Manki's reply in an open thread that lists `variants`, other instances of the problem the thread names. */
export function formatVariantReply(variants: Finding[]): string {
  return formatReplyListing(variants.length === 1 ? 'This round found another instance of this problem.' : `This round found ${variants.length} more instances of this problem.`, variants);
}

/** Returns Manki's reply in an open thread whose problem `raised` name again at a higher grade. A blocker makes the thread block. */
export function formatRaisedReply(raised: Finding[]): string {
  const grade = SEVERITY_ORDER.find(s => raised.some(f => f.severity === s)) ?? 'blocker';
  const lead = grade === 'blocker' ? 'This round raises this problem again as a blocker, so this thread now blocks.' : `This round raises this problem again as a ${grade}.`;
  return formatReplyListing(lead, raised);
}

/** Returns a reply that opens with `lead` and lists `findings`. */
function formatReplyListing(lead: string, findings: Finding[]): string {
  return [lead, findings.map(f => formatReplyFinding(f).join('\n\n')).join('\n\n---\n\n')].join('\n\n');
}

/** Returns the parts of a finding shown in a reply: its header, title, description and fix. */
function formatReplyFinding(finding: Finding): string[] {
  const fix = fixPart(finding, finding.suggestedFix?.trim() ? formatBodyFix(finding.suggestedFix, finding.file) : undefined);
  return [
    `${SEVERITY_EMOJI[finding.severity]} ${formatFindingHeader(finding)}`,
    `**${sanitizeMarkdown(finding.title)}**`,
    ...formatFindingDescription(finding),
    ...(fix?.open ? [fix.open] : []),
  ];
}

/** Whether an unresolved Manki thread was already posted for this finding. */
function hasOpenThread(finding: Finding, existingThreads: PreviousFinding[]): boolean {
  const open = existingThreads.filter(t => t.status !== 'resolved' && t.threadId && t.markerSlug);
  const fingerprint = { file: finding.file, lineStart: finding.line, lineEnd: finding.line, slug: titleToSlug(finding.title) };
  return findPriorThreadId(fingerprint, open) !== undefined;
}

/** Returns why an earlier thread carries a non-blocking finding, which is then not posted again. */
function carriedBy(finding: Finding, existingThreads: PreviousFinding[]): string | undefined {
  if (finding.answeredIn) return `it goes as a reply in its answered thread ${finding.answeredIn.threadId}`;
  if (finding.threadId) return `${finding.variantOf ? 'it goes as a reply in' : 'it restates'} the open thread ${finding.threadId}`;
  return !finding.ownThread && hasOpenThread(finding, existingThreads) ? 'an open thread already carries it' : undefined;
}

/**
 * Puts the notes of `result.findings` last, in the judge's order, and keeps the first `limit` of them. The others move
 * to `result.unposted`, marked `note_cap`. A note the judge did not rank follows the ranked ones, in the order
 * returned. A tool alert is listed with the notes and counts toward no limit. A note an earlier thread carries is not
 * listed, so it stays in place and counts toward no limit.
 */
export function capNotes(result: ReviewResult, existingThreads: PreviousFinding[], limit = DEFAULT_NOTES): void {
  const listable = new Set(result.findings.filter(f => isListedNote(f) && !carriedBy(f, existingThreads)));
  const rank = (f: Finding): number => f.noteRank ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...listable].sort((a, b) => rank(a) - rank(b));
  const capped = new Set(ordered.filter(canLeaveOut).slice(limit));
  result.findings = [...result.findings.filter(f => !listable.has(f)), ...ordered.filter(f => !capped.has(f))];
  if (capped.size > 0) result.unposted = [...(result.unposted ?? []), ...[...capped].map((f): Finding => ({ ...f, unpostedReason: 'note_cap' }))];
}

/** Whether the review lists the finding as a note. A security finding below `warning` keeps its thread instead. */
function isListedNote(finding: Finding): boolean {
  return isNote(finding.severity) && !isSecurityFinding(finding.tags, finding.reviewers);
}

const MAX_LISTED_FINDINGS = 10;

/** One finding the review checked and left out, with the line that says why. */
type LeftOutEntry = Pick<Finding, 'title' | 'file' | 'line'> & { reason?: string };

/** Renders a left out finding as a list item: the title and a link to its line, then the start of the reason on a line of its own. */
function formatLeftOutEntry({ title, file, line, reason }: LeftOutEntry, linkTo: LineLink): string {
  const location = file ? ` · [${inlineCode(findingLocation({ file, line }))}](${linkTo(file, line)})` : '';
  const shown = reason && splitLead(sanitizeMarkdown(reason).replace(/\s+/g, ' '), 2, 300).lead;
  return `- **${sanitizeMarkdown(title)}**${location}${shown ? `\n  ${shown}` : ''}`;
}

/**
 * Returns the fold that lists what the round checked and left out: each finding of `disproved`, each warning of
 * `result.unposted` that nothing proves, each warning of `result.unpostedPreExisting`, which no check confirmed, and
 * each lead of `result.openLeads`. Every kind shows its first `MAX_LISTED_FINDINGS`. Returns none when there is
 * nothing to list.
 */
function formatLeftOut(result: ReviewResult, disproved: DisprovedFinding[], linkTo: LineLink): string | null {
  const because = (f: Finding, why: string): LeftOutEntry => ({ ...f, reason: `${why[0].toUpperCase()}${why.slice(1)}.` });
  const unproven = [
    ...(result.unposted ?? []).flatMap(f => f.unpostedReason && leftOutUnproven(f) ? [because(f, UNPOSTED_REASONS[f.unpostedReason])] : []),
    ...(result.unpostedPreExisting ?? []).filter(f => f.severity === 'warning').map(f => because(f, `${UNPOSTED_REASONS.pre_existing}, and no tool check confirmed it`)),
  ];
  const leads = (result.openLeads ?? []).map((f): LeftOutEntry => ({ ...f, reason: f.leadSince ? `Open since round ${f.leadSince}.` : undefined }));
  const kinds = [
    { heading: 'Disproved by a tool check', noun: 'finding', short: 'disproved', entries: disproved },
    { heading: 'Not proven, so not listed', noun: 'warning', short: 'unproven', entries: unproven },
    { heading: 'Not finished checking', noun: 'lead', short: 'not finished', entries: leads },
  ].filter(kind => kind.entries.length > 0);
  if (kinds.length === 0) return null;
  const total = kinds.reduce((sum, kind) => sum + kind.entries.length, 0);
  const split = kinds.length > 1 ? ` (${kinds.map(kind => `${kind.entries.length} ${kind.short}`).join(', ')})` : '';
  const sections = kinds.map(({ heading, noun, entries }) => {
    const more = entries.length - MAX_LISTED_FINDINGS;
    const list = entries.slice(0, MAX_LISTED_FINDINGS).map(entry => formatLeftOutEntry(entry, linkTo)).join('\n');
    return formatFindingSection(`${heading} · ${countOf(entries.length, noun)}`, [list, ...(more > 0 ? [`<sub>and ${more} more</sub>`] : [])]);
  });
  // A lead the judge never saw has no entry in that log, so the line shows only with a finding the judge decided.
  const log = disproved.length + unproven.length > 0 ? ['<sub>The progress comment has the full log under "Judge decisions", in its "Review metadata" fold.</sub>'] : [];
  return `<details>\n<summary>Checked and left out: ${countOf(total, 'finding')}${split}</summary>\n\n${[...sections, ...log].join('\n\n')}\n\n</details>`;
}

/**
 * Returns the notes of a review as one collapsed section, a fold per note, in the order given. A line under it says
 * how many notes of `unposted` are over the `review.notes` limit.
 */
function formatNotesSection(notes: Finding[], unposted: Finding[], links: CodeLinks): string | null {
  const listed = notes.length > 0
    && `<details>\n<summary><b>${countOf(notes.length, 'note')}</b> · not blocking</summary>\n\n${notes.map(f => formatFindingFold(f, links, true)).join('\n\n')}\n\n</details>`;
  const capped = unposted.filter(f => f.unpostedReason === 'note_cap').length;
  const unlisted = capped > 0 && `<sub>${capped} ${listed ? 'more ' : ''}${capped === 1 ? 'note is' : 'notes are'} not listed.</sub>`;
  return [listed, unlisted].filter(Boolean).join('\n\n') || null;
}

/**
 * Post the review. Blocking findings become threads. Other findings on a changed line
 * become line comments marked "not blocking", up to `MAX_NON_BLOCKING_INLINE` and most severe
 * first. The rest go in the body. A note never gets a thread: the body lists the notes in one collapsed section.
 *
 * A blocking finding on a changed line gets a line comment, one elsewhere in a diff file
 * gets a file-level comment. A finding that one of the open `existingThreads` already carries
 * is not posted again. A blocker whose `threadId` names one of them is listed in the body under
 * a link to that thread. When `interRoundDiff` is given, non-blocking findings on code it did not
 * change are only counted.
 *
 * When `context` is provided without `reviewTimeMs`, the hidden stats line
 * records `0s` for review time. Pass both together to avoid this.
 * Once GitHub writes are stopped, throws the abort reason and posts nothing.
 * Returns the review's id, and why an approval was held as a COMMENT: the PR is a draft, or it conflicts with its base, as it is when posting.
 * `draft` is the PR's draft state at the event, used when the PR can't be read.
 */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  result: ReviewResult,
  diff?: ParsedDiff,
  context?: RoundContext,
  reviewTimeMs?: number,
  { existingThreads = [], draft = false, configHold, noVerdict = false, skipped, memorySkip, restart, onPosted, unreadRecords, disproved = [] }: {
    existingThreads?: PreviousFinding[]; draft?: boolean; configHold?: ConfigHold; noVerdict?: boolean;
    /** The dropped findings a tool check disproved, which the body lists as checked and left out. */
    disproved?: DisprovedFinding[];
    /** The reviews whose round record could not be read while a thread stays open, named in the review's first line. */
    unreadRecords?: string[];
    /** Why the round ran without memory, with the fix. */
    memorySkip?: string;
    /** What a review started by hand turns back on, for a round that pauses automatic review. */
    restart?: string;
    /** Changed files no model read. Any one holds the approval. */
    skipped?: SkippedFiles;
    /** Called once GitHub created the review, before the file-level comments, which can still fail. */
    onPosted?: () => void;
  } = {},
): Promise<{ id: number; approvalHeld: ApprovalHeld }> {
  const event = mapVerdictToEvent(result.verdict);

  const validComments: Array<{path: string; line: number; side: 'RIGHT'; body: string}> = [];
  const fileComments: Array<{ path: string; body: string; finding: Finding }> = [];
  const invalidComments: string[] = [];
  const generalFindings: string[] = [];
  const stillOpen: string[] = [];
  /** The findings posted as threads this round, counted in the verdict line, and those among them posted as line comments. */
  const threadFindings: Finding[] = [];
  const lineThreads = new Set<Finding>();
  /** The findings listed as folds in the review body, under one section per origin. */
  const bodyFindings: Finding[] = [];
  const notes: Finding[] = [];
  /** The blockers the body shows because no thread can hold them. */
  const unthreaded: Finding[] = [];
  let carriedBlockers = 0;
  const carriedThreadIds = new Set<string>();
  const nonBlocking: Finding[] = [];
  const linkTo = buildLineLink(owner, repo, commitSha, github.context.serverUrl);
  const followUps = agreedFollowUps(existingThreads);
  const carried = result.carried ?? [];
  const listedFiles = [...result.findings.filter(f => !isBlockingFinding(f)), ...followUps].filter(f => f.file && f.line > 0).map(f => f.file);
  const changed = diff?.files.map(f => f.path) ?? [];
  const cited = [...new Set(result.findings.flatMap(f => citedFiles(f, changed)))].slice(0, MAX_CITED_FILES);
  const files = await fetchFileLines(octokit, owner, repo, commitSha, [...new Set([...listedFiles, ...cited])]);
  const links: CodeLinks = { linkTo, files, changed };

  for (const f of result.findings) {
    if (!isBlockingFinding(f)) {
      const carried = carriedBy(f, existingThreads);
      if (carried) {
        core.info(`Skipping "${f.title}" on ${f.file}: ${carried}`);
      } else if (isListedNote(f)) {
        notes.push(f);
      } else if (isPreExisting(f) || f.origin === 'reviewed' || f.origin === 'earlier') {
        bodyFindings.push(f);
      } else {
        nonBlocking.push(f);
      }
      continue;
    }

    const threadId = f.threadId ?? f.answeredIn?.threadId;
    const openThread = threadId ? existingThreads.find(t => t.threadId === threadId) : undefined;
    if (threadId && openThread) {
      core.info(`Skipping "${f.title}" on ${f.file}: the thread ${threadId} already carries it`);
      // A thread that did not block before is raised by this round, so its blocker counts as new. One whose grade could
      // not be read may have blocked, so it counts as still open.
      if (threadBlocks(openThread) || openThread.gradeUnknown) {
        carriedBlockers++;
        carriedThreadIds.add(threadId);
      }
      if (!result.needsHuman?.blockers.some(b => b.threadId === threadId)) {
        // The finding shows under the link, so a wrong `sameAs` link still shows the defect. The indent keeps it in the list item.
        stillOpen.push(`${formatTraceEntry(openThread)}\n\n${`This round names it as:\n\n${formatFindingBlock(f, links)}`.replace(/^(?=.)/gm, '  ')}`);
      }
      continue;
    }

    const diffFile = f.file ? diff?.files.find(df => df.path === f.file) : undefined;
    if (!f.file || (f.line <= 0 && !diffFile)) {
      generalFindings.push(formatFindingBlock(f, links, true));
      unthreaded.push(f);
      continue;
    }

    const commentBody = formatFindingComment(f, links);

    if (!diff || (diffFile && f.line > 0 && isLineInDiff(diffFile, f.line))) {
      validComments.push({ path: f.file, line: f.line, side: 'RIGHT', body: commentBody });
      threadFindings.push(f);
      lineThreads.add(f);
    } else if (!diffFile) {
      invalidComments.push(formatFindingBlock(f, links, true));
      unthreaded.push(f);
    } else if (!f.ownThread && hasOpenThread(f, existingThreads)) {
      core.info(`Skipping file-level comment for "${f.title}" on ${f.file}: an open thread already carries it`);
    } else {
      fileComments.push({ path: f.file, body: commentBody, finding: f });
      threadFindings.push(f);
    }
  }

  const inline = new Set(nonBlocking
    .filter(f => diff && f.line > 0 && isOnChangedLine(f, diff))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
    .slice(0, MAX_NON_BLOCKING_INLINE));
  for (const f of nonBlocking) {
    if (inline.has(f)) {
      validComments.push({ path: f.file, line: f.line, side: 'RIGHT', body: formatFindingComment(f, links) });
      threadFindings.push(f);
      lineThreads.add(f);
    } else {
      bodyFindings.push(f);
    }
  }

  // An incomplete round keeps its record for diagnostics. What it shows reads as it does without one.
  const round = context?.meta.incomplete ? undefined : context;
  const reviewedCommitFooter = buildReviewedCommitFooter(owner, repo, commitSha, github.context.serverUrl, round, reviewTimeMs);

  const blockingFindings = result.findings.filter(isBlockingFinding);
  const earlier = carriedThreadIds.size + (result.verdictTrace?.unresolvedPriors.length ?? 0);
  const blockerCounts: BlockerCounts = { fresh: blockingFindings.length - carriedBlockers, earlier, followUp: (round?.meta.round ?? 1) > 1 };
  const standingHold: ApprovalHold | undefined = configHold ? { reason: 'config', file: configHold }
    : skipped && skipped.excluded.length + skipped.binary.length > 0 ? { reason: 'unread', skipped } : undefined;
  const hold = event === 'APPROVE' ? standingHold ?? await fetchApprovalHold(octokit, owner, repo, prNumber, draft) : undefined;
  const approvalHeld: ApprovalHeld = hold?.reason ?? false;
  // A config hold outlasts this round, since it also stops a later auto-approve, so a round that requests changes names it too.
  const lineHold = hold ?? (standingHold?.reason === 'config' ? standingHold : undefined);
  // An approval held for unread files says so in its verdict line, so only the other holds get a line of their own.
  const heldLine = lineHold && lineHold.reason !== 'unread' && approvalHoldLine(lineHold);

  const limitWarning = formatLimitWarning(latestLimits(result.llmCalls ?? []));

  /**
   * Renders the body. A finding posted as a thread is only counted in it, since its thread sits right below.
   * `withoutLineThreads` leaves out the line comments, for a review GitHub only takes without them.
   */
  const renderBody = (withoutLineThreads = false): string => {
    const threads = threadFindings.filter(f => !(withoutLineThreads && lineThreads.has(f)));
    const lead = formatLead(result, blockerCounts, { threads, listed: [...bodyFindings, ...notes], carried, hold }, limitWarning, unreadRecords);
    let head = heldLine ? `${heldLine}\n\n${lead}` : lead;
    if (memorySkip) {
      head += `\n\n**Memory skipped:** ${memorySkip}`;
    }
    const readyReport = formatReadyReport(result);
    if (readyReport?.whatThisDoes) {
      head += `\n\n${readyReport.whatThisDoes}`;
    }
    const blockingThreads = formatBlockingPriorThreads(result);
    const overrides = event === 'APPROVE' && formatSecurityOverrides(existingThreads.flatMap(t =>
      t.securityOverride ? [{ title: t.title, threadUrl: t.threadUrl, login: t.securityOverride.login }] : []));
    const sections = [
      formatNeedsHuman(result, restart),
      (blockingThreads || stillOpen.length > 0) && [blockingThreads ?? STILL_OPEN_HEADING, ...stillOpen].join('\n'),
      generalFindings.length > 0 && `**Blockers not tied to a line:**\n\n${generalFindings.join('\n\n')}`,
      invalidComments.length > 0 && `**Blockers in files outside this diff:**\n\n${invalidComments.join('\n\n')}`,
      ...formatOriginSections(bodyFindings, links, blockerCounts.followUp),
      formatCarriedWarnings(carried),
      formatNotesSection(notes, result.unposted ?? [], links),
      skipped && skippedFileList(skipped) && `### Not read by any model · ${countOf(skipped.excluded.length + skipped.binary.length, 'file')}\n\nA person needs to look at these before the PR merges.\n\n${skippedFileList(skipped)}`,
      formatFindingSection(`📌 ${countOf(followUps.length, 'follow-up')} agreed for later`, followUps.map(f => formatFindingFold(f, links)), 'Agreed in their threads as later work. None of them blocks.'),
      formatRelatedWork(result.relatedWork, owner, repo),
      overrides,
      readyReport?.whatToTest,
      // The fold points at the progress comment's "Judge decisions", which an incomplete round does not have.
      result.reviewComplete && formatLeftOut(result, disproved, linkTo),
    ].filter((section): section is string => !!section);
    // A rule sets each section apart.
    return sections.length > 0 ? `${head}\n\n---\n\n${sections.join('\n\n---\n\n')}` : head;
  };

  // Generated text often names code without backticks, so every posted body is highlighted before it goes out.
  const codeTokens = diff ? codeTokensFromDiff(diff) : new Set<string>();
  const highlight = <T extends { body: string }>(c: T): T => ({ ...c, body: highlightCode(c.body, codeTokens) });
  const body = highlightCode(renderBody(), codeTokens);
  const postedComments = [...validComments, ...fileComments].map(highlight);
  const inBody = new Set([...bodyFindings, ...notes, ...unthreaded]);
  const placeOf = (f: Finding): PostedPlace => threadFindings.includes(f) ? 'thread' : inBody.has(f) ? 'body' : 'earlier_thread';
  const recordPlace = (entry: FindingFingerprintEntry, f: Finding): FindingFingerprintEntry => {
    const posted = placeOf(f);
    const cited = posted === 'body' && f.severity === 'warning' ? citedLine(files.get(f.file), f.line) : undefined;
    return { ...entry, posted, ...(cited && { citedLine: cited }) };
  };
  const record = (context
    ? formatRecordTrailer({
      ...context,
      // The record's entries are built from `result.findings` in the same order. A record built from other findings keeps its entries as they are.
      ...(context.findings.entries.length === result.findings.length && {
        findings: { ...context.findings, entries: context.findings.entries.map((entry, i) => recordPlace(entry, result.findings[i])) },
      }),
      output: { bodyLength: body.length, commentLengths: postedComments.map(c => c.body.length) },
      ...(event === 'APPROVE' && { approval: { held: approvalHeld } }),
    }, reviewTimeMs ?? 0, REVIEW_BODY_BUDGET - body.length)
    : '') + (noVerdict ? `\n\n${NO_VERDICT_MARKER}` : '') + (standingHold ? `\n\n${HELD_FOR_PERSON_MARKER}` : '');

  if (invalidComments.length > 0) {
    core.info(`Moved ${invalidComments.length} comments to review body (not postable as threads)`);
  }
  const postedVerdict = approvalHeld ? 'COMMENT' : result.verdict;
  if (approvalHeld) {
    const why = hold?.reason === 'conflict' ? `PR conflicts with ${hold.baseRef}`
      : hold?.reason === 'config' ? (hold.file === 'base' ? 'The base branch config did not load' : 'The PR\'s own config does not load')
      : hold?.reason === 'unread' ? 'No model read some of the changed files' : 'The PR is a draft';
    core.info(`${why}, so the approval is posted as a comment`);
  }
  core.info(`Posting review: ${mapVerdictToEvent(postedVerdict)} with ${validComments.length} line comments and ${fileComments.length} file-level comments`);

  const withoutLineThreads = (): string => highlightCode(renderBody(true), codeTokens);
  const review = await submitReview(octokit, owner, repo, prNumber, commitSha, postedVerdict, body, record, validComments.map(highlight), reviewedCommitFooter, withoutLineThreads);
  onPosted?.();
  const refused = await postFileLevelComments(octokit, owner, repo, prNumber, commitSha, fileComments.map(highlight));
  if (refused.length > 0) {
    const titles = refused.map(f => `"${f.title}" (${f.file})`).join(', ');
    const section = highlightCode(`\n\n**Blockers that could not be posted as threads:**\n\n${refused.map(f => formatFindingBlock(f, links, true)).join('\n\n')}`, codeTokens);
    // Truncate the existing body, never the blocking findings appended to it or the round record.
    const room = REVIEW_BODY_BUDGET - section.length - record.length;
    if (room <= 0) {
      throw new Error(`Could not post blocking findings as threads or fit them in review #${review.id}: ${titles}`);
    }
    try {
      await octokit.rest.pulls.updateReview({
        owner,
        repo,
        pull_number: prNumber,
        review_id: review.id,
        body: appendReviewFooter(`${truncateBody(review.body, room)}${section}${record}`, reviewedCommitFooter),
      });
    } catch (error) {
      throw new Error(`Could not post blocking findings as threads or in review #${review.id}: ${titles}. ${error instanceof Error ? error.message : error}`);
    }
  }
  return { id: review.id, approvalHeld };
}

/** Whether `error` is GitHub's refusal when the repo setting stops the workflow token from approving. */
export function isApprovalSettingRefusal(error: unknown): boolean {
  return /not permitted to (create or )?approve pull requests/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Creates the review, falling back to a body-only review when GitHub rejects the line
 * comments and to COMMENT when it refuses the event with a 422. A refusal on a commit that
 * is no longer the PR head throws `SupersededError` instead. Returns the review ID
 * and the posted body without the reviewed-commit footer and the markers.
 */
async function submitReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  verdict: ReviewVerdict,
  body: string,
  record: string,
  validComments: Array<{path: string; line: number; side: 'RIGHT'; body: string}>,
  reviewedCommitFooter: string,
  /** The body without the line comments listed as threads, for when GitHub refuses their lines. */
  bodyWithoutLineComments: () => string = () => body,
): Promise<{ id: number; body: string }> {
  const event = mapVerdictToEvent(verdict);
  const fit = (text: string): string => truncateBody(text, REVIEW_BODY_BUDGET - record.length);
  const compose = (text: string): string => appendReviewFooter(`${text}${record}`, reviewedCommitFooter);
  assertWritesAllowed();
  try {
    const { data: review } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event,
      body: compose(fit(body)),
      comments: validComments,
    });

    core.info(`Posted review #${review.id} with verdict ${verdict}`);
    return { id: review.id, body: fit(body) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isLineError = errorMessage.includes('pull_request_review_thread.line') ||
      errorMessage.includes('line must be part of the diff');

    // If it's a line validation error, retry without inline comments
    if (isLineError && validComments.length > 0) {
      core.warning('Inline comments rejected by GitHub (invalid lines). Posting review without inline comments.');
      const allAsBody = validComments.map(c => `- ${commentHeadline(c.body)}`).join('\n');
      const lineErrFallbackBody = fit(`${bodyWithoutLineComments()}\n\n**Inline comments could not be posted:**\n${allAsBody}`);

      const { data: review } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitSha,
        event,
        body: compose(lineErrFallbackBody),
        comments: [],
      });

      core.info(`Posted review #${review.id} without inline comments (line validation failed)`);
      return { id: review.id, body: lineErrFallbackBody };
    }

    // Only a 422 is GitHub refusing this review event (e.g. approving or requesting
    // changes is not allowed), so a 5xx or rate limit must not weaken the verdict.
    const status = (error as { status?: number }).status;
    if (event === 'COMMENT' || status !== 422) {
      throw error;
    }

    await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
    const hint = isApprovalSettingRefusal(error)
      ? ' Ensure "Allow GitHub Actions to create and approve pull requests" is enabled in repo settings.'
      : '';
    core.warning(`GitHub refused the ${event} review (${status}: ${errorMessage}).${hint} Falling back to COMMENT.`);

    const findingSummary = validComments.map(c => `- ${commentHeadline(c.body)} (\`${c.path}:${c.line}\`)`).join('\n');
    const fallbackBody = fit(`${bodyWithoutLineComments()}\n\n**Findings (could not post inline):**\n${findingSummary}`);

    const { data: review } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: 'COMMENT',
      body: compose(fallbackBody),
      comments: [],
    });

    core.info(`Posted fallback COMMENT review #${review.id} (original verdict: ${verdict})`);
    return { id: review.id, body: fallbackBody };
  }
}

function dynamicFence(content: string): string {
  const maxRun = (content.match(/`+|~+/g) || []).reduce((max: number, s: string) => Math.max(max, s.length), 0);
  return '`'.repeat(Math.max(3, maxRun + 1));
}

/** Wraps `text` in a `dynamicFence`, so nothing inside can close the block, with `info` as its language. */
function fenceText(text: string, info = ''): string {
  const fence = dynamicFence(text);
  return `${fence}${info}\n${text}\n${fence}`;
}

/** Manki's own description of how a review runs, linked from every review's footer. */
const HOW_REVIEWS_WORK_URL = 'https://github.com/manki-review/manki/blob/main/docs/how-reviews-work.md';

/** Formats a token count for reading, such as `980`, `23k` or `1.2M`. */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const thousands = Math.round(count / 1000);
  return thousands < 1000 ? `${thousands}k` : `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * The round's token totals and estimated cost, such as `Tokens: 1.2M in (980k from cache) · 23k out · about $1.58 at
 * API prices`. The cost is left out when no call was priced. Unset for a round without calls.
 */
function formatRoundUsage(usage: RoundUsage): string | undefined {
  if (!usage.calls) return undefined;
  const cache = usage.cacheReadTokens ? ` (${formatTokens(usage.cacheReadTokens)} from cache)` : '';
  const unpriced = usage.unpricedCalls ?? 0;
  const priced = usage.calls - (usage.failedCalls ?? 0) - unpriced;
  const cost = usage.estimatedCostUsd ?? 0;
  const amount = cost < 0.01 ? 'under $0.01' : `about $${cost.toFixed(2)}`;
  const price = priced > 0 ? ` · ${amount} at API prices${unpriced > 0 ? ', partly priced' : ''}` : '';
  return `Tokens: ${formatTokens(usage.inputTokens ?? 0)} in${cache} · ${formatTokens(usage.outputTokens ?? 0)} out${price}`;
}

/**
 * Returns the footer, a collapsed "About this review": the reviewed commit, and with a round context the round, the
 * lines read and the time it took, the models that found and judged the findings, and the tokens and cost.
 */
function buildReviewedCommitFooter(owner: string, repo: string, commitSha: string, serverUrl: string, context?: RoundContext, reviewTimeMs?: number): string {
  const commit = `[\`${commitSha.slice(0, 7)}\`](${repoUrl(serverUrl, owner, repo)}/commit/${commitSha})`;
  // The routed group says which models read the PR. Without it, the configured reviewer model did.
  const routed = context?.routing?.reviewers.map(r => r.model);
  const finders = [...new Set(routed?.length ? routed : [context?.models.reviewer].filter((m): m is string => !!m))].map(m => inlineCode(m));
  const usage = context && formatRoundUsage(context.usage);
  const lines = [
    `- Reviewed ${commit}${context ? `, round ${context.meta.round}` : ''}`,
    ...(context ? [`- ${countOf(context.diff.lines, 'changed line')} read${reviewTimeMs ? ` in ${formatDuration(reviewTimeMs)}` : ''}`] : []),
    ...(context ? [`- Found by ${finders.join(' and ')}, judged by ${inlineCode(context.models.judge)}`] : []),
    ...(usage ? [`- ${usage}`] : []),
    `- [How Manki reviews](${HOW_REVIEWS_WORK_URL})`,
  ];
  return `<details>\n<summary>About this review</summary>\n\n${lines.join('\n')}\n\n</details>`;
}

function appendReviewFooter(body: string, footer: string): string {
  return withMarkers(`${body}\n\n${footer}`, ...BOT_MARKERS);
}

function truncateBody(text: string, maxLength: number = 60000): string {
  if (text.length <= maxLength) return text;
  const notice = '\n\n*(Review body truncated)*';
  const safeMax = Math.max(0, maxLength - notice.length);
  const cutoff = text.lastIndexOf(' ', safeMax);
  return text.slice(0, cutoff > safeMax - 100 ? cutoff : safeMax) + notice;
}

function sanitizeFilePath(file: string): string {
  return file.replace(/`/g, "'").replace(/[\n\r]/g, ' ');
}

function mapVerdictToEvent(verdict: ReviewVerdict): 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' {
  switch (verdict) {
    case 'APPROVE': return 'APPROVE';
    case 'REQUEST_CHANGES': return 'REQUEST_CHANGES';
    case 'COMMENT': return 'COMMENT';
  }
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The first line of every review in which Manki approves the PR. */
const APPROVED_LINE = '✅ **Approved.**';

/** The first line of the review body for each outcome. Its emoji is the only one in the review. */
const VERDICT_LINES: Record<RoundOutcome, (result: ReviewResult, blockers: BlockerCounts, posted: PostedFindings) => string> = {
  READY: (_result, _blockers, { threads, listed, carried, hold }) => {
    if (hold?.reason === 'unread') return `✅ **Approved, but a person must approve:** no model read ${hold.skipped.excluded.length + hold.skipped.binary.length} of the changed files.`;
    const all = [...[...threads, ...listed].filter(f => !isBlockingFinding(f)), ...carried];
    if (all.length === 0) return APPROVED_LINE;
    return `${APPROVED_LINE} ${formatSeverityCounts(all)}, ${all.length === 1 ? 'which doesn\'t block' : 'none of which block'}.`;
  },
  ADDRESS_FIRST: (_result, blockers, { threads }) => {
    // A blocking warning already counts as a blocker.
    const others = threads.filter(f => !isBlockingFinding(f));
    return `🔴 **Changes requested:** ${formatBlockerCounts(blockers)}${others.length > 0 ? `, plus ${formatSeverityCounts(others)} in threads` : ''}.`;
  },
  INCOMPLETE: result => `${REVIEW_INCOMPLETE_LINE} ${asSentence(sanitizeMarkdown(result.summary.trim()) || 'The review did not finish')}`,
  NOT_CONVERGING: result => {
    const blockers = countOf(result.needsHuman?.blockers.length ?? 0, 'blocker');
    return result.needsHuman?.cause === 'budget'
      ? `🛑 **Needs a human:** ${blockers} still open after the last automatic round.`
      : `🛑 **Needs a human:** ${blockers} came back after a fix.`;
  },
};

/** The findings this round posts: as threads, listed in the body, and the hold on an approval. */
interface PostedFindings {
  threads: Finding[];
  listed: Finding[];
  /** The warnings carried from earlier rounds, which an approval counts with the findings it lists. */
  carried: FindingFingerprintEntry[];
  hold?: ApprovalHold;
}

/** Returns how many findings of each severity there are, most severe first, as "1 warning and 2 notes". */
function formatSeverityCounts(findings: Array<Pick<FindingFingerprintEntry, 'severity'>>): string {
  const parts = SEVERITY_ORDER.flatMap(s => {
    const n = findings.filter(f => f.severity === s).length;
    return n > 0 ? [countOf(n, s)] : [];
  });
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join('');
}

/** The blockers first raised this round, those still open from an earlier review, and whether earlier reviews exist. */
interface BlockerCounts {
  fresh: number;
  earlier: number;
  followUp: boolean;
}

/** Returns the blocker count for the verdict line, telling new blockers apart from those still open from an earlier review. */
function formatBlockerCounts({ fresh, earlier, followUp }: BlockerCounts): string {
  if (earlier === 0) return countOf(fresh, followUp ? 'new blocker' : 'blocker');
  if (fresh === 0) return `${countOf(earlier, 'blocker')} still open from ${earlier === 1 ? 'an earlier review' : 'earlier reviews'}`;
  return `${countOf(fresh, 'new blocker')} and ${earlier} still open`;
}

/**
 * Returns the sentence a round says about itself: the judge's summary, or else the first two sentences of the top
 * blocker's description. The judge writes its summary before later steps take findings out of the round, so the summary
 * is left out when the judge kept a finding and `result.findings` holds none of the findings it kept. Later steps also
 * make blockers the summary never saw, so it is left out when a finding blocks that the judge did not grade a blocker
 * in that call. An incomplete round's summary says why the round did not finish, so it is returned as it is.
 */
export function roundSentence(result: ReviewResult): string {
  if (!result.reviewComplete) return result.summary;
  // A finding the judge kept and a later step dropped is `ignore` by a step that is not the judge's. One filed as `ignore` has no step.
  const droppedLater = (f: Finding) => f.gradePath?.length ? f.gradePath.at(-1)!.by !== 'judge' : false;
  const kept = (result.allJudgedFindings ?? []).filter(f => f.severity !== 'ignore' || droppedLater(f));
  const listed = new Set(result.findings.map(findingKey));
  // The judge graded a blocker itself when the cell it stated gives `blocker` with no doubt behind it. A doubt leaves `gradeIfConfirmed`.
  // A sweep's finding is graded in a later judge call, and the verdict reader's has no cell.
  const sweepers = new Set(result.sweeps?.map(sweep => sweep.reviewer));
  const judgeGraded = (f: Finding) => isGradeCell(f.cell) && cellGrade(f.cell.row, f.cell.judgeColumn ?? f.cell.column) === 'blocker' && !f.gradeIfConfirmed && !f.reviewers.some(r => sweepers.has(r));
  const blockers = result.findings.filter(f => f.severity === 'blocker');
  // The judge writes its summary before the verdict reader runs, so it never describes the reader's blockers.
  const stands = result.verdictReason !== 'verdict_reader' && (kept.length === 0 || kept.some(f => listed.has(findingKey(f)))) && blockers.every(judgeGraded);
  if (stands && result.summary.trim()) return result.summary;
  const blocking = result.findings.filter(isBlockingFinding);
  const top = blocking.find(f => f.severity === 'blocker') ?? blocking[0];
  return top ? top.description.trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(' ') : '';
}

/**
 * Returns what a check or a terminal shows for a round: `roundSentence`, or the earlier threads still open when only
 * they block, which the review body lists in its own section.
 */
export function roundSummary(result: ReviewResult): string {
  return roundSentence(result) || formatBlockingPriorThreads(result) || '';
}

/** Returns what follows the verdict line in the review body. A READY round with a verdict reader report shows that report instead. */
function formatVerdictDetail(result: ReviewResult): string {
  if (result.outcome === 'READY' && result.verdictReport) return '';
  if (result.outcome !== 'READY' && result.outcome !== 'ADDRESS_FIRST') return '';
  const sentence = sanitizeMarkdown(roundSentence(result).trim());
  return sentence && result.outcome === 'ADDRESS_FIRST' ? asSentence(sentence) : sentence;
}

/**
 * Returns what opens the review body: the verdict line, the `limitWarning` box and the summary. A round that only the
 * round records of `unreadRecords` kept from approving leads with that, since none of its open threads is a known blocker.
 */
function formatLead(result: ReviewResult, blockers: BlockerCounts, posted: PostedFindings, limitWarning?: string, unreadRecords?: string[]): string {
  if (!result.outcome) return [sanitizeMarkdown(roundSentence(result).trim()), limitWarning].filter(Boolean).join('\n\n');
  if (unreadRecords) return [unreadRecordsLine(unreadRecords), limitWarning, withheldSummary(roundSentence(result))].filter(Boolean).join('\n\n');
  const detail = formatVerdictDetail(result);
  const label = result.outcome === 'ADDRESS_FIRST' ? 'What blocks' : 'Summary';
  return [VERDICT_LINES[result.outcome](result, blockers, posted), limitWarning, detail && `**${label}:** ${detail}`].filter(Boolean).join('\n\n');
}

/**
 * Lists every entry in `verdictTrace.unresolvedPriors`, with its location and a link to the
 * thread, so the author sees which earlier thread blocks without reading the context JSON.
 * An entry already listed under "Needs a human" is left out.
 */
export function formatBlockingPriorThreads(
  result: Pick<ReviewResult, 'verdictTrace' | 'outcome' | 'needsHuman'>,
): string | null {
  const listed = new Set(result.outcome === 'NOT_CONVERGING' ? result.needsHuman?.blockers.map(b => b.fingerprint) : []);
  const priors = (result.verdictTrace?.unresolvedPriors ?? []).filter(p => !listed.has(p.fingerprint));
  if (priors.length === 0) return null;

  return `${STILL_OPEN_HEADING}\n${priors.map(formatTraceEntry).join('\n')}`;
}

const STILL_OPEN_HEADING = '**Still open from earlier reviews:**';

/** Returns the blocking threads still open, by `threadBlocks`, one linked line each, or null when there are none. */
export function formatOpenBlockers(threads: PreviousFinding[]): string | null {
  const open = threads.filter(t => (t.status === 'open' || t.status === 'replied' || t.reopen) && threadBlocks(t));
  return open.length > 0 ? `${STILL_OPEN_HEADING}\n${open.map(formatTraceEntry).join('\n')}` : null;
}

function safeThreadUrl(url: string | undefined): string | null {
  return url && /^https?:\/\/[^\s)]+$/.test(url) ? url : null;
}

function formatTraceEntry(p: Pick<VerdictTraceEntry, 'file' | 'title' | 'line' | 'threadUrl'>): string {
  const file = sanitizeFilePath(p.file);
  const location = !file ? '' : p.line ? `\`${file}:${p.line}\`: ` : `\`${file}\`: `;
  const title = sanitizeMarkdown(p.title || '(untitled)');
  const safeUrl = safeThreadUrl(p.threadUrl);
  const link = safeUrl ? ` ([view thread](${safeUrl}))` : '';
  return `- ${location}${title}${link}`;
}

function formatNeedsHuman(result: ReviewResult, restart?: string): string | null {
  if (result.outcome !== 'NOT_CONVERGING' || !result.needsHuman) return null;
  return `Automatic review is paused until someone comments \`@manki review\`.${restart ? ` ${restart}` : ''}\n\n${result.needsHuman.blockers.map(formatTraceEntry).join('\n')}`;
}

/** Returns `text` for a link label on one line, with the backslashes and brackets that would end the label escaped. */
function linkText(text: string): string {
  return sanitizeMarkdown(text).replace(/\s+/g, ' ').trim().replace(/[\\[\]]/g, '\\$&');
}

// Most telling first, which is also the order the note lists them in.
const RELATION_LABEL: Record<Exclude<RelatedRelation, 'unrelated'>, string> = {
  duplicate: 'Duplicate',
  fixes_issue: 'Fixed here, not linked',
  overlapping: 'Overlaps',
};

/**
 * Returns the note listing the open PRs and issues the dedup model tied to this PR, or null when it tied none. The
 * model's reason stays out, since the other PRs' and issues' text can steer it, and only the round record keeps it.
 */
function formatRelatedWork(work: RelatedWork | undefined, owner: string, repo: string): string | null {
  const labels = Object.keys(RELATION_LABEL);
  const related = (work?.items ?? [])
    .flatMap(item => item.relation && item.relation !== 'unrelated' ? [{ ...item, relation: item.relation }] : [])
    .sort((a, b) => labels.indexOf(a.relation) - labels.indexOf(b.relation));
  if (related.length === 0) return null;
  const lines = related.map(item => {
    const url = `${repoUrl(github.context.serverUrl, owner, repo)}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}`;
    const draft = item.draft ? ' (draft)' : '';
    return `- ${RELATION_LABEL[item.relation]} · [#${item.number} ${linkText(item.title)}](${url})${draft}`;
  });
  return `**Related work:** open PRs and issues that may cover the same change. None of them blocks.\n\n${lines.join('\n')}`;
}

/** Returns one line naming the security findings a repo admin dismissed on their own PR, or null when there are none. */
function formatSecurityOverrides(overrides: ReadonlyArray<{ title: string; threadUrl?: string; login: string }>): string | null {
  if (overrides.length === 0) return null;
  const entries = overrides.map(o => {
    const title = sanitizeMarkdown(o.title || '(untitled)');
    const url = safeThreadUrl(o.threadUrl);
    return `${url ? `[${title}](${url})` : title} by @${o.login}`;
  });
  return `**Findings dismissed by a repo admin:** ${entries.join(', ')}.`;
}

function formatLabelled(label: string, text: string): string {
  const safe = sanitizeMarkdown(text.trim());
  return `**${label}:**${safe.includes('\n') ? '\n\n' : ' '}${safe}`;
}

const TEST_GUIDE_NOTE = '_The review model wrote these steps. Check what a step runs before you follow it._';

/**
 * Renders the setup on its own line and the steps as a numbered list, one step per line, under a note that the model
 * wrote them. Fences are dropped, so no step renders as a code block with a copy button.
 */
function formatTestGuide(guide: TestGuide): string {
  const oneLine = (text: string): string => sanitizeMarkdown(text.replace(/```/g, '').replace(/\s+/g, ' ').trim());
  const steps = guide.steps.map((step, i) => `${i + 1}. ${oneLine(step.replace(/^\s*\d+[.)]\s*/, ''))}`).join('\n');
  return `${TEST_GUIDE_NOTE}\n\n${guide.setup ? `**Setup:** ${oneLine(guide.setup)}\n\n${steps}` : steps}`;
}

/**
 * Returns what an approved change does, in at most two sentences, and the collapsed steps to test it, or none. Either part
 * is left out when the reader left it blank, as a reader that asked for changes may.
 */
function formatReadyReport(result: ReviewResult): { whatThisDoes?: string; whatToTest?: string } | null {
  if (result.outcome !== 'READY' || !result.verdictReport) return null;
  const { whatThisDoes, whatToTest } = result.verdictReport;
  return {
    ...(whatThisDoes.trim() && { whatThisDoes: formatLabelled('What this does', splitLead(whatThisDoes, 2, 400).lead) }),
    ...(whatToTest.steps.length > 0 && { whatToTest: `<details>\n<summary>What to test</summary>\n\n${formatTestGuide(whatToTest)}\n\n</details>` }),
  };
}

// Sanitizes LLM-generated text (titles, descriptions, summaries) before embedding
// it into the GitHub comment body. Our own structural markup (<details>, <summary>,
// collapsible sections, etc.) is added AFTER sanitization and is never passed through here.
function sanitizeMarkdown(text: string): string {
  // Decode common HTML entities so encoded tags like &lt;script&gt; are caught by tag stripping
  let result = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  // Run comment stripping twice to handle nested comments like <!-- <!-- --> -->,
  // then clean up any dangling close markers left behind.
  result = result.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  result = result.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  result = result.replace(/-->/g, '');

  // Run tag stripping twice to handle nesting like <div<div>>
  result = result.replace(HTML_TAG_REGEX, '');
  result = result.replace(HTML_TAG_REGEX, '');

  return fenceOwnCode(result
    .replace(HTML_UNCLOSED_TAG_REGEX, '')  // Unclosed tags at end of string
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                       // Images: keep alt text only
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                        // Links: keep text only
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                       // Second pass for nested brackets
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                        // Second pass for nested brackets
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')                       // Reference images
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')                        // Reference links
    .replace(/^\[[^\]]*\]:\s+.*$/gm, '')                             // Link/image definitions
    // A zero-width space keeps GitHub from turning a bare URL into a link.
    .replace(/(https?|ftp):\/\//gi, '$1:\u200B//')
    .replace(/www\./gi, 'www\u200B.')
    // Insert zero-width space after @ to prevent GitHub from resolving mentions.
    // Lookbehind avoids matching email addresses (which have chars before @).
    // Also handles @org/team patterns.
    .replace(/(?<![a-zA-Z0-9.])@([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)?)/g, '@\u200B$1'));
}

/** Reduce a finding title to a URL-safe slug for use in HTML comment markers and fingerprints. */
export function titleToSlug(title: string): string {
  return title.replace(/[^a-zA-Z0-9]/g, '-');
}

const SUGGESTION_MAX_LINES = 3;
const SUGGESTION_MAX_LENGTH = 120;

// An inline finding shows about 700 characters at most, this budget plus line breaks and a truncation mark.
// The rest of its description is collapsed.
const MAX_VISIBLE_COMMENT = 650;
const MIN_VISIBLE_DESCRIPTION = 150;

/** Returns the length of `text` without collapsed `<details>` blocks and HTML comments, which a reader does not see. */
function visibleLength(text: string): number {
  return text.replace(/<details>[\s\S]*?<\/details>/g, '').replace(/<!--[\s\S]*?-->/g, '').length;
}
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
// A run that could open a fence, anywhere in a line, since later splitting can move it to the start of one.
const FENCE_RUN_RE = /`{3,}|~{3,}/g;

/**
 * Rebuilds the fences in model-written `text` as Manki's own: each fenced block gets a `dynamicFence` that nothing in it
 * can close and a plain language name at most, and a block left open is closed. Any other run of three backticks or
 * tildes is escaped, so no prose can open a fence, such as a `suggestion`, around what Manki appends after it.
 */
function fenceOwnCode(text: string): string {
  return splitFences(text.split('\n')).filter(p => p.lines.length > 0).map(p => p.kind === 'code'
    ? fenceText(p.lines.join('\n'), plainLanguage(p.lang))
    : p.lines.join('\n').replace(FENCE_RUN_RE, run => run.replace(/./g, '\\$&'))).join('\n');
}

const PLAIN_LANGUAGE_RE = /^[A-Za-z0-9_+#.-]{1,32}$/;

/**
 * Returns `info` when it is a plain language name, or nothing. Any other info string is dropped, so no spelling that
 * GitHub would read as `suggestion` gets a commit button.
 */
function plainLanguage(info = ''): string {
  const lang = info.trim();
  return PLAIN_LANGUAGE_RE.test(lang) && lang.toLowerCase() !== 'suggestion' ? info : '';
}
const PROSE_LINE_RE = /^[A-Z][A-Za-z']*(?:\s+\S+){2,}[.:]$/;
// A comment that says where the code goes, such as `// After the guard, add:`, means the code does not apply as is.
const PLACEMENT_COMMENT_RE = /^\s*(?:\/\/|#|--|\/\*)\s+(?:(?:in|after|before|replace|add|then|change|move|instead)\b|.*:\s*(?:\*\/)?$)/i;
const PROSE_FILE_RE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

interface FixPart {
  kind: 'prose' | 'code';
  lines: string[];
  lang?: string;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

/**
 * Splits a suggested fix into prose and code. With fences, everything outside them is prose.
 * Without, prose lines are peeled off the start and the end, except in prose files.
 */
function splitFix(fix: string, file: string): FixPart[] {
  const lines = fix.split('\n');
  if (!lines.some(l => FENCE_LINE_RE.test(l))) {
    const isProse = (l: string): boolean => !PROSE_FILE_RE.test(file) && (PROSE_LINE_RE.test(l.trim()) || !l.trim());
    let start = 0;
    let end = lines.length;
    while (start < end && isProse(lines[start])) start++;
    while (end > start && isProse(lines[end - 1])) end--;
    return [
      { kind: 'prose' as const, lines: lines.slice(0, start) },
      { kind: 'code' as const, lines: lines.slice(start, end) },
      { kind: 'prose' as const, lines: lines.slice(end) },
    ].map(p => ({ ...p, lines: trimBlankLines(p.lines) })).filter(p => p.lines.length > 0);
  }
  return splitFences(lines).map(p => ({ ...p, lines: trimBlankLines(p.lines) })).filter(p => p.lines.length > 0);
}

/** Splits `lines` at fence lines into prose and code parts, in order. A block left open runs to the end. */
function splitFences(lines: string[]): FixPart[] {
  const parts: FixPart[] = [];
  let fence: string | null = null;
  let current: FixPart = { kind: 'prose', lines: [] };
  for (const line of lines) {
    const marker = line.match(FENCE_LINE_RE);
    if (!marker) {
      current.lines.push(line);
    } else if (fence === null) {
      // A backtick run followed by another backtick on the line is inline code, not a fence.
      if (marker[1][0] === '`' && marker[2].includes('`')) {
        current.lines.push(line);
        continue;
      }
      parts.push(current);
      fence = marker[1];
      current = { kind: 'code', lines: [], lang: marker[2].trim() };
    } else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      parts.push(current);
      fence = null;
      current = { kind: 'prose', lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  parts.push(current);
  return parts;
}

/** Renders the parts of a fix as text and fenced code blocks. A block without a language gets the extension of `file`. */
function renderFixParts(parts: FixPart[], file: string): string {
  const extension = file.match(/\.([A-Za-z0-9+#-]+)$/)?.[1] ?? '';
  // Code inside a dynamic fence renders literally, so only the prose needs sanitizing.
  return parts.map(p => {
    const text = p.lines.join('\n');
    if (p.kind === 'prose') return sanitizeMarkdown(text);
    return fenceText(text, plainLanguage(p.lang) || plainLanguage(extension));
  }).join('\n\n');
}

/**
 * Returns a suggested fix as a `suggestion` block, or nothing when it is not one. Only short code that replaces the
 * flagged line as is goes in one, because committing it writes the block verbatim into the file. Code with hidden
 * characters never does, since a reader cannot see what would be committed.
 */
function suggestionBlock(parts: FixPart[]): string | undefined {
  const [only] = parts;
  if (parts.length !== 1 || only.kind !== 'code') return undefined;
  const code = only.lines.join('\n');
  if (only.lines.length > SUGGESTION_MAX_LINES || code.length > SUGGESTION_MAX_LENGTH || PLACEMENT_COMMENT_RE.test(only.lines[0]) || hiddenCharacters(code).length > 0) return undefined;
  const fence = dynamicFence(code);
  return `${fence}suggestion\n${code}\n${fence}`;
}

/** Returns the line a finding opens with: severity, the reporting tool if any, category and effort. */
function formatFindingHeader(finding: Finding): string {
  const severity = `${finding.severity[0].toUpperCase()}${finding.severity.slice(1)}`;
  const label = `**${isBlockingFinding(finding) ? severity : `${severity}, not blocking`}**`;
  const tool = finding.toolSource ? ` (${sanitizeMarkdown(finding.toolSource)})` : '';
  const kind = [isPreExisting(finding) && 'Pre-existing', finding.category && FINDING_CATEGORIES[finding.category], finding.effort && FINDING_EFFORTS[finding.effort]].filter(Boolean);
  return [`${label}${tool}`, ...kind].join(' · ');
}

/** Returns the header line and title of a comment from `formatFindingComment`, on one line. */
function commentHeadline(body: string): string {
  return body.split('\n\n', 2).join(' ');
}

const MAX_CHECK_CHARS = 160;
/** Code previews in a "How this was checked" fold. Further checks are listed as links. */
const MAX_CHECK_PREVIEWS = 3;
/** Lines a preview shows for one check, from the line above the cited ones. A longer citation keeps its first lines. */
const CHECK_PREVIEW_LINES = 5;
/** Lines a preview shows for checks close together in one file, which share it. */
const SHARED_PREVIEW_LINES = 8;
// A `path:line` or `path:start-end` at the start of a check: bare, all in backticks, or with only the path in them.
// Further lines or ranges can follow after commas, as in `path:12,40-42`.
const CHECK_LOCATION_RE = /^(?:`([^\s`:]+):(\d+)(?:-(\d+))?((?:, ?\d+(?:-\d+)?)*)`|`([^\s`:]+)`:(\d+)(?:-(\d+))?((?:, ?\d+(?:-\d+)?)*)|([^\s`:]+):(\d+)(?:-(\d+))?((?:, ?\d+(?:-\d+)?)*))(?![\w`-])[\s:,;.]*/;
// A backtick run that can open inline code: at the start or after a space or an opening mark, and before text.
const OPENS_CODE_RE = /^$|[\s([{"'=]$/;
// A backtick run that can close inline code: at the end or before a space or a closing mark.
const CLOSES_CODE_RE = /^$|^[\s.,;:!?)\]}"']/;
// A repository path made only of characters that cannot end a Markdown link or start another URL.
const LINKABLE_PATH_RE = /^[\w@+.-]+(?:\/[\w@+.-]+)*$/;

const REFUTATION_PART: Record<RefutationOutcome, { label: string; text: string }> = {
  confirmed: { label: 'Double-checked', text: 'Manki tried to disprove this by reading the code and could not.' },
  unsettled: { label: 'Not settled', text: 'Manki tried to disprove this by reading the code and could not decide.' },
  // A posted disproved finding is a blocker, a security finding, one a second check confirmed or one `isDisprovedRaise` names, since a disproof drops any other.
  disproved: { label: 'Doubt found', text: 'Manki found a reason this may not happen, but a disproof alone never clears a blocker or a security finding, so please check it yourself.' },
};
const DISPROVED_RAISE_TEXT = 'Manki found a reason this may not happen, and a second check on another model agreed, so this does not block. Please check it yourself.';
const PAIR_REFUTATION_LABEL = 'Second check, on another model';

/** Opens the fold under a finding comment, so reading the comment back stops its description there. */
const CHECKS_MARKER = '<!-- manki-checks -->';

const REFUTATION_SUMMARY: Record<RefutationOutcome, string> = { confirmed: 'double-checked', unsettled: 'not settled', disproved: 'doubt found' };

/** Shortens model text to one plain line, so no raw tool output or code block reaches the comment. */
function oneLine(text: string): string {
  const line = balanceCodeSpans(sanitizeMarkdown(text).replace(/```/g, '').replace(/\s+/g, ' ').trim());
  return line.length <= MAX_CHECK_CHARS ? line : shortenLine(line);
}

// A backtick run Markdown reads as code, not one escaped with a backslash.
const LIVE_BACKTICKS_RE = /(?<!\\)`+/g;

/**
 * Cuts a line whose code spans pair to `MAX_CHECK_CHARS`, ending in an ellipsis. A span the cut falls in is closed
 * after the ellipsis, or left out when none of its code would show, so the cut never leaves a span open.
 */
function shortenLine(line: string): string {
  const keep = MAX_CHECK_CHARS - 1;
  let open: RegExpMatchArray | undefined;
  let stop = keep;
  for (const run of line.matchAll(LIVE_BACKTICKS_RE)) {
    if (run.index! + run[0].length <= keep) {
      open = !open ? run : run[0].length === open[0].length ? undefined : open;
      continue;
    }
    if (open) {
      const [fence] = open;
      // A longer backtick run inside the span can be cut down to the fence's length, so a run at the cut is dropped.
      const code = line.slice(open.index! + fence.length, keep - fence.length).replace(/`+$/, '').trimEnd();
      if (code.trim()) return `${line.slice(0, open.index! + fence.length)}${code}…${fence}`;
      stop = open.index!;
    } else {
      stop = Math.min(run.index!, keep);
    }
    break;
  }
  return `${line.slice(0, stop).trimEnd()}…`;
}

/**
 * Returns a line of code as inline code cut to `MAX_CHECK_CHARS`, or nothing for a blank line or one with hidden
 * characters, which a reader could not see. Code is not model text, so it skips `balanceCodeSpans`, which would read a
 * backslash at its end as escaping the closing backtick. Only the HTML comment marks Manki reads its data from are broken up.
 */
function codeLine(code: string): string {
  if (hiddenCharacters(code).length > 0) return '';
  const line = code.replace(/<!--|-->/g, mark => mark.split('').join('\u200B')).replace(/\s+/g, ' ').trim();
  return line ? inlineCode(line.length <= MAX_CHECK_CHARS ? line : `${line.slice(0, MAX_CHECK_CHARS - 1)}…`) : '';
}

/** Returns `line` with every live backtick escaped, so it shows as text. */
function escapeBackticks(line: string): string {
  return line.replace(/(?<!\\)`/g, '\\`');
}

/** Whether every backtick run in `runs` opens or closes inline code as Markdown pairs them, with none left over. */
function pairsAsMarkdown(runs: RegExpMatchArray[]): boolean {
  let open: number | undefined;
  for (const run of runs) {
    if (open === undefined) open = run[0].length;
    else if (run[0].length === open) open = undefined;
  }
  return open === undefined;
}

/**
 * Returns `line` with inline code that cannot break the Markdown after it. A model often quotes code that holds a
 * backtick in single backticks, which Markdown closes at the inner one. Such a line is paired by where each run sits:
 * one before text opens, one after text closes the runs it matches exactly. Each outermost span is written again with
 * a longer backtick run. A line that cannot be paired either way shows every backtick as text.
 */
function balanceCodeSpans(line: string): string {
  const runs = [...line.matchAll(LIVE_BACKTICKS_RE)];
  if (pairsAsMarkdown(runs)) return line;
  let out = '';
  let last = 0;
  // The lengths of the runs still open, and where the outermost one starts.
  const open: number[] = [];
  let outer = 0;
  for (const run of runs) {
    const at = run.index!;
    const length = run[0].length;
    const before = line.slice(0, at);
    const after = line.slice(at + length);
    if (open.length > 0 && /\S$/.test(before) && CLOSES_CODE_RE.test(after.slice(0, 1))) {
      // A closing run closes whole opening runs, the latest first, and none partly.
      let left = length;
      let closed = 0;
      while (left > 0 && open.length > 0 && open[open.length - 1] <= left) {
        closed = open.pop()!;
        left -= closed;
      }
      if (left > 0) return escapeBackticks(line);
      if (open.length === 0) {
        out += line.slice(last, outer) + inlineCode(line.slice(outer + closed, at + length - closed));
        last = at + length;
      }
    } else if (OPENS_CODE_RE.test(before.slice(-1)) && /^\S/.test(after)) {
      if (open.length === 0) outer = at;
      open.push(length);
    } else {
      return escapeBackticks(line);
    }
  }
  return open.length === 0 ? out + line.slice(last) : escapeBackticks(line);
}

/** Lines `start` to `end` of `file`. */
interface CodeRange { file: string; start: number; end: number }

/**
 * One check behind a finding: what it showed, empty for a bare location, and the lines it cites when it starts with one.
 * `also` holds any further lines the location lists.
 */
interface Check { text: string; at?: CodeRange; also?: CodeRange[] }

/**
 * Links a finding's code to the reviewed commit. `files` holds the lines of the files read there, which keep a preview
 * inside its file. With `changed`, the PR's changed files, they give a cited file name its directories.
 */
interface CodeLinks { linkTo: LineLink; files: ReadonlyMap<string, readonly string[]>; changed?: readonly string[] }

/**
 * Returns `path` as the repository path it names. A file name with no directories gets those of the one known file
 * with that name, and returns nothing when several have it. When none has it, `atRoot` keeps it as a file at the
 * repository root, and otherwise it returns nothing, since the file can sit in any directory.
 */
function knownPath(path: string, known: readonly string[], atRoot = false): string | undefined {
  if (path.includes('/') || known.includes(path)) return path;
  const matches = [...new Set(known.filter(file => file.endsWith(`/${path}`)))];
  return matches.length === 1 ? matches[0] : matches.length === 0 && atRoot ? path : undefined;
}

/** Returns the range `line` or `start-end` names in `file`, if it is a valid one. */
function lineRange(file: string, lines: string): CodeRange | undefined {
  const [start, end = start] = lines.split('-').map(Number);
  return start > 0 && end >= start ? { file, start, end } : undefined;
}

function parseCheck(entry: string, known: readonly string[], atRoot = false): Check | undefined {
  const match = entry.match(CHECK_LOCATION_RE);
  const [cited, line, last, more] = match ? [1, 5, 9].map(i => match.slice(i, i + 4)).find(group => group[0] !== undefined)! : [];
  const resolved = match ? knownPath(sanitizeFilePath(cited), known, atRoot) : undefined;
  // The cited path and the file names it resolves against are both PR content, so only a plain repository path becomes a link.
  const path = resolved && LINKABLE_PATH_RE.test(resolved) && !resolved.split('/').some(segment => segment === '.' || segment === '..') ? resolved : undefined;
  const at = path ? lineRange(path, last ? `${line}-${last}` : line) : undefined;
  const rest = oneLine(at ? entry.slice(match![0].length) : entry);
  // A sentence starts with a capital, but a text that opens with a path or a name stays as written.
  const text = /^[a-z]+(?![\w./:@-])/.test(rest) ? `${rest[0].toUpperCase()}${rest.slice(1)}` : rest;
  if (!at) return text ? { text } : undefined;
  const also = (more ?? '').split(',').flatMap(lines => lineRange(at.file, lines.trim()) ?? []);
  return { text, at, ...(also.length && { also }) };
}

const overlaps = (a: CodeRange, b: CodeRange): boolean => a.file === b.file && a.start <= b.end && b.start <= a.end;

/** Returns the words of `text` in lower case, with a space on each side. */
function wordsOf(text: string): string {
  return ` ${text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean).join(' ')} `;
}

/**
 * Whether `a` and `b` are one check worded twice, as when two reviewers flag the same problem. They cite the same
 * place, and the code one quotes, at least two words of it, is part of the code the other quotes. Checks that quote
 * no code must say the same words.
 */
function sameCheck(a: Check, b: Check): boolean {
  const lead = (text: string): string | undefined => text.match(/^[^\s`]*(?:\/|:\d)[^\s`]*/)?.[0];
  const place = !a.at && !b.at ? lead(a.text) : undefined;
  if (a.at && b.at ? !overlaps(a.at, b.at) : place === undefined || place !== lead(b.text)) return false;
  // An unlinked check names its place in its text, which is no part of what it says.
  const [saidA, saidB] = [a, b].map(check => (place ? check.text.slice(place.length) : check.text));
  const [codeA, codeB] = [saidA, saidB].map(said => [...said.matchAll(/(?<!\\)(`+)(.+?)(?<!\\)\1/g)].map(span => span[2]).join(' '));
  if (!codeA || !codeB) return wordsOf(saidA) === wordsOf(saidB);
  const [shorter, longer] = [wordsOf(codeA), wordsOf(codeB)].sort((x, y) => x.length - y.length);
  return shorter.trim().includes(' ') && longer.includes(shorter);
}

/**
 * Returns the reviewer's checks, each once, then each further line they list and each proving line that no check cites,
 * then the search that came back empty. `known` holds the repository paths a cited file name is resolved against.
 */
function findingChecks({ evidence }: Finding, known: readonly string[], atRoot = false): Check[] {
  const parsed = (evidence?.checks ?? []).flatMap(entry => parseCheck(entry, known, atRoot) ?? []);
  const checks = parsed.reduce<Check[]>((kept, check) => (kept.some(k => sameCheck(k, check)) ? kept : [...kept, check]), []);
  const proven = (evidence?.proof ?? []).flatMap(proof => parseCheck(proof, known, atRoot)?.at ?? []);
  for (const at of [...parsed.flatMap(c => c.also ?? []), ...proven]) {
    if (!checks.some(c => c.at && overlaps(c.at, at))) checks.push({ text: '', at });
  }
  if (evidence?.emptySearch) checks.push({ text: `Searched with no match: ${oneLine(evidence.emptySearch)}` });
  return checks;
}

/** Cited files whose lines are fetched. A preview in any other file covers only its cited lines. */
const MAX_CITED_FILES = 20;

/**
 * Returns the files a finding's checks cite, whose lines keep its previews inside them, with names resolved against
 * `changed`. A name no changed file has is tried at the repository root, and links only when it is read there.
 */
function citedFiles(finding: Finding, changed: readonly string[]): string[] {
  return findingChecks(finding, changed, true).flatMap(c => c.at?.file ?? []);
}

/** The lines a preview of `at` shows: from the line above it, at most `CHECK_PREVIEW_LINES`, inside the file. */
function previewRange(at: CodeRange, files: ReadonlyMap<string, readonly string[]>): CodeRange {
  const start = Math.max(1, at.start - 1);
  const last = files.get(at.file)?.length;
  const end = Math.min(start + CHECK_PREVIEW_LINES - 1, last ?? at.end);
  return { file: at.file, start, end: Math.max(start, end) };
}

/** Groups located checks into previews. Checks in one file share a preview when theirs fit in `SHARED_PREVIEW_LINES`. */
function checkPreviews(checks: Check[], files: ReadonlyMap<string, readonly string[]>): { range: CodeRange; checks: Check[] }[] {
  const previews: { range: CodeRange; checks: Check[] }[] = [];
  for (const check of checks) {
    const range = previewRange(check.at!, files);
    const shared = previews.find(p => p.range.file === range.file
      && Math.max(p.range.end, range.end) - Math.min(p.range.start, range.start) < SHARED_PREVIEW_LINES);
    if (shared) {
      shared.range = { file: range.file, start: Math.min(shared.range.start, range.start), end: Math.max(shared.range.end, range.end) };
      shared.checks.push(check);
    } else {
      previews.push({ range, checks: [check] });
    }
  }
  for (const preview of previews) preview.checks.sort((a, b) => a.at!.start - b.at!.start);
  return previews;
}

function rangeLabel({ file, start, end }: CodeRange): string {
  return `${file}:${start}${end > start ? `-${end}` : ''}`;
}

function linkedRange(range: CodeRange, linkTo: LineLink): string {
  return `[${inlineCode(rangeLabel(range))}](${linkTo(range.file, range.start, range.end)})`;
}

function refutationPart(label: string, lead: string, { outcome, reason, proof }: Refutation, linkTo: LineLink, known: readonly string[]): FoldPart {
  // The refuter keeps only proof locations that exist in the workspace, so a bare file name there is a root file.
  const cited = outcome === 'confirmed' ? [] : (proof ?? []).flatMap(p => parseCheck(p, known, true)?.at ?? []);
  const text = [lead, reason ? oneLine(reason) : '', cited.length ? `See ${cited.map(r => linkedRange(r, linkTo)).join(', ')}.` : '']
    .filter(Boolean).join(' ');
  return { label, text, open: `**${label}:** ${text}` };
}

/** Returns a part for each refuter that checked `finding`. */
function refutationParts(finding: Finding, linkTo: LineLink, known: readonly string[]): FoldPart[] {
  const { refutation, pairRefutation } = finding;
  const pairLead = pairRefutation && REFUTATION_SUMMARY[outcomeOf(pairRefutation)];
  const lead = refutation && (isDisprovedRaise(finding) ? DISPROVED_RAISE_TEXT : REFUTATION_PART[outcomeOf(refutation)].text);
  return [
    ...(refutation && lead ? [refutationPart(REFUTATION_PART[outcomeOf(refutation)].label, lead, refutation, linkTo, known)] : []),
    ...(pairRefutation && pairLead ? [refutationPart(PAIR_REFUTATION_LABEL, `${pairLead[0].toUpperCase()}${pairLead.slice(1)}.`, pairRefutation, linkTo, known)] : []),
  ];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The parts of a finding's fold that say how it was checked, with the counts and outcomes its summary names. With a
 * `status`, the words of the finding's `checkStatus`, the summary names that in place of the outcomes.
 */
interface FindingChecks { parts: FoldPart[]; reads: string[]; outcomes: string[]; status?: string }

const NOT_CHECKED: FindingChecks = {
  parts: [{ label: 'Not checked against the code', text: 'Nothing was cited to back it.', open: '**Not checked against the code.** Nothing was cited to back it.' }],
  reads: [],
  outcomes: ['not checked against the code'],
};

/**
 * Returns how `finding` was checked: the check on its own line, a code preview with a sentence for up to
 * `MAX_CHECK_PREVIEWS` other places and the rest as links, then each refuter's outcome. A finding that cites nothing
 * says so, unless a tool reported it or it is an earlier round's finding.
 */
function checksSection(finding: Finding, { linkTo, files, changed = [] }: CodeLinks, ownLine: string): FindingChecks {
  const known = [...changed, ...files.keys(), ...(finding.file ? [finding.file] : [])];
  const checks = findingChecks(finding, known);
  const refutations = refutationParts(finding, linkTo, known);
  const status = finding.checkStatus && { status: CHECK_STATUSES[finding.checkStatus] };
  if (checks.length === 0 && refutations.length === 0) {
    return { ...(finding.toolSource || finding.reviewers.length === 0 ? { parts: [], reads: [], outcomes: [] } : NOT_CHECKED), ...status };
  }
  const isOwn = (c: Check): boolean => !!c.at && c.at.file === finding.file && c.at.start <= finding.line && finding.line <= c.at.end;
  const ownChecks = checks.filter(isOwn);
  const own = ownChecks.filter(c => c.text);
  // The comment already sits on its own line, so a bare location there is listed only when nothing else shows.
  const bare = own.length === 0 && checks.length === ownChecks.length && refutations.length === 0 ? ownChecks : [];
  const previews = checkPreviews(checks.filter(c => c.at && !isOwn(c)), files);
  const listed = [...bare, ...previews.slice(MAX_CHECK_PREVIEWS).flatMap(p => p.checks), ...checks.filter(c => !c.at)];
  const shown = previews.slice(0, MAX_CHECK_PREVIEWS);
  // A bare location in the list shows its first line of code, when that file was read.
  const listItem = ({ text, at }: Check): string => {
    if (!at) return `- ${text}`;
    const said = text || codeLine(files.get(at.file)?.[at.start - 1] ?? '');
    return `- ${linkedRange(at, linkTo)}${said ? `: ${said}` : ''}`;
  };
  const lines = [
    ...(own.length ? [`On the ${ownLine} line: ${own.map(c => c.text).join(' ')}`] : []),
    ...shown.map(({ range, checks: shared }) => {
      // The preview shows the code, so a bare location in it adds no line of its own.
      const said = shared.filter(c => c.text);
      const link = linkTo(range.file, range.start, range.end);
      if (said.length === 0) return link;
      return `${said.length === 1 ? said[0].text : `${said.map(c => `- ${c.text}`).join('\n')}\n`}\n${link}`;
    }),
    ...(listed.length ? [listed.map(listItem).join('\n')] : []),
  ];
  const lone = lines.length === 1 && shown.length === 0 && !lines[0].includes('\n');
  const checked: FoldPart[] = lines.length === 0 ? [] : [{
    label: 'Checked in the code',
    text: lines.join('\n\n'),
    ...(lone && { open: lines[0].startsWith('- ') ? `**Checked:** ${lines[0].slice(2)}` : lines[0] }),
  }];
  const read = checks.filter(c => c.at).length;
  const other = checks.length - read;
  return {
    parts: [...checked, ...refutations],
    reads: [read && `${read} ${read === 1 ? 'place' : 'places'} read`, other && plural(other, 'other check')].filter(r => typeof r === 'string'),
    outcomes: [finding.refutation && REFUTATION_SUMMARY[outcomeOf(finding.refutation)], finding.pairRefutation && `second check: ${REFUTATION_SUMMARY[outcomeOf(finding.pairRefutation)]}`].filter(o => typeof o === 'string'),
    ...status,
  };
}

function labelledPart({ label, text }: FoldPart): string {
  return `**${label}**\n${text}`;
}

/**
 * Returns the fold under a finding: the fix, then why it matters, then how it was checked, each under its label, with
 * the refuters' outcomes last. Its summary names what it holds. A part alone that fits on one line shows open instead,
 * since a fold never holds a single line, unless the summary has a `checkStatus` to name.
 */
function formatFold(fix: FoldPart | undefined, why: string, checks: FindingChecks): string {
  const parts = [...(fix ? [fix] : []), ...(why ? [{ label: 'Why it matters', text: why }] : []), ...checks.parts];
  if (parts.length === 0) return '';
  const [first] = parts;
  if (parts.length === 1 && first.open && !first.open.includes('\n') && !checks.status) return `${CHECKS_MARKER}\n${first.open}`;
  const topics = [...(fix ? [HOW_TO_FIX_LABEL] : []), ...(why ? [fix ? 'why' : 'Why it matters'] : [])];
  const outcomes = checks.status ? [checks.status] : checks.outcomes;
  let summary = `How this was checked: ${[...checks.reads, ...outcomes].join(', ')}`;
  if (topics.length > 0) {
    const items = [...topics, ...checks.reads];
    const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')}${items.length > 2 ? ',' : ''} and ${items[items.length - 1]}`;
    summary = `${list}${outcomes.length ? ` · ${outcomes.join(', ')}` : ''}`;
  }
  // The summary names a lone part, so it needs no label of its own, unless the status took the place of its outcome there.
  const named = parts.length === 1 && !(checks.status && checks.outcomes.length > 0);
  const body = named ? first.text : parts.map(labelledPart).join('\n\n');
  return `${CHECKS_MARKER}\n<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

/**
 * Returns the box that files `finding` as an issue. Its id is the file, the line and a hash of the exact title and
 * description, so two findings on one line whose titles differ only in punctuation get boxes of their own.
 */
function issueBoxFor(finding: Finding): string {
  // A file name with `-->` or a line break would end the hidden comment that carries the id, so those are encoded.
  const file = finding.file.replace(/[%<>\r\n]/g, encodeURIComponent);
  const hash = createHash('sha256').update(`${finding.title}\n${finding.description}`).digest('hex').slice(0, 12);
  return issueBox(`${file}:${finding.line}:${hash}`);
}

function formatFindingComment(finding: Finding, links: CodeLinks): string {
  let comment = `${SEVERITY_EMOJI[finding.severity]} ${formatFindingHeader(finding)}\n\n**${sanitizeMarkdown(finding.title)}**\n\n`;
  const note = trustNote(finding);
  if (note) comment += `${note}\n\n`;
  // A committable suggestion stays open, so GitHub offers to commit it. Any other code fix goes in the fold.
  const fixParts = finding.suggestedFix?.trim() ? splitFix(finding.suggestedFix, finding.file) : [];
  const suggestion = suggestionBlock(fixParts);
  const fix = fixPart(finding, suggestion || fixParts.length === 0 ? undefined : renderFixParts(fixParts, finding.file));
  const checks = checksSection(finding, links, 'commented');
  const label = labelDescription(finding, '');
  const open = `${suggestion ? `\n\n${suggestion}` : ''}\n\n${formatFold(fix, '', checks)}`;
  const room = Math.max(MIN_VISIBLE_DESCRIPTION, MAX_VISIBLE_COMMENT - comment.length - label.length - visibleLength(open));
  const description = sanitizeMarkdown(finding.description);
  const { lead, rest } = splitLead(description, 3, room);
  // A fold never holds a single sentence, so one sentence past the lead shows with it, unless the lead was cut short.
  const folds = rest.includes('\n') || rest.split(/(?<=[.!?])\s+/).length > 1 || !description.trim().startsWith(lead);
  const shown = folds ? lead : description.trim();
  comment += `${shown ? labelDescription(finding, shown) : ''}${suggestion ? `\n\n${suggestion}` : ''}`;
  const fold = formatFold(fix, folds ? rest : '', checks);
  if (fold) comment += `\n\n${fold}`;
  comment += `\n\n${issueBoxFor(finding)}`;

  const data: Record<string, unknown> = {
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    flaggedBy: finding.reviewers,
    title: finding.title,
    ...(finding.suggestedFix && { fix: safeTruncate(finding.suggestedFix, 200) }),
    ...(finding.howToFix && { howToFix: safeTruncate(finding.howToFix, 300) }),
    ...(finding.tags && finding.tags.length > 0 && { tags: finding.tags }),
    ...(finding.originalSeverity && { originalSeverity: finding.originalSeverity }),
  };
  comment += `\n\n<!-- manki:${finding.severity}:${titleToSlug(finding.title)} -->`;
  comment += `\n<!-- manki-finding: ${sanitizeHtmlCommentJson(JSON.stringify(data))} -->`;

  return comment;
}

/**
 * React to an issue comment with an emoji. Failures are silently ignored
 * since reactions are non-critical UX signals.
 */
export async function reactToIssueComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
): Promise<void> {
  try {
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  } catch {
    // Non-critical — don't fail the workflow over a reaction
  }
}

/**
 * React to a pull request review comment with an emoji. Failures are silently
 * ignored since reactions are non-critical UX signals.
 */
export async function reactToReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
): Promise<void> {
  try {
    await octokit.rest.reactions.createForPullRequestReviewComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  } catch {
    // Non-critical — don't fail the workflow over a reaction
  }
}

// Room for a non-trivial PR's changed files in full: 400KB is about 110k tokens, a ninth of the finders' context window.
const DEFAULT_MAX_FILE_SIZE = 200 * 1024;
const DEFAULT_MAX_TOTAL_SIZE = 400 * 1024;

/**
 * Fetch file contents for changed files via the GitHub API.
 * Skips binary files and files exceeding the size limit.
 * If total content exceeds the budget, includes only the largest files that fit.
 */
export async function fetchFileContents(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  files: string[],
  maxFileSize: number = DEFAULT_MAX_FILE_SIZE,
  maxTotalSize: number = DEFAULT_MAX_TOTAL_SIZE,
): Promise<Map<string, string>> {
  const results: Array<{ path: string; content: string }> = [];

  const fetches = files.map(async (path) => {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });

      if (Array.isArray(data) || !('content' in data) || data.encoding !== 'base64') {
        return null;
      }

      if (data.size > maxFileSize) {
        core.debug(`Skipping ${path}: ${data.size} bytes exceeds ${maxFileSize} limit`);
        return null;
      }

      const content = Buffer.from(data.content, 'base64').toString('utf-8');

      // Skip binary files (content with null bytes)
      if (content.includes('\0')) {
        core.debug(`Skipping ${path}: binary file`);
        return null;
      }

      return { path, content };
    } catch {
      core.debug(`Could not fetch ${path}`);
      return null;
    }
  });

  const settled = await Promise.all(fetches);
  for (const result of settled) {
    if (result) {
      results.push(result);
    }
  }

  // Sort by content size descending so we include the largest files first
  results.sort((a, b) => b.content.length - a.content.length);

  const fileContents = new Map<string, string>();
  let totalSize = 0;

  for (const { path, content } of results) {
    if (totalSize + content.length > maxTotalSize) {
      core.debug(`Skipping ${path}: would exceed total size budget (${totalSize}/${maxTotalSize})`);
      continue;
    }
    fileContents.set(path, content);
    totalSize += content.length;
  }

  core.info(`Fetched ${fileContents.size}/${files.length} file contents (${totalSize} bytes)`);
  return fileContents;
}

/** The largest file the contents API returns with its content. */
export const MAX_CONTENT_API_BYTES = 1024 * 1024;

/** Returns the lines of each of `files` at `ref`, leaving out any file that can't be read. */
async function fetchFileLines(octokit: Octokit, owner: string, repo: string, ref: string, files: string[]): Promise<Map<string, string[]>> {
  if (files.length === 0) return new Map();
  const contents = await fetchFileContents(octokit, owner, repo, ref, files, MAX_CONTENT_API_BYTES, Infinity);
  return new Map([...contents].map(([path, text]) => [path, fileLines(text)]));
}

/** Returns the lines of a file with `content`, without the empty one a final line break leaves. */
function fileLines(content: string): string[] {
  return content.replace(/\r?\n$/, '').split(/\r?\n/);
}

/**
 * Returns a reader for the lines of the files in `files` that reads each file once. A file that is gone has no lines.
 * A file that cannot be read gives undefined, after a warning that ends with `consequence`.
 */
export function cachedFileLines(files: Pick<RepoFiles, 'read'>, consequence: string): (path: string) => Promise<string[] | undefined> {
  const read = new Map<string, Promise<string[] | undefined>>();
  return path => {
    const lines = read.get(path) ?? files.read(path).then(content => content === null ? [] : fileLines(content), error => {
      core.warning(`Failed to read ${path}, ${consequence}: ${error}`);
      return undefined;
    });
    read.set(path, lines);
    return lines;
  };
}

export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
}

const MAX_ISSUE_BODY_LENGTH = 2000;
const MAX_LINKED_ISSUES = 5;

/** Returns the issue numbers the PR body links with a closing keyword or "part of". */
export function linkedIssueNumbers(prBody: string): Set<number> {
  return new Set([...prBody.matchAll(/(?:closes?|fixes?|resolves?|part\s+of)\s+#(\d+)/gi)].map(match => parseInt(match[1], 10)));
}

/**
 * Parse PR body for issue references and fetch their details.
 */
export async function fetchLinkedIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  prBody: string,
): Promise<LinkedIssue[]> {
  if (!prBody) return [];

  const issueNumbers = linkedIssueNumbers(prBody);
  if (issueNumbers.size === 0) return [];

  const results: LinkedIssue[] = [];
  for (const issueNumber of issueNumbers) {
    if (results.length >= MAX_LINKED_ISSUES) break;
    try {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
      const rawBody = data.body || '';
      const body = rawBody.length > MAX_ISSUE_BODY_LENGTH
        ? sanitizeMarkdown(rawBody.slice(0, MAX_ISSUE_BODY_LENGTH) + '\n... (truncated)')
        : sanitizeMarkdown(rawBody);
      results.push({ number: data.number, title: sanitizeMarkdown(data.title), body });
    } catch {
      core.debug(`Could not fetch linked issue #${issueNumber}`);
    }
  }

  return results;
}

/**
 * Edit a progress comment in place to mark its run as cancelled/superseded.
 * Preserves audit trail — the original dashboard body is kept.
 */
async function markProgressCommentCancelled(
  octokit: Octokit, owner: string, repo: string, commentId: number, originalBody: string,
): Promise<void> {
  if (originalBody.includes(CANCELLED_MARKER)) return;
  const settings = parseSettingsBlock(originalBody);
  const boxes = new Set(settings?.boxes);
  boxes.delete('cancel');
  const body = withSettingsBlock(withMarkers([
    '**Review cancelled:** the run stopped before the review finished.',
    '',
    '<details><summary>Original progress</summary>',
    '',
    stripSettingsBlock(originalBody),
    '',
    '</details>',
  ].join('\n'), CANCELLED_MARKER), settings && { ...settings, status: 'review cancelled', boxes });
  try {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
  } catch (error) {
    core.warning(`Failed to mark progress comment as cancelled: ${error instanceof Error ? error.message : error}`);
  }
}

interface GraphqlConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Runs `query` page by page from `cursor` and returns every node of the connection `connectionOf` picks.
 * `query` must take a `$cursor: String` variable and select `pageInfo { hasNextPage endCursor }`.
 */
async function paginateGraphql<R, T>(
  octokit: Octokit,
  query: string,
  variables: Record<string, unknown>,
  connectionOf: (result: R) => GraphqlConnection<T>,
  cursor: string | null = null,
): Promise<T[]> {
  const nodes: T[] = [];
  do {
    const connection = connectionOf(await octokit.graphql<R>(query, { ...variables, cursor }));
    nodes.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return nodes;
}

/** Returns every review thread on the PR. `threadFields` is the GraphQL selection for one thread. */
async function fetchReviewThreadNodes<T>(
  octokit: Octokit, owner: string, repo: string, prNumber: number, threadFields: string,
): Promise<T[]> {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { ${threadFields} }
          }
        }
      }
    }
  `;
  return paginateGraphql(
    octokit, query, { owner, repo, prNumber },
    (result: { repository: { pullRequest: { reviewThreads: GraphqlConnection<T> } } }) => result.repository.pullRequest.reviewThreads,
  );
}

/** Returns every comment on the PR, most recently updated first. */
async function fetchPRComments(
  octokit: Octokit, owner: string, repo: string, prNumber: number,
): Promise<IssueComment[]> {
  const data = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  return [...data].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

/** Returns Manki's newest comment that ends with a settings block. `comments` come newest first. */
function findSettingsComment(comments: IssueComment[], bot: BotIdentity): (IssueComment & { body: string }) | undefined {
  return comments.find((c): c is IssueComment & { body: string } => isBotUser(bot, c.user) && !!c.body && parseSettingsBlock(c.body) !== undefined);
}

/** Returns Manki's newest comment that has a settings block, with the block. `comments` come newest first. */
function latestSettings(comments: IssueComment[], bot: BotIdentity): { id: number; body: string; settings: SettingsView } | undefined {
  const current = findSettingsComment(comments, bot);
  const settings = current && parseSettingsBlock(current.body);
  return current && settings && { id: current.id, body: current.body, settings };
}

/**
 * Shows `settings` in the block of Manki's newest comment that has one. The block keeps its ticked boxes and,
 * unless `settings` names one, its last reviewed commit. Without such a comment, posts `text` with the block.
 */
async function showSettings(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, settings: SettingsView, text: string,
): Promise<void> {
  try {
    const current = findSettingsComment(await fetchPRComments(octokit, owner, repo, prNumber), bot);
    const live = current && parseSettingsBlock(current.body);
    if (current && live) {
      const view = { ...settings, lastReviewed: settings.lastReviewed ?? live.lastReviewed, ticked: live.ticked };
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: current.id, body: withSettingsBlock(stripSettingsBlock(current.body), view) });
    } else {
      // The complete marker keeps the comment from reading as a run in progress.
      const body = withSettingsBlock(withMarkers(text, ...BOT_MARKERS, REVIEW_COMPLETE_MARKER), settings);
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    }
  } catch (error) {
    core.warning(`Failed to show the review status in the settings block: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Replaces the settings block of comment `commentId` with the block for `settings`, or removes it without one.
 * The comment is read just before, so an edit another run made to it in the meantime stays.
 */
async function setSettingsBlock(octokit: Octokit, owner: string, repo: string, commentId: number, settings?: SettingsView): Promise<void> {
  try {
    const { data } = await octokit.rest.issues.getComment({ owner, repo, comment_id: commentId });
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: withSettingsBlock(stripSettingsBlock(data.body ?? ''), settings) });
  } catch (error) {
    core.warning(`Failed to update the settings block of comment ${commentId}: ${error instanceof Error ? error.message : error}`);
  }
}

/** Removes the settings block from each of Manki's `comments` except `keepId`, so only the newest progress comment has one. */
async function retireSettingsBlocks(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, comments: IssueComment[], keepId: number,
): Promise<void> {
  for (const c of comments) {
    if (c.id !== keepId && isBotUser(bot, c.user) && c.body?.includes(SETTINGS_MARKER)) await setSettingsBlock(octokit, owner, repo, c.id);
  }
}

/**
 * Post-step cleanup: marks the progress comment this run posted as cancelled, unless it already ended.
 * Returns whether it marked one. Invoked when GitHub Actions cancels or fails the main step.
 */
async function markOwnProgressCommentCancelled(octokit: Octokit, owner: string, repo: string): Promise<boolean> {
  const commentId = Number(core.getState(PROGRESS_STATE_KEY));
  if (!commentId) return false;
  try {
    const { data } = await octokit.rest.issues.getComment({ owner, repo, comment_id: commentId });
    if (!data.body || data.body.includes(REVIEW_COMPLETE_MARKER) || data.body.includes(CANCELLED_MARKER)) return false;
    await markProgressCommentCancelled(octokit, owner, repo, commentId, data.body);
    return true;
  } catch (error) {
    // A run that reviews nothing deletes its progress comment.
    if ((error as { status?: number }).status === 404) return false;
    core.warning(`Post-cleanup failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

type BotReviewSummary = {
  id: number;
  state: string;
  commitId: string;
  htmlUrl: string;
  body: string;
};

/**
  * Shared scanner: returns all non-DISMISSED reviews by `bot` on the
  * PR in API order (oldest first), or every one with `includeDismissed`. Callers
  * filter to the commit SHA they care about.
 *
 * Fail-open contract: any API error returns `[]` rather than throwing, so
 * callers such as `hasBotReviewOnCommit` and `isApprovedOnCommit` return
 * `false` and allow the run to proceed. Callers must not wrap this function in
 * a try/catch to handle errors — the catch is already here.
 */
async function fetchBotReviews(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, includeDismissed = false,
): Promise<BotReviewSummary[]> {
  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return reviews.slice(-500)
      .filter((r: { state?: string; user?: { login?: string } | null; body?: string | null }) =>
        isBotUser(bot, r.user) && (includeDismissed || r.state !== 'DISMISSED') &&
        !!r.body && r.body.includes(BOT_MARKER),
      )
      .map((r: unknown) => {
        const raw = r as { id: number; state: string; commit_id: string; html_url?: string; body?: string | null };
        return {
          id: raw.id,
          state: raw.state,
          commitId: raw.commit_id,
          htmlUrl: raw.html_url ?? '',
          body: raw.body ?? '',
        };
      });
  } catch {
    return [];
  }
}

/**
 * State-based head-SHA dedupe gate. Returns the most-recent non-DISMISSED
 * review by `bot` whose `commit_id` matches `commitSha`, otherwise
 * `undefined`. An incomplete review does not count, so a later run still reviews the commit.
 * Run entry points consult this before any LLM call so serialized
 * sibling events (e.g., the `pull_request_review` + `pull_request_review_comment`
 * fan-out from a single human review) cannot post duplicate reviews on the
 * same commit.
 */
async function findBotReviewOnCommit(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string,
): Promise<BotReviewSummary | undefined> {
  const reviews = await fetchBotReviews(octokit, bot, owner, repo, prNumber);
  const onCommit = reviews.filter(r => r.commitId === commitSha && !(r.state === 'COMMENTED' && r.body.startsWith(REVIEW_INCOMPLETE_LINE)));
  return onCommit[onCommit.length - 1];
}

async function hasBotReviewOnCommit(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string,
): Promise<boolean> {
  return (await findBotReviewOnCommit(octokit, bot, owner, repo, prNumber, commitSha)) !== undefined;
}

/**
 * Auto-approve gate. Returns true only when the latest non-DISMISSED bot review
 * (across all commits on the PR) is APPROVED and lands on `commitSha`. The
 * "latest across all commits" semantic is preserved so a fresh CHANGES_REQUESTED
 * on a newer commit overrides an older APPROVED.
 */
async function isApprovedOnCommit(octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string): Promise<boolean> {
  const reviews = await fetchBotReviews(octokit, bot, owner, repo, prNumber);
  const latest = reviews[reviews.length - 1];
  if (!latest || latest.state !== 'APPROVED') return false;
  return latest.commitId === commitSha;
}

type StandingVerdict = {
  verdict: 'APPROVE' | 'REQUEST_CHANGES';
  commitSha: string;
};

/**
 * Returns the verdict of the latest bot review and the commit it reviewed. An
 * approval that a push dismissed still counts as APPROVE. Returns `undefined`
 * for a comment, a dismissal by hand, or when the reviews cannot be read.
 */
async function fetchStandingVerdict(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number,
): Promise<StandingVerdict | undefined> {
  const latest = (await fetchBotReviews(octokit, bot, owner, repo, prNumber, true)).at(-1);
  if (!latest) return undefined;
  if (latest.state === 'APPROVED') return { verdict: 'APPROVE', commitSha: latest.commitId };
  if (latest.state === 'CHANGES_REQUESTED') return { verdict: 'REQUEST_CHANGES', commitSha: latest.commitId };
  if (latest.state !== 'DISMISSED') return undefined;
  // The reviews API reports only `DISMISSED`. The timeline keeps the state
  // before the dismissal and, for a push, the commit that caused it.
  try {
    const events = await octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
      owner, repo, issue_number: prNumber, per_page: 100,
    });
    const dismissed = events
      .map(e => ('dismissed_review' in e ? e.dismissed_review : undefined))
      .find(d => d?.review_id === latest.id);
    if (dismissed?.state === 'approved' && dismissed.dismissal_commit_id) {
      return { verdict: 'APPROVE', commitSha: latest.commitId };
    }
  } catch (error) {
    core.warning(`Failed to read review dismissals: ${error instanceof Error ? error.message : error}`);
  }
  return undefined;
}

export type { CodeLinks };
export { APPROVED_LINE, CHECKS_MARKER, FIX_LABEL, UNCONFIRMED_NOTE, formatFindingBlock, inline, WHAT_GOES_WRONG_LABEL, WHY_LABEL, dynamicFence, fenceText, formatFindingComment, formatSecurityOverrides, formatStatsOneLiner, mapVerdictToEvent, resolveReferences, sanitizeFilePath, sanitizeMarkdown, truncateBody, BOT_LOGIN, BotIdentity, hasWriteAccess, isBotLogin, isRepoAdmin, BOT_MARKER, REVIEW_COMPLETE_MARKER, REVIEW_INCOMPLETE_LINE, PAUSE_NOTICE_MARKER, AUTO_APPROVE_MARKER, CANCELLED_MARKER, VERSION_MARKER_PREFIX, MANKI_VERSION, isApprovedOnCommit, hasBotReviewOnCommit, findBotReviewOnCommit, markOwnProgressCommentCancelled, isFailedProgress, extractVersionFromBody, fetchPRComments, GraphqlConnection, paginateGraphql, fetchReviewThreadNodes, fetchStandingVerdict, latestSettings, retireSettingsBlocks, setSettingsBlock, showSettings, NO_VERDICT_MARKER, HELD_FOR_PERSON_MARKER };
export type { StandingVerdict };
