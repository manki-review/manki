import { createHash } from 'crypto';
import { createRequire } from 'module';
import { posix } from 'path';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { assertWritesAllowed } from './abort';
import { isAllowedAccount } from './auth';
import { changedKeys, DEFAULT_NOTES, fallbackConfig, loadConfig, readClosedPaths } from './config';
import { AgentProgressEntry, ApprovalRecord, RecordOnlyReason, SideCheckKind, agreedOutcome, oneCheckOnBase, sameOnBase, confirmsAll, confirmsCodePath, confirmsDefect, openCodePremise, leftOutUnproven, BinaryFile, CHECK_STATUSES, ConfigSource, DashboardData, DisprovedFinding, FOLLOW_UP_TAG, Finding, PRE_EXISTING_TAG, Refutation, RefutationOutcome, FINDING_CATEGORIES, FINDING_EFFORTS, FindingFingerprintEntry, FindingSeverity, ParsedDiff, RelatedRelation, RelatedWork, ReviewMetadata, RoundDependencySource, ReviewResult, RulesMode, RoundRelatedRepo, PostedPlace, RoundContext, RoundScope, RoundOutcome, RoundUsage, ReviewConfig, ReviewVerdict, SCOPE_READER_NAME, VerdictReport, RoundDiffExcludedFile, StaticSignal, VALID_PR_TYPES, VerdictTraceEntry, TestGuide, isBlockingSeverity, isSecurityFinding, canLeaveOut, UNPOSTED_REASONS } from './types';
import { holdsLines } from './code-window';
import { firstCommentableLine, isLineInDiff, listedFilesDiff, findClosedPattern } from './diff';
import { issueBox, ISSUE_BOX_LABEL, messageBox, withMessageBoxes } from './issue-box';
import { codeTokensFromDiff, highlightCode } from './highlight';
import { citedLine, currentFindingLine, findPriorThreadId } from './finding-fingerprint';
import type { FixClaim, PreviousFinding } from './recap';
import { AUTHOR_CLEAR_ROLES, REVERT_CAUGHT, AuthorClearRole, breaksRule, cellGrade, votedDown, findingKey, isDisprovedBlocker, isGuardedFinding, isGradeCell, isNote, MAX_AGENT_RETRIES, outcomeOf, overruledDisproof, gradedAbove, pendingGrade, SEVERITY_NAME, SEVERITY_ORDER, threadBlocks } from './types';
import { formatDuration, hiddenCharacters, ownMarker, safeTruncate, sanitizeHtmlCommentJson, sanitizeTokens, withMarkers } from './utils';
import { compressReviewRecord, extractApprovalRecords, formatReviewRecord, hasOwnMarker, hasReviewRecord, smallerRecords } from './review-record';
import { modelDisplayName } from './providers/model-registry';
import { formatRunner } from './run-diagnostics';
import { RELATED_REPO_HOST } from './related-repos';
import { distinctModels } from './routing';
import { latestLimits } from './providers/instrumentation';
import type { LimitUsage } from './providers/types';
import { MessageBox, parseSettingsBlock, SETTINGS_MARKER, SettingsView, stripSettingsBlock, withSettingsBlock } from './settings';

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

/** What GitHub says `login` may do on a repo. `role` is absent when the lookup failed or the answer held none. */
interface RepoAccess {
  /** `admin`, `write`, `read` or `none`. It reports a `maintain` role as `write`. */
  permission: string;
  /** GitHub's `role_name`: `admin`, `maintain`, `write`, `triage`, `read`, or the name of a custom role. */
  role?: string;
  /** Whether GitHub reports the account's type as `User`. A bot, an organisation and an answer without a type are no person. */
  person: boolean;
  /** The account's user id, which the token service's allow list knows it by. */
  userId?: number;
}

const permissionLookups = new WeakMap<Octokit, Map<string, Promise<RepoAccess>>>();
const allowListLookups = new WeakMap<Octokit, Map<string, Promise<boolean>>>();

/** Returns the answer `cache` holds for `octokit` under `key`, and asks `lookup` for it the first time. */
function cachedPerClient<T>(cache: WeakMap<Octokit, Map<string, Promise<T>>>, octokit: Octokit, key: string, lookup: () => Promise<T>): Promise<T> {
  let answers = cache.get(octokit);
  if (!answers) {
    answers = new Map();
    cache.set(octokit, answers);
  }
  let answer = answers.get(key);
  if (!answer) {
    answer = lookup();
    answers.set(key, answer);
  }
  return answer;
}

/**
 * Returns the repo access of `login`. `author_association` cannot tell, since an org member with read access shows
 * as `MEMBER` and a private org member with write access as `NONE`. Each client caches its answers, so a run asks
 * once per login. A failed lookup counts as `none` with no role, and as no person.
 */
function repoPermission(octokit: Octokit, owner: string, repo: string, login: string): Promise<RepoAccess> {
  return cachedPerClient(permissionLookups, octokit, `${owner}/${repo}/${login.toLowerCase()}`, async () => {
    try {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login });
      const userId = data.user?.id;
      return {
        permission: data.permission, ...(typeof data.role_name === 'string' && { role: data.role_name }), person: data.user?.type === 'User',
        ...(typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0 && { userId }),
      };
    } catch (error) {
      core.warning(`Could not read the repo permission of ${login}, treating it as none: ${error}`);
      return { permission: 'none', person: false };
    }
  });
}

/**
 * Returns the repository role of `login` when it is at least `needed`, the base branch's `author_clear_role`.
 * Returns none for a lower role, a custom role, an account that is no person, a failed lookup and an unset `needed`.
 * So only a role GitHub confirmed lets a PR author clear a guarded finding on their own PR.
 */
async function authorClearRole(octokit: Octokit, owner: string, repo: string, login: string, needed: AuthorClearRole | undefined): Promise<AuthorClearRole | undefined> {
  if (!needed) return undefined;
  const { role, person } = await repoPermission(octokit, owner, repo, login);
  if (!person) return undefined;
  const held = AUTHOR_CLEAR_ROLES.findIndex(r => r === role);
  return held >= AUTHOR_CLEAR_ROLES.indexOf(needed) ? AUTHOR_CLEAR_ROLES[held] : undefined;
}

/**
 * Whether `login` is a person who can push to the repo, or one a maintainer put on the token service's allow list for
 * it. A `maintain` role reads as `write`. A bot never counts, whatever its permission.
 */
async function hasWriteAccess(octokit: Octokit, owner: string, repo: string, login: string): Promise<boolean> {
  const { permission, person, userId } = await repoPermission(octokit, owner, repo, login);
  if (!person) return false;
  if (['admin', 'write'].includes(permission)) return true;
  return userId !== undefined && await cachedPerClient(allowListLookups, octokit, `${owner}/${repo}/${userId}`, () => isAllowedAccount(owner, repo, userId));
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
/**
 * Opens the marker of a review without a verdict that limits stopped: the time, in ISO 8601, at which they lift. The
 * token service reads it below the round record and starts no retry of the commit before then.
 */
const RETRY_AFTER_MARKER = '<!-- manki-retry-after: ';
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
/** Says that the token service's catch-up started the run, in its progress comment and its review. */
const CATCH_UP_LINE = 'Started automatically, since no review of this commit had finished.';
/** Matches the sentence of an incomplete round's summary that names the review command as the way to retry it. */
const RETRY_COMMAND_RE = /\bretry with \/manki review\b/i;
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

/** Thrown when a PR changes more files than GitHub lists, so its diff cannot be read whole. */
export class TooManyFilesError extends Error {
  constructor(readonly changedFiles: number, readonly listedFiles: number) {
    super(`The PR changes ${changedFiles} files, and GitHub lists only ${listedFiles} of them`);
    this.name = 'TooManyFilesError';
  }
}

/**
 * Whether GitHub refused a diff for its size, as it does for a PR with more than 300 files, or because the diff took
 * too long to generate.
 */
function isDiffRefused(error: unknown): boolean {
  const errors = (error as { response?: { data?: { errors?: unknown } } } | undefined)?.response?.data?.errors;
  return (Array.isArray(errors) && errors.some(e => (e as { code?: unknown } | null)?.code === 'too_large'))
    || /diff exceeded the maximum|diff is taking too long to generate/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Fetches the raw diff of a PR. GitHub refuses the diff of a large PR, so that diff is built from the PR's listed files
 * instead. Throws `TooManyFilesError` when GitHub does not list them all.
 */
export async function fetchPRDiff(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<string> {
  try {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });
    return data as unknown as string;
  } catch (error) {
    if (!isDiffRefused(error)) throw error;
    core.info(`GitHub refused the diff of PR #${prNumber}, reading its listed files instead`);
  }
  const [files, { data: pr }] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 }),
    octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
  ]);
  if (pr.changed_files > files.length) throw new TooManyFilesError(pr.changed_files, files.length);
  return listedFilesDiff(files);
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

const PUSHED_HEAD_WAIT_MS = 3 * 60_000;
const PUSHED_HEAD_POLL_MS = 10_000;

export interface HeadedPull {
  number: number;
  state: string;
  head: { sha: string; ref: string; repo: { name: string; owner: { login: string } } | null };
}

/**
 * Waits until GitHub has moved the open PR `pull` to the newest commit of its head branch, and returns the PR as it is then.
 * GitHub moves the branch with a push, and the PR up to minutes later. When the branch cannot be read at all, `pull` counts
 * as current. `unseen` is the branch's newest commit when the PR still does not show it after the wait.
 */
export async function awaitPushedHead(octokit: Octokit, owner: string, repo: string, pull: HeadedPull): Promise<{ pull: HeadedPull; unseen?: string }> {
  const deadline = Date.now() + PUSHED_HEAD_WAIT_MS;
  const unread = (what: string) => (error: unknown): undefined => {
    core.warning(`Could not read ${what} of #${pull.number}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  };
  let current = pull;
  let newest: string | undefined;
  for (;;) {
    const { head, state, number } = current;
    if (state !== 'open' || !head.ref || !head.repo) return { pull: current };
    // After a failed lookup the last known commit still says whether the PR is behind.
    newest = await octokit.rest.git.getRef({ owner: head.repo.owner.login, repo: head.repo.name, ref: `heads/${head.ref}` })
      .then(r => r.data.object.sha).catch(unread('the head branch')) ?? newest;
    if (!newest || newest === head.sha) return { pull: current };
    if (Date.now() >= deadline) return { pull: current, unseen: newest };
    core.info(`PR #${number} is at ${head.sha.slice(0, 7)} and its branch at ${newest.slice(0, 7)}, waiting for GitHub to move the PR`);
    await new Promise(resolve => setTimeout(resolve, PUSHED_HEAD_POLL_MS));
    current = await octokit.rest.pulls.get({ owner, repo, pull_number: number }).then(r => r.data).catch(unread('the pull request')) ?? current;
  }
}

const MERGEABLE_ATTEMPTS = 3;
const MERGEABLE_RETRY_MS = 1500;

/** Why an approval was posted as a comment instead, or `false` when it was not held. */
export type ApprovalHeld = false | 'conflict' | 'draft' | 'config' | 'unread' | 'warnings' | 'refused';

/** Returns the `approval` a round record keeps for a round that would approve: why it was held, and whether warnings hold it too. */
export function roundApproval(held: ApprovalHeld, warningsHeld: boolean): NonNullable<RoundContext['approval']> {
  return { held, ...(warningsHeld && { warningsHeld: true as const }) };
}

/** Why GitHub refused a review event: the repository setting that stops GitHub Actions from approving, or another reason. */
type EventRefusal = 'setting' | 'other';

/** Leads a review that would approve when GitHub refused the approval, so Manki posted it as a comment. */
const APPROVAL_REFUSED_LINES: Record<EventRefusal, string> = {
  setting: '**Approval held:** GitHub refused the approval because the repository does not allow GitHub Actions to approve pull requests, so this review is a comment. Enable "Allow GitHub Actions to create and approve pull requests" in the repository settings, or approve the PR by hand.',
  other: '**Approval held:** GitHub refused the approval, so this review is a comment. A person needs to approve the PR.',
};

/** The changed files no model reads: those `exclude_paths` or `closed_paths` drops, and those with no code to read, such as binaries. */
export interface SkippedFiles {
  excluded: RoundDiffExcludedFile[];
  binary: BinaryFile[];
}

/** Returns the changed files of `diff` that no model reads. A parsed lockfile is read even when `exclude_paths` drops it, and a deleted binary has nothing to read. */
export function skippedFiles(excluded: RoundDiffExcludedFile[], lockfiles: ReadonlyArray<{ path: string }>, diff: ParsedDiff): SkippedFiles {
  return { excluded: excluded.filter(f => !lockfiles.some(l => l.path === f.path)), binary: (diff.binarySkipped ?? []).filter(f => !f.deleted) };
}

/**
 * The config file that holds an approval because it does not load: the base branch's, the default branch's that stands
 * in for a base without one, or the PR's own copy.
 */
export type ConfigHold = 'base' | 'default_branch' | 'head';

/**
 * Why Manki holds an approval right now: the PR is a draft, it conflicts with `baseRef`, a config file did not load, no
 * model read some of its files, or `count` warnings wait for a fix or an accepted answer. Of those, `unthreaded` have no thread
 * and `guarded` have a thread that no answer of the PR author clears: security warnings and blockers a check disproved. Without `count` the warning threads could not be read. `earlier`
 * are the warning threads of earlier rounds among them, which the review body lists under the line.
 */
export type ApprovalHold = { reason: 'draft' } | { reason: 'conflict'; baseRef: string } | { reason: 'config'; file: ConfigHold } | { reason: 'unread'; skipped: SkippedFiles }
  | { reason: 'warnings'; count?: number; guarded?: number; unthreaded?: number; earlier?: HeldWarningEntry[] };

/** An earlier warning thread that holds the approval, as the review body lists it. */
type HeldWarningEntry = Pick<VerdictTraceEntry, 'file' | 'title' | 'line' | 'threadUrl'>;

/**
 * Returns why an approval must be held, read from the PR as it is now, or `undefined` when it may be posted.
 * Retries while GitHub has not computed whether the PR conflicts with its base. When the PR can't be read,
 * `draftWhenUnread` decides whether it counts as a draft. With `strict` it throws instead when the PR can't be read or
 * GitHub still has not computed the conflict, so the caller never takes an unknown state for no hold.
 */
export async function fetchApprovalHold(octokit: Octokit, owner: string, repo: string, prNumber: number, draftWhenUnread = false, strict = false): Promise<ApprovalHold | undefined> {
  for (let attempt = 1; attempt <= MERGEABLE_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise(resolve => setTimeout(resolve, MERGEABLE_RETRY_MS));
    try {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      if (data.draft) return { reason: 'draft' };
      if (data.mergeable === false || data.mergeable_state === 'dirty') return { reason: 'conflict', baseRef: data.base.ref };
      if (data.mergeable !== null) return undefined;
    } catch (error) {
      if (strict) throw error;
      core.warning(`Mergeable lookup failed, proceeding: ${error instanceof Error ? error.message : error}`);
      return draftWhenUnread ? { reason: 'draft' } : undefined;
    }
  }
  if (strict) throw new Error(`GitHub has not computed whether PR #${prNumber} conflicts with its base`);
  core.info(`GitHub has not computed whether PR #${prNumber} conflicts with its base, proceeding`);
  return undefined;
}

/** Returns the line that says a round requests changes because the round records of `reviews` could not be read while a thread is open. */
export function unreadRecordsLine(reviews: readonly string[]): string {
  const named = reviews.map((url, i) => `[review ${i + 1}](${url})`).join(', ');
  return `**Approval withheld:** Manki could not read its record of an earlier review${named ? ` (${named})` : ''}, so it cannot tell how serious the open threads are. It does not approve while one is open. Once a maintainer has checked and resolved them, the next review can approve.`;
}

/** Returns the judge's summary of a round an unread round record kept from approving, labelled as no reason it blocks. */
export function withheldSummary(summary: string): string {
  const text = sanitizeMarkdown(summary.trim());
  return text ? `**Summary:** ${asSentence(text)}` : '';
}

/** Ends a line that sends someone to the review box while `auto_approve` is off. */
const ROUND_APPROVES_LINE = '`auto_approve` is off, so Manki approves only at the end of a review round, when nothing holds the approval.';

/** Ends a line that tells someone to push for a review. A push starts none while automatic review is off or paused. */
export const AFTER_PUSH_LINE = 'If the push starts no review, as while automatic review is off or paused, comment `/manki review`.';

/**
 * Returns the line that says why Manki does not approve. `autoApprove` is the `auto_approve` setting. With it off the
 * approval check approves nothing, so the lines for a draft and for warnings name the review box and promise no
 * approval for marking the PR ready or for an accepted answer in a thread.
 */
export function approvalHoldLine(hold: ApprovalHold, autoApprove = true): string {
  return holdLine(hold, autoApprove).line;
}

/** Returns the box for the next step the line of `hold` names, which a message that shows the line carries. */
export function approvalHoldBox(hold: ApprovalHold, autoApprove = true): MessageBox | undefined {
  return holdLine(hold, autoApprove).box;
}

/** Returns the line of `approvalHoldLine` with the box that stands for its next step, when the step has one. */
function holdLine(hold: ApprovalHold, autoApprove: boolean): { line: string; box?: MessageBox } {
  if (hold.reason === 'draft') {
    if (!autoApprove) return { line: `**Approval held:** this PR is a draft. Mark it ready for review, then tick the review box in the settings block. ${ROUND_APPROVES_LINE}`, box: 'again' };
    // "Nothing else" covers only what the PR shows, such as an open thread or a conflict. For every other case, in which
    // nothing follows, the check command names the reason.
    return { line: '**Approval held:** this PR is a draft. Mark it ready for review, and Manki approves it if nothing else holds the approval. If the latest commit has no review yet, Manki reviews it first when automatic review runs on this PR. If nothing happens, as for a PR from a fork or while automatic review is off or paused, comment `/manki check`, and Manki approves or says what holds the approval.', box: 'check' };
  }
  if (hold.reason === 'config') {
    return {
      line: hold.file !== 'head'
        ? `**Approval held:** the config file on the ${hold.file === 'base' ? 'base branch' : 'default branch, which this review reads because the base branch has none,'} could not be read or does not load, so Manki reviewed with the defaults.`
        : `**Approval held:** this PR's copy of the config file does not load or could not be read. Fix it and push, and Manki reviews the new commit. ${AFTER_PUSH_LINE}`,
    };
  }
  if (hold.reason === 'unread') return { line: `**Approval held:** no model read some of the files this PR changes, so a person needs to approve it.\n\n${formatSkippedFiles(hold.skipped)}` };
  if (hold.reason === 'warnings') {
    if (hold.count === undefined) {
      const line = '**Approval waits on the warning threads.** Manki could not read them, so it does not approve yet.';
      return autoApprove
        ? { line: `${line} Comment \`/manki check\`, and Manki approves or says what holds the approval.`, box: 'check' }
        : { line: `${line} Tick the review box in the settings block. ${ROUND_APPROVES_LINE}`, box: 'again' };
    }
    const lead = `**${countOf(hold.count, 'warning')} to address.** ${hold.count === 1 ? 'Fix it' : 'Fix each one'}`;
    // A warning without a thread can only be fixed, and holds until a later round no longer finds it.
    const unthreaded = hold.unthreaded ?? 0;
    const threaded = hold.count - unthreaded;
    const noThread = (n: number) => `${n === 1 ? 'has no thread and holds' : 'have no thread and hold'} until a later review round no longer finds ${n === 1 ? 'it' : 'them'}.`;
    if (threaded === 0) return { line: `${lead}. ${hold.count === 1 ? 'It' : 'They'} ${noThread(hold.count)}` };
    // Neither a reply nor the issue box clears a guarded warning, which needs a fix or a resolve by someone allowed to
    // clear it. The box is named only when every holding warning has a thread to tick it in. A reply lifts a hold only
    // when Manki accepts it, so the line promises nothing for an explanation alone.
    const guarded = hold.guarded ?? 0;
    const explain = 'reply in its thread with a reason Manki accepts';
    const ways = guarded === threaded ? 'or have a maintainer resolve its thread'
      : unthreaded > 0 ? `or ${explain}` : `${explain}, or tick \`${ISSUE_BOX_LABEL}\` to track it for later`;
    const mixed = guarded > 0 && guarded < threaded ? ' A security warning, or a warning a check lowered from a blocker, needs a fix or a maintainer to resolve its thread.' : '';
    const line = `${lead}, ${ways}.${mixed}${unthreaded > 0 ? ` ${unthreaded} of them ${noThread(unthreaded)}` : ''}`;
    return autoApprove ? { line } : { line: `${line} Once every warning is handled, tick the review box in the settings block. ${ROUND_APPROVES_LINE}`, box: 'again' };
  }
  return { line: `**Approval held:** this PR conflicts with ${inline(hold.baseRef)}. Rebase it, and Manki reviews the result. ${AFTER_PUSH_LINE}` };
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
  binary: 'no lines to read, such as a binary, a rename, a mode change, an empty file or a diff too large for GitHub to show',
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
    ...excluded.map(f => `- ${inline(f.path)}: matches ${inline(f.matchedPattern)} in \`${f.closed ? 'closed_paths' : 'exclude_paths'}\``),
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

/** The most files GitHub lists for a comparison. It says nothing when it leaves more out. */
export const MAX_COMPARE_FILES = 300;

/** Why a change since a commit is not known: the head does not descend from it, as after a rebase or a force push, or it could not be read. */
export type UnknownChange = 'not_descendant' | 'unreadable';

/**
 * Returns the unified diff of `files`, or of every file without them, from `base` to `head`, or why it is not known. A file
 * GitHub leaves out of a long comparison is missing from the diff of `files`. The diff of every file is not known then,
 * since a file left out would read as unchanged.
 */
export async function readChangesSince(octokit: Octokit, owner: string, repo: string, base: string, head: string, files?: readonly string[]): Promise<{ diff: string } | { unknown: UnknownChange }> {
  if (base === head) return { diff: '' };
  try {
    const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base, head });
    if (data.status !== 'ahead' && data.status !== 'identical') return { unknown: 'not_descendant' };
    if (!files && (data.files?.length ?? 0) >= MAX_COMPARE_FILES) return { unknown: 'unreadable' };
    // A file renamed since keeps its old name only in `previous_filename`.
    return { diff: listedFilesDiff((data.files ?? []).filter(f => !files || files.includes(f.filename) || (!!f.previous_filename && files.includes(f.previous_filename)))) };
  } catch (error) {
    core.warning(`Failed to compare ${base} with ${head}: ${error}`);
    return { unknown: 'unreadable' };
  }
}

/** Returns the diff of `readChangesSince`, or `undefined` when it is not known. */
export async function fetchChangesSince(...args: Parameters<typeof readChangesSince>): Promise<string | undefined> {
  const change = await readChangesSince(...args);
  return 'diff' in change ? change.diff : undefined;
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

/** Returns the sha of the merge base of `base` and `head`: the commit the PR's diff starts from. */
export async function fetchMergeBase(octokit: Octokit, owner: string, repo: string, base: string, head: string): Promise<string> {
  const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base, head, per_page: 1 });
  return data.merge_base_commit.sha;
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

/** Returns the git blob id of `bytes`. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** The answer of the contents API for one path, as far as Manki reads it. */
type ContentAnswer = { type: string; sha: string; content?: string; encoding?: string } | unknown[];

/** Thrown when a file exists but was not read: a symlink whose target is never read, or content GitHub or git did not give. */
export class UnreadFileError extends Error {}

/**
 * Returns the bytes of a contents API answer when they are the file at the path asked for. GitHub answers a symlink to a
 * file with the target's content and the type `file`, but with the blob id of the link itself, so content whose blob id
 * differs from the one reported is a followed symlink and gives none. So does a `symlink` answer, which has no content.
 */
function ownContent(data: ContentAnswer): Buffer | undefined {
  if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string' || data.encoding !== 'base64') return undefined;
  const bytes = Buffer.from(data.content, 'base64');
  return gitBlobSha(bytes) === data.sha ? bytes : undefined;
}

/**
 * Returns a config file's content at `ref`, or null when it does not exist. Throws when it cannot be read. Without
 * `followSymlinks`, a symlink reads as no file, never as its target.
 */
export async function readConfigFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  configPath: string,
  followSymlinks = true,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: configPath, ref });
    if (!followSymlinks) {
      if (Array.isArray(data)) return null;
      const bytes = ownContent(data as ContentAnswer);
      if (!bytes) throw new UnreadFileError(`${configPath} was not read: a symlink, a file over 1 MB or content that does not match its hash`);
      return bytes.toString('utf-8');
    }
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

/** Whether the config of the base branch, or the default branch's in its place, could not be read or loaded. */
export function configFailed(source: ConfigSource): boolean {
  return source.endsWith('_unreadable') || source.endsWith('_invalid');
}

/**
 * Returns the top-level keys the change's own config `head` edits against the base branch's. A base config that could
 * not be read or loaded gives none, since the defaults that stand in for it are not what the change edits. Neither does
 * one taken from the default branch, which the change does not edit.
 */
export function editedKeys(head: ReviewConfig, base: { config: ReviewConfig; source: ConfigSource }): string[] {
  return configFailed(base.source) || base.source === 'default_branch' ? [] : changedKeys(head, base.config);
}

/**
 * Returns the config file that holds the round's approval: the base branch's, or the default branch's in its place, when
 * it could not be read or loaded, else the PR's own when `brokenOwnCopy` says the PR changed it and it does not load. A
 * PR that only predates the base's copy holds nothing.
 */
export function brokenConfig(source: ConfigSource, brokenOwnCopy: boolean): ConfigHold | undefined {
  if (configFailed(source)) return source.startsWith('default_branch') ? 'default_branch' : 'base';
  return brokenOwnCopy ? 'head' : undefined;
}

/**
 * Loads the base branch's config, which `read` returns. When the base has no file, `readDefault` reads the default
 * branch's in its place, and without one either the built-in defaults apply. A read that fails is tried once more. A
 * file that does not load gives the defaults, with the source saying why, so the change that fixes it is still reviewed.
 * The defaults keep the `closed_paths` the file sets, as `readClosedPaths` reads them. When the file cannot say which
 * paths it closes, because both reads fail or `readClosedPaths` reads nothing, `closedUnknown` is the note to post in
 * place of anything a model would read. `describe` words the error in the warning.
 */
export async function loadBaseConfig(
  read: () => Promise<string | null>,
  configPath: string,
  describe: (error: unknown) => string,
  readDefault?: () => Promise<string | null>,
): Promise<{ config: ReviewConfig; source: ConfigSource; closedUnknown?: string }> {
  let fromDefault = false;
  const branch = () => (fromDefault ? 'default branch' : 'base branch');
  const fallBack = (failure: 'unreadable' | 'invalid', problem: string, error: unknown, closedPaths?: string[]) => {
    core.warning(`${problem} ${configPath} on the ${branch()}, using the defaults and no approval: ${describe(error)}`);
    const source: ConfigSource = fromDefault ? `default_branch_${failure}` : `base_${failure}`;
    if (closedPaths) return { config: fallbackConfig(closedPaths), source };
    const why = failure === 'unreadable' ? 'could not be read' : 'names `closed_paths` but does not parse, or its `closed_paths` is not a list of paths';
    const closedUnknown = `The ${branch()}'s \`${configPath}\` ${why}, so Manki cannot tell which paths \`closed_paths\` keeps from every model, and reads no code until it is fixed.`;
    return { config: fallbackConfig(), source, closedUnknown };
  };
  const readTwice = (reader: () => Promise<string | null>) => reader().catch((error: unknown) => {
    core.info(`Could not read ${configPath} on the ${branch()}, trying once more: ${describe(error)}`);
    return reader();
  });
  let content: string | null;
  try {
    content = await readTwice(read);
    if (content === null && readDefault) {
      fromDefault = true;
      content = await readTwice(readDefault);
    }
  } catch (error) {
    return fallBack('unreadable', 'Could not read', error);
  }
  try {
    const config = loadConfig(content ?? undefined, configPath);
    if (content !== null && fromDefault) {
      core.info(`The base branch has no ${configPath}, so this run uses the default branch's`);
      return { config, source: 'default_branch' };
    }
    return { config, source: config.review ? 'base' : 'builtin' };
  } catch (error) {
    return fallBack('invalid', 'Could not load', error, readClosedPaths(content));
  }
}

const MAX_RESOLVE_DEPTH = 3;

/** Reads a repository's files at one commit. */
export interface RepoFiles {
  /**
   * Returns a file's content, or null when no file is at `path`. Throws when it cannot be read. A symlink reads as its
   * target, or with `followSymlinks` false as no file.
   */
  read(path: string, followSymlinks?: boolean): Promise<string | null>;
  /** Returns the path of every file in the tree. */
  list(): Promise<string[]>;
}

export function githubRepoFiles(octokit: Octokit, owner: string, repo: string, ref: string): RepoFiles {
  return {
    read: (path, followSymlinks) => readConfigFile(octokit, owner, repo, ref, path, followSymlinks),
    list: async () => {
      const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: ref, recursive: 'true' });
      return data.tree.filter(e => e.type === 'blob' && e.path).map(e => e.path!);
    },
  };
}

/**
 * Returns `files` without the paths `closedPaths` closes: reading one finds no file, and the list leaves it out. A
 * symlink reads as no file either, since its target can be closed. With `refuseClosed`, reading a closed path throws
 * instead, for a caller that must not take a closed file for a deleted one.
 */
export function openRepoFiles(files: RepoFiles, closedPaths: readonly string[], refuseClosed = false): RepoFiles {
  if (closedPaths.length === 0) return files;
  const closed = (path: string): null => {
    if (refuseClosed) throw new Error(`${path} is closed by \`closed_paths\``);
    return null;
  };
  return {
    read: async (path) => {
      if (findClosedPattern(path, closedPaths)) return closed(path);
      try {
        return await files.read(path, false);
      } catch (error) {
        if (!refuseClosed && error instanceof UnreadFileError) return null;
        throw error;
      }
    },
    list: async () => (await files.list()).filter(path => !findClosedPattern(path, closedPaths)),
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
const ROOT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'];
/** The places GitHub looks for a contributing guide, in its order. Only the first found is read. */
const CONTRIBUTING_GUIDES = ['.github/CONTRIBUTING.md', 'CONTRIBUTING.md', 'docs/CONTRIBUTING.md'];
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

/** Returns the repo description and the instruction files `buildRepoContext` reads at `ref`, none of them closed by `closedPaths`. */
export async function fetchRepoContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  changedPaths: string[],
  closedPaths: readonly string[] = [],
): Promise<RepoContext> {
  const context = await buildRepoContext(openRepoFiles(githubRepoFiles(octokit, owner, repo, ref), closedPaths), changedPaths);
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
 * and the first contributing guide of `CONTRIBUTING_GUIDES`, then the `.md` files they link to, breadth first. A path
 * appears once, and so do files with the same content after `@file` resolution. The file that crosses
 * `MAX_INSTRUCTIONS_CHARS` is cut, and farther files are left out.
 */
export async function buildRepoContext(files: RepoFiles, changedPaths: string[]): Promise<RepoContext> {
  const queue: { path: string; depth: number; guide?: boolean }[] = [...await findNearestInstructionFiles(files, changedPaths), ...ROOT_INSTRUCTION_FILES].map(path => ({ path, depth: 0 }));
  const queued = new Set(queue.map(({ path }) => path));
  // A guide passed over is left out of `queued`, so a link to it still reads it.
  queue.push(...CONTRIBUTING_GUIDES.map(path => ({ path, depth: 0, guide: true })));

  const parts: string[] = [];
  const loaded: InstructionFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let cut: string | undefined;
  let guideFound = false;
  for (const { path, depth, guide } of queue) {
    if (guide && guideFound) continue;
    const file = await readInstructionFile(files, path);
    if (guide && file !== null) {
      guideFound = true;
      queued.add(path);
    }
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
 * Returns the file's content with `@file` references inlined and the `.md` files it links to, or null when no file is at
 * `path`. A file that cannot be read is logged and reads as empty, so the guide search stops at it as GitHub would.
 */
async function readInstructionFile(files: RepoFiles, path: string): Promise<{ content: string; links: string[] } | null> {
  try {
    const content = await files.read(path);
    if (content === null) return null;
    const links: string[] = [];
    return { content: await resolveReferences(files, content, dirOf(path), links), links };
  } catch (error) {
    core.warning(`Could not read instruction file ${path}: ${error}`);
    return { content: '', links: [] };
  }
}

/**
 * Build text status lines showing review progress across phases.
 */
export const INDENT = '&nbsp;&nbsp;&nbsp;&nbsp;';

/** The time from `startedAt` until `now`, as a live line shows it. */
function soFar(startedAt: number, now: number): string {
  return `${formatDuration(Math.max(1000, now - startedAt))} so far`;
}

function renderAgentLines(agents: AgentProgressEntry[], now: number): string {
  return agents.map(a => {
    const name = sanitizeMarkdown(a.name);
    if (a.status === 'done') {
      return `${INDENT}✅ ${name}: ${countOf(a.findingCount ?? 0, 'finding')} (${a.reused ? 'kept from the last attempt' : formatDuration(a.durationMs ?? 0)})`;
    }
    if (a.status === 'failed') {
      const why = (a.notStarted ?? []).map(line => `. ${sanitizeMarkdown(line.charAt(0).toUpperCase() + line.slice(1))}`).join('');
      if (a.retryCount && a.retryCount > 0) {
        return `${INDENT}🔴 ${name}: failed after ${a.retryCount + 1} attempts (${formatDuration(a.durationMs ?? 0)})${why}`;
      }
      return `${INDENT}🔴 ${name}: failed (${formatDuration(a.durationMs ?? 0)})${why}`;
    }
    if (a.status === 'retrying') {
      if (a.retryCount != null) {
        return `${INDENT}🔁 ${name}: retrying (${a.retryCount + 1}/${MAX_AGENT_RETRIES + 1})`;
      }
      return `${INDENT}🔁 ${name}: retrying`;
    }
    if (a.status === 'reviewing') {
      if (a.startedAt === undefined) return `${INDENT}⏳ ${name}`;
      const steps = a.toolSteps ? `${countOf(a.toolSteps, 'tool step')} · ` : '';
      return `${INDENT}⏳ ${name}: ${steps}${soFar(a.startedAt, now)}`;
    }
    return `${INDENT}○ ${name}`;
  }).join('\n');
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
    .map(s => countOf(severities[s], SEVERITY_NAME[s]))
    .join(' · ');
}

function reviewHeading(routing: DashboardData['routing']): string {
  if (!routing) return 'Review';
  const route = [routing.class, routing.group].filter((part): part is string => Boolean(part)).join(' · ');
  return `Review (${sanitizeMarkdown(route)})`;
}

const SIDE_CHECK_NAMES: Record<SideCheckKind, string> = { comparison: 'comparisons', related: 'related checks', claim: 'claim checks', pattern: 'pattern checks', fix: 'fix checks', sweep: 'sweeps', second_read: 'second reads', origin: 'origin checks' };
// `runReview` starts these five steps beside the finders in every round, the second reads after the finders and the sweeps after the judge, so the sweeps show under the judge.
const BESIDE_FINDERS: SideCheckKind[] = ['comparison', 'related', 'claim', 'pattern', 'fix'];

/**
 * The line of the side checks of `kinds`, such as `⏳ Comparisons and claim checks: 2 of 5 done, 1 finding`. It is done
 * once every step of `kinds` ended all its checks. Unset while none of them asks a check.
 */
function sideCheckLine(checks: DashboardData['sideChecks'], kinds: SideCheckKind[]): string | undefined {
  const steps = kinds.flatMap(kind => (checks?.[kind] ? [{ kind, ...checks[kind] }] : []));
  const asking = steps.filter(step => step.total > 0);
  if (asking.length === 0) return undefined;
  const names = asking.map(step => SIDE_CHECK_NAMES[step.kind]);
  const label = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const sum = (field: 'total' | 'ended' | 'findings') => asking.reduce((n, step) => n + step[field], 0);
  const found = sum('findings') > 0 ? `, ${countOf(sum('findings'), 'finding')}` : '';
  const text = `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${sum('ended')} of ${sum('total')} done${found}`;
  const ends = steps.map(step => step.endedAt);
  if (steps.length < kinds.length || ends.some(end => end === undefined)) return `${INDENT}⏳ ${text}`;
  const took = Math.max(...ends as number[]) - Math.min(...steps.map(step => step.startedAt));
  return `${INDENT}✅ ${text} (${formatDuration(took)})`;
}

/**
 * The refuter's line, such as `refuter: 1 of 3 checks done · 1 disproved` while it checks and `refuter: 3 checked · 1
 * disproved` once every check ended. Unset while it checks nothing.
 */
function refuterLine(refuter: DashboardData['refuter']): string | undefined {
  if (!refuter || refuter.total === 0) return undefined;
  const outcomes = (['confirmed', 'disproved', 'unsettled'] as const).filter(o => (refuter.outcomes[o] ?? 0) > 0).map(o => `${refuter.outcomes[o]} ${o}`);
  const done = Object.values(refuter.outcomes).reduce((n, count) => n + (count ?? 0), 0);
  const progress = done === refuter.total ? `${done} checked` : `${done} of ${refuter.total} checks done`;
  return `${INDENT}refuter: ${progress}${outcomes.map(o => ` · ${o}`).join('')}`;
}

/**
 * The lines under the judge in the order its steps ran: its grades, the refuter's checks, the origin checks, the sweeps
 * and the verdict reader, each once it started. The finished comment names the finders' grades of the dropped findings.
 */
function judgeStepLines(data: DashboardData, now: number): string[] {
  const { graded, verdictReader: reader } = data;
  const done = data.phase === 'complete';
  const dropped = done && data.droppedSeverities ? renderSeverityBreakdown(data.droppedSeverities) : '';
  return [
    graded && `${INDENT}graded ${countOf(graded.kept + graded.dropped + graded.merged, 'finding')}: ${graded.kept} kept · ${graded.dropped} dropped${graded.merged ? ` · ${graded.merged} merged` : ''}${done ? '' : ` (${formatDuration(graded.durationMs)})`}`,
    dropped && `${INDENT}dropped, as the finders filed them: ${dropped}`,
    refuterLine(data.refuter),
    originLine(data),
    ...sweepLines(data),
    reader && `${INDENT}verdict reader: ${reader.durationMs === undefined ? `reading the diff · ${soFar(reader.startedAt, now)}` : `read the diff (${formatDuration(reader.durationMs)})`}`,
  ].filter((line): line is string => !!line);
}

/**
 * What the round added to the review's findings or took out of them before the judge graded them, such as `1 tool alert
 * added`.
 */
function beforeJudge(data: DashboardData): string {
  const repeats = (data.staticDedupCount ?? 0) + (data.llmDedupCount ?? 0) - (data.sweepDedupCount ?? 0);
  const leads = data.openLeadCount ?? 0;
  return ([
    [data.toolAlertCount ?? 0, 'tool alert added', 'tool alerts added'],
    [data.carriedLeadCount ?? 0, 'possible problem carried over from the last round', 'possible problems carried over from the last round'],
    [leads, 'possible problem not finished checking', 'possible problems not finished checking'],
    [repeats, 'dropped as a repeat of an earlier resolved finding', 'dropped as repeats of earlier resolved findings'],
  ] as const).filter(([count]) => count > 0).map(([count, singular, plural]) => countOf(count, singular, plural)).join(', ');
}

/**
 * The sweeps' line, such as `sweeps: 1 of 2 done`, written like the other lines under the judge since the sweeps run on
 * the findings it kept. A second line counts the sweep findings dropped as repeats.
 */
function sweepLines(data: DashboardData): string[] {
  const sweep = data.sideChecks?.sweep;
  if (!sweep || sweep.total === 0) return [];
  const found = sweep.findings > 0 ? `, ${countOf(sweep.findings, 'finding')}` : '';
  const took = sweep.endedAt === undefined ? '' : ` (${formatDuration(sweep.endedAt - sweep.startedAt)})`;
  const line = `${INDENT}sweeps: ${sweep.ended} of ${sweep.total} done${found}${took}`;
  const drops = ([
    [data.sweepRepeatCount ?? 0, 'sweep finding already judged this round', 'sweep findings already judged this round'],
    [data.sweepDedupCount ?? 0, 'sweep finding dropped as a repeat of an earlier resolved finding', 'sweep findings dropped as repeats of earlier resolved findings'],
  ] as const).filter(([count]) => count > 0).map(([count, singular, plural]) => countOf(count, singular, plural));
  return [line, ...(drops.length > 0 ? [`${INDENT}${drops.join(', ')}`] : [])];
}

/**
 * The origin checks' line, under the judge since they run on the findings it kept. While they run it reads `origin
 * checks: 1 of 2 done`, and once every check ended `origin checks: 2 checked · 1 older than this PR`.
 */
function originLine(data: DashboardData): string | undefined {
  const origin = data.sideChecks?.origin;
  if (!origin || origin.total === 0) return undefined;
  if (origin.endedAt === undefined) return `${INDENT}origin checks: ${origin.ended} of ${origin.total} done`;
  return `${INDENT}origin checks: ${origin.ended} checked${origin.findings > 0 ? ` · ${origin.findings} older than this PR` : ''}`;
}

/** How the progress comment names each reason a finding is in the round record only. Reasons with one name are counted together. */
const RECORD_ONLY_NAMES: Record<RecordOnlyReason, string> = {
  pre_existing: 'older than this PR',
  reviewed_code: 'on code an earlier round reviewed',
  listed_earlier: 'listed by an earlier round',
  note_cap: 'over the `review.notes` limit',
  caught_by_test: 'already caught by a test',
  memory_suppression: 'suppressed by memory',
  static_signal_match: 'reported by a CI tool',
  no_trigger: 'no realistic trigger',
  rare_trigger: 'rare trigger',
  unsettled_check: 'no proof',
  not_checked: 'no proof',
  no_proof: 'no proof',
  refutation: 'disproved by a check of the code',
  in_pr_suppression: 'suppressed in this PR',
  resolved_thread: 'matches a resolved thread',
  ratchet: 'matches an earlier round',
};

/**
 * The finished comment's section on what the review posted: the count and grades of the posted findings, the ones no
 * judge call graded, and why each finding the judge kept and the review did not post stayed out.
 */
function postedLines(data: DashboardData, posted: Record<string, number>): string[] {
  const named = new Map<string, number>();
  for (const [reason, name] of Object.entries(RECORD_ONLY_NAMES) as Array<[RecordOnlyReason, string]>) {
    const count = data.recordOnly?.[reason] ?? 0;
    if (count > 0) named.set(name, (named.get(name) ?? 0) + count);
  }
  const recordOnly = [...named].map(([name, count]) => `${count} ${name}`).join(' · ');
  const grades = renderSeverityBreakdown(posted);
  const throttled = data.testNitSuppressedCount ?? 0;
  return [
    `**Posted:** ${countOf(Object.values(posted).reduce((n, count) => n + count, 0), 'finding')}`,
    grades && `${INDENT}${grades}`,
    data.addedAfterJudgeCount ? `${INDENT}added after the judge: ${countOf(data.addedAfterJudgeCount, 'finding')}` : '',
    recordOnly && `${INDENT}not posted: ${recordOnly}`,
    data.unsettledLeadCount ? `${INDENT}not finished checking: ${countOf(data.unsettledLeadCount, 'possible problem')}` : '',
    data.repeatCount ? `${INDENT}left out as repeats of other findings: ${data.repeatCount}` : '',
    throttled > 0 ? `${INDENT}left out: ${countOf(throttled, 'suggestion')} on test files, which Manki posts only in the first round` : '',
  ].filter(line => line);
}

/** Renders the stages of `data`. A review still running shows the time each running stage has taken by `now`. */
export function buildDashboard(data: DashboardData, now = Date.now()): string {
  const agents = data.agentProgress;
  const review = reviewHeading(data.routing);
  const hasAgentProgress = !!(agents && agents.length > 0);
  const sections: string[] = [];

  if (data.catchUp) sections.push(CATCH_UP_LINE);
  if (data.phase !== 'complete') {
    sections.push('**Review in progress**');
  }

  const plannerLines: string[] = [];
  if (data.phase === 'planning') {
    plannerLines.push(`**Planner**`);
    plannerLines.push(`${INDENT}analyzing...${data.plannerStartedAt === undefined ? '' : ` (${soFar(data.plannerStartedAt, now)})`}`);
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
      reviewLines.push(renderAgentLines(agents, now));
    } else {
      reviewLines.push(`**${review}**`);
      reviewLines.push(`${INDENT}reviewing with ${data.agentCount} agents...`);
    }
  } else {
    reviewLines.push(`**${review}:** ${countOf(data.rawFindingCount ?? 0, 'finding')}`);
    if (hasAgentProgress) {
      reviewLines.push(renderAgentLines(agents, now));
    }
  }
  reviewLines.push(...[sideCheckLine(data.sideChecks, BESIDE_FINDERS), sideCheckLine(data.sideChecks, ['second_read'])].filter((line): line is string => !!line));
  const sameEffort = data.routing?.deeperSameEffort;
  if (sameEffort) {
    reviewLines.push(`${INDENT}_(the deeper review adds no effort for ${sameEffort.map(sanitizeMarkdown).join(', ')}: the model receives no more effort than without it)_`);
  }
  sections.push(reviewLines.join('\n'));

  const judgeLines: string[] = [];
  if (data.phase === 'planning' || data.phase === 'started') {
    judgeLines.push(`**Judge**`);
    judgeLines.push(`${INDENT}pending`);
  } else if (data.judgeSkipped) {
    judgeLines.push(`**Judge:** skipped, nothing to judge`);
    const drops = beforeJudge(data);
    if (drops) judgeLines.push(`${INDENT}before the judge: ${drops}`);
    judgeLines.push(...judgeStepLines(data, now));
  } else if (data.phase === 'reviewed') {
    judgeLines.push(`**Judge**`);
    if (!data.graded) {
      const drops = beforeJudge(data);
      const time = data.judgeStartedAt === undefined ? '' : ` · ${soFar(data.judgeStartedAt, now)}`;
      judgeLines.push(`${INDENT}grading ${data.judgeInputCount ?? data.rawFindingCount ?? 0} findings${drops ? ` (${drops})` : ''}${time}`);
    }
    judgeLines.push(...judgeStepLines(data, now));
  } else {
    judgeLines.push(`**Judge**${data.judgeDurationMs != null ? ` (${formatDuration(data.judgeDurationMs)})` : ''}`);
    const drops = beforeJudge(data);
    if (drops) judgeLines.push(`${INDENT}before the judge: ${drops}`);
    judgeLines.push(...judgeStepLines(data, now));
  }
  sections.push(judgeLines.join('\n'));
  if (data.phase === 'complete' && data.postedSeverities) sections.push(postedLines(data, data.postedSeverities).join('\n'));

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
  return placeProgressComment(octokit, owner, repo, prNumber, body);
}

/**
 * Posts `body` as the run's progress comment, or edits comment `reuseId` into it, and saves the comment's ID for the post
 * step. A new comment is posted when `reuseId` cannot be edited.
 */
async function placeProgressComment(octokit: Octokit, owner: string, repo: string, prNumber: number, body: string, reuseId?: number): Promise<number> {
  let id = reuseId;
  if (id !== undefined) {
    try {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: id, body });
    } catch (error) {
      core.warning(`Failed to reuse comment ${id}, posting a new one: ${error instanceof Error ? error.message : error}`);
      id = undefined;
    }
  }
  id ??= (await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body })).data.id;
  core.saveState(PROGRESS_STATE_KEY, String(id));
  return id;
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

/**
 * Posts the comment that shows an auto-approve of `headSha` is running, or turns comment `reuseId` into it. The post step
 * marks it cancelled when the run stops early.
 */
export async function postAutoApproveProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  reuseId?: number,
): Promise<number> {
  const body = withMarkers('**Auto-approving:** no findings remain.', ...BOT_MARKERS, autoApproveHeadMarker(headSha));
  return placeProgressComment(octokit, owner, repo, prNumber, body, reuseId);
}

const HEAD_MARKER_OPENER = '<!-- manki-auto-approve-head: ';

/**
 * The hidden marker naming the head an auto-approve comment is for, or the head an approval posted again without a
 * round approves. Pass it to `markProgressCommentFailed` so a failure keeps it.
 */
export function autoApproveHeadMarker(headSha: string): string {
  return `${HEAD_MARKER_OPENER}${headSha} -->`;
}

/** Returns the ID of Manki's comment that says an auto-approve of `headSha` failed, or `undefined` when there is none. */
export function failedAutoApproveId(comments: IssueComment[], bot: BotIdentity, headSha: string): number | undefined {
  return comments.find(c => isBotUser(bot, c.user) && !!c.body?.startsWith(failedLead('Auto-approve')) && c.body.includes(autoApproveHeadMarker(headSha)))?.id;
}

/** The start of a progress comment whose `action` failed. */
const failedLead = (action: 'Review' | 'Auto-approve'): string => `🔴 **${action} failed:**`;

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
 * so the post step leaves the comment alone. `markers` are kept on the comment.
 */
export async function markProgressCommentFailed(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  action: 'Review' | 'Auto-approve',
  reason: string,
  settings?: SettingsView,
  markers: readonly string[] = [],
): Promise<void> {
  const body = withMarkers(
    `${failedLead(action)} ${safeTruncate(sanitizeMarkdown(sanitizeTokens(String(reason))), 300)}`,
    ...BOT_MARKERS,
    CANCELLED_MARKER,
    ...markers,
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
export function formatResetTime(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatLimitWindow(limit: LimitUsage): string {
  return `${sanitizeMarkdown(limit.window)} ${limit.usedPercent}%${limit.resetsAt != null ? ` (resets ${formatResetTime(limit.resetsAt)})` : ''}`;
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
    return [`**${sanitizeMarkdown(limit.account)} has used ${limit.usedPercent}% of its ${sanitizeMarkdown(limit.window)} limit**, past the ${mark}% mark.${resets}`];
  });
  if (lines.length === 0) return undefined;
  return `> [!CAUTION]\n${[...lines, 'Once a limit is used up, reviews on that account stop until it resets.'].map(line => `> ${line}`).join('\n>\n')}`;
}

/**
 * Marks `comment`, the failed progress comment of an earlier run on `headSha`, as superseded by the review that starts
 * now. Its report stays below that line, so which reviewer failed and why stays readable, and its settings block goes.
 */
export async function markFailedProgressSuperseded(
  octokit: Octokit, owner: string, repo: string, comment: { id: number; body: string }, headSha: string,
): Promise<void> {
  const body = `**Review superseded** by a later review of \`${headSha.slice(0, 7)}\`. This attempt ended as follows.\n\n${stripSettingsBlock(comment.body)}`;
  try {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body });
  } catch (error) {
    core.warning(`Failed to mark the failed progress comment ${comment.id} as superseded: ${error instanceof Error ? error.message : error}`);
  }
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
    parts.push(`- Models: ${metadata.config.reviewerModel ? `reviewer=${sanitizeMarkdown(metadata.config.reviewerModel)}, ` : ''}judge=${sanitizeMarkdown(metadata.config.judgeModel)}`);
    parts.push(`- Triage: ${metadata.config.triage}`);
    parts.push(`- Team: ${metadata.config.teamAgents.map(sanitizeMarkdown).join(', ')}`);
    parts.push(...(metadata.config.limitFallbacks ?? []).map(line => `- ${line}`));
    parts.push(`- Memory: ${metadata.config.memoryEnabled ? `enabled (${sanitizeMarkdown(String(metadata.config.memoryRepo))})` : 'disabled'}`);
    parts.push('');

    if (metadata.limits && metadata.limits.length > 0) {
      parts.push('**Account limits:**');
      for (const account of new Set(metadata.limits.map(l => l.account))) {
        parts.push(`- ${sanitizeMarkdown(account)}: ${metadata.limits.filter(l => l.account === account).map(formatLimitWindow).join(', ')}`);
      }
      parts.push('');
    }

    if (metadata.judgeDecisions.length > 0) {
      parts.push('**Judge decisions:**');
      for (const d of metadata.judgeDecisions) {
        const outcome = d.listed ? 'Not finished' : d.kept ? 'Kept' : d.unpostedReason ? `Not listed, ${UNPOSTED_REASONS[d.unpostedReason]}` : 'Dropped';
        const importance = d.importance ? `, trigger ${d.importance.trigger} and harm ${d.importance.matters} of 10${d.importance.reason ? `: "${sanitizeMarkdown(d.importance.reason)}"` : ''}` : '';
        parts.push(`- ${outcome}: "${sanitizeMarkdown(d.title)}" (${SEVERITY_NAME[d.severity]}): "${sanitizeMarkdown(d.reasoning)}"${importance}`);
      }
      parts.push('');
    }


    parts.push('**Timing:**');
    parts.push(`- Parse: ${(metadata.timing.parseMs / 1000).toFixed(1)}s`);
    parts.push(`- Review agents: ${(metadata.timing.reviewMs / 1000).toFixed(1)}s`);
    parts.push(`- Judge: ${metadata.timing.judgeMs === undefined ? 'skipped' : `${(metadata.timing.judgeMs / 1000).toFixed(1)}s`}`);
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

/** Says what the round kept of the last attempt on its commit: the models of the finders it did not run again, and the checks. */
function reusedLine(context: RoundContext): string | undefined {
  if (!context.meta.reusedFrom) return undefined;
  const models = [...new Set((context.reviewers.agentMetrics ?? []).filter(m => m.reused).map(m => sanitizeMarkdown(m.model ? modelDisplayName(m.model) : m.name)))];
  const checks = [...(context.comparisons ?? []), ...(context.prClaims?.claims ?? []), ...(context.fixes?.fixes ?? [])].filter(c => c.reused).length;
  const answers = checks > 0 ? `the answers of ${countOf(checks, 'check')}` : '';
  if (models.length === 0) return answers ? `This review kept ${answers} from the last attempt on this commit.` : undefined;
  return `${models.join(' and ')} read this commit in the last attempt, and ${models.length === 1 ? 'its' : 'their'} findings were kept${answers && `, as were ${answers}`}.`;
}

/** Whether `body` is a progress comment whose review failed or ended incomplete. */
function isFailedProgress(body: string): boolean {
  return body.startsWith(REVIEW_FAILED_LINE) || body.startsWith(failedLead('Review'));
}

/** How often the live dashboard edits the progress comment while a review runs. */
export const LIVE_EDIT_MS = 20_000;

/**
 * Runs `edit` every `LIVE_EDIT_MS` until `stop`, so the progress comment follows the review without an edit per event.
 * No stage waits for an edit: one still running skips the next, and a failed one only warns. `stop` waits for an edit
 * in flight, so the edit that follows it lands last.
 */
export function startLiveEdits(edit: () => Promise<void>): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    inFlight ??= edit()
      .catch(error => core.warning(`Failed to update the progress comment: ${error instanceof Error ? error.message : error}`))
      .finally(() => { inFlight = undefined; });
  }, LIVE_EDIT_MS);
  // A run that never stops the edits still ends.
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
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
 * block in place. A failed dismissal only warns, since the new review already stands. Returns how many reviews it
 * dismissed, and `failed` when the listing or any dismissal failed, so a review it should dismiss may still stand. `kept`
 * counts the reviews in `state` it left because they are on `keepCommit`. Throws the abort reason once GitHub writes are stopped.
 */
export async function dismissPreviousReviews(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
  keepReviewId?: number,
  state: 'CHANGES_REQUESTED' | 'APPROVED' = 'CHANGES_REQUESTED',
  keepCommit?: string,
): Promise<{ dismissed: number; failed: boolean; kept: number }> {
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
    return { dismissed: 0, failed: true, kept: 0 };
  }
  let dismissed = 0;
  let failed = false;
  let kept = 0;

  for (const review of reviews) {
    const onKeptCommit = keepCommit !== undefined && reviewedCommit(review) === keepCommit;
    const ours = isBotUser(bot, review.user) && !!review.body && (review.body.includes(BOT_MARKER) || isAutoApproval(review.body)) && review.state === state;
    if (ours && onKeptCommit) kept++;
    if (review.id !== keepReviewId && !onKeptCommit && ours) {
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
        dismissed++;
      } catch (e) {
        // A repository ruleset can restrict who may dismiss reviews, and the stale review then stays in force.
        core.warning(`Could not dismiss the previous review #${review.id}, it still ${state === 'APPROVED' ? 'approves' : 'requests changes'}: ${e instanceof Error ? e.message : e}`);
        failed = true;
      }
    }
  }
  return { dismissed, failed, kept };
}

function countOf(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatStatsOneLiner(context: RoundContext, reviewTimeMs: number): string {
  const sev = context.findings.severityCounts;
  const breakdown = SEVERITY_ORDER
    .filter(s => s !== 'ignore' && (sev[s] ?? 0) > 0)
    .map(s => countOf(sev[s], SEVERITY_NAME[s]))
    .join(', ');
  const time = Math.round(reviewTimeMs / 1000);
  return `<!-- manki-stats: ${countOf(context.findings.count, 'finding')} (${breakdown || 'none'}), ${countOf(context.diff.lines, 'line')}, ${time}s -->`;
}

const REVIEW_BODY_BUDGET = 60000;

/** The most of the review body the round record may take, so the verdict and findings still show when the body is cut. */
const MAX_RECORD_CHARS = REVIEW_BODY_BUDGET - 10000;

/** Characters per line of the full record in the log, since the runner's log can lose a very long line and every line after it. */
const RECORD_LOG_LINE_CHARS = 1000;

/**
 * Returns the hidden stats line and round record that end a review. `room` is what the visible body leaves, and the
 * record gets at most `MAX_RECORD_CHARS` of it. The record is plain JSON when it fits, and compressed otherwise. A
 * record over its room even compressed takes the first of `smallerRecords` that fits, or the last one when none does,
 * so the caller cuts the body. Unless `cutLog` says it already did, the log then names what was left out and holds the
 * full record compressed. Only a record whose last form is still over `MAX_RECORD_CHARS` throws, which takes hundreds of findings.
 */
function formatRecordTrailer(context: RoundContext, reviewTimeMs: number, room: number, cutLog: { logged: boolean }): string {
  const stats = `\n\n${formatStatsOneLiner(context, reviewTimeMs)}\n`;
  const recordRoom = Math.min(room, MAX_RECORD_CHARS);
  const fits = (record: string, limit = recordRoom): boolean => stats.length + record.length <= limit;
  // A plain record over its room is compressed before any part of it is cut.
  const plainRoom = recordRoom - stats.length;
  const record = formatReviewRecord(context, plainRoom);
  if (fits(record)) return `${stats}${record}`;

  let slim = record;
  let cut = '';
  for (const smaller of smallerRecords(context)) {
    slim = formatReviewRecord(smaller, plainRoom);
    const { omitted = [], compacted = [] } = smaller.meta;
    cut = [omitted.length > 0 && `without ${omitted.join(', ')}`, compacted.length > 0 && `with ${compacted.join(', ')} shortened`].filter(Boolean).join(' and ');
    if (fits(slim)) break;
  }
  if (!cutLog.logged) {
    cutLog.logged = true;
    core.warning(`The round record takes ${record.length} characters even compressed, more than the ${Math.max(0, recordRoom - stats.length)} the review leaves it, ${cut ? `so the review carries it ${cut}` : 'and has no part the review can leave out'}. The full record follows in the log.`);
    const full = compressReviewRecord(context);
    core.startGroup(`Full round record, gzip compressed and base64 encoded in ${Math.ceil(full.length / RECORD_LOG_LINE_CHARS)} lines`);
    for (let i = 0; i < full.length; i += RECORD_LOG_LINE_CHARS) core.info(full.slice(i, i + RECORD_LOG_LINE_CHARS));
    core.endGroup();
  }
  if (!fits(slim, MAX_RECORD_CHARS)) throw new Error(`The round record takes ${slim.length} characters even in its minimal form, too many for a review body`);
  return `${stats}${slim}`;
}

/** The icon that opens a finding comment or a finding listed in the review body. */
const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  blocker: '🚫',
  warning: '⚠️',
  note: '✨',
  ignore: '⚪',
};

/** Shown under the title of a finding whose `checkStatus` is `unconfirmed`, when `trustNote` can name nothing more specific. */
const UNCONFIRMED_NOTE = '_Manki could not confirm this, so please check it._';
const NO_PROOF_NOTE = '_Manki could not confirm this, since no line in the code was cited for it._';
const OPEN_PREMISE_NOTE = '_Manki confirmed the code path but could not check:';

/**
 * Matches each line `trustNote` writes. A premise is not plain prose, so `highlightCode` can wrap the first word of its
 * line in backticks when a PR adds that word.
 */
const TRUST_NOTE_RE = /^(?:_Manki|`_Manki`) (?:could not confirm this|confirmed the code path but could not check:)[^\n]*/;

/**
 * Returns the line under the title of a finding whose `checkStatus` is `unconfirmed`. It names the premise a check left
 * open after it confirmed the defect, or says that no line was cited when the finding cites none and no check ran. The
 * premise is model text, so it shows as one line.
 */
function trustNote(finding: Finding): string | undefined {
  if (finding.checkStatus !== 'unconfirmed') return undefined;
  const premise = openCodePremise(finding);
  const text = premise && oneLine(premise).replace(/[\s.]+$/, '');
  if (text) return `${OPEN_PREMISE_NOTE} ${text}${text.endsWith('…') ? '' : '.'}_`;
  // A check can leave the finding no line, such as one that confirmed only the premises, and still have cited lines.
  const cited = finding.evidence?.proof.length || finding.evidence?.relatedProof?.length || finding.refutation || finding.pairRefutation;
  return cited ? UNCONFIRMED_NOTE : NO_PROOF_NOTE;
}

/** Security findings below a warning posted as line comments per review. The rest go in the body list. */
const MAX_NON_BLOCKING_INLINE = 5;

/** The most of a blocker's description the round record keeps when the blocker got no thread. */
const MAX_RECORDED_DESCRIPTION = 1000;

/** Whether a warning was deferred as a follow-up. */
function isFollowUp(finding: Finding): boolean {
  return !!finding.tags?.includes(FOLLOW_UP_TAG);
}

function isPreExisting(finding: Pick<Finding, 'tags'>): boolean {
  return !!finding.tags?.includes(PRE_EXISTING_TAG);
}

/**
 * Whether a warning holds an approval by itself. It takes a finding or a round record entry. A pre-existing defect
 * never holds. Neither does a warning that goes into its answered thread, since that thread holds for it.
 */
export function holdsApproval(finding: { severity: FindingSeverity | 'unknown'; tags?: string[]; answeredIn?: Finding['answeredIn'] }): boolean {
  return finding.severity === 'warning' && !isPreExisting(finding) && !finding.answeredIn;
}

/** Whether a finding is posted as a thread. A pre-existing one is only when it still blocks, as a security finding does. */
function isBlockingFinding(finding: Finding): boolean {
  if (isPreExisting(finding)) return finding.severity === 'blocker';
  return isBlockingSeverity(finding.severity) && !isFollowUp(finding);
}

/** Whether the verdict line counts a finding as a blocker. A warning posted as a thread counts as a warning. */
function isCountedBlocker(finding: Finding): boolean {
  return finding.severity === 'blocker' && isBlockingFinding(finding);
}

function isOnChangedLine(finding: Finding, diff: ParsedDiff): boolean {
  const diffFile = finding.file ? diff.files.find(df => df.path === finding.file) : undefined;
  return !!diffFile && isLineInDiff(diffFile, finding.line);
}

/** Whether a thread of `finding` can go on its own line: a changed line of `diff`, or any line of a file when no diff is known. */
function onOwnLine(finding: Finding, diff: ParsedDiff | undefined): boolean {
  return diff ? finding.line > 0 && isOnChangedLine(finding, diff) : !!finding.file && finding.line > 0;
}

/** The earlier thread `postReview` puts a finding into: the thread the finding is `linked` to, or the open thread `openThreadFor` `matched`. */
export interface EarlierPlace { threadId: string; by: 'linked' | 'matched' }

/** Returns the earlier thread `postReview` puts each finding into, and nothing for a finding it posts on its own or lists in the body. */
export function earlierPlaces(findings: readonly Finding[], existingThreads: PreviousFinding[], diff: ParsedDiff | undefined): Map<Finding, EarlierPlace | undefined> {
  return new Map(findings.map(f => [f, earlierPlaceOf(f, existingThreads, diff)]));
}

function earlierPlaceOf(finding: Finding, existingThreads: PreviousFinding[], diff: ParsedDiff | undefined): EarlierPlace | undefined {
  const matched = openThreadFor(finding, existingThreads);
  if (!isBlockingFinding(finding)) {
    const linked = finding.answeredIn?.threadId ?? finding.threadId;
    return linked ? { threadId: linked, by: 'linked' } : matched ? { threadId: matched, by: 'matched' } : undefined;
  }
  const threadId = finding.threadId ?? finding.answeredIn?.threadId;
  const open = threadId ? existingThreads.find(t => t.threadId === threadId) : undefined;
  if (threadId && open && !gradedAbove(finding.severity, open)) return { threadId, by: 'linked' };
  // A blocker on its own line gets a thread there even when an open thread matches it.
  return matched && !onOwnLine(finding, diff) ? { threadId: matched, by: 'matched' } : undefined;
}

function inlineCode(text: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = '`'.repeat(longestRun + 1);
  return longestRun > 0 ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`;
}

/**
 * Returns the URL of `line` in `file` at the reviewed commit, or of the lines `line` to `end` when `end` is past `line`.
 * Returns `undefined` for a file name that `hasDotSegment`, which gets no link.
 */
type LineLink = (file: string, line: number, end?: number) => string | undefined;

/** Whether `path` has a `.` or `..` segment. A browser resolves those, so a link built from it can leave the repository. */
function hasDotSegment(path: string): boolean {
  return path.split('/').some(segment => segment === '.' || segment === '..');
}

/**
 * Returns `path`, as a model or a person wrote it, as a plain repository path: without `./`, `.` segments, repeated
 * slashes or a `..` that stays inside the repository. Returns nothing for any other path, such as an absolute path, a
 * URL or one that leaves the repository, so a comparison with a repository path never matches on its spelling.
 */
function plainRepoPath(path: string): string | undefined {
  const normal = posix.normalize(path.trim());
  return LINKABLE_PATH_RE.test(normal) && !hasDotSegment(normal) ? normal : undefined;
}

/** Returns each of `paths` that is a plain repository path, as `plainRepoPath` gives it, once and without `ownFile`. */
export function plainCitedFiles(paths: readonly string[], ownFile: string | undefined): string[] {
  return [...new Set(paths.flatMap(path => plainRepoPath(path) ?? []))].filter(path => path !== ownFile);
}

/** Returns `text` as a Markdown link to `url`, or `text` alone when there is no URL. */
export function linked(text: string, url: string | undefined): string {
  return url ? `[${text}](${url})` : text;
}

function repoUrl(serverUrl: string, owner: string, repo: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/${owner}/${repo}`;
}

export function buildLineLink(owner: string, repo: string, commitSha: string, serverUrl: string): LineLink {
  // `encodeURIComponent` keeps parentheses, and a `)` in a file name would end the Markdown link the URL goes into.
  const segment = (part: string): string => encodeURIComponent(part).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16)}`);
  return (file, line, end = line) => hasDotSegment(file) ? undefined : `${repoUrl(serverUrl, owner, repo)}/blob/${commitSha}/${file.split('/').map(segment).join('/')}${line > 0 ? `#L${line}${end > line ? `-L${end}` : ''}` : ''}`;
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
 * The first sentence is always kept, cut at a word when it alone passes both `maxLength` and `keepFirst`. A code fence,
 * a blank line or a line that starts a list ends the lead. A list right after the lead joins it whole when both fit in
 * `maxLength`, and is never cut, also across blank lines between its items.
 */
function splitLead(text: string, maxSentences: number, maxLength: number, keepFirst = 0): { lead: string; rest: string } {
  const trimmed = text.trim();
  const stopAt = trimmed.search(/`{3}|~{3}|\n[ \t]*\n|\n[ \t]*(?:[-*+]|\d+[.)])\s/);
  const prose = stopAt === -1 ? trimmed : trimmed.slice(0, stopAt);
  // Odd entries are the whitespace between sentences, so joining a slice keeps the original spacing. The number that
  // starts a list item ends no sentence.
  const parts = prose.trimEnd().split(/(?<=[.!?])(?<!(?:^|\n)[ \t]*\d+\.)(\s+)/);
  let end = 1;
  while (end + 1 < parts.length && (end + 1) / 2 < maxSentences && parts.slice(0, end + 2).join('').length <= maxLength) end += 2;
  const sentences = parts.slice(0, end).join('');
  const list = end >= parts.length ? trimmed.slice(sentences.length).match(/^\s*\n([ \t]*(?:[-*+]|\d+[.)])\s[\s\S]*?)(?=\n\s*\n[ \t]*(?!(?:[-*+]|\d+[.)])\s)\S|$)/) : null;
  const withList = list && !/`{3}|~{3}/.test(list[0]) && sentences.length + list[0].length <= maxLength;
  const lead = withList ? trimmed.slice(0, sentences.length + list[0].length) : sentences;
  const rest = trimmed.slice(lead.length).trim();
  if (lead.length <= Math.max(maxLength, keepFirst)) return { lead, rest };
  const atWord = lead.slice(0, maxLength + 1).search(/\s+\S{0,40}$/);
  return { lead: safeTruncate(lead, atWord > 0 ? atWord : maxLength), rest: trimmed };
}

export function findingLocation(finding: Pick<Finding, 'file' | 'line'>): string {
  return `${sanitizeFilePath(encodeCommentBreakers(finding.file))}${finding.line > 0 ? `:${finding.line}` : ''}`;
}

/**
 * Returns `description` under its label: what goes wrong for a blocking severity, why it is worth changing for the rest.
 * The label goes on its own line above a list, heading or quote, whose marker would show as text after it.
 */
function labelDescription(finding: Finding, description: string): string {
  const label = isBlockingSeverity(finding.severity) ? WHAT_GOES_WRONG_LABEL : WHY_LABEL;
  // `parseFindingFromComment` ends the description at a line that starts with `FIX_LABEL`, so no line of the description does.
  const text = description.replace(/^\*\*Fix:\*\*/gm, '**Fix**:');
  return `${label}${/^(?:[-*+]\s|#{1,6}\s|>|\d+[.)]\s)/.test(text) ? '\n\n' : ' '}${text}`;
}

/** Matches the line `trackedNote` writes. */
const TRACKED_NOTE_RE = /^Tracked in #\d+\./;

/** Returns the line naming the open issue or PR of related work that describes `finding`, which GitHub links. */
function trackedNote(finding: Finding): string | undefined {
  return finding.trackedIn && `Tracked in #${finding.trackedIn.number}.`;
}

/** Matches the line `baseNote` writes. */
const BASE_NOTE_RE = /^\*\*(?:Possibly older than this PR|Already broken before this PR)\.\*\* [^\n]*/;

/**
 * Returns what `baseNote` says of `finding`, with the branch and the base lines the origin checks cited, linked at the
 * base commit when `links` can. Two checks on different models (`sameOnBase`) say the failure was already there: on a
 * pre-existing finding that no longer blocks, and on a security finding that still blocks, which a maintainer decides.
 * One check only says the finding may be older. A pre-existing finding that stopped blocking for another reason needs neither.
 */
function baseLines(finding: Finding, links?: CodeLinks): { says: 'stopped' | 'security' | 'older'; branch: string; ranges: CodeRange[]; linkTo: LineLink } | undefined {
  const stopped = isPreExisting(finding) && finding.severity !== 'blocker';
  const both = sameOnBase(finding);
  const security = !stopped && !!both && isSecurityFinding(finding.tags, finding.reviewers);
  const base = stopped || security ? both : oneCheckOnBase(finding);
  if (!base?.base?.length) return undefined;
  const ranges = base.base.flatMap(location => {
    const [, file, range] = location.match(/^(.+):(\d+(?:-\d+)?)$/) ?? [];
    const at = file ? lineRange(file, range) : undefined;
    return at ? [at] : [];
  });
  return {
    says: stopped ? 'stopped' : security ? 'security' : 'older',
    branch: links?.baseBranch ? inlineCode(links.baseBranch) : 'the base branch',
    ranges,
    linkTo: (base.commit && links?.linkAt?.(base.commit)) || (() => undefined),
  };
}

/** Returns the line that says the origin checks found the failure of `finding` at the PR's base, with the first base line. */
function baseNote(finding: Finding, links?: CodeLinks): string | undefined {
  const base = baseLines(finding, links);
  if (!base) return undefined;
  const { says, branch } = base;
  const line = linkedRanges(base.ranges.slice(0, 1), base.linkTo);
  if (says === 'security') return `**Already broken before this PR.** Two checks found the same problem on ${branch} at ${line}. It is a security finding, so it stays until it is fixed or a maintainer clears it.`;
  return says === 'stopped'
    ? `**Already broken before this PR.** Two checks found the same problem on ${branch} at ${line}, so it doesn't block this PR.`
    : `**Possibly older than this PR.** One check found the same problem on ${branch} at ${line}. If that is right, a maintainer can dismiss the finding.`;
}

/** Returns the base lines that `baseNote` leaves out. */
function otherBaseLinesPart(finding: Finding, links?: CodeLinks): FoldPart[] {
  const base = baseLines(finding, links);
  if (!base || base.ranges.length < 2) return [];
  const label = `Other lines with the same problem on ${base.branch}`;
  const text = linkedRanges(base.ranges.slice(1), base.linkTo);
  return [{ label, text, open: `**${label}:** ${text}` }];
}

/** Returns the line that says this PR fixes the failure of `finding` at its `fixedElsewhere` line, linked when `links` can. */
function fixedElsewhereNote(finding: Finding, links?: CodeLinks): string | undefined {
  const [, file, range] = finding.fixedElsewhere?.match(/^(.+):(\d+(?:-\d+)?)$/) ?? [];
  const at = file ? lineRange(file, range) : undefined;
  return at && `**The same problem remains here.** This PR fixes it at ${linkedRange(at, links?.linkTo ?? (() => undefined))} but not on this path.`;
}

/**
 * Returns the `trustNote`, the `trackedNote`, the `fixedElsewhereNote`, the `baseNote` and what goes wrong, as listed
 * under a finding in the review body.
 */
function formatFindingDescription(finding: Finding, links?: CodeLinks): string[] {
  const lines = [trustNote(finding), trackedNote(finding), fixedElsewhereNote(finding, links), baseNote(finding, links)].filter((line): line is string => !!line);
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
function formatFindingBlock(finding: Finding, links: CodeLinks, offerIssue = false, noThread = false): string {
  const lines = [formatFindingHeader(finding, noThread), `**${sanitizeMarkdown(finding.title)}**`];
  if (finding.file) lines.push(linked(inlineCode(findingLocation(finding)), links.linkTo(finding.file, finding.line)));
  const fold = formatFold(bodyFixPart(finding, links.files), '', checksSection(finding, links, 'flagged'));
  const block = [...lines, ...formatFindingDescription(finding, links), ...(fold ? [fold] : [])].join('\n');
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

/** Matches the line under the title of a thread for a warning on such code, in every wording threads carry. */
const MISSED_EARLIER_NOTE_RE = /^_An earlier round already reviewed these lines and missed this[^\n]*/;
const missedEarlierNote = (says: string): string => `_An earlier round already reviewed these lines and missed this. ${says}._`;

const MISSED_EARLIER_NOTE = missedEarlierNote('It is in this PR\'s own code, so it still holds the approval');

/** `MISSED_EARLIER_NOTE` for a security warning, which a reply does not clear. */
const MISSED_EARLIER_SECURITY_NOTE = missedEarlierNote('It is in this PR\'s own code, so it still needs a fix or a maintainer to resolve it');

/** Returns the note for `finding`, which does not call the code the PR's own below a `baseNote` that says otherwise. */
function missedEarlierNoteFor(finding: Finding): string {
  const guarded = isGuardedFinding(finding.tags, finding.reviewers);
  if (baseLines(finding)) return missedEarlierNote(guarded ? 'It still needs a fix or a maintainer to resolve it' : 'It still holds the approval');
  return guarded ? MISSED_EARLIER_SECURITY_NOTE : MISSED_EARLIER_NOTE;
}

/** Lines shown on each side of the flagged line in a finding's code preview. */
const PREVIEW_CONTEXT = 2;

/**
 * Renders a finding listed in the review body as a closed fold. Its summary holds the title, the header line and
 * the location. Inside are what goes wrong, a permalink to the flagged lines, which GitHub shows as code, then the
 * parts of `formatFold` under their labels, with the finding's `checkStatus` in a line of its own after the fix. The file's lines keep the permalink inside it, since GitHub shows a range
 * past the end as a bare link. A pre-existing finding keeps only what goes wrong, with one base line, and its fix. Its
 * evidence stays in the round record and its thread.
 */
function formatFindingFold(finding: Finding, links: CodeLinks, offerIssue = false): string {
  const { linkTo, files } = links;
  const link = finding.file ? linkTo(finding.file, finding.line) : undefined;
  const code = `<code>${inlineHtml(findingLocation(finding))}</code>`;
  const location = finding.file ? ` · ${link ? `<a href="${link}">${code}</a>` : code}` : '';
  const summary = `<summary>${SEVERITY_EMOJI[finding.severity]} <b>${inlineHtml(sanitizeMarkdown(finding.title))}</b><br><sub>${inlineHtml(formatFindingHeader(finding))}${location}</sub></summary>`;
  const last = files.get(finding.file)?.length;
  const compact = isPreExisting(finding);
  // A diff already shows the flagged line, so the fold previews it only without one.
  const preview = !compact && !formatFixDiff(finding, files) && finding.file && finding.line > 0 && (last === undefined || finding.line <= last)
    ? [linkTo(finding.file, Math.max(1, finding.line - PREVIEW_CONTEXT), Math.min(last ?? finding.line, finding.line + PREVIEW_CONTEXT))].flatMap(url => url ?? [])
    : [];
  const checks = compact ? undefined : checksSection(finding, links, 'flagged');
  const fix = bodyFixPart(finding, files);
  const parts = [...(fix ? [labelledPart(fix)] : []), ...(checks?.status ? [`**How this was checked:** ${checks.status}`] : []), ...(checks?.parts ?? []).map(labelledPart)];
  const fold = `<details>\n${summary}\n\n${[...formatFindingDescription(finding, links), ...preview, ...parts].join('\n\n')}\n\n</details>`;
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
  return formatFindingSection(`Earlier warnings, not fixed · ${formatSeverityCounts(carried)}`, lines.length > 0 ? [lines.join('\n')] : [], carried.length === 1
    ? 'An earlier round listed it, and this round did not find it fixed, so it stays listed. It doesn\'t block.'
    : 'An earlier round listed these, and this round did not find them fixed, so they stay listed. None of them blocks.', '###');
}

/** Returns the section for the holding warnings that got no thread, which says what clears them, or null when there are none. */
function formatUnthreadedWarnings(warnings: Finding[], links: CodeLinks): string | null {
  if (warnings.length === 0) return null;
  const clears = warnings.length === 1
    ? 'It has no thread, so it holds the approval until a later review round no longer finds it.'
    : 'They have no thread, so each one holds the approval until a later review round no longer finds it.';
  return `**Warnings that could not be posted as threads:**\n\n${warnings.map(f => formatFindingBlock(f, links, true, true)).join('\n\n')}\n\n${clears}`;
}

/**
 * Returns the findings listed in the review body in one group per origin, each a title, its findings in the order they
 * show and an optional intro: found this round (just "Findings" on a first round), still open from an earlier round's
 * body, one group per round, missed by an earlier review, and pre-existing, which a pre-existing finding stays in even
 * when it restates one.
 */
function originGroups(findings: Finding[], followUp: boolean): Array<[string, Finding[], string?]> {
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
      ? 'An earlier round reviewed these lines and did not raise it. It does not block or hold the approval.'
      : 'An earlier round reviewed these lines and did not raise them. None of them blocks or holds the approval.'],
    ['Pre-existing', preExisting, preExisting.length === 1
      ? 'This PR did not cause it, so it doesn\'t block: it is on lines the PR did not change, or the code fails the same way without the PR.'
      : 'This PR did not cause these, so none of them block: each is on lines the PR did not change, or the code fails the same way without the PR.'],
  ];
  return groups.map(([title, listed, intro]) => [title, [...listed].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)), intro]);
}

/** Returns the `originGroups` of `findings` as sections of the review body, each headed by its counts per severity. */
function formatOriginSections(findings: Finding[], links: CodeLinks, followUp: boolean): string[] {
  return originGroups(findings, followUp).flatMap(([title, listed, intro]) => {
    const section = formatFindingSection(`${title} · ${formatSeverityCounts(listed)}`, listed.map(f => formatFindingFold(f, links, true)), intro, '###');
    return section ? [section] : [];
  });
}

/**
 * Returns the body of `render` that fits in `room` characters, and the findings it left out. It leaves out whole
 * findings of `order`, one more at a time, and cuts at a word only a body that does not fit without all of them.
 */
function fitBody(render: (cut: number) => string, order: readonly Finding[], room: number): FittedBody {
  for (let cut = 0; cut <= order.length; cut++) {
    const text = render(cut);
    if (text.length <= room) return { text, dropped: new Set(order.slice(0, cut)) };
  }
  return { text: truncateBody(render(order.length), room), dropped: new Set(order) };
}

/**
 * Returns the trailer for `body`, fitted under `trailer`: written again by `trailerFor` with the findings the body left
 * out, so the record does not list them as posted. `trailer` stays when nothing was left out, or when the new trailer
 * does not fit in the `room` the body leaves.
 */
function markLeftOut(trailer: string, body: FittedBody, room: number, trailerFor: (room: number, dropped: ReadonlySet<Finding>) => string): string {
  if (body.dropped.size === 0) return trailer;
  const marked = trailerFor(room, body.dropped);
  return marked.length <= room ? marked : trailer;
}

/** The line that ends a review body which left out `count` findings for lack of room. */
function leftOutForRoom(count: number): string {
  return `<sub>${countOf(count, 'finding')} ${count === 1 ? 'is' : 'are'} left out of this review for lack of room. Manki's record of this review keeps ${count === 1 ? 'it' : 'them'}.</sub>`;
}

/**
 * Posts each comment as a file-level review thread and returns the findings GitHub refused. These are the threads on a
 * file with no changed line, and those of a review whose line comments GitHub refused. The create-review endpoint does
 * not document `subject_type` on its comments, so these go through the single-comment endpoint.
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

/**
 * Returns the line of each closed thread where Manki's latest answer agreed to leave its finding for later work, with
 * the issue Manki filed for it, if any. A suggestion is optional, so an agreed one is not listed again.
 */
function agreedFollowUps(threads: PreviousFinding[]): string[] {
  return threads.flatMap(t => {
    if (!t.answer || !AGREED_ANSWER_RE.test(t.answer) || t.severity === 'unknown' || isNote(t.recordedGrade ?? t.severity) || t.fixed) return [];
    if (t.status !== 'resolved' && t.status !== 'auto-resolved') return [];
    return [`${formatTraceEntry({ file: t.file, line: currentFindingLine(t), title: t.title, threadUrl: t.threadUrl })}${t.filedIssue ? ` (tracked in #${t.filedIssue})` : ''}`];
  });
}

/**
 * Returns Manki's reply in an answered thread when the problem of `findings` came back and the code there got worse. A
 * scope warning rests on no code. It comes back to a `closed` thread only after the PR title or description changed, and
 * to an open one with the reader's current wording, and its reply says which.
 */
export function formatFoundAgainReply(findings: Finding[], closed = true): string {
  const scope = findings.every(f => f.reviewers.includes(SCOPE_READER_NAME));
  const lead = !scope ? 'This came up again, and the code here is worse than when this thread was answered.'
    : closed ? 'The PR title or description changed since this thread was settled, and the scope reader raises this again.'
      : 'The scope reader read the PR again and still raises this, in these words.';
  return formatReplyListing(lead, findings);
}

/** Returns Manki's reply in an open thread that lists `variants`, other instances of the problem the thread names. */
export function formatVariantReply(variants: Finding[]): string {
  return formatReplyListing(variants.length === 1 ? 'This round found another instance of this problem.' : `This round found ${variants.length} more instances of this problem.`, variants);
}

/** Returns a reply that opens with `lead` and lists `findings`. */
function formatReplyListing(lead: string, findings: Finding[]): string {
  return [lead, findings.map(f => formatReplyFinding(f).join('\n\n')).join('\n\n---\n\n')].join('\n\n');
}

/** Returns the parts of a finding shown in a reply: its header, title, description, base lines and fix. A reply has no fold. */
function formatReplyFinding(finding: Finding): string[] {
  const fix = fixPart(finding, finding.suggestedFix?.trim() ? formatBodyFix(finding.suggestedFix, finding.file) : undefined);
  return [
    `${SEVERITY_EMOJI[finding.severity]} ${formatFindingHeader(finding)}`,
    `**${sanitizeMarkdown(finding.title)}**`,
    ...formatFindingDescription(finding),
    ...otherBaseLinesPart(finding).flatMap(part => part.open ?? []),
    ...(fix?.open ? [fix.open] : []),
  ];
}

/**
 * Returns the ID of the unresolved Manki thread already posted for this finding, unless the finding is posted on its own.
 * A thread graded below the finding never carries it, so a warning or a blocker is never left to a suggestion thread.
 * Neither does a thread Manki closed because its finding continues in another thread.
 */
function openThreadFor(finding: Finding, existingThreads: PreviousFinding[]): string | undefined {
  if (finding.ownThread) return undefined;
  const open = existingThreads.filter(t => t.status !== 'resolved' && !t.raised && t.threadId && t.markerSlug && !gradedAbove(finding.severity, t));
  const fingerprint = { file: finding.file, lineStart: finding.line, lineEnd: finding.line, slug: titleToSlug(finding.title) };
  return findPriorThreadId(fingerprint, open);
}

/** Returns why an earlier thread carries a non-blocking finding, which is then not posted again. `matched` is its `openThreadFor`. */
function carriedBy(finding: Finding, matched: string | undefined): string | undefined {
  if (finding.answeredIn) return `it goes as a reply in its answered thread ${finding.answeredIn.threadId}`;
  if (finding.threadId) return `${finding.variantOf ? 'it goes as a reply in' : 'it restates'} the open thread ${finding.threadId}`;
  return matched ? `the open thread ${matched} already carries it` : undefined;
}

/**
 * Puts the notes of `result.findings` last and keeps the first `limit` of them. The others move to `result.unposted`,
 * marked `note_cap`. A note the other finder's vote lowered from a warning (`votedDown`) comes first and is never capped.
 * A note on a failure this PR fixes elsewhere (`fixedElsewhere`) follows. Every note in the
 * `style` row of the severity table follows every other note, so a style note takes only a slot no other note fills.
 * Within each group a `soleFinder` note follows the notes more than one finder or check reported, and then the notes keep
 * the judge's order. A note the judge did not rank follows the ranked ones, in the order returned. A tool alert is listed with the notes and counts toward no limit. A note an earlier thread carries is
 * not listed, so it stays in place and counts toward no limit. A `testing` note without a `revertGap` follows every
 * other note except the style notes. One whose `revertGap` is `REVERT_CAUGHT` claims a gap a test already covers, so it
 * moves to `result.unposted` before the limit, marked `caught_by_test`.
 */
export function capNotes(result: ReviewResult, existingThreads: PreviousFinding[], limit = DEFAULT_NOTES): void {
  const listable = new Set(result.findings.filter(f => isListedNote(f) && !carriedBy(f, openThreadFor(f, existingThreads))));
  const caught = new Set([...listable].filter(f => f.category === 'testing' && f.revertGap === REVERT_CAUGHT && canLeaveOut(f)));
  const group = (f: Finding): number => (votedDown(f) ? -2 : f.fixedElsewhere ? -1 : f.cell?.row === 'style' ? 2 : f.category === 'testing' && !f.revertGap ? 1 : 0);
  const rank = (f: Finding): number => f.noteRank ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...listable].filter(f => !caught.has(f)).sort((a, b) => group(a) - group(b) || Number(!!a.soleFinder) - Number(!!b.soleFinder) || rank(a) - rank(b));
  const capped = new Set(ordered.filter(canLeaveOut).slice(limit));
  result.findings = [...result.findings.filter(f => !listable.has(f)), ...ordered.filter(f => !capped.has(f))];
  const unposted = [
    ...[...caught].map((f): Finding => ({ ...f, unpostedReason: 'caught_by_test' })),
    ...[...capped].map((f): Finding => ({ ...f, unpostedReason: 'note_cap' })),
  ];
  if (unposted.length > 0) result.unposted = [...(result.unposted ?? []), ...unposted];
}

/** Whether the finding is a note `capNotes` limits, posted as a suggestion. A security finding below `warning` is posted like a warning instead. */
function isListedNote(finding: Finding): boolean {
  return isNote(finding.severity) && !isSecurityFinding(finding.tags, finding.reviewers);
}

const MAX_LISTED_FINDINGS = 10;

/** One finding the review checked and left out, with the line that says why. */
type LeftOutEntry = Pick<Finding, 'title' | 'file' | 'line'> & { reason?: string };

/** Renders a left out finding as a list item: the title and a link to its line, then the start of the reason on a line of its own. */
function formatLeftOutEntry({ title, file, line, reason }: LeftOutEntry, linkTo: LineLink): string {
  const location = file ? ` · ${linked(inlineCode(findingLocation({ file, line })), linkTo(file, line))}` : '';
  const shown = reason && splitLead(sanitizeMarkdown(reason).replace(/\s+/g, ' '), 2, 300).lead;
  return `- **${sanitizeMarkdown(title)}**${location}${shown ? `\n  ${shown}` : ''}`;
}

/**
 * Returns the fold that lists what the round checked and left out: each finding of `disproved`, each warning of
 * `result.unposted` that nothing proves or whose trigger is too rare, and each lead of `result.openLeads`. Every kind shows its first
 * `MAX_LISTED_FINDINGS`. Returns none when there is nothing to list.
 */
function formatLeftOut(result: ReviewResult, disproved: DisprovedFinding[], linkTo: LineLink): string | null {
  const because = (f: Finding, why: string): LeftOutEntry => ({ ...f, reason: `${why[0].toUpperCase()}${why.slice(1)}.` });
  const unproven = (result.unposted ?? []).flatMap(f => f.unpostedReason && leftOutUnproven(f) ? [because(f, UNPOSTED_REASONS[f.unpostedReason])] : []);
  const rare = (result.unposted ?? []).flatMap(f => f.unpostedReason === 'rare_trigger' && f.importance ? [because(f, `trigger ${f.importance.trigger} of 10, below the cut-off of ${f.importance.cutOff}`)] : []);
  const leads = (result.openLeads ?? []).map((f): LeftOutEntry => ({ ...f, reason: f.leadSince ? `Open since round ${f.leadSince}.` : undefined }));
  const kinds = [
    { heading: 'Disproved by a check of the code', noun: 'finding', short: 'disproved', entries: disproved },
    { heading: 'Not proven, so not listed', noun: 'warning', short: 'unproven', entries: unproven },
    { heading: 'Rare trigger, so not listed', noun: 'warning', short: 'rare', entries: rare },
    { heading: 'Not finished checking', noun: 'possible problem', short: 'not finished', entries: leads },
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
  const judgedLead = (result.openLeads ?? []).some(lead => result.allJudgedFindings?.includes(lead));
  const log = disproved.length + unproven.length + rare.length > 0 || judgedLead ? ['<sub>The progress comment has the full log under "Judge decisions", in its "Review metadata" fold.</sub>'] : [];
  return `<details>\n<summary>Checked and left out: ${countOf(total, 'finding')}${split}</summary>\n\n${[...sections, ...log].join('\n\n')}\n\n</details>`;
}

/**
 * Returns the notes the body lists as one collapsed section of suggestions, a fold per note, in the order given. A line
 * under it says how many notes of `unposted` are over the `review.notes` limit.
 */
function formatNotesSection(notes: Finding[], unposted: Finding[], links: CodeLinks): string | null {
  const listed = notes.length > 0
    && `<details>\n<summary><b>${countOf(notes.length, 'suggestion')}</b> · not blocking</summary>\n\n${notes.map(f => formatFindingFold(f, links, true)).join('\n\n')}\n\n</details>`;
  const capped = unposted.filter(f => f.unpostedReason === 'note_cap').length;
  const unlisted = capped > 0 && `<sub>${capped} ${listed ? 'more ' : ''}${capped === 1 ? 'suggestion is' : 'suggestions are'} not listed.</sub>`;
  return [listed, unlisted].filter(Boolean).join('\n\n') || null;
}

/**
 * Post the review. Blocking findings and the warnings that `holdsApproval` become threads. Security findings below a
 * warning on a changed line become line comments marked "not blocking", up to `MAX_NON_BLOCKING_INLINE`. The rest go
 * in the body. Every note `capNotes` kept on a changed line gets a line comment as a suggestion,
 * unless it is a tool alert, pre-existing or on code an earlier round reviewed. The body lists the other notes in one collapsed section.
 *
 * A blocking finding or a holding warning on a changed line gets a line comment, one elsewhere in a diff file
 * gets a file-level comment. One outside the diff files, or tied to no file, gets a file-level comment on the first
 * diff file, which says where the finding is. A finding that one of the open `existingThreads` already carries
 * is not posted again. A blocker whose `threadId` names one of them is listed in the body under
 * a link to that thread. Three kinds of finding that neither block nor hold stay in the body: a pre-existing one,
 * a security note that restates a finding an earlier round listed in its body, and a security note on code an
 * earlier round reviewed.
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
  { existingThreads = [], placements = earlierPlaces(result.findings, existingThreads, diff), draft = false, autoApprove = true, configHold, noVerdict = false, skipped, memorySkip, restart, onPosted, unreadRecords, disproved = [], openWarnings = [], rules, closedPaths = [] }: {
    existingThreads?: PreviousFinding[]; draft?: boolean; configHold?: ConfigHold; noVerdict?: boolean;
    /** The `earlierPlaces` of the round's findings, which decide each finding an earlier thread takes. */
    placements?: ReadonlyMap<Finding, EarlierPlace | undefined>;
    /** The `closed_paths` setting. A file it closes is neither read nor linked, so the review quotes no code of it. */
    closedPaths?: readonly string[];
    /** The `review.rules` setting, which decides whether a confirmed rule keeps a finding a check disproved. */
    rules?: RulesMode;
    /** The earlier warning threads that still hold the approval, or `unread` when they could not be read, which holds it too. */
    openWarnings?: ReadonlyArray<{ isSecurity?: boolean; disprovedBlocker?: boolean; findingTitle: string; place?: { file: string; line: number; originalLine?: number; findingLine?: number }; threadUrl?: string }> | 'unread';
    /** The `auto_approve` setting, which decides what the lines for a held draft and for warnings tell the reader to do. */
    autoApprove?: boolean;
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
): Promise<{ id: number; approvalHeld: ApprovalHeld; warningsHeld: boolean }> {
  const event = mapVerdictToEvent(result.verdict);

  const validComments: Array<{path: string; line: number; side: 'RIGHT'; body: string}> = [];
  /** The threads off the finding's line, also posted as line comments on their file's first changed line. GitHub takes them as file-level threads when it refuses the review's lines. */
  const fileComments: Array<{ path: string; body: string; finding: Finding }> = [];
  /** The threads on a changed file with no line a comment can go on, such as a deleted or renamed file, posted as file-level threads after the review. */
  const fileOnly: typeof fileComments = [];
  const invalidComments: string[] = [];
  const generalFindings: string[] = [];
  /** The earlier threads a finding of this round restates, with what the round names each one as. */
  const restatements = new Map<string, string[]>();
  /** The findings posted as threads this round, counted in the verdict line. */
  const threadFindings: Finding[] = [];
  /** The blockers and holding warnings posted as line comments, which get a file-level thread when GitHub refuses the lines. */
  const lineThreads: Array<{ path: string; finding: Finding }> = [];
  /** The blockers in no changed file, whose threads are on `anchor`. */
  const detached: Finding[] = [];
  /** The holding warnings in no changed file, whose threads are on `anchor`. */
  const detachedWarnings: Finding[] = [];
  /** The findings listed as folds in the review body, under one section per origin. */
  const bodyFindings: Finding[] = [];
  const notes: Finding[] = [];
  /** The blockers and holding warnings the body shows because no thread can hold them. */
  const unthreaded: Finding[] = [];
  /** The findings left to an open thread that matches them, with that thread's ID, which the record keeps. */
  const leftTo = new Map<Finding, string>();
  /** The findings an open thread already carries. */
  const carriedFindings = new Set<Finding>();
  /** The open threads that carry a finding, each with whether one of its findings is a blocker. */
  const carriedThreads = new Map<string, boolean>();
  const nonBlocking: Finding[] = [];
  const isClosed = (file: string) => !!findClosedPattern(file, closedPaths);
  // GitHub shows a permalink to lines on a line of its own as their code, so a closed file gets no link either.
  const linkAt = (commit: string): LineLink => {
    const permalink = buildLineLink(owner, repo, commit, github.context.serverUrl);
    return (file, line, end) => (isClosed(file) ? undefined : permalink(file, line, end));
  };
  const linkTo = linkAt(commitSha);
  const followUps = agreedFollowUps(existingThreads);
  const carried = result.carried ?? [];
  const listedFiles = result.findings.filter(f => !isBlockingFinding(f) && f.file && f.line > 0).map(f => f.file);
  const changed = diff?.files.map(f => f.path) ?? [];
  // GitHub only takes comments on changed files, so the first one with a changed line carries the thread of a blocker that sits elsewhere.
  const anchorFile = diff?.files.find(f => firstCommentableLine(f) !== undefined) ?? diff?.files.at(0);
  const anchor = anchorFile?.path;
  const cited = [...new Set(result.findings.flatMap(f => citedFiles(f, changed)))].slice(0, MAX_CITED_FILES);
  const gone = new Set<string>();
  const files = await fetchFileLines(octokit, owner, repo, commitSha, [...new Set([...listedFiles, ...cited])].filter(file => !isClosed(file)), gone);
  const baseBranch: string | undefined = github.context.payload.pull_request?.base?.ref;
  const links: CodeLinks = { linkTo, linkAt, ...(baseBranch && { baseBranch }), files, changed, related: relatedCommits(result.relatedRepos, result.dependencySources), rules };

  /** Records that the open thread `threadId` carries `f`, which counts and lists that thread as still open. */
  const carry = (f: Finding, threadId: string): void => {
    carriedFindings.add(f);
    carriedThreads.set(threadId, !!carriedThreads.get(threadId) || isCountedBlocker(f));
    // "Needs a human" lists its threads. Any other shows the finding under its link, so a wrong `sameAs` link still
    // shows the defect. The indent keeps it in the list item.
    if (result.needsHuman?.blockers.some(b => b.threadId === threadId)) return;
    const restatement = `This round names it as:\n\n${formatFindingBlock(f, links)}`.replace(/^(?=.)/gm, '  ');
    restatements.set(threadId, [...(restatements.get(threadId) ?? []), restatement]);
  };

  /**
   * Posts a blocker or a holding warning as a thread of its own: a line comment on a changed line, or else a line comment
   * on the first changed line of its file, or of `anchor` when its file is not changed. A changed file with no such line
   * takes a file-level thread. A finding off its line that an open thread matched, by `placements`, stays in that thread.
   */
  const postThread = (f: Finding): void => {
    const blocking = isBlockingFinding(f);
    const diffFile = f.file ? diff?.files.find(df => df.path === f.file) : undefined;
    const elsewhere = diff ? !diffFile : !f.file || f.line <= 0;
    if (onOwnLine(f, diff)) {
      validComments.push({ path: f.file, line: f.line, side: 'RIGHT', body: formatFindingComment(f, links) });
      lineThreads.push({ path: f.file, finding: f });
      threadFindings.push(f);
      return;
    }
    const matched = placements.get(f)?.threadId;
    if (matched) {
      core.info(`Skipping file-level comment for "${f.title}" on ${f.file}: the open thread ${matched} already carries it`);
      leftTo.set(f, matched);
      carry(f, matched);
      return;
    }
    const onFile = elsewhere ? anchorFile : diffFile;
    if (!onFile) {
      if (blocking) (f.file && f.line > 0 ? invalidComments : generalFindings).push(formatFindingBlock(f, links, true));
      unthreaded.push(f);
      return;
    }
    const comment = { path: onFile.path, body: formatFindingComment(f, links, elsewhere ? 'detached' : 'file'), finding: f };
    const line = firstCommentableLine(onFile);
    if (line) {
      validComments.push({ path: comment.path, line, side: 'RIGHT', body: comment.body });
      fileComments.push(comment);
    } else {
      fileOnly.push(comment);
    }
    threadFindings.push(f);
    if (elsewhere) (blocking ? detached : detachedWarnings).push(f);
  };

  for (const f of result.findings) {
    const place = placements.get(f);
    if (!isBlockingFinding(f)) {
      if (place) {
        const matched = openThreadFor(f, existingThreads);
        core.info(`Skipping "${f.title}" on ${f.file}: ${carriedBy(f, matched)}`);
        if (matched) leftTo.set(f, matched);
      } else if (isListedNote(f)) {
        notes.push(f);
      } else if (holdsApproval(f)) {
        postThread(f);
      } else if (isPreExisting(f) || f.origin === 'earlier' || (f.origin === 'reviewed' && isNote(f.severity))) {
        // On code an earlier round reviewed, only a warning gets a thread. A security note there stays listed.
        bodyFindings.push(f);
      } else {
        nonBlocking.push(f);
      }
      continue;
    }

    if (place?.by === 'linked') {
      core.info(`Skipping "${f.title}" on ${f.file}: the thread ${place.threadId} already carries it`);
      carry(f, place.threadId);
      continue;
    }
    postThread(f);
  }

  const onChangedLine = (f: Finding): boolean => !!diff && f.line > 0 && isOnChangedLine(f, diff);
  // Only the notes `capNotes` caps get a thread. It never caps a tool alert, which stays listed.
  const suggestions = notes.filter(f => canLeaveOut(f) && onChangedLine(f) && !isPreExisting(f) && f.origin !== 'earlier' && f.origin !== 'reviewed');
  const inline = new Set([
    ...nonBlocking.filter(onChangedLine).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)).slice(0, MAX_NON_BLOCKING_INLINE),
    ...suggestions,
  ]);
  const inlineComments: typeof validComments = [];
  /** The line comments other than suggestions, which the body names by their headline when GitHub refuses the lines. */
  const headlined: typeof validComments = [];
  for (const f of [...nonBlocking, ...suggestions]) {
    if (inline.has(f)) {
      const comment = { path: f.file, line: f.line, side: 'RIGHT' as const, body: formatFindingComment(f, links) };
      inlineComments.push(comment);
      if (!suggestions.includes(f)) headlined.push(comment);
      threadFindings.push(f);
    } else {
      bodyFindings.push(f);
    }
  }
  validComments.push(...inlineComments);
  const listedNotes = notes.filter(f => !inline.has(f));

  // An incomplete round keeps its record for diagnostics. What it shows reads as it does without one.
  const round = context?.meta.incomplete ? undefined : context;
  const reviewedCommitFooter = buildReviewedCommitFooter(owner, repo, commitSha, github.context.serverUrl, round, reviewTimeMs);

  // A pause counts only what "Needs a human" does not list: on the budget cause every blocker of the round and every
  // earlier one, on the repeated cause each earlier blocker a finding of this round names again, with its thread.
  const human = result.outcome === 'NOT_CONVERGING' ? result.needsHuman : undefined;
  const humanFingerprints = new Set(human?.blockers.map(b => b.fingerprint));
  const listedByHuman = (f: Finding): boolean => (human?.cause === 'budget' && isCountedBlocker(f)) || (!!f.sameAs && humanFingerprints.has(f.sameAs));
  const humanThreads = new Set([
    ...(human?.blockers ?? []).map(b => b.threadId),
    ...[...carriedFindings].filter(listedByHuman).map(f => f.threadId ?? f.answeredIn?.threadId ?? leftTo.get(f)),
  ]);
  const blockingFindings = result.findings.filter(f => isCountedBlocker(f) && !listedByHuman(f));
  const relisted = blockingFindings.filter(f => f.relisted).length;
  const priors = (result.verdictTrace?.unresolvedPriors ?? []).filter(p => !humanFingerprints.has(p.fingerprint));
  // A thread counts once: as an earlier blocker when `priors` lists it or a blocker restates it, else as a warning.
  const priorThreads = new Set(priors.map(p => p.threadId));
  const restated = [...carriedThreads].filter(([id]) => !humanThreads.has(id) && !priorThreads.has(id));
  const earlier = restated.filter(([, blocker]) => blocker).length + relisted + priors.length;
  const restatedWarnings = restated.length - restated.filter(([, blocker]) => blocker).length;
  const fresh = blockingFindings.filter(f => !carriedFindings.has(f)).length - relisted;
  const blockerCounts: BlockerCounts = { fresh, earlier, followUp: (round?.meta.round ?? 1) > 1 };
  const standingHold: ApprovalHold | undefined = configHold ? { reason: 'config', file: configHold }
    : skipped && skipped.excluded.length + skipped.binary.length > 0 ? { reason: 'unread', skipped } : undefined;
  const holding = threadFindings.filter(holdsApproval);
  const holdingUnthreaded = unthreaded.filter(holdsApproval).length;
  const warnings = openWarnings === 'unread' ? undefined : openWarnings.length + holding.length + holdingUnthreaded;
  const guarded = openWarnings === 'unread' ? 0 : openWarnings.filter(t => t.isSecurity || t.disprovedBlocker).length + holding.filter(f => isGuardedFinding(f.tags, f.reviewers)).length;
  const earlierWarnings = openWarnings === 'unread' ? [] : openWarnings.map(t => ({ file: t.place?.file ?? '', line: t.place ? currentFindingLine(t.place) || (t.place.findingLine ?? 0) : 0, title: t.findingTitle, threadUrl: t.threadUrl }));
  const warningHold: ApprovalHold | undefined = warnings === undefined ? { reason: 'warnings' }
    : warnings > 0 ? { reason: 'warnings', count: warnings, ...(guarded > 0 && { guarded }), ...(holdingUnthreaded > 0 && { unthreaded: holdingUnthreaded }), ...(earlierWarnings.length > 0 && { earlier: earlierWarnings }) } : undefined;
  // A draft or a conflict comes before the warnings, which the verdict line still names, so neither hides the other.
  // It is read beside a config or unread hold too, which comes first but gets a line of its own.
  const prHold = event === 'APPROVE' ? await fetchApprovalHold(octokit, owner, repo, prNumber, draft) : undefined;
  const hold = event === 'APPROVE' ? standingHold ?? prHold ?? warningHold : undefined;
  const approvalHeld: ApprovalHeld = hold?.reason ?? false;
  const warningsHeld = event === 'APPROVE' && !!warningHold;
  // A review that warnings hold reads like a change request, so what the change does waits for the approval check's
  // approval. A review held for a person, or posted with `auto_approve` off, gets no such approval, so it keeps both parts
  // for whoever approves.
  const keepForApproval = warningsHeld && !standingHold && autoApprove;
  const verdictReport = result.outcome === 'READY' ? result.verdictReport : undefined;
  const readyReport = keepForApproval ? null : formatReadyReport(verdictReport);
  const keptReport = keepForApproval && verdictReport && formatReadyReport(verdictReport) ? { whatThisDoes: verdictReport.whatThisDoes, whatToTest: verdictReport.whatToTest } : undefined;
  // A config hold outlasts this round, since it also stops a later auto-approve, so a round that requests changes names it too.
  const lineHold = hold ?? (standingHold?.reason === 'config' ? standingHold : undefined);
  // An approval held for unread files or for warnings says so in its verdict line, so only the other holds get a line of their own.
  const ownLines = [lineHold && lineHold.reason !== 'unread' && lineHold.reason !== 'warnings' && lineHold, standingHold && prHold]
    .filter((h): h is ApprovalHold => !!h);
  const heldLines = ownLines.map(h => approvalHoldLine(h, autoApprove)).join('\n\n');

  const limitWarning = formatLimitWarning(latestLimits(result.llmCalls ?? []));
  const unthreadedWarnings = unthreaded.filter(f => !isBlockingFinding(f));
  const onAnchor = (noun: string, list: Finding[]): string | false => list.length > 0
    && `**${noun} not on a changed file:**\n\n${list.map(formatTraceEntry).join('\n')}\n\nComments are only possible on changed files, so the thread of each is on \`${sanitizeFilePath(encodeCommentBreakers(anchor ?? ''))}\`.`;

  // Without their threads, the suggestions are listed in full with the other notes.
  const notesListed = (withoutLineThreads: boolean): Finding[] => withoutLineThreads ? notes : listedNotes;
  /** The findings a body too long for the review leaves out first: pre-existing ones from the end, then notes, then the others from the end. */
  const cutOrder = (withoutLineThreads: boolean): Finding[] => {
    const listed = originGroups(bodyFindings, blockerCounts.followUp).flatMap(([, group]) => group);
    return [...listed.filter(f => !isPreExisting(f)), ...notesListed(withoutLineThreads), ...listed.filter(isPreExisting)].reverse();
  };

  /**
   * Renders the body. A finding posted as a thread is only counted in it, since its thread sits right below.
   * `withoutLineThreads` leaves out the non-blocking line comments, for a review GitHub only takes without them.
   * `cut` leaves out that many findings of `cutOrder`, which the verdict line still counts.
   */
  const renderBody = (withoutLineThreads = false, approvalRefusal?: EventRefusal, cut = 0): string => {
    const dropped = new Set(cutOrder(withoutLineThreads).slice(0, cut));
    const shown = (list: Finding[]): Finding[] => list.filter(f => !dropped.has(f));
    const threads = threadFindings.filter(f => !(withoutLineThreads && inline.has(f)));
    // Without their threads, the body lists them, so the verdict line still counts them.
    const listed = [...bodyFindings, ...listedNotes, ...unthreadedWarnings, ...(withoutLineThreads ? inline : [])];
    const lead = formatLead(result, blockerCounts, { threads, restatedWarnings, listed, carried, hold, warningHold, autoApprove }, limitWarning, unreadRecords);
    const line = approvalRefusal ? APPROVAL_REFUSED_LINES[approvalRefusal] : heldLines;
    let head = line ? `${line}\n\n${lead}` : lead;
    if (context?.meta.trigger?.catchUp) head += `\n\n${CATCH_UP_LINE}`;
    const kept = context && reusedLine(context);
    if (kept) head += `\n\n${kept}`;
    const verdictLine = !unreadRecords && result.outcome;
    head = withMessageBoxes(head, [
      verdictLine === 'INCOMPLETE' && RETRY_COMMAND_RE.test(result.summary) && 'again',
      ...(approvalRefusal ? [] : ownLines.map(h => approvalHoldBox(h, autoApprove))),
      verdictLine === 'READY' && warningHold && hold && approvalHoldBox(warningHold, autoApprove),
    ]);
    if (memorySkip) {
      head += `\n\n**Memory skipped:** ${memorySkip}`;
    }
    if (readyReport?.whatThisDoes) {
      head += `\n\n${readyReport.whatThisDoes}`;
    }
    const blockingThreads = formatBlockingPriorThreads(result, restatements);
    // A thread `formatBlockingPriorThreads` lists takes its restatements there, so it is listed once.
    const stillOpen = [...restatements].filter(([id]) => !priorThreads.has(id)).map(([id, texts]) =>
      [formatTraceEntry(existingThreads.find(t => t.threadId === id)!), ...texts].join('\n\n'));
    const overrides = event === 'APPROVE' && formatSecurityOverrides(existingThreads.flatMap(t =>
      t.securityOverride ? [{ title: t.title, threadUrl: t.threadUrl, ...t.securityOverride }] : []));
    const sections = [
      formatNeedsHuman(result, restart),
      (blockingThreads || stillOpen.length > 0) && [blockingThreads ?? STILL_OPEN_HEADING, ...stillOpen].join('\n'),
      onAnchor('Blockers', detached),
      onAnchor('Warnings', detachedWarnings),
      generalFindings.length > 0 && `**Blockers not tied to a line:**\n\n${generalFindings.join('\n\n')}`,
      invalidComments.length > 0 && `**Blockers in files outside this diff:**\n\n${invalidComments.join('\n\n')}`,
      formatUnthreadedWarnings(unthreadedWarnings, links),
      ...formatOriginSections(shown(bodyFindings), links, blockerCounts.followUp),
      formatCarriedWarnings(carried),
      formatNotesSection(shown(notesListed(withoutLineThreads)), result.unposted ?? [], links),
      dropped.size > 0 && leftOutForRoom(dropped.size),
      skipped && skippedFileList(skipped) && `### Not read by any model · ${countOf(skipped.excluded.length + skipped.binary.length, 'file')}\n\nA person needs to look at these before the PR merges.\n\n${skippedFileList(skipped)}`,
      formatFindingSection(`📌 ${countOf(followUps.length, 'follow-up')} agreed for later`, followUps.length > 0 ? [followUps.join('\n')] : [], 'Agreed in their threads as later work. None of them blocks.'),
      formatRelatedWork(result.relatedWork, owner, repo),
      formatScope(result.scope, linkTo),
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
  /** The body as `renderBody` writes it, fitted to a number of characters by leaving out whole findings. */
  const fitted = (withoutLineThreads = false, approvalRefusal?: EventRefusal): BodyFit => room =>
    fitBody(cut => highlightCode(renderBody(withoutLineThreads, approvalRefusal, cut), codeTokens), cutOrder(withoutLineThreads), room);
  const postedComments = [...validComments, ...fileOnly].map(highlight);
  const inBody = new Set([...bodyFindings, ...listedNotes, ...unthreaded]);
  // The record with each finding's place, in the `room` the body leaves. A finding in `refused` got no thread from GitHub, so the body carries it.
  // A record composed again for a retried post differs only in where findings went and whether the approval was refused, so the log shows the first cut one.
  const cutLog = { logged: false };
  // A finding the body left out for lack of room, in `dropped`, is in the record only.
  const recordFor = (refused: ReadonlySet<Finding>, approvalRefused: boolean, room: number, dropped: ReadonlySet<Finding> = new Set()): string => {
    const placeOf = (f: Finding): PostedPlace => dropped.has(f) ? 'record' : refused.has(f) || inBody.has(f) ? 'body' : threadFindings.includes(f) ? 'thread' : 'earlier_thread';
    const recordPlace = (entry: FindingFingerprintEntry, f: Finding): FindingFingerprintEntry => {
      const posted = placeOf(f);
      // A finding left out of the body keeps what a listed one records, so a later round still carries a warning among them.
      const listed = posted === 'body' || posted === 'record';
      const bodyWarning = listed && f.severity === 'warning';
      const cited = bodyWarning ? citedLine(files.get(f.file), f.line) : undefined;
      // A file that is gone at the head was read and ends the warning. Only one that exists but was not read keeps it.
      const unread = bodyWarning && !!f.file && f.line > 0 && !files.has(f.file) && !gone.has(f.file);
      // A finding with a thread of its own records no earlier thread, which its record entry would otherwise raise.
      const { threadId: linked, ...unlinked } = entry;
      const threadId = posted === 'thread' ? undefined : linked ?? (posted === 'earlier_thread' ? leftTo.get(f) : undefined);
      const description = listed && (f.severity === 'blocker' || cited || unread) && f.description ? safeTruncate(f.description, MAX_RECORDED_DESCRIPTION) : undefined;
      const holds = holdsApproval(f);
      return { ...unlinked, ...(threadId && { threadId }), posted, ...(cited && { citedLine: cited }), ...(unread && { unread: true as const }), ...(holds && { holds }), ...(description && { description }) };
    };
    return (context
      ? formatRecordTrailer({
        ...context,
        // The record's entries are built from `result.findings` in the same order. A record built from other findings keeps its entries as they are.
        ...(context.findings.entries.length === result.findings.length && {
          findings: { ...context.findings, entries: context.findings.entries.map((entry, i) => recordPlace(entry, result.findings[i])) },
        }),
        output: { bodyLength: body.length, commentLengths: postedComments.map(c => c.body.length) },
        ...(event === 'APPROVE' && { approval: roundApproval(approvalRefused ? 'refused' : approvalHeld, !!warningHold) }),
        ...(keptReport && { readyReport: keptReport }),
      }, reviewTimeMs ?? 0, room, cutLog)
      : '') + (noVerdict ? `\n\n${NO_VERDICT_MARKER}` : '') + (noVerdict && result.retryAfter ? `\n${RETRY_AFTER_MARKER}${result.retryAfter} -->` : '')
      + (standingHold ? `\n\n${HELD_FOR_PERSON_MARKER}` : '');
  };

  if (invalidComments.length > 0) {
    core.info(`Moved ${invalidComments.length} comments to review body (not postable as threads)`);
  }
  const postedVerdict = approvalHeld ? 'COMMENT' : result.verdict;
  if (approvalHeld) {
    const why = hold?.reason === 'conflict' ? `PR conflicts with ${hold.baseRef}`
      : hold?.reason === 'config' ? (hold.file === 'head' ? 'The PR\'s own config does not load' : `The ${hold.file === 'base' ? 'base' : 'default'} branch config did not load`)
      : hold?.reason === 'unread' ? 'No model read some of the changed files'
      : hold?.reason === 'warnings' ? 'Warnings wait for a fix or an accepted answer' : 'The PR is a draft';
    core.info(`${why}, so the approval is posted as a comment`);
  }
  core.info(`Posting review: ${mapVerdictToEvent(postedVerdict)} with ${validComments.length} line comments, ${fileComments.length} of them off their finding's line, and ${fileOnly.length} file-level comments`);

  const review = await submitReview(
    octokit, owner, repo, prNumber, commitSha, postedVerdict, fitted(), (room, dropped) => recordFor(new Set(), false, room, dropped), validComments.map(highlight), reviewedCommitFooter,
    approvalRefusal => fitted(true, approvalRefusal), (approvalRefusal, room, dropped) => recordFor(inline, !!approvalRefusal, room, dropped), headlined.map(highlight),
  );
  const approvalRefused = postedVerdict === 'APPROVE' && !!review.refused;
  onPosted?.();
  // A blocker or a holding warning whose line comment GitHub refused gets a file-level thread on its file.
  const retried = review.lineComments ? [] : [...fileComments, ...lineThreads.map(c => ({ ...c, body: formatFindingComment(c.finding, links, 'file') }))];
  const refused = await postFileLevelComments(octokit, owner, repo, prNumber, commitSha, [...fileOnly, ...retried].map(highlight));
  if (refused.length > 0) {
    const titles = refused.map(f => `"${f.title}" (${f.file})`).join(', ');
    const refusedBlockers = refused.filter(isBlockingFinding);
    const blockerSection = refusedBlockers.length > 0 ? `\n\n**Blockers that could not be posted as threads:**\n\n${refusedBlockers.map(f => formatFindingBlock(f, links, true)).join('\n\n')}` : '';
    const warningSection = formatUnthreadedWarnings(refused.filter(f => !isBlockingFinding(f)), links);
    const section = highlightCode(`${blockerSection}${warningSection ? `\n\n${warningSection}` : ''}`, codeTokens);
    // The verdict line counted each refused warning as one with a thread, so it is restated with them among those without one.
    const refusedHolding = refused.filter(holdsApproval);
    const holdLine = (h: ApprovalHold): string => highlightCode(approvalHoldLine(h, autoApprove), codeTokens);
    const restate = (text: string): string => warningHold?.count && refusedHolding.length > 0
      ? text.replace(holdLine(warningHold), () => holdLine({
        ...warningHold,
        unthreaded: (warningHold.unthreaded ?? 0) + refusedHolding.length,
        guarded: (warningHold.guarded ?? 0) - refusedHolding.filter(f => isGuardedFinding(f.tags, f.reviewers)).length,
      }))
      : text;
    const fullBody = restate(review.fit(Infinity).text);
    const inRecord = (room: number, dropped?: ReadonlySet<Finding>) => recordFor(new Set([...refused, ...(review.lineComments ? [] : inline)]), approvalRefused, room, dropped);
    const refusedRecord = inRecord(REVIEW_BODY_BUDGET - section.length - fullBody.length);
    // Cut the existing body, never the findings appended to it or the round record.
    const room = REVIEW_BODY_BUDGET - section.length - refusedRecord.length;
    if (room <= 0) {
      throw new Error(`Could not post findings as threads or fit them in review #${review.id}: ${titles}`);
    }
    const cut = review.fit(room);
    const kept = { ...cut, text: restate(cut.text) };
    const record = markLeftOut(refusedRecord, kept, REVIEW_BODY_BUDGET - section.length - kept.text.length, inRecord);
    try {
      await octokit.rest.pulls.updateReview({
        owner,
        repo,
        pull_number: prNumber,
        review_id: review.id,
        body: appendReviewFooter(`${kept.text}${section}${record}`, reviewedCommitFooter),
      });
    } catch (error) {
      throw new Error(`Could not post findings as threads or in review #${review.id}: ${titles}. ${error instanceof Error ? error.message : error}`);
    }
  }
  // Warnings can hold behind another hold that comes first, and still take back an approval of this commit.
  return { id: review.id, approvalHeld: approvalRefused ? 'refused' : approvalHeld, warningsHeld };
}

/** Whether `error` is GitHub's refusal when the repo setting stops the workflow token from approving. */
export function isApprovalSettingRefusal(error: unknown): boolean {
  return /not permitted to (create or )?approve pull requests/i.test(error instanceof Error ? error.message : String(error));
}

/** A review body and the findings it left out for lack of room. */
interface FittedBody {
  text: string;
  dropped: ReadonlySet<Finding>;
}

/** A review body fitted to a number of characters. Given `Infinity`, it returns the body whole. */
type BodyFit = (room: number) => FittedBody;

/**
 * Creates the review, falling back to a body-only review when GitHub rejects the line
 * comments and to COMMENT when it refuses the event with a 422. A refusal on a commit that
 * is no longer the PR head throws `SupersededError` instead. The record gets the room the whole
 * body leaves, and the body is fitted to the room the record leaves. Returns the review ID
 * and the fit of the posted body, without the reviewed-commit footer and the markers.
 */
async function submitReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  verdict: ReviewVerdict,
  body: BodyFit,
  /** The record in the given room, with the findings the body left out for lack of room. */
  record: (room: number, dropped: ReadonlySet<Finding>) => string,
  validComments: Array<{path: string; line: number; side: 'RIGHT'; body: string}>,
  reviewedCommitFooter: string,
  /** The body without the line comments listed as threads, for when GitHub refuses their lines, or the approval for `approvalRefusal`. */
  bodyWithoutLineComments: (approvalRefusal?: EventRefusal) => BodyFit,
  /** The record for a review posted without its line comments, where no finding of theirs has a thread. */
  recordWithoutLineComments: (approvalRefusal: EventRefusal | undefined, room: number, dropped: ReadonlySet<Finding>) => string,
  /** The line comments the body names by their headline when the review posts without them. The caller posts a blocker as a file-level thread instead. */
  unthreaded: typeof validComments,
): Promise<{ id: number; fit: BodyFit; lineComments: boolean; refused?: EventRefusal }> {
  const event = mapVerdictToEvent(verdict);
  /** The review text of the body of `fit` with `suffix` after it and the trailer that goes with it, and the fit of that body. */
  const compose = (fit: BodyFit, suffix: string, trailerFor: (room: number, dropped: ReadonlySet<Finding>) => string): { posted: string; fit: BodyFit } => {
    const withSuffix: BodyFit = room => {
      const fitted = fit(room - suffix.length);
      return { ...fitted, text: `${fitted.text}${suffix}` };
    };
    const trailer = trailerFor(REVIEW_BODY_BUDGET - withSuffix(Infinity).text.length, new Set());
    const fitted = withSuffix(REVIEW_BODY_BUDGET - trailer.length);
    const marked = markLeftOut(trailer, fitted, REVIEW_BODY_BUDGET - fitted.text.length, trailerFor);
    return { posted: appendReviewFooter(`${fitted.text}${marked}`, reviewedCommitFooter), fit: withSuffix };
  };
  const listUnthreaded = (heading: string, line: (c: typeof unthreaded[number]) => string): string =>
    unthreaded.length > 0 ? `\n\n**${heading}**\n${unthreaded.map(c => `- ${line(c)}`).join('\n')}` : '';
  assertWritesAllowed();
  try {
    const full = compose(body, '', record);
    const { data: review } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event,
      body: full.posted,
      comments: validComments,
    });

    core.info(`Posted review #${review.id} with verdict ${verdict}`);
    return { id: review.id, fit: full.fit, lineComments: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isLineError = errorMessage.includes('pull_request_review_thread.line') ||
      errorMessage.includes('line must be part of the diff');

    // If it's a line validation error, retry without inline comments
    if (isLineError && validComments.length > 0) {
      core.warning('Inline comments rejected by GitHub (invalid lines). Posting review without inline comments.');
      const bare = compose(bodyWithoutLineComments(), listUnthreaded('Inline comments could not be posted:', c => commentHeadline(c.body)), (room, dropped) => recordWithoutLineComments(undefined, room, dropped));

      const { data: review } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitSha,
        event,
        body: bare.posted,
        comments: [],
      });

      core.info(`Posted review #${review.id} without inline comments (line validation failed)`);
      return { id: review.id, fit: bare.fit, lineComments: false };
    }

    // Only a 422 is GitHub refusing this review event (e.g. approving or requesting
    // changes is not allowed), so a 5xx or rate limit must not weaken the verdict.
    const status = (error as { status?: number }).status;
    if (event === 'COMMENT' || status !== 422) {
      throw error;
    }

    await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
    const refused: EventRefusal = isApprovalSettingRefusal(error) ? 'setting' : 'other';
    const hint = refused === 'setting'
      ? ' Ensure "Allow GitHub Actions to create and approve pull requests" is enabled in repo settings.'
      : '';
    core.warning(`GitHub refused the ${event} review (${status}: ${errorMessage}).${hint} Falling back to COMMENT.`);

    const approvalRefusal = event === 'APPROVE' ? refused : undefined;
    const fallback = compose(
      bodyWithoutLineComments(approvalRefusal),
      listUnthreaded('Findings (could not post inline):', c => `${commentHeadline(c.body)} (\`${findingLocation({ file: c.path, line: c.line })}\`)`),
      (room, dropped) => recordWithoutLineComments(approvalRefusal, room, dropped),
    );

    const { data: review } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: 'COMMENT',
      body: fallback.posted,
      comments: [],
    });

    core.info(`Posted fallback COMMENT review #${review.id} (original verdict: ${verdict})`);
    return { id: review.id, fit: fallback.fit, lineComments: false, refused };
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
 * Returns one line per finder or judge model of the round that reached a limit and whose fallback model answered in
 * its place, such as "`gpt-5.5` reached its limit, so `claude-sonnet-5-5` read in its place". The model "could not be
 * reached" when its endpoint could not be. The fallback "judged" for the judge and the verdict reader, and "checked" for
 * the refuter.
 */
export function limitFallbackLines({ models, routing }: Pick<RoundContext, 'models' | 'routing'>): string[] {
  const finderModels = new Map(routing?.reviewers.map(r => [r.name, r.model] as const));
  const lines = (models.fallbacks ?? []).flatMap(({ stage, agent, fallbackModel, limit, unreachable }) => {
    const finder = stage === 'reviewer';
    const model = finder ? finderModels.get(agent ?? '') : stage === 'judge' || stage === 'verdict' ? models.judge : undefined;
    if (!limit || !model) return [];
    const did = finder ? 'read' : agent === 'refute' ? 'checked' : 'judged';
    return [`${inlineCode(model)} ${unreachable ? 'could not be reached' : 'reached its limit'}, so ${inlineCode(fallbackModel)} ${did} in its place`];
  });
  return [...new Set(lines)];
}

/**
 * Returns the footer, a collapsed "About this review": the reviewed commit, and with a round context the round, the
 * lines read and the time it took, the models that found and judged the findings, each model a fallback answered for,
 * the tokens and cost, and the runner.
 */
function buildReviewedCommitFooter(owner: string, repo: string, commitSha: string, serverUrl: string, context?: RoundContext, reviewTimeMs?: number): string {
  const commit = `[\`${commitSha.slice(0, 7)}\`](${repoUrl(serverUrl, owner, repo)}/commit/${commitSha})`;
  // The routed group says which models read the PR. Without it, the configured reviewer model did.
  const routed = context?.routing?.reviewers.map(r => r.model);
  const finders = distinctModels(routed?.length ? routed : [context?.models.reviewer].filter((m): m is string => !!m)).map(m => inlineCode(m));
  const usage = context && formatRoundUsage(context.usage);
  const lines = [
    `- Reviewed ${commit}${context ? `, round ${context.meta.round}` : ''}`,
    ...(context ? [`- ${countOf(context.diff.lines, 'changed line')} read${reviewTimeMs ? ` in ${formatDuration(reviewTimeMs)}` : ''}`] : []),
    ...(context ? [`- Found by ${finders.join(' and ')}, judged by ${inlineCode(context.models.judge)}`] : []),
    ...(context ? limitFallbackLines(context).map(line => `- ${line}`) : []),
    ...(usage ? [`- ${usage}`] : []),
    ...(context?.runner ? [`- ${formatRunner(context.runner)}`] : []),
    `- [How Manki reviews](${HOW_REVIEWS_WORK_URL})`,
  ];
  return `<details>\n<summary>About this review</summary>\n\n${lines.join('\n')}\n\n</details>`;
}

/** The footer line of `buildReviewedCommitFooter` that links the reviewed commit. */
const REVIEWED_COMMIT_LINE = /^- Reviewed \[`[0-9a-f]{7}`\]\(\S+\/commit\/([0-9a-f]{40})\)/;

/** Returns the commit that `line` of a Manki review body names: in the footer, the head marker or the approval record. */
function commitNamedBy(line: string): string | undefined {
  const [record] = extractApprovalRecords(line);
  let named: unknown = line.match(REVIEWED_COMMIT_LINE)?.[1] ?? ownMarker(line, HEAD_MARKER_OPENER);
  try {
    if (record) named = (JSON.parse(record) as Partial<ApprovalRecord>).head;
  } catch {
    // A record that does not parse names no commit.
  }
  return typeof named === 'string' && /^[0-9a-f]{40}$/.test(named) ? named : undefined;
}

/**
 * Returns the commit a Manki review gave its verdict on, or `undefined` when its body names no full commit hash. Only
 * the review's own body decides: its last line that names a commit, which Manki writes below all text it quotes.
 * GitHub moves `commit_id` to the new head when a push leaves the PR's change as it was, so `commit_id` never counts.
 */
export function reviewedCommit(review: { body?: string | null }): string | undefined {
  const lines = (review.body ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const named = commitNamedBy(lines[i]);
    if (named) return named;
  }
  return undefined;
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

/** Encodes the characters of `text` that open or close an HTML comment or end its line, so a file name can neither end one of Manki's hidden markers nor fake one. */
function encodeCommentBreakers(text: string): string {
  return text.replace(/[<>\r\n]/g, encodeURIComponent);
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

/**
 * Whether `body` is the review body of an auto-approval. A round review quotes model text, which could echo the marker,
 * so only a review without a round record counts.
 */
function isAutoApproval(body: string): boolean {
  return !hasReviewRecord(body) && body.startsWith(APPROVED_LINE) && hasOwnMarker(body, AUTO_APPROVE_MARKER);
}

/** The first line of the review body for each outcome. Its emoji is the only one in the review. */
const VERDICT_LINES: Record<RoundOutcome, (result: ReviewResult, blockers: BlockerCounts, posted: PostedFindings) => string> = {
  READY: (_result, _blockers, { threads, listed, carried, hold, warningHold, autoApprove }) => {
    const unread = hold?.reason === 'unread' && hold.skipped.excluded.length + hold.skipped.binary.length;
    // Another hold has a line of its own or is named here, and the warnings still hold once it lifts.
    // Handling the warnings brings the approval only when they are all that holds. Another hold's line says what it needs.
    const approves = hold?.reason === 'warnings' && hold.count !== undefined && autoApprove ? ' Manki approves once every warning is handled.' : '';
    if (warningHold && hold) {
      const line = `⚠️ ${approvalHoldLine(warningHold, autoApprove)}${approves}${unread ? ` A person must also approve, since no model read ${unread} of the changed files.` : ''}`;
      // This review shows the warnings it posts, so only those held by an earlier thread are listed here.
      const earlier = warningHold.reason === 'warnings' && warningHold.earlier;
      return earlier ? `${line}\n\n${formatStillOpen(earlier)}` : line;
    }
    if (unread) return `✅ **Approved, but a person must approve:** no model read ${unread} of the changed files.`;
    const all = [...[...threads, ...listed].filter(f => !isBlockingFinding(f)), ...carried];
    if (all.length === 0) return APPROVED_LINE;
    return `${APPROVED_LINE} ${formatSeverityCounts(all)}, ${all.length === 1 ? 'which doesn\'t block' : 'none of which block'}.`;
  },
  ADDRESS_FIRST: (_result, blockers, posted) => {
    const others = joinCounts(formatNonBlocking(posted));
    return `🔴 **Changes requested:** ${formatBlockerCounts(blockers)}${others ? `, plus ${others}` : ''}.`;
  },
  INCOMPLETE: result => `${REVIEW_INCOMPLETE_LINE} ${asSentence(sanitizeMarkdown(result.summary.trim()) || 'The review did not finish')}`,
  NOT_CONVERGING: (result, blockers, posted) => {
    const listed = countOf(result.needsHuman?.blockers.length ?? 0, 'blocker');
    const others = joinCounts([blockers.fresh + blockers.earlier > 0 ? formatBlockerCounts(blockers) : '', ...formatNonBlocking(posted)]);
    const plus = others ? `, plus ${others}` : '';
    return result.needsHuman?.cause === 'budget'
      ? `🛑 **Needs a human:** ${listed} still open after the last automatic round${plus}.`
      : `🛑 **Needs a human:** ${listed} came back after a fix${plus}.`;
  },
};

/**
 * Returns the counts of what does not block: the findings posted as threads, the earlier warning threads this round
 * restates and the warnings the body lists, as ["1 warning in threads", "1 warning still open from an earlier review"].
 */
function formatNonBlocking({ threads, restatedWarnings, listed }: PostedFindings): string[] {
  const others = threads.filter(f => !isCountedBlocker(f));
  const listedWarnings = listed.filter(f => f.severity === 'warning').length;
  return [
    others.length > 0 ? `${formatSeverityCounts(others)} in threads` : '',
    restatedWarnings > 0 ? `${countOf(restatedWarnings, 'warning')} still open from ${restatedWarnings === 1 ? 'an earlier review' : 'earlier reviews'}` : '',
    listedWarnings > 0 ? `${countOf(listedWarnings, 'warning')} listed below` : '',
  ];
}

/** Joins the non-empty `parts` as a list with "and". A part that already joins two counts with "and" sets the last one apart by a comma. */
function joinCounts(parts: string[]): string {
  const kept = parts.filter(Boolean);
  if (kept.length < 2) return kept.join('');
  const comma = kept.length > 2 || kept.some(p => p.includes(' and '));
  return `${kept.slice(0, -1).join(', ')}${comma ? ', and ' : ' and '}${kept[kept.length - 1]}`;
}

/** The findings this round posts: as threads, listed in the body, and the hold on an approval. */
interface PostedFindings {
  threads: Finding[];
  /** The earlier warning threads a finding of this round restates, which no blocker of this round or earlier one shares. */
  restatedWarnings: number;
  listed: Finding[];
  /** The warnings carried from earlier rounds, which an approval counts with the findings it lists. */
  carried: FindingFingerprintEntry[];
  hold?: ApprovalHold;
  /** The warnings that hold the approval, also when another hold comes first. */
  warningHold?: ApprovalHold;
  autoApprove: boolean;
}

/** Returns how many findings of each severity there are, most severe first, as "1 warning and 2 suggestions". */
function formatSeverityCounts(findings: Array<Pick<FindingFingerprintEntry, 'severity'>>): string {
  const parts = SEVERITY_ORDER.flatMap(s => {
    const n = findings.filter(f => f.severity === s).length;
    return n > 0 ? [countOf(n, SEVERITY_NAME[s])] : [];
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
 * blocker's description, or nothing when no finding blocks. The judge writes its summary before later steps take
 * findings out of the round, so the summary is left out when the judge kept a finding and `result.findings` holds none
 * of the findings it kept. Later steps also make blockers the summary never saw and lower blockers it names. So it is
 * left out unless the findings the judge graded a blocker in that call are exactly the findings that block. An
 * incomplete round's summary says why the round did not finish, so it is returned as it is.
 */
export function roundSentence(result: ReviewResult): string {
  if (!result.reviewComplete) return result.summary;
  // A finding the judge kept and a later step dropped is `ignore` by a step that is not the judge's. One filed as `ignore` has no step.
  const droppedLater = (f: Finding) => f.gradePath?.length ? f.gradePath.at(-1)!.by !== 'judge' : false;
  const kept = (result.allJudgedFindings ?? []).filter(f => f.severity !== 'ignore' || droppedLater(f));
  const listed = new Set(result.findings.map(findingKey));
  // The judge graded a blocker itself when the cell it stated gives `blocker` with no doubt behind it. A doubt leaves `gradeIfConfirmed`.
  // A blocker two disproofs lowered keeps that cell as `judgeCell`. A sweep's finding is graded in a later judge call, and the verdict reader's has no cell.
  const sweepers = new Set(result.sweeps?.map(sweep => sweep.reviewer));
  const judgeGraded = (f: Finding) => {
    const stated = f.judgeCell ?? f.cell;
    return isGradeCell(stated) && cellGrade(stated.row, stated.judgeColumn ?? stated.column) === 'blocker' && !f.gradeIfConfirmed && !f.reviewers.some(r => sweepers.has(r));
  };
  const blockers = new Set(result.findings.filter(f => f.severity === 'blocker').map(findingKey));
  const sameBlockers = [...(result.allJudgedFindings ?? []), ...result.findings].every(f => judgeGraded(f) === blockers.has(findingKey(f)));
  // The judge writes its summary before the verdict reader runs, so it never describes the reader's blockers.
  const stands = result.verdictReason !== 'verdict_reader' && (kept.length === 0 || kept.some(f => listed.has(findingKey(f)))) && sameBlockers;
  if (stands && result.summary.trim()) return result.summary;
  // Only a blocker stands in for the summary, so a round nothing blocks then has no sentence.
  const top = result.findings.find(f => f.severity === 'blocker');
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
 * An entry already listed under "Needs a human" is left out. Under each entry follow its `restatements`, by thread ID.
 */
export function formatBlockingPriorThreads(
  result: Pick<ReviewResult, 'verdictTrace' | 'outcome' | 'needsHuman'>,
  restatements: ReadonlyMap<string, string[]> = new Map(),
): string | null {
  const listed = new Set(result.outcome === 'NOT_CONVERGING' ? result.needsHuman?.blockers.map(b => b.fingerprint) : []);
  const priors = (result.verdictTrace?.unresolvedPriors ?? []).filter(p => !listed.has(p.fingerprint));
  if (priors.length === 0) return null;

  return `${STILL_OPEN_HEADING}\n${priors.map(p => [formatTraceEntry(p), ...(p.threadId ? restatements.get(p.threadId) ?? [] : [])].join('\n\n')).join('\n')}`;
}

const STILL_OPEN_HEADING = '**Still open from earlier reviews:**';

/** Returns the earlier threads `entries` under the heading for threads still open, one linked line each. */
function formatStillOpen(entries: ReadonlyArray<Pick<VerdictTraceEntry, 'file' | 'title' | 'line' | 'threadUrl'>>): string {
  return `${STILL_OPEN_HEADING}\n${entries.map(formatTraceEntry).join('\n')}`;
}

/** Returns the blocking threads still open, by `threadBlocks`, one linked line each, or null when there are none. */
export function formatOpenBlockers(threads: PreviousFinding[]): string | null {
  const open = threads.filter(t => (t.status === 'open' || t.status === 'replied' || t.reopen) && threadBlocks(t));
  return open.length > 0 ? formatStillOpen(open) : null;
}

function safeThreadUrl(url: string | undefined): string | null {
  return url && /^https?:\/\/[^\s)]+$/.test(url) ? url : null;
}

function formatTraceEntry(p: Pick<VerdictTraceEntry, 'file' | 'title' | 'line' | 'threadUrl'>): string {
  const file = sanitizeFilePath(encodeCommentBreakers(p.file));
  const location = !file ? '' : p.line ? `\`${file}:${p.line}\`: ` : `\`${file}\`: `;
  const title = sanitizeMarkdown(p.title || '(untitled)');
  const safeUrl = safeThreadUrl(p.threadUrl);
  const link = safeUrl ? ` ([view thread](${safeUrl}))` : '';
  return `- ${location}${title}${link}`;
}

function formatNeedsHuman(result: ReviewResult, restart?: string): string | null {
  if (result.outcome !== 'NOT_CONVERGING' || !result.needsHuman) return null;
  const next = `Automatic review is paused. To get the next round, tick the review box in the settings block, or push and then comment \`/manki review\`.${restart ? ` ${restart}` : ''}`;
  return `${withMessageBoxes(next, ['again'])}\n\n${result.needsHuman.blockers.map(formatTraceEntry).join('\n')}`;
}

/** Returns `text` for a link label on one line, with the backslashes and brackets that would end the label escaped. */
function linkText(text: string): string {
  return sanitizeMarkdown(text).replace(/\s+/g, ' ').trim().replace(/[\\[\]]/g, '\\$&');
}

// The relations the author can act on, in the order the note lists them, each with the line telling them what to do.
const RELATION_ACTION: Record<Extract<RelatedRelation, 'duplicate' | 'fixes_issue'>, (link: string, number: number) => string> = {
  duplicate: link => `${link} seems to make the same change. Close one of the two if so.`,
  fixes_issue: (link, number) => `This PR may fix ${link}. Add \`Closes #${number}\` to the description if it does.`,
};

/** Files a list of files shows by name before it counts the rest. */
const MAX_LISTED_FILES = 10;

/** Returns `files` as inline code, at most `MAX_LISTED_FILES` of them and a count of the rest. */
export function fileList(files: readonly string[]): string {
  const shown = files.slice(0, MAX_LISTED_FILES).map(f => inlineCode(sanitizeFilePath(f))).join(', ');
  return files.length > MAX_LISTED_FILES ? `${shown} and ${files.length - MAX_LISTED_FILES} more` : shown;
}

/**
 * Returns the review body's Scope section: the scope reader's doubt that the change is useful and its proposed split,
 * or null when it has neither, or when `review.scope_blocks` posted them as warnings.
 */
function formatScope(scope: RoundScope | undefined, linkTo: LineLink): string | null {
  if (!scope || scope.warned || (!scope.doubt && !scope.split)) return null;
  const cited = linkedRanges((scope.proof ?? []).flatMap(at => {
    const range = lineRange(at.slice(0, at.lastIndexOf(':')), at.slice(at.lastIndexOf(':') + 1));
    return range ? [range] : [];
  }), linkTo);
  const parts = [
    scope.doubt && `**Is this change useful?** ${sanitizeMarkdown(scope.doubt)}${cited ? ` See ${cited}.` : ''}`,
    scope.split && `**Split into ${scope.split.length} PRs?** The change covers topics that each make sense on their own:\n\n${scope.split.map((part, i) => `${i + 1}. ${sanitizeMarkdown(part.name)}: ${fileList(part.files)}`).join('\n')}`,
  ].filter(Boolean);
  return `**Scope:** a judgment of the PR as a whole, not a defect in its code. It never holds the approval.\n\n${parts.join('\n\n')}`;
}

/**
 * Returns the note listing the open PRs this PR may duplicate and the open issues it may fix, each with what to do, or
 * null when there is none. Overlapping and unrelated candidates stay in the round record only. The model's reason
 * stays out too, since the other PRs' and issues' text can steer it.
 */
function formatRelatedWork(work: RelatedWork | undefined, owner: string, repo: string): string | null {
  const relations = Object.keys(RELATION_ACTION);
  const actionable = (work?.items ?? [])
    .flatMap(item => item.relation === 'duplicate' || item.relation === 'fixes_issue' ? [{ ...item, relation: item.relation }] : [])
    .sort((a, b) => relations.indexOf(a.relation) - relations.indexOf(b.relation));
  if (actionable.length === 0) return null;
  const lines = actionable.map(item => {
    const url = `${repoUrl(github.context.serverUrl, owner, repo)}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}`;
    const draft = item.draft ? ' (draft)' : '';
    return `- ${RELATION_ACTION[item.relation](`[#${item.number} ${linkText(item.title)}](${url})${draft}`, item.number)}`;
  });
  return `**Related work:** open PRs and issues this PR may duplicate or fix. None of them blocks.\n\n${lines.join('\n')}`;
}

/**
 * Returns the guarded findings a PR author dismissed on their own PR as a list, or null when there are none. The heading
 * names the author and the role that allowed it. Every entry carries the same two, since both are the PR author's. A
 * finding whose thread holds Manki's confirmation of a fix in another pull request is listed apart, with that pull request.
 */
function formatSecurityOverrides(overrides: ReadonlyArray<{ title: string; threadUrl?: string; login: string; role: AuthorClearRole; fixClaim?: FixClaim }>): string | null {
  if (overrides.length === 0) return null;
  const [{ login, role }] = overrides;
  const item = (o: typeof overrides[number]) => {
    const title = sanitizeMarkdown(o.title || '(untitled)');
    const url = safeThreadUrl(o.threadUrl);
    return `- ${url ? `[${title}](${url})` : title}`;
  };
  const confirmed = overrides.filter(o => o.fixClaim?.status === 'confirmed');
  const other = overrides.filter(o => o.fixClaim?.status !== 'confirmed');
  const by = `**Findings dismissed by the PR author** \`@${login}\` (\`${role}\` role)`;
  return [
    other.length > 0 && `${by}:\n\n${other.map(item).join('\n')}`,
    confirmed.length > 0 && `${by} **as fixed in another PR.** In a reply, Manki confirmed that the PR named replaced the cited line on the default branch.\n\n${confirmed.map(o => `${item(o)}: #${o.fixClaim!.pr}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

function formatLabelled(label: string, text: string): string {
  const safe = sanitizeMarkdown(text.trim());
  return `**${label}:**${safe.includes('\n') ? '\n\n' : ' '}${safe}`;
}

export const TEST_GUIDE_NOTE = '_The review model wrote these steps. Check what a step runs before you follow it._';

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
 * Returns what an approved change does, in at most two sentences, and the collapsed steps to test it, or null when
 * `report` has neither. Either part is left out when the reader left it blank, as a reader that asked for changes may.
 */
export function formatReadyReport(report: Pick<VerdictReport, 'whatThisDoes' | 'whatToTest'> | undefined): { whatThisDoes?: string; whatToTest?: string } | null {
  if (!report) return null;
  const { whatThisDoes, whatToTest } = report;
  const parts = {
    ...(whatThisDoes.trim() && { whatThisDoes: formatLabelled('What this does', splitLead(whatThisDoes, 2, 400).lead) }),
    ...(whatToTest.steps.length > 0 && { whatToTest: `<details>\n<summary>What to test</summary>\n\n${formatTestGuide(whatToTest)}\n\n</details>` }),
  };
  return parts.whatThisDoes || parts.whatToTest ? parts : null;
}

/** How often `sanitizeMarkdown` strips before it gives up and encodes what could still form markup. Model text needs two or three rounds. */
const MAX_STRIP_ROUNDS = 20;

/** Removes each HTML comment, comment mark, known HTML tag and link from `text` once, keeping the text of a link. */
function stripMarkup(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<!--|-->/g, '')
    .replace(HTML_TAG_REGEX, '')
    .replace(HTML_UNCLOSED_TAG_REGEX, '')  // Unclosed tags at end of string
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                       // Images: keep alt text only
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                        // Links: keep text only
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')                       // Reference images
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')                        // Reference links
    .replace(/^\[[^\]]*\]:\s+.*$/gm, '');                            // Link/image definitions
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
  // A removal can join two halves into a comment mark, a tag or a link, so every removal runs again until none changes the text.
  let rounds = 0;
  for (let next = stripMarkup(result); next !== result; next = stripMarkup(result)) {
    result = next;
    if (++rounds === MAX_STRIP_ROUNDS) {
      result = result.replace(/[<>[\]]/g, c => `&#${c.charCodeAt(0)};`);
      break;
    }
  }

  return fenceOwnCode(result
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

// An inline finding shows about 700 characters at most, this budget plus line breaks and a truncation mark. It shows a
// first sentence of up to `MAX_WHOLE_FIRST_SENTENCE` whole even past that. The rest of its description is collapsed.
const MAX_VISIBLE_COMMENT = 650;
const MIN_VISIBLE_DESCRIPTION = 150;

const MAX_WHOLE_FIRST_SENTENCE = 300;

/** Returns the length of `text` without collapsed `<details>` blocks, HTML comments and link targets, which a reader does not see. */
function visibleLength(text: string): number {
  return text.replace(/<details>[\s\S]*?<\/details>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\]\(https?:[^\s)]*\)/g, ']').length;
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
function formatFindingHeader(finding: Finding, noThread = false): string {
  const name = SEVERITY_NAME[finding.severity];
  const severity = `${name[0].toUpperCase()}${name.slice(1)}`;
  // A reply clears neither a guarded warning nor a warning with no thread to reply in. Any other holding warning
  // carries a plain label, since the review's first line says how to clear it.
  const tail = isBlockingFinding(finding) ? ''
    : !holdsApproval(finding) ? ', not blocking'
    : noThread || isGuardedFinding(finding.tags, finding.reviewers) ? ', needs a fix' : '';
  const label = `**${severity}${tail}**`;
  // `matchTitleLine` reads `):` on the first line as the end of the tool name in the one-line layout, so the name holds none.
  const tool = finding.toolSource ? ` (${sanitizeMarkdown(finding.toolSource).replace(/\):+/g, ')')})` : '';
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
  // A posted disproved finding is a blocker, a security finding, one a second check confirmed, one `isDisprovedBlocker` names or one that `gradedByRule`, since a disproof drops any other.
  disproved: { label: 'Doubt found', text: 'Manki found a reason this may not happen. That doubt alone does not remove the finding, so please check it yourself.' },
};
const DISPROVED_TEXT = 'Manki found a reason this may not happen, so this does not block. Please check it yourself.';
const DISPROVED_PAIR_TEXT = 'Manki found a reason this may not happen, and a second check on another model agreed, so this does not block. Please check it yourself.';
const OVERRULED_DISPROOF_TEXT = 'This check disagrees about the damage or the defect. The finding stays because Manki confirmed that it breaks a rule of this repository.';
const PAIR_REFUTATION_LABEL = 'Second check, on another model';

/** Opens the fold under a finding comment, so reading the comment back stops its description there. */
const CHECKS_MARKER = '<!-- manki-checks -->';

const REFUTATION_SUMMARY: Record<RefutationOutcome, string> = { confirmed: 'double-checked', unsettled: 'not settled', disproved: 'doubt found' };

/** Shortens model text to one plain line, so no raw tool output or code block reaches the comment. */
function oneLine(text: string): string {
  // A fence becomes a space, never nothing, so dropping it cannot join the two halves of a tag.
  const line = balanceCodeSpans(sanitizeMarkdown(text).replace(/```/g, ' ').replace(/\s+/g, ' ').trim());
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
 * Each configured related repo of the round by its `owner/name`, and each package it read by its `<registry>/<name>@<version>`:
 * whether the round fetched it, and for a repo the commit it fetched when the round recorded a valid one.
 */
type RelatedCommits = ReadonlyMap<string, { fetched: boolean; commit?: string; package?: true }>;

/** Returns each related repo of `repos` with whether the round fetched it, and its commit, and each package of `packages` with whether the round read it. */
export function relatedCommits(repos: readonly RoundRelatedRepo[] = [], packages: readonly RoundDependencySource[] = []): RelatedCommits {
  return new Map([
    ...repos.map(({ repo, status, commit }): [string, { fetched: boolean; commit?: string }] => {
      const fetched = status === 'fetched';
      return [repo, { fetched, ...(fetched && commit && /^[0-9a-f]{40,64}$/.test(commit) && { commit }) }];
    }),
    // A package's lines show as locations, since no host keeps its published files at a line link.
    ...packages.map(({ package: name, status }): [string, { fetched: boolean; package: true }] => [name, { fetched: status === 'fetched', package: true }]),
  ]);
}

/**
 * Returns each line of a related repo in `proof`, the `relatedProof` of a check or of a finding's evidence, as a link to that line at
 * the commit the round fetched, or as its location alone when `related` has no commit for the repo. A line of a repo
 * the round did not fetch is left out, and so is one whose path has a `.` or `..` segment, a line 0 or a range that
 * runs backwards. Lines an `earlier` round checked were read at a commit this round does not know. So each shows as its
 * location alone, never as a link, for any repo `related` holds. Only the location is shown, never the line's text.
 */
function relatedLineLinks(proof: readonly string[] = [], related: RelatedCommits, earlier = false): string[] {
  return proof.flatMap((location) => {
    const repo = [...related.keys()].find(name => location.startsWith(`${name}:`));
    const [, path, start, end] = (repo && /^([^:]+):(\d+)(?:-(\d+))?$/.exec(location.slice(repo.length + 1))) || [];
    const [first, last] = [Number(start), Number(end ?? start)];
    if (!repo || !path || hasDotSegment(path) || !holdsLines(Infinity, first, last)) return [];
    const { fetched, commit } = related.get(repo)!;
    if (earlier) return [inlineCode(location)];
    if (!fetched) return [];
    const [owner, name] = repo.split('/');
    return [linked(inlineCode(location), commit && buildLineLink(owner, name, commit, RELATED_REPO_HOST)(path, first, last))];
  });
}

/**
 * Links a finding's code to the reviewed commit. `files` holds the lines of the files read there, which keep a preview
 * inside its file. With `changed`, the PR's changed files, they give a cited file name its directories. `related`
 * holds the related repos whose lines a check may show. `linkAt` links lines of another commit of the repository,
 * such as the PR's base.
 */
interface CodeLinks { linkTo: LineLink; linkAt?: (commit: string) => LineLink; baseBranch?: string; files: ReadonlyMap<string, readonly string[]>; changed?: readonly string[]; related: RelatedCommits; rules?: RulesMode }

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
  const path = resolved && LINKABLE_PATH_RE.test(resolved) && !hasDotSegment(resolved) ? resolved : undefined;
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
  return linked(inlineCode(rangeLabel(range)), linkTo(range.file, range.start, range.end));
}

/**
 * Returns `ranges` as an inline list that names each file once. A file with one range keeps the `file:line` link, and a
 * file with several gets its line numbers linked one by one after the file name.
 */
function linkedRanges(ranges: readonly CodeRange[], linkTo: LineLink): string {
  const byFile = new Map<string, CodeRange[]>();
  for (const range of ranges) byFile.set(range.file, [...(byFile.get(range.file) ?? []), range]);
  return joinCounts([...byFile.values()].map(inFile => {
    if (inFile.length === 1) return linkedRange(inFile[0], linkTo);
    const lines = inFile.map(({ file, start, end }) => linked(`${start}${end > start ? `-${end}` : ''}`, linkTo(file, start, end)));
    return `${inlineCode(inFile[0].file)} lines ${joinCounts(lines)}`;
  }));
}

/**
 * Returns the part for one refuter's `check`, with the lines it cites. The lines of a confirming check that became
 * proof of the finding, in `evidence`, show under "Checked in the code" and not here.
 */
function refutationPart(label: string, lead: string, check: Pick<Refutation, 'outcome' | 'defect' | 'reason' | 'proof' | 'relatedProof'>, evidence: Finding['evidence'], { linkTo, related }: CodeLinks, known: readonly string[]): FoldPart {
  const { reason, proof, relatedProof } = check;
  const confirmed = outcomeOf(check) === 'confirmed';
  const unlisted = (lines: readonly string[] = [], proven: readonly string[] = []): string[] => lines.filter(line => !(confirmed && proven.includes(line)));
  // The refuter keeps only proof locations that exist in the workspace, so a bare file name there is a root file.
  const cited = [
    linkedRanges(unlisted(proof, evidence?.proof).flatMap(p => parseCheck(p, known, true)?.at ?? []), linkTo),
    ...relatedLineLinks(unlisted(relatedProof, evidence?.relatedProof), related),
  ].filter(Boolean);
  const text = [lead, reason ? oneLine(reason) : '', cited.length ? `See ${cited.join(', ')}.` : '']
    .filter(Boolean).join(' ');
  return { label, text, open: `**${label}:** ${text}` };
}

/** Returns a part for each refuter that checked `finding`. */
function refutationParts(finding: Finding, links: CodeLinks, known: readonly string[]): FoldPart[] {
  const { refutation, pairRefutation } = finding;
  // A check that confirmed premises only did not say the defect exists, so it reads as unsettled on a finding marked
  // `unconfirmed`. One that confirmed the code path reads as confirmed on a finding marked `confirmed`.
  const shown = (check: Refutation): RefutationOutcome =>
    (finding.checkStatus === 'unconfirmed' && outcomeOf(check) === 'confirmed' && !confirmsDefect(check, finding) ? 'unsettled'
      : finding.checkStatus === 'confirmed' && outcomeOf(check) === 'unsettled' && confirmsCodePath(check, finding) ? 'confirmed' : outcomeOf(check));
  const pairLead = pairRefutation && REFUTATION_SUMMARY[shown(pairRefutation)];
  // A blocker its disproofs lowered says so on its first check, and its rule only set how far it went down.
  const keptByRule = !isDisprovedBlocker(finding) && !!overruledDisproof(finding, links.rules);
  // Each check that disproved a finding its rule keeps says why the finding stays.
  const text = (check: Refutation, plain: string): string => (keptByRule && outcomeOf(check) === 'disproved' ? OVERRULED_DISPROOF_TEXT : plain);
  const pairAgreed = !!pairRefutation?.model && !!refutation?.model && pairRefutation.model !== refutation.model && outcomeOf(pairRefutation) === 'disproved';
  const lead = refutation && (isDisprovedBlocker(finding) ? (pairAgreed ? DISPROVED_PAIR_TEXT : DISPROVED_TEXT) : text(refutation, REFUTATION_PART[shown(refutation)].text));
  // A lowered blocker whose first check failed says on the second one that it does not block.
  const pairText = pairLead && (!refutation && isDisprovedBlocker(finding) ? DISPROVED_TEXT : `${pairLead[0].toUpperCase()}${pairLead.slice(1)}.`);
  return [
    ...(refutation && lead ? [refutationPart(REFUTATION_PART[shown(refutation)].label, lead, refutation, finding.evidence, links, known)] : []),
    ...(pairRefutation && pairText ? [refutationPart(PAIR_REFUTATION_LABEL, text(pairRefutation, pairText), pairRefutation, finding.evidence, links, known)] : []),
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
 * Returns the part that names the rule a confirmed rule finding breaks, and says when that rule is why the finding
 * blocks: the rule raised it to a blocker, and its damage alone would not have. The damage alone blocks only when the
 * finding's `pendingGrade`, or its cell when it has none, is a blocker and the checks confirmed the finding, by
 * `agreedOutcome`, which is what gives a held or capped blocker back. A finding with a `consequence` premise needs
 * every check to `confirmsAll` for that. The file name and the quote are repository text, so each shows as a code span
 * or not at all.
 */
function rulePart(finding: Finding): FoldPart | undefined {
  if (!breaksRule(finding) || !finding.rule) return undefined;
  const quote = codeLine(finding.rule.quote);
  const raised = !!finding.gradePath?.some(step => step.by === 'rule' && step.to === 'blocker');
  // A finding without a cell the table knows is read as one whose damage can block.
  const damageCanBlock = !isGradeCell(finding.cell) || (pendingGrade(finding) ?? cellGrade(finding.cell.row, finding.cell.column)) === 'blocker';
  const checks = [finding.refutation, finding.pairRefutation].filter((check): check is Refutation => !!check);
  const confirmed = finding.doubts?.some(d => d.consequence) ? confirmsAll(checks) : agreedOutcome(checks) === 'confirmed';
  const blocks = finding.severity === 'blocker' && raised && !(damageCanBlock && confirmed);
  const text = `This PR breaks a required rule of ${codeLine(finding.rule.file) || 'an instruction file'}${quote ? `: ${quote}` : '.'}`
    + (blocks ? ' It blocks because this repository sets `review.rules: block`.' : '');
  return { label: 'Repository rule', text, open: `**Repository rule:** ${text}` };
}

/** Returns the repository paths a finding's cited file names resolve against: the changed files, the files read and its own. */
function knownFiles(finding: Finding, { files, changed = [] }: CodeLinks): string[] {
  return [...changed, ...files.keys(), ...(finding.file ? [finding.file] : [])];
}

/**
 * Returns the plain repository paths, other than its own file, that `finding` links in its "Checked in the code"
 * section. A later round counts a push to one of them as a push to the thread.
 */
function evidenceFiles(finding: Finding, links: CodeLinks): string[] {
  return plainCitedFiles(findingChecks(finding, knownFiles(finding, links)).flatMap(c => c.at ? [c.at.file] : []), finding.file);
}

/**
 * Returns how `finding` was checked: the rule it breaks, the check on its own line, a code preview with a sentence for up to
 * `MAX_CHECK_PREVIEWS` other places and the rest as links, then each refuter's outcome and the base lines its
 * `baseNote` leaves out. A finding that cites nothing
 * says so, unless a tool reported it or it is an earlier round's finding.
 */
function checksSection(finding: Finding, links: CodeLinks, ownLine: string): FindingChecks {
  const { linkTo, files, related } = links;
  const known = knownFiles(finding, links);
  const checks = findingChecks(finding, known);
  const refutations = refutationParts(finding, links, known);
  // A finding proven from a related repo rests on lines the PR's own files do not hold, so they are listed too. The
  // evidence of a blocker listed again is an earlier round's, and so is the commit its related lines were read at.
  // An earlier round's evidence can cite a package this round did not read. A package's key ends in `@<version>`, which
  // no repo's `owner/name` does, so such a line still shows as a location.
  const earlierPackages = finding.relisted ? (finding.evidence?.relatedProof ?? []).flatMap((location): Array<[string, { fetched: boolean; package: true }]> => {
    const key = location.slice(0, Math.max(location.indexOf(':'), 0));
    return /@[^/@]+$/.test(key) && !related.has(key) ? [[key, { fetched: false, package: true }]] : [];
  }) : [];
  const readable: RelatedCommits = earlierPackages.length > 0 ? new Map([...related, ...earlierPackages]) : related;
  const ofPackage = (location: string) => [...readable].some(([name, { package: isPackage }]) => isPackage && location.startsWith(`${name}:`));
  const repoLines = relatedLineLinks(finding.evidence?.relatedProof?.filter(l => !ofPackage(l)), readable, finding.relisted);
  const packageLines = relatedLineLinks(finding.evidence?.relatedProof?.filter(ofPackage), readable, finding.relisted);
  const relatedLines = [...repoLines, ...packageLines];
  const status = finding.checkStatus && { status: CHECK_STATUSES[finding.checkStatus] };
  const rule = rulePart(finding);
  const otherBase = otherBaseLinesPart(finding, links);
  if (checks.length === 0 && refutations.length === 0 && !rule && relatedLines.length === 0) {
    return { ...(finding.toolSource || finding.reviewers.length === 0 || finding.reviewers.includes(SCOPE_READER_NAME) ? { parts: otherBase, reads: [], outcomes: [] } : { ...NOT_CHECKED, parts: [...NOT_CHECKED.parts, ...otherBase] }), ...status };
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
      const link = linkTo(range.file, range.start, range.end) ?? inlineCode(rangeLabel(range));
      if (said.length === 0) return link;
      return `${said.length === 1 ? said[0].text : `${said.map(c => `- ${c.text}`).join('\n')}\n`}\n${link}`;
    }),
    ...(listed.length ? [listed.map(listItem).join('\n')] : []),
    ...(repoLines.length ? [`In a related repository${finding.relisted ? ', as an earlier round read it' : ''}: ${repoLines.join(', ')}`] : []),
    ...(packageLines.length ? [`In a dependency's published source${finding.relisted ? ', as an earlier round read it' : ''}: ${packageLines.join(', ')}`] : []),
  ];
  const lone = lines.length === 1 && shown.length === 0 && !lines[0].includes('\n');
  const checked: FoldPart[] = lines.length === 0 ? [] : [{
    label: 'Checked in the code',
    text: lines.join('\n\n'),
    ...(lone && { open: lines[0].startsWith('- ') ? `**Checked:** ${lines[0].slice(2)}` : lines[0] }),
  }];
  const read = checks.filter(c => c.at).length;
  const other = checks.length - read;
  const places = read + relatedLines.length;
  return {
    parts: [...(rule ? [rule] : []), ...checked, ...refutations, ...otherBase],
    reads: [places && `${places} ${places === 1 ? 'place' : 'places'} read`, other && plural(other, 'other check')].filter(r => typeof r === 'string'),
    outcomes: [
      rule && 'breaks a repository rule', finding.refutation && REFUTATION_SUMMARY[outcomeOf(finding.refutation)], finding.pairRefutation && `second check: ${REFUTATION_SUMMARY[outcomeOf(finding.pairRefutation)]}`,
      (isPreExisting(finding) || isSecurityFinding(finding.tags, finding.reviewers)) && sameOnBase(finding) && 'same before this PR',
    ].filter(o => typeof o === 'string'),
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
  // The `%` is encoded too, so the id reads back as the file name.
  const file = encodeCommentBreakers(finding.file.replace(/%/g, '%25'));
  const hash = createHash('sha256').update(`${finding.title}\n${finding.description}`).digest('hex').slice(0, 12);
  return issueBox(`${file}:${finding.line}:${hash}`);
}

/**
 * Returns the line that opens a thread posted on another file than its finding's, saying where the problem is. It is always
 * written with `detached` in the finding data, which is how `parseFindingFromComment` knows the line is there.
 */
function detachedNote(finding: Finding, linkTo: LineLink): string {
  const file = sanitizeFilePath(encodeCommentBreakers(finding.file));
  const where = file
    ? `This is in ${linked(`\`${file}${finding.line > 0 ? `:${finding.line}` : ''}\``, linkTo(finding.file, finding.line))}, not in the file this thread is on.`
    : 'This is not tied to a file or line.';
  return `${where} Comments are only possible on changed files, so the thread is posted here.`;
}

/**
 * Returns the line that opens a thread off the line of `finding` on its file: a link to the line the finding names, or
 * that the finding concerns the whole file. It is always written with `lineNote` in the finding data, which is how
 * `parseFindingFromComment` knows the line is there.
 */
function lineNote(finding: Finding, linkTo: LineLink): string {
  if (finding.line <= 0) return 'This concerns the whole file, not one line of it.';
  return `This is on ${linked(`line ${finding.line}`, linkTo(finding.file, finding.line))}. A comment on that line is not possible, so the thread is elsewhere in the file.`;
}

/**
 * Formats a finding's thread comment. `place` says where the thread sits: on the finding's line, on its file as a
 * file-level thread, or `detached` on another file than the finding's.
 */
function formatFindingComment(finding: Finding, links: CodeLinks, place: 'line' | 'file' | 'detached' = 'line'): string {
  const detached = place === 'detached';
  const onLine = place === 'file' ? `${lineNote(finding, links.linkTo)}\n\n` : '';
  let comment = `${SEVERITY_EMOJI[finding.severity]} ${formatFindingHeader(finding)}\n\n**${sanitizeMarkdown(finding.title)}**\n\n${onLine}`;
  if (detached) comment += `${detachedNote(finding, links.linkTo)}\n\n`;
  for (const note of [trustNote(finding), trackedNote(finding), baseNote(finding, links)]) {
    if (note) comment += `${note}\n\n`;
  }
  if (finding.origin === 'reviewed' && holdsApproval(finding)) comment += `${missedEarlierNoteFor(finding)}\n\n`;
  // A committable suggestion stays open, so GitHub offers to commit it. Any other code fix goes in the fold. Committing
  // writes the block over the commented line, so only a thread on the finding's line gets one.
  const fixParts = finding.suggestedFix?.trim() ? splitFix(finding.suggestedFix, finding.file) : [];
  const suggestion = place === 'line' ? suggestionBlock(fixParts) : undefined;
  const fix = fixPart(finding, suggestion || fixParts.length === 0 ? undefined : renderFixParts(fixParts, finding.file));
  const checks = checksSection(finding, links, place === 'line' ? 'commented' : 'flagged');
  const label = labelDescription(finding, '');
  const open = `${suggestion ? `\n\n${suggestion}` : ''}\n\n${formatFold(fix, '', checks)}`;
  // The line note takes no room, so a thread shows the same description with it as without it.
  const room = Math.max(MIN_VISIBLE_DESCRIPTION, MAX_VISIBLE_COMMENT - (visibleLength(comment) - visibleLength(onLine)) - label.length - visibleLength(open));
  const description = sanitizeMarkdown(finding.description);
  // A scope warning's list is what it proposes, so no length budget folds it.
  const { lead, rest } = splitLead(description, 3, finding.reviewers.includes(SCOPE_READER_NAME) ? Infinity : room, MAX_WHOLE_FIRST_SENTENCE);
  // A fold never holds a single sentence, so one sentence past the lead shows with it, unless the lead was cut short.
  const folds = rest.includes('\n') || rest.split(/(?<=[.!?])\s+/).length > 1 || !description.trim().startsWith(lead);
  const shown = folds ? lead : description.trim();
  comment += `${shown ? labelDescription(finding, shown) : ''}${suggestion ? `\n\n${suggestion}` : ''}`;
  const fold = formatFold(fix, folds ? rest : '', checks);
  if (fold) comment += `\n\n${fold}`;
  comment += `\n\n${issueBoxFor(finding)}`;
  // Manki's resolve after a dismiss clears only a thread that neither blocks nor holds the approval.
  if (finding.severity === 'note' && !isSecurityFinding(finding.tags, finding.reviewers)) comment += `\n${messageBox('dismiss')}`;

  const cited = evidenceFiles(finding, links);
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
    ...(detached && { detached: true }),
    ...(onLine && { lineNote: true }),
    ...(cited.length > 0 && { evidenceFiles: cited }),
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
 * Skips binary files, files exceeding the size limit and symlinks, whose target is never read.
 * If total content exceeds the budget, includes the files in `first` in their order, then the largest of the rest, as many as fit.
 * Adds each file that is not at `ref` to `notFound`, so a caller can tell a file that is gone from one it failed to read.
 */
export async function fetchFileContents(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  files: string[],
  maxFileSize: number = DEFAULT_MAX_FILE_SIZE,
  maxTotalSize: number = DEFAULT_MAX_TOTAL_SIZE,
  first: readonly string[] = [],
  notFound?: Set<string>,
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

      const bytes = ownContent(data);
      if (!bytes) {
        core.debug(`Skipping ${path}: a symlink, whose target is never read`);
        return null;
      }
      const content = bytes.toString('utf-8');

      // Skip binary files (content with null bytes)
      if (content.includes('\0')) {
        core.debug(`Skipping ${path}: binary file`);
        return null;
      }

      return { path, content };
    } catch (error) {
      if ((error as { status?: number }).status === 404) notFound?.add(path);
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

  const kept = new Set<string>();
  let totalSize = 0;

  const byPath = new Map(results.map(r => [r.path, r]));
  const leading = [...new Set(first)].flatMap(p => byPath.get(p) ?? []);
  for (const { path, content } of [...leading, ...results.filter(r => !leading.includes(r))]) {
    if (totalSize + content.length > maxTotalSize) {
      core.debug(`Skipping ${path}: would exceed total size budget (${totalSize}/${maxTotalSize})`);
      continue;
    }
    kept.add(path);
    totalSize += content.length;
  }
  // The map keeps the largest-first order, so a round where every file fits reads them as before.
  const fileContents = new Map(results.filter(r => kept.has(r.path)).map(r => [r.path, r.content]));

  core.info(`Fetched ${fileContents.size}/${files.length} file contents (${totalSize} bytes)`);
  return fileContents;
}

/** The largest file the contents API returns with its content. */
export const MAX_CONTENT_API_BYTES = 1024 * 1024;

/** Returns the lines of each of `files` at `ref`, leaving out any file that can't be read. */
async function fetchFileLines(octokit: Octokit, owner: string, repo: string, ref: string, files: string[], notFound?: Set<string>): Promise<Map<string, string[]>> {
  if (files.length === 0) return new Map();
  const contents = await fetchFileContents(octokit, owner, repo, ref, files, MAX_CONTENT_API_BYTES, Infinity, [], notFound);
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
  /** The commit `reviewedCommit` returns for the review. */
  commitId?: string;
  htmlUrl: string;
  body: string;
};

/**
  * Shared scanner: returns all non-DISMISSED reviews by `bot` on the
  * PR in API order (oldest first), or every one with `includeDismissed`. Callers
  * filter to the commit SHA they care about. An auto-approval counts like a round review, on the commit its approval
  * record names.
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
        !!r.body && (r.body.includes(BOT_MARKER) || isAutoApproval(r.body)),
      )
      .map((r: unknown) => {
        const raw = r as { id: number; state: string; html_url?: string; body?: string | null };
        return {
          id: raw.id,
          state: raw.state,
          commitId: reviewedCommit(raw),
          htmlUrl: raw.html_url ?? '',
          body: raw.body ?? '',
        };
      });
  } catch {
    return [];
  }
}

/**
 * Whether a Manki review gave a verdict on its commit. An incomplete round and a round in which no model read a file
 * gave none, so neither stands as the review of that commit.
 */
function givesVerdict(review: { state?: string; body?: string | null }): boolean {
  const body = review.body ?? '';
  return !hasOwnMarker(body, NO_VERDICT_MARKER) && !(review.state === 'COMMENTED' && body.startsWith(REVIEW_INCOMPLETE_LINE));
}

/**
 * State-based head-SHA dedupe gate. Returns the most-recent review by `bot` that `reviewedCommit` places on `commitSha`
 * when it gave a verdict, otherwise `undefined`. Only a review that `standingOnCommit` keeps counts. A
 * newest review without a verdict does not count, so a later run reviews the commit
 * again, also when an earlier review of the commit is complete.
 * Run entry points consult this before any LLM call so serialized
 * sibling events (e.g., the `pull_request_review` + `pull_request_review_comment`
 * fan-out from a single human review) cannot post duplicate reviews on the
 * same commit.
 */
async function findBotReviewOnCommit(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string,
): Promise<BotReviewSummary | undefined> {
  const onCommit = (await fetchBotReviews(octokit, bot, owner, repo, prNumber, true)).filter(r => r.commitId === commitSha);
  const newest = (await standingOnCommit(octokit, bot, owner, repo, prNumber, onCommit)).at(-1);
  return newest && givesVerdict(newest) ? newest : undefined;
}

async function hasBotReviewOnCommit(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string,
): Promise<boolean> {
  return (await findBotReviewOnCommit(octokit, bot, owner, repo, prNumber, commitSha)) !== undefined;
}

/** Whether anyone edited the review or comment with the GraphQL node id `nodeId`. A query that fails counts as an edit. */
export async function wasEdited(octokit: Octokit, nodeId: string): Promise<boolean> {
  try {
    const { node } = await octokit.graphql<{ node: { lastEditedAt?: string | null } | null }>(
      'query($id: ID!) { node(id: $id) { ... on Comment { lastEditedAt } } }',
      { id: nodeId },
    );
    return node?.lastEditedAt !== null;
  } catch (error) {
    core.warning(`Could not read whether ${nodeId} was edited, so it counts as edited: ${error instanceof Error ? error.message : error}`);
    return true;
  }
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

/** The verdict of a posted review, by its state on GitHub. A comment and a dismissed review have none. */
const REVIEW_STATE_VERDICTS: Partial<Record<string, StandingVerdict['verdict']>> = { APPROVED: 'APPROVE', CHANGES_REQUESTED: 'REQUEST_CHANGES' };

/**
 * Returns the verdict of the latest bot review and the commit it reviewed. An
 * approval that a push dismissed still counts as APPROVE. Returns `undefined`
 * for a comment, a dismissal by hand, a review that names no commit, or when the reviews cannot be read.
 */
async function fetchStandingVerdict(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number,
): Promise<StandingVerdict | undefined> {
  const latest = (await fetchBotReviews(octokit, bot, owner, repo, prNumber, true)).at(-1);
  const commitSha = latest?.commitId;
  if (!latest || !commitSha) return undefined;
  const verdict = REVIEW_STATE_VERDICTS[latest.state];
  if (verdict) return { verdict, commitSha };
  if (latest.state !== 'DISMISSED') return undefined;
  try {
    const dismissed = (await fetchReviewDismissals(octokit, owner, repo, prNumber)).find(d => d.reviewId === latest.id);
    if (dismissed?.state === 'approved' && dismissed.dismissalCommitId) {
      return { verdict: 'APPROVE', commitSha };
    }
  } catch (error) {
    core.warning(`Failed to read review dismissals: ${error instanceof Error ? error.message : error}`);
  }
  return undefined;
}

type ReviewDismissal = {
  reviewId: number;
  /** The review's state before the dismissal, such as `approved` or `changes_requested`. */
  state: string;
  /** The commit whose push dismissed the review, set only for a dismissal by a push. */
  dismissalCommitId?: string | null;
  actor?: { login?: string; type?: string } | null;
};

/**
 * Returns every review dismissal on the PR's timeline. The reviews API reports only `DISMISSED`, while the timeline keeps
 * who dismissed a review, its state before, and for a push the commit that caused it. Throws when the timeline cannot be read.
 */
async function fetchReviewDismissals(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<ReviewDismissal[]> {
  const events = await octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  return events.flatMap(e => 'dismissed_review' in e && e.dismissed_review ? [{
    reviewId: e.dismissed_review.review_id,
    state: e.dismissed_review.state,
    dismissalCommitId: e.dismissed_review.dismissal_commit_id,
    actor: 'actor' in e ? e.actor : undefined,
  }] : []);
}

/**
 * Returns the reviews of `onCommit`, Manki's reviews of one commit oldest first, that stand on it. The newest review with
 * a verdict decides. When a person dismissed it, a request for changes still stands, since the dismissal only sets its
 * block aside, while an approval leaves nothing standing on the commit. When the timeline proves that Manki, a push or
 * another app dismissed it, every review not dismissed stands. A dismissal the timeline does not show leaves nothing standing.
 */
async function standingOnCommit<T extends { id: number; state?: string; body?: string | null }>(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, onCommit: T[],
): Promise<T[]> {
  const kept = onCommit.filter(r => r.state !== 'DISMISSED');
  const newest = onCommit.filter(givesVerdict).at(-1);
  if (newest?.state !== 'DISMISSED') return kept;
  try {
    const set = (await fetchReviewDismissals(octokit, owner, repo, prNumber)).find(d => d.reviewId === newest.id);
    if (!set) {
      core.warning(`The timeline does not say who dismissed Manki's review ${newest.id}, so no review of its commit counts`);
      return [];
    }
    if (set.dismissalCommitId || set.actor && (set.actor.type !== 'User' || isBotLogin(bot, set.actor.login))) return kept;
    // A person dismissed it, or the timeline names nobody.
    return set.actor && set.state === 'changes_requested' ? onCommit.filter(r => r.state !== 'DISMISSED' || r === newest) : [];
  } catch (error) {
    core.warning(`Could not read who dismissed Manki's review, so no review of its commit counts: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

export type { CodeLinks };
export { APPROVED_LINE, CHECKS_MARKER, isAutoApproval, FIX_LABEL, MISSED_EARLIER_NOTE, MISSED_EARLIER_NOTE_RE, MISSED_EARLIER_SECURITY_NOTE, BASE_NOTE_RE, TRACKED_NOTE_RE, TRUST_NOTE_RE, UNCONFIRMED_NOTE, formatFindingBlock, inline, WHAT_GOES_WRONG_LABEL, WHY_LABEL, dynamicFence, fenceText, formatFindingComment, formatSecurityOverrides, formatStatsOneLiner, mapVerdictToEvent, resolveReferences, sanitizeFilePath, sanitizeMarkdown, truncateBody, BOT_LOGIN, BotIdentity, hasWriteAccess, isBotLogin, isBotUser, authorClearRole, BOT_MARKER, REVIEW_COMPLETE_MARKER, REVIEW_INCOMPLETE_LINE, PAUSE_NOTICE_MARKER, AUTO_APPROVE_MARKER, CANCELLED_MARKER, VERSION_MARKER_PREFIX, MANKI_VERSION, isApprovedOnCommit, givesVerdict, hasBotReviewOnCommit, findBotReviewOnCommit, markOwnProgressCommentCancelled, isFailedProgress, extractVersionFromBody, fetchPRComments, GraphqlConnection, paginateGraphql, fetchReviewThreadNodes, standingOnCommit, fetchStandingVerdict, REVIEW_STATE_VERDICTS, latestSettings, retireSettingsBlocks, setSettingsBlock, showSettings, HELD_FOR_PERSON_MARKER };
export type { StandingVerdict };
