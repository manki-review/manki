import * as core from '@actions/core';
import * as github from '@actions/github';
import { LLMClient } from './providers';
import { BotIdentity, fetchReviewThreadNodes, GraphqlConnection, hasWriteAccess, isBotLogin, isRepoAdmin, isTrustedAssociation, LOW_CONFIDENCE_NOTE, paginateGraphql, titleToSlug } from './github';
import { findPriorThreadId } from './finding-fingerprint';
import { matchesSuppression, Suppression } from './memory';
import { isSecurityFinding } from './review';
import { AuthorReplyClass, DuplicateMatchType, Finding, FindingFingerprint, FindingMetadata, FindingSeverity, InPrSuppression, InPrSuppressionReason, ReclassifiedPrior, migrateLegacyPrType, migrateLegacySeverity, OpenThreadsState, RoundContext, SecurityOverride, SEVERITY_TOKEN_PATTERN } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- manki';

/** Shared prefix that identifies a severity title line in a manki comment body. */
const FINDING_TITLE_RE = /\*\*(?:Blocker|Warning|Suggestion|Nitpick|Ignore)\*\*(?:\s*<sub>\[[^\]]*\]<\/sub>)?\s*:\s*/;

/** The hidden finding data in a thread comment. Comments without it use the older `**Severity**: title` layout. */
const FINDING_DATA_RE = /<!-- manki-finding: (.+?) -->/;

function parseFindingData(body: string): { title?: string; fix?: string; tags?: string[]; flaggedBy?: string[] } | undefined {
  const match = body.match(FINDING_DATA_RE);
  if (!match) return undefined;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { title, fix, tags, flaggedBy } = parsed as { title?: unknown; fix?: unknown; tags?: unknown; flaggedBy?: unknown };
    return {
      ...(typeof title === 'string' && { title }),
      ...(typeof fix === 'string' && fix.length > 0 && { fix }),
      ...(isStringArray(tags) && { tags }),
      ...(isStringArray(flaggedBy) && { flaggedBy }),
    };
  } catch {
    return undefined;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/** Whether a Manki thread's first comment holds a security finding, read from its hidden finding data. */
function isSecurityThread(body: string): boolean {
  const data = parseFindingData(body);
  return isSecurityFinding(data?.tags, data?.flaggedBy ?? []);
}

/** Marks Manki's reply on a security thread it reopened after the PR author resolved it. */
const REOPENED_MARKER = '<!-- manki-reopened -->';

/** A reply that opens with a `dismiss` command. */
const DISMISS_COMMAND_RE = /^\s*(?:@manki-review|@manki|\/manki)\s+dismiss\b/i;

const SECURITY_OVERRIDE_MARKER_RE = /<!-- manki-security-override:(resolve|dismiss):([\w-]+) -->/;

/** Marks Manki's reply on a security thread the PR author cleared as a repo admin, with how and by whom. */
function securityOverrideMarker(via: SecurityOverride['via'], login: string): string {
  return `<!-- manki-security-override:${via}:${login} -->`;
}

/** How the PR author cleared a security thread as a repo admin. */
interface ThreadSecurityOverride extends Omit<SecurityOverride, 'thread'> {
  /** Whether Manki has already replied on the thread to record the override. */
  announced: boolean;
}

/** Returns the override recorded in one of Manki's own comments on a thread, if any. */
function recordedSecurityOverride(
  bot: BotIdentity, comments: ReadonlyArray<{ body?: string | null; author: { login: string } | null }>,
): Omit<SecurityOverride, 'thread'> | undefined {
  for (const c of comments) {
    const match = isBotLogin(bot, c.author?.login) ? c.body?.match(SECURITY_OVERRIDE_MARKER_RE) : null;
    if (match) return { via: match[1] as SecurityOverride['via'], login: match[2] };
  }
  return undefined;
}

interface OverrideCandidate {
  isSecurity?: boolean;
  isResolved: boolean;
  resolvedByLogin?: string;
  recordedOverride?: Omit<SecurityOverride, 'thread'>;
}

function isLogin(login: string | undefined, prAuthorLogin: string | undefined): login is string {
  return !!login && !!prAuthorLogin && login.toLowerCase() === prAuthorLogin.toLowerCase();
}

/** Whether a resolved security thread can only be cleared by the PR author as a repo admin, so it needs the admin check. */
function isOverrideCandidate(t: OverrideCandidate, prAuthorLogin: string | undefined): boolean {
  return !!t.isSecurity && t.isResolved && (isLogin(t.resolvedByLogin, prAuthorLogin) || isLogin(t.recordedOverride?.login, prAuthorLogin));
}

/** The security overrides on `previousFindings`, one per thread. */
function securityOverridesIn(previousFindings: PreviousFinding[]): Array<SecurityOverride & { announced: boolean }> {
  return previousFindings.flatMap(f => f.threadId && f.securityOverride ? [{ thread: f.threadId, ...f.securityOverride }] : []);
}

/**
 * Returns how the PR author cleared a resolved security thread as a repo admin: the override Manki recorded on it,
 * or else the author's own resolve. Both need `prAuthorIsAdmin`: a marker alone proves nothing, since a Manki reply can echo text it was given.
 */
function securityOverrideOf(t: OverrideCandidate, prAuthorLogin: string | undefined, prAuthorIsAdmin: boolean): ThreadSecurityOverride | undefined {
  if (!prAuthorIsAdmin || !isOverrideCandidate(t, prAuthorLogin)) return undefined;
  if (t.recordedOverride && isLogin(t.recordedOverride.login, prAuthorLogin)) return { ...t.recordedOverride, announced: true };
  return isLogin(t.resolvedByLogin, prAuthorLogin) ? { login: t.resolvedByLogin, via: 'resolve', announced: false } : undefined;
}

const LLM_DEDUP_TIMEOUT_MS = 120_000;

/**
 * Whether `login` may clear a security thread by resolving it, or by agreeing when they also have write access:
 * a human other than the PR author. Only the PR author and people with write access can resolve a thread,
 * so with the author unknown any human resolver has write access.
 */
function mayClearSecurityThread(login: string | undefined, bot: BotIdentity, prAuthorLogin: string | undefined): boolean {
  if (!login || isBotLogin(bot, login) || login.endsWith('[bot]')) return false;
  return !prAuthorLogin || login.toLowerCase() !== prAuthorLogin.toLowerCase();
}

/** Matches the title line of a thread comment in either layout. */
function matchTitleLine(body: string): RegExpMatchArray | null {
  return body.match(new RegExp(FINDING_TITLE_RE.source + '(.+?)(?:\\n|$)'))
    ?? (FINDING_DATA_RE.test(body) ? body.match(/^\S+ \*\*\w+(?:, not blocking)?(?::\*\*|\*\* \(.*?\):) (.+?)[ \t]*(?:\n|$)/) : null);
}

/** Escape double quotes and strip triple-backtick sequences from untrusted text before LLM interpolation. */
export function sanitize(s: string, maxLength = 200): string {
  const cleaned = s.replace(/[\r\n]/g, ' ').replace(/`/g, '').replace(/"/g, '\\"');
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + '...' : cleaned;
}


/**
 * Build a stable fingerprint for a finding. The slug mirrors the regex used
 * when writing the `<!-- manki:severity:SLUG -->` HTML marker in `github.ts`,
 * so fingerprints round-trip through posted review comments.
 */
function fingerprintFinding(
  title: string,
  file: string,
  lineStart: number,
  lineEnd: number = lineStart,
): FindingFingerprint {
  return {
    file,
    lineStart,
    lineEnd,
    slug: titleToSlug(title),
  };
}

const AGREE_SIGNALS = [
  'fixed', 'done', "you're right", 'good catch', 'addressed',
  'resolved', 'agreed', 'will do', '\u{1F44D}',
];

const DISAGREE_SIGNALS = [
  'disagree', 'intentional', 'keeping', "won't", 'wontfix',
  'by design', 'not a bug', 'unnecessary', 'this is fine', '\u{1F44E}',
];

const PARTIAL_SIGNALS = [
  'partially', 'sort of', 'kind of', 'some of', 'most of',
  'mostly', 'working on', 'follow-up',
];

const NEGATION_WORDS = new Set([
  'not', "don't", "doesn't", "didn't", "won't", "can't", "isn't", "wasn't", 'never',
]);

/**
 * Tokenize text by splitting on whitespace and stripping leading/trailing
 * ASCII punctuation from each token. Emoji and other non-ASCII characters
 * are preserved so emoji signals match correctly.
 */
function tokenize(text: string): string[] {
  return text.split(/\s+/).map(t => t.replace(/^[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]+|[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]+$/g, ''));
}

/**
 * Returns true if the signal (a phrase) appears in `tokens` starting at some
 * index, AND none of the two tokens immediately before that index is a
 * negation word. Multi-word signals are matched as a contiguous token run.
 */
function hasSignalWithoutNegation(tokens: string[], signal: string): boolean {
  const sigTokens = signal.split(/\s+/);
  outer: for (let i = 0; i <= tokens.length - sigTokens.length; i++) {
    for (let j = 0; j < sigTokens.length; j++) {
      if (tokens[i + j] !== sigTokens[j]) continue outer;
    }
    // Found signal at index i — check for preceding negation
    for (let offset = 1; offset <= 2; offset++) {
      const prev = i - offset;
      if (prev >= 0 && NEGATION_WORDS.has(tokens[prev])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Classify an author reply body into a coarse stance.
 * Keyword order matters: agree wins over disagree, which wins over partial.
 * Signals preceded by a negation word within two tokens are skipped.
 */
function classifyAuthorReply(text: string | undefined): AuthorReplyClass {
  if (!text) return 'none';
  if (DISMISS_COMMAND_RE.test(text)) return 'agree';
  const tokens = tokenize(text.toLowerCase());
  if (AGREE_SIGNALS.some(s => hasSignalWithoutNegation(tokens, s))) return 'agree';
  if (DISAGREE_SIGNALS.some(s => hasSignalWithoutNegation(tokens, s))) return 'disagree';
  if (PARTIAL_SIGNALS.some(s => hasSignalWithoutNegation(tokens, s))) return 'partial';
  return 'none';
}

interface PreviousFinding extends FindingMetadata {
  title: string;
  file: string;
  line: number;
  lineStart?: number;
  severity: FindingSeverity | 'unknown';
  /** `auto-resolved`: Manki resolved the thread without the judge marking it `addressed`. It counts as neither dismissed nor open. */
  status: 'open' | 'resolved' | 'replied' | 'auto-resolved';
  /** Resolved because the judge of an earlier round marked the thread `addressed`. */
  fixed?: boolean;
  threadId?: string;
  threadUrl?: string;
  /** Slug from the thread's `<!-- manki:<severity>:<slug> -->` marker. */
  markerSlug?: string;
  /** Line the thread was posted on. Stays set after the thread goes outdated, unlike `line`. */
  originalLine?: number;
  authorReplyText?: string;
  /** Login of the latest non-bot replier on this thread, if any. */
  authorReplyLogin?: string;
  /** `author_association` of the latest non-bot replier. */
  authorReplyAssociation?: string;
  isSecurity?: boolean;
  /** On a security thread, whether the latest replier may agree it away: `mayClearSecurityThread` with write access. */
  authorReplyMayClear?: boolean;
  /** A security thread the PR author resolved, which Manki has not reopened before. */
  reopen?: boolean;
  /** A security thread the PR author cleared as a repo admin. */
  securityOverride?: ThreadSecurityOverride;
}

/**
 * Build suppression entries from the current PR's review threads. Returns one
 * entry per manki-authored thread that is either resolved or whose latest
 * author reply is classified `agree`. Threads without a parseable title
 * (missing severity marker) are skipped.
 *
 * `agree-reply` suppressions only fire when the reply author matches
 * `prAuthorLogin`. This prevents an arbitrary third-party commenter from
 * silently dropping findings by posting "Fixed!" on a manki thread on a
 * public repo. On a security finding they fire only for someone other than
 * the PR author with write access. `resolved-thread` suppressions are
 * unaffected because resolving a thread already requires repository write access.
 */
function collectInPrSuppressions(
  previousFindings: PreviousFinding[],
  prAuthorLogin?: string,
): InPrSuppression[] {
  const suppressions: InPrSuppression[] = [];
  for (const pf of previousFindings) {
    if (!pf.title || pf.title.length < 3) continue;
    if (!pf.line) continue;
    const reason = inPrSuppressionReasonFor(pf, prAuthorLogin);
    if (!reason) continue;
    const lineStart = pf.lineStart ?? pf.line;
    const lineEnd = pf.line;
    const entry: InPrSuppression = {
      fingerprint: fingerprintFinding(pf.title, pf.file, lineStart, lineEnd),
      reason,
    };
    if (reason === 'agree-reply' && pf.authorReplyLogin) {
      entry.authorLogin = pf.authorReplyLogin;
    }
    suppressions.push(entry);
  }
  return suppressions;
}

function inPrSuppressionReasonFor(
  pf: PreviousFinding,
  prAuthorLogin?: string,
): InPrSuppressionReason | undefined {
  if (pf.status === 'resolved') return 'resolved-thread';
  // Only honour agree-replies from the PR author. Without this gate, any
  // third-party commenter on a public repo could suppress lower-severity
  // findings by posting "Fixed!" on a manki thread.
  if (
    (pf.isSecurity || (prAuthorLogin && pf.authorReplyLogin === prAuthorLogin)) &&
    replyClassOf(pf) === 'agree'
  ) return 'agree-reply';
  return undefined;
}

/** Classifies the latest human reply on `pf`. A security finding is agreed away only when `authorReplyMayClear` holds. */
function replyClassOf(pf: PreviousFinding): AuthorReplyClass {
  const replyClass = classifyAuthorReply(pf.authorReplyText);
  return replyClass === 'agree' && pf.isSecurity && !pf.authorReplyMayClear ? 'none' : replyClass;
}

interface RecapState {
  previousFindings: PreviousFinding[];
  priorRounds: RoundContext[];
  /** Three-way state of the open-thread fetch. Optional so legacy callers and test mocks omitting the field still typecheck; treated as `'fetched'` downstream. */
  openThreadsState?: OpenThreadsState;
  /** Count of fingerprints whose `authorReplyClass` flipped during `refreshAuthorReplyClass`. Optional so test mocks omitting the field still typecheck; defaults to 0. */
  reclassifiedPriorCount?: number;
  /** Attribution for the flips. Only includes flips where the prior entry had a `threadId`. */
  reclassifiedPriors?: ReclassifiedPrior[];
}

const CONTEXT_BLOCK_DETAILS_RE = /<details>\s*<summary>Manki context<\/summary>\s*```json\s*([\s\S]*?)```\s*<\/details>/g;
const CONTEXT_BLOCK_HTML_COMMENT_RE = /<!-- manki-context: (.+?) -->/g;
const REQUIRED_ROUND_CONTEXT_KEYS = ['meta', 'config', 'diff', 'models', 'planner', 'reviewers', 'judge', 'dedup', 'memory', 'findings', 'usage', 'verdict'] as const;

/**
 * Parse Manki context blocks from PR-level review bodies. Supports both the
 * `<details>` wrapper (visible aggregate review) and the `<!-- manki-context: ... -->`
 * wrapper (hidden per-round review). Unknown future fields on `RoundContext`
 * are preserved opaquely. Duplicates on `meta.round` are deduped by keeping
 * the entry with the highest review id (latest-posted). Result is sorted
 * ascending by `meta.round`.
 */
function parseContextBlocks(
  reviews: Array<{ body: string; id: number }>,
  owner: string,
  repo: string,
  prNumber: number,
): RoundContext[] {
  const byRound = new Map<number, { ctx: RoundContext; reviewId: number }>();
  const duplicateRounds = new Set<number>();

  for (const review of reviews) {
    const reviewUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}#pullrequestreview-${review.id}`;
    const candidates: string[] = [];

    for (const m of review.body.matchAll(CONTEXT_BLOCK_DETAILS_RE)) {
      candidates.push(m[1]);
    }
    if (candidates.length === 0) {
      for (const m of review.body.matchAll(CONTEXT_BLOCK_HTML_COMMENT_RE)) {
        candidates.push(m[1]);
      }
    }

    for (const raw of candidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        core.warning(`Skipping malformed Manki context block at ${reviewUrl}: ${msg}`);
        continue;
      }

      if (!parsed || typeof parsed !== 'object') {
        core.warning(`Skipping Manki context block at ${reviewUrl}: not an object`);
        continue;
      }
      const meta = (parsed as { meta?: unknown }).meta;
      if (!meta || typeof meta !== 'object') {
        core.warning(`Skipping Manki context block at ${reviewUrl}: missing meta`);
        continue;
      }
      const round = (meta as { round?: unknown }).round;
      const mankiVersion = (meta as { mankiVersion?: unknown }).mankiVersion;
      if (typeof round !== 'number') {
        core.warning(`Skipping Manki context block at ${reviewUrl}: missing or non-numeric meta.round`);
        continue;
      }
      if (typeof mankiVersion !== 'string') {
        core.warning(`Skipping Manki context block at ${reviewUrl}: missing meta.mankiVersion`);
        continue;
      }
      const missingKey = REQUIRED_ROUND_CONTEXT_KEYS.find(k => !(k in (parsed as object)));
      if (missingKey) {
        core.warning(`Skipping Manki context block at ${reviewUrl}: missing required field '${missingKey}'`);
        continue;
      }

      const ctx = parsed as RoundContext;
      if (ctx.planner && typeof ctx.planner.prType === 'string') {
        ctx.planner.prType = migrateLegacyPrType(ctx.planner.prType);
      }
      if (ctx.planner) {
        // Back-compat: pre-5.2.0 context blocks predate the structured planner
        // provenance fields. Project the old `used: boolean` onto the new
        // `source` enum so consumers reading `ctx.planner.source` get a defined
        // value.
        if (typeof ctx.planner.source !== 'string') {
          // `fallbackReason` was not persisted before 5.2.0, so the
          // `heuristic_fallback` branch below is unreachable for old context
          // blocks. Pre-5.2.0 rounds where the planner was attempted but
          // failed will map to `heuristic`. The attempted-but-failed
          // distinction is unrecoverable because the data was never recorded.
          if (ctx.planner.used) {
            ctx.planner.source = 'planner';
          } else if (ctx.planner.fallbackReason) {
            ctx.planner.source = 'heuristic_fallback';
          } else {
            ctx.planner.source = 'heuristic';
          }
          (ctx.planner as { used: boolean }).used = ctx.planner.source === 'planner';
        }
      }
      const existing = byRound.get(round);
      if (existing) {
        duplicateRounds.add(round);
        if (review.id > existing.reviewId) {
          byRound.set(round, { ctx, reviewId: review.id });
        }
      } else {
        byRound.set(round, { ctx, reviewId: review.id });
      }
    }
  }

  for (const round of duplicateRounds) {
    const winner = byRound.get(round);
    core.warning(`Duplicate Manki context blocks for round ${round}, keeping review id ${winner?.reviewId}`);
  }

  return Array.from(byRound.values())
    .map(v => v.ctx)
    .sort((a, b) => a.meta.round - b.meta.round);
}

/**
 * Fetch previous review state for a PR.
 */
async function fetchRecapState(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthorLogin?: string,
): Promise<RecapState> {
  const [threadsResult, priorRounds] = await Promise.all([
    fetchReviewThreads(octokit, bot, owner, repo, prNumber),
    fetchPriorRoundContexts(octokit, bot, owner, repo, prNumber),
  ]);
  const { threads, state: openThreadsState } = threadsResult;
  const addressedThreadIds = judgeAddressedThreadIds(priorRounds);
  const botThreads = threads.filter(t => t.isBotThread);
  const prAuthorIsAdmin = !!prAuthorLogin && botThreads.some(t => isOverrideCandidate(t, prAuthorLogin))
    && await isRepoAdmin(octokit, owner, repo, prAuthorLogin);
  // An org member with read access also shows as `MEMBER`, so a security agreement needs write access checked through the API.
  const agreers = new Set(botThreads.flatMap(t => t.isSecurity && t.authorReplyLogin && mayClearSecurityThread(t.authorReplyLogin, bot, prAuthorLogin)
    && isTrustedAssociation(t.authorReplyAssociation) ? [t.authorReplyLogin] : []));
  const mayAgree = new Map(await Promise.all([...agreers].map(async login => [login, await hasWriteAccess(octokit, owner, repo, login)] as const)));

  const previousFindings = botThreads.map(t => {
    const securityOverride = addressedThreadIds.has(t.threadId) ? undefined : securityOverrideOf(t, prAuthorLogin, prAuthorIsAdmin);
    return {
      title: t.findingTitle,
      file: t.file,
      line: t.line,
      lineStart: t.lineStart,
      severity: t.severity,
      status: threadStatus(t, addressedThreadIds, bot, prAuthorLogin, !!securityOverride),
      ...(t.isResolved && addressedThreadIds.has(t.threadId) && { fixed: true }),
      threadId: t.threadId,
      threadUrl: t.threadUrl,
      ...(t.markerSlug && { markerSlug: t.markerSlug }),
      ...(t.originalLine && { originalLine: t.originalLine }),
      authorReplyText: t.authorReplyText,
      authorReplyLogin: t.authorReplyLogin,
      ...(t.authorReplyAssociation && { authorReplyAssociation: t.authorReplyAssociation }),
      ...(t.isSecurity && { isSecurity: true }),
      ...(t.isSecurity && t.authorReplyLogin && mayAgree.get(t.authorReplyLogin) && { authorReplyMayClear: true }),
      ...(!securityOverride && shouldReopen(t, addressedThreadIds, prAuthorLogin) && { reopen: true }),
      ...(securityOverride && { securityOverride }),
      description: t.description,
      suggestedFix: t.suggestedFix,
    };
  });

  // A replied thread counts as resolved on the same "agree" gate as `inPrSuppressionReasonFor`.
  const resolved = previousFindings.filter(
    f => f.status === 'resolved' || (f.status === 'replied' && inPrSuppressionReasonFor(f, prAuthorLogin) === 'agree-reply'),
  );
  const open = previousFindings.filter(f => f.status === 'open');

  core.info(`Recap: ${resolved.length} resolved, ${open.length} open, ${previousFindings.length} total previous findings`);

  const { rounds: enrichedPriorRounds, reclassifiedPriorCount, reclassifiedPriors } =
    refreshAuthorReplyClass(attachPriorThreadIds(priorRounds, previousFindings), previousFindings);

  return {
    previousFindings,
    priorRounds: enrichedPriorRounds,
    openThreadsState,
    reclassifiedPriorCount,
    reclassifiedPriors,
  };
}

/** IDs of the threads that the judge of any round evaluated as `addressed`. */
function judgeAddressedThreadIds(rounds: RoundContext[]): Set<string> {
  return new Set(
    rounds.flatMap(r => r.judge.threadEvaluations ?? [])
      .filter(e => e.status === 'addressed')
      .map(e => e.threadId),
  );
}

/** Whether the PR author resolved a security thread the judge has not marked `addressed`, and Manki has not reopened it yet. */
function shouldReopen(t: ReviewThread, addressedThreadIds: Set<string>, prAuthorLogin: string | undefined): boolean {
  return t.isSecurity && t.isResolved && t.resolvedByHuman && !t.reopenedByManki && !addressedThreadIds.has(t.threadId)
    && !!prAuthorLogin && t.resolvedByLogin?.toLowerCase() === prAuthorLogin.toLowerCase();
}

/**
 * Returns the thread's status for the next round. A resolved security thread stays `open` or `replied`
 * unless the judge marked it `addressed`, `mayClearSecurityThread` accepts the resolver, or a repo admin overrode it.
 */
function threadStatus(
  t: ReviewThread, addressedThreadIds: Set<string>, bot: BotIdentity, prAuthorLogin: string | undefined, securityOverride: boolean,
): PreviousFinding['status'] {
  const unresolved = t.hasHumanReply ? 'replied' : 'open';
  if (!t.isResolved) return unresolved;
  if (addressedThreadIds.has(t.threadId)) return 'resolved';
  if (t.isSecurity) return securityOverride || mayClearSecurityThread(t.resolvedByLogin, bot, prAuthorLogin) ? 'resolved' : unresolved;
  return t.resolvedByHuman ? 'resolved' : 'auto-resolved';
}

/**
 * Gives each prior-round finding without a `threadId` the ID of the Manki
 * thread posted for it. Round contexts are written before GitHub assigns
 * thread IDs, so the match goes by the thread marker's slug, the file, and the
 * nearest posted line. A prior left without a match was posted in the review
 * body, not as a thread.
 */
function attachPriorThreadIds(rounds: RoundContext[], previousFindings: PreviousFinding[]): RoundContext[] {
  const threads = previousFindings.filter(pf => pf.threadId && pf.markerSlug);
  if (threads.length === 0) return rounds;
  return rounds.map(r => ({
    ...r,
    findings: {
      ...r.findings,
      entries: r.findings.entries.map(entry => {
        if (entry.threadId) return entry;
        const threadId = findPriorThreadId(entry.fingerprint, threads);
        return threadId ? { ...entry, threadId } : entry;
      }),
    },
  }));
}

/** Cap on `reclassifiedPriors[]` to bound context-block size. */
const RECLASSIFIED_PRIORS_CAP = 50;

/**
 * Re-derive `authorReplyClass` on each prior-round fingerprint from the live
 * `previousFindings` thread state. The value cached at emit time is always
 * `'none'` (the round just completed, no reply existed yet) and would otherwise
 * stay frozen across later rounds, breaking cross-round suppression, planner
 * hints, and the prior-unaddressed verdict gate. Matching is by `threadId`
 * when present, then falls back to fingerprint slug + file so older context
 * blocks written before threadId stabilisation still re-classify correctly.
 *
 * Also returns the count and (capped) attribution of every flip so the recap
 * stage can surface re-classification provenance in `RoundContext.recap`.
 * Slug-file fallback flips contribute to the count but cannot be attributed
 * by `threadId`, so they are omitted from the entries list.
 */
function refreshAuthorReplyClass(
  rounds: RoundContext[],
  previousFindings: PreviousFinding[],
): { rounds: RoundContext[]; reclassifiedPriorCount: number; reclassifiedPriors: ReclassifiedPrior[] } {
  if (rounds.length === 0) {
    return { rounds, reclassifiedPriorCount: 0, reclassifiedPriors: [] };
  }
  const byThread = new Map<string, PreviousFinding>();
  const bySlugFile = new Map<string, PreviousFinding>();
  for (const pf of previousFindings) {
    if (pf.threadId) {
      byThread.set(pf.threadId, pf);
    } else {
      bySlugFile.set(`${pf.file}:${titleToSlug(pf.title)}`, pf);
    }
  }
  let reclassifiedPriorCount = 0;
  const reclassifiedPriors: ReclassifiedPrior[] = [];
  const refreshed = rounds.map(r => ({
    ...r,
    findings: {
      ...r.findings,
      entries: r.findings.entries.map(entry => {
        const pf = entry.threadId
          ? byThread.get(entry.threadId)
          : bySlugFile.get(`${entry.fingerprint.file}:${entry.fingerprint.slug}`);
        if (!pf) return entry;
        const next = replyClassOf(pf);
        const prev = entry.authorReplyClass ?? 'none';
        if (next !== prev) {
          reclassifiedPriorCount++;
          if (entry.threadId && reclassifiedPriors.length < RECLASSIFIED_PRIORS_CAP) {
            reclassifiedPriors.push({ threadId: entry.threadId, from: prev, to: next });
          }
        }
        return { ...entry, authorReplyClass: next };
      }),
    },
  }));
  return { rounds: refreshed, reclassifiedPriorCount, reclassifiedPriors };
}

async function fetchPriorRoundContexts(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<RoundContext[]> {
  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const candidates = reviews
      .filter((r): r is typeof r & { body: string; id: number } => {
        const body = r.body;
        if (!body) return false;
        if (!isBotLogin(bot, r.user?.login)) return false;
        return body.includes('<summary>Manki context</summary>') || body.includes('<!-- manki-context:');
      })
      .map(r => ({ body: r.body, id: r.id }));
    return parseContextBlocks(candidates, owner, repo, prNumber);
  } catch (error) {
    core.warning(`Failed to fetch prior round contexts: ${error}`);
    return [];
  }
}

interface ReviewThread extends FindingMetadata {
  threadId: string;
  threadUrl: string;
  markerSlug?: string;
  originalLine?: number;
  isBotThread: boolean;
  isResolved: boolean;
  resolvedByHuman: boolean;
  resolvedByLogin?: string;
  isSecurity: boolean;
  reopenedByManki: boolean;
  recordedOverride?: Omit<SecurityOverride, 'thread'>;
  hasHumanReply: boolean;
  findingTitle: string;
  file: string;
  line: number;
  lineStart: number;
  severity: FindingSeverity | 'unknown';
  authorReplyText?: string;
  authorReplyLogin?: string;
  authorReplyAssociation?: string;
}

/**
 * Parse the prose description and suggested-fix excerpt from a manki-authored
 * thread's first comment body. Returns `undefined` for either field when the
 * comment doesn't match the expected layout. The judge tolerates missing
 * fields. Pure string scan, no markdown parser, intentionally conservative so
 * unexpected layouts skip extraction rather than emit garbage.
 */
function parseFindingFromComment(body: string): FindingMetadata {
  const titleMatch = matchTitleLine(body);
  if (!titleMatch || titleMatch.index === undefined) return {};
  const afterTitle = body.slice(titleMatch.index + titleMatch[0].length);

  let descSlice = afterTitle;
  const stopMarkers = [
    '\n```',
    '\n<details>',
    '\n<!-- manki:',
    '\n<!-- manki-finding:',
  ];
  let earliest = descSlice.length;
  let truncatingStop = false;
  for (const marker of stopMarkers) {
    const idx = descSlice.indexOf(marker);
    if (idx >= 0 && idx < earliest) {
      earliest = idx;
      truncatingStop = marker === '\n```';
    }
  }
  descSlice = descSlice.slice(0, earliest).replace(/^[\s\n]+|[\s\n]+$/g, '');
  if (descSlice.startsWith(LOW_CONFIDENCE_NOTE)) descSlice = descSlice.slice(LOW_CONFIDENCE_NOTE.length).replace(/^\s+/, '');
  const remainingSubs = descSlice.match(/^(?:<sub>[^\n]*<\/sub>\s*\n?)+/);
  if (remainingSubs) descSlice = descSlice.slice(remainingSubs[0].length).replace(/^\s+/, '');
  if (descSlice.length > 500) descSlice = descSlice.slice(0, 500) + '...';
  else if (truncatingStop && descSlice.length > 0) descSlice += '…(truncated)';
  const description: string | undefined = descSlice.length > 0 ? descSlice : undefined;

  let suggestedFix = parseFindingData(body)?.fix;
  const aiContextMatch = body.match(/<summary>AI context<\/summary>[\s\S]*?```json\s*([\s\S]*?)```/);
  if (aiContextMatch) {
    try {
      const parsed: unknown = JSON.parse(aiContextMatch[1]);
      if (parsed && typeof parsed === 'object' && 'fix' in parsed) {
        const fix = (parsed as { fix?: unknown }).fix;
        if (typeof fix === 'string' && fix.length > 0) suggestedFix = fix;
      }
    } catch {
      // Malformed AI context JSON — skip suggestedFix, keep description.
    }
  }
  if (suggestedFix && suggestedFix.length > 300) suggestedFix = suggestedFix.slice(0, 300) + '...';

  return { description, suggestedFix };
}

interface FetchReviewThreadsResult {
  threads: ReviewThread[];
  state: OpenThreadsState;
}

const THREAD_COMMENT_FIELDS = 'body url authorAssociation author { login }';

const THREAD_COMMENTS_QUERY = `
  query($threadId: ID!, $cursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ${THREAD_COMMENT_FIELDS} }
        }
      }
    }
  }
`;

interface ThreadCommentNode {
  body: string;
  url?: string;
  authorAssociation?: string;
  author: { login: string } | null;
}

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  resolvedBy?: { login: string } | null;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine?: number | null;
  comments: GraphqlConnection<ThreadCommentNode>;
}

async function fetchReviewThreads(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<FetchReviewThreadsResult> {
  try {
    // Ten comments per thread keep the query's rate-limit cost low. Longer threads are read in full below.
    const threadNodes = await fetchReviewThreadNodes<ReviewThreadNode>(octokit, owner, repo, prNumber, `
      id
      isResolved
      resolvedBy {
        login
      }
      path
      line
      startLine
      originalLine
      comments(first: 10) {
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_COMMENT_FIELDS} }
      }
    `);
    for (const thread of threadNodes) {
      if (!thread.comments.pageInfo.hasNextPage) continue;
      // A missing later reply can only keep a prior open, never retire it, so the comments read so far are safe to use.
      try {
        thread.comments.nodes.push(...await paginateGraphql(
          octokit, THREAD_COMMENTS_QUERY, { threadId: thread.id },
          (result: { node: { comments: GraphqlConnection<ThreadCommentNode> } }) => result.node.comments,
          thread.comments.pageInfo.endCursor,
        ));
      } catch (error) {
        core.warning(`Failed to fetch the remaining comments of review thread ${thread.id}, using the first ${thread.comments.nodes.length}: ${error}`);
      }
    }

    const threads = threadNodes.map(thread => {
      const firstComment = thread.comments.nodes[0];
      const isBotThread = !!firstComment?.body?.includes(BOT_MARKER) && isBotLogin(bot, firstComment.author?.login);

      // Use the latest non-bot reply so evolving threads (e.g. initial
      // "Fixed!" followed by a retraction) classify by the author's current
      // stance rather than their first reaction.
      const nonBotReplies = thread.comments.nodes.filter((c, i) =>
        i > 0 && !isBotLogin(bot, c.author?.login)
      );
      const lastNonBotReply = nonBotReplies[nonBotReplies.length - 1];
      const hasHumanReply = lastNonBotReply !== undefined;
      const authorReplyText = lastNonBotReply?.body;
      const authorReplyLogin = lastNonBotReply?.author?.login;
      const authorReplyAssociation = lastNonBotReply?.authorAssociation;

      const severityMatch = firstComment?.body?.match(new RegExp(`manki:(${SEVERITY_TOKEN_PATTERN}):`));
      const severity = (severityMatch?.[1]
        ? migrateLegacySeverity(severityMatch[1])
        : 'unknown') as FindingSeverity | 'unknown';

      const markerSlug = firstComment?.body?.match(new RegExp(`<!-- manki:(?:${SEVERITY_TOKEN_PATTERN}):(.+?) -->`))?.[1];

      const body = firstComment?.body ?? '';
      const findingTitle = parseFindingData(body)?.title?.trim() || matchTitleLine(body)?.[1]?.trim() || '';

      const { description, suggestedFix } = isBotThread && firstComment?.body
        ? parseFindingFromComment(firstComment.body)
        : {};

      const line = thread.line ?? 0;
      const lineStart = thread.startLine ?? line;
      const recordedOverride = isBotThread ? recordedSecurityOverride(bot, thread.comments.nodes) : undefined;

      return {
        threadId: thread.id,
        threadUrl: firstComment?.url ?? '',
        isBotThread,
        isResolved: thread.isResolved,
        resolvedByHuman: !!thread.resolvedBy?.login && !isBotLogin(bot, thread.resolvedBy.login),
        ...(thread.resolvedBy?.login && { resolvedByLogin: thread.resolvedBy.login }),
        isSecurity: isBotThread && isSecurityThread(body),
        reopenedByManki: thread.comments.nodes.some(c => isBotLogin(bot, c.author?.login) && c.body?.includes(REOPENED_MARKER)),
        ...(recordedOverride && { recordedOverride }),
        hasHumanReply,
        findingTitle,
        description,
        suggestedFix,
        file: thread.path ?? '',
        line,
        lineStart,
        ...(thread.originalLine && { originalLine: thread.originalLine }),
        ...(markerSlug && { markerSlug }),
        severity,
        authorReplyText,
        authorReplyLogin,
        ...(authorReplyAssociation && { authorReplyAssociation }),
      };
    });
    return { threads, state: threads.length === 0 ? 'empty' : 'fetched' };
  } catch (error) {
    core.warning(`Failed to fetch review threads: ${error}`);
    return { threads: [], state: 'fetch_failed' };
  }
}

/**
 * Filter out findings that duplicate previous ones or match stored suppressions.
 * Returns only genuinely new findings.
 */
interface DuplicateMatch {
  finding: Finding;
  matchedTitle: string;
  /** Which matcher branch fired. `'llm'` only used by `llmDeduplicateFindings`. */
  matchType: DuplicateMatchType;
}

function deduplicateFindings(
  newFindings: Finding[],
  previousFindings: PreviousFinding[],
  suppressions?: Suppression[],
): { unique: Finding[]; duplicates: DuplicateMatch[] } {
  if (suppressions && suppressions.length > 0) {
    newFindings = newFindings.filter(f => {
      const match = suppressions.some(s => matchesSuppression(f, s));
      if (match) core.info(`Suppressed by memory: "${f.title}"`);
      return !match;
    });
  }

  const unique: Finding[] = [];
  const duplicates: DuplicateMatch[] = [];
  const resolved = previousFindings.filter(f => f.status === 'resolved');
  // Waived priors come first, so a finding that matches both a waived and a fixed one is still dropped.
  const engaged = [...resolved.filter(f => !f.fixed), ...resolved.filter(f => f.fixed)];

  for (const finding of newFindings) {
    let matched: { prev: PreviousFinding; matchType: DuplicateMatchType } | undefined;
    for (const prev of engaged) {
      const matchType = matchPreviousType(finding, prev);
      if (matchType) {
        matched = { prev, matchType };
        break;
      }
    }

    if (matched?.prev.fixed) {
      unique.push(resemblingFixed(finding, matched.prev));
    } else if (matched) {
      duplicates.push({ finding, matchedTitle: matched.prev.title, matchType: matched.matchType });
    } else {
      unique.push(finding);
    }
  }

  return { unique, duplicates };
}

/** Returns `finding` with a note for the judge. A finding next to a fixed one can be a new defect, so dedup never drops it. */
function resemblingFixed(finding: Finding, fixed: PreviousFinding): Finding {
  core.info(`Dedup: "${finding.title}" resembles fixed "${fixed.title}", sending it to the judge`);
  return finding.resemblesFixed ? finding : { ...finding, resemblesFixed: { title: fixed.title, file: fixed.file, line: fixed.line } };
}

/**
 * Title-overlap classifier. Returns the branch that fired or `null` when
 * none did. `titlesOverlap` is the boolean wrapper kept for tests and
 * external callers; new code prefers this typed variant.
 */
function titleOverlapType(a: string, b: string): DuplicateMatchType | null {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return 'exact';

  const shorter = aLower.length <= bLower.length ? aLower : bLower;
  const longer = aLower.length > bLower.length ? aLower : bLower;
  if (shorter.length >= 5 && longer.includes(shorter)) return 'substring';

  if (wordOverlapRatio(a, b) >= 0.5) return 'word_overlap';
  return null;
}

function titlesOverlap(a: string, b: string): boolean {
  return titleOverlapType(a, b) !== null;
}

function wordOverlapRatio(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/).map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '')).filter(w => w.length >= 3));
  const bWords = new Set(b.toLowerCase().split(/\s+/).map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '')).filter(w => w.length >= 3));
  if (aWords.size === 0 || bWords.size === 0) return 0;

  let overlap = 0;
  for (const w of aWords) {
    if (bWords.has(w)) overlap++;
  }

  return overlap / Math.min(aWords.size, bWords.size);
}

function matchPreviousType(finding: Finding, previous: PreviousFinding): DuplicateMatchType | null {
  if (!previous.title || previous.title.length < 3) return null;
  if (!finding.title || finding.title.length < 3) return null;

  const matchType = titleOverlapType(finding.title, previous.title);
  if (!matchType) return null;

  if (finding.file !== previous.file) return null;

  // Relax line proximity when word overlap is strong (>= 70%)
  const maxLineDelta = wordOverlapRatio(finding.title, previous.title) >= 0.7 ? 20 : 5;
  if (Math.abs(finding.line - previous.line) > maxLineDelta) return null;

  return matchType;
}

async function llmDeduplicateFindings(
  findings: Finding[],
  previousFindings: PreviousFinding[],
  client: LLMClient,
): Promise<{ unique: Finding[]; duplicates: DuplicateMatch[] }> {
  const resolved = previousFindings.filter(f => f.status === 'resolved');
  if (findings.length === 0 || resolved.length === 0) {
    return { unique: findings, duplicates: [] };
  }

  // Uses the module-level sanitize() function

  const resolvedList = resolved.map((f, i) =>
    `${i + 1}. "${sanitize(f.title)}" (${sanitize(f.file)}:${f.line})`
  ).join('\n');

  const newList = findings.map((f, i) =>
    `${i + 1}. "${sanitize(f.title)}" (${sanitize(f.file)}:${f.line})`
  ).join('\n');

  try {
    const response = await client.sendMessage(
      'You are deduplicating code review findings. Given a list of new findings and a list of earlier resolved findings, determine which new findings are about the same issue as a resolved one, even if phrased differently. Respond with ONLY a JSON array of objects: { "index": <1-based new finding index>, "matchedDismissed": <1-based resolved finding index> }. Only include findings that match. If none match, return [].',
      `## Earlier resolved findings:\n${resolvedList}\n\n## New findings:\n${newList}`,
      { effort: 'low', timeoutMs: LLM_DEDUP_TIMEOUT_MS },
    );

    let jsonText = response.content.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const matches = JSON.parse(jsonText) as Array<{ index: number; matchedDismissed: number }>;
    const unique: Finding[] = [];
    const duplicates: DuplicateMatch[] = [];
    for (let i = 0; i < findings.length; i++) {
      const priors = matches.filter(m => m.index - 1 === i).map(m => resolved[m.matchedDismissed - 1]).filter(p => p !== undefined);
      const waived = priors.find(p => !p.fixed);
      if (waived) {
        core.info(`LLM dedup: "${findings[i].title}" matches earlier resolved "${waived.title}"`);
        duplicates.push({ finding: findings[i], matchedTitle: waived.title ?? 'unknown', matchType: 'llm' });
      } else if (priors.length > 0) {
        unique.push(resemblingFixed(findings[i], priors[0]));
      } else {
        unique.push(findings[i]);
      }
    }

    if (duplicates.length > 0) {
      core.info(`LLM dedup removed ${duplicates.length} findings matching earlier resolved ones`);
    }

    return { unique, duplicates };
  } catch (error) {
    core.warning(`LLM dedup failed, keeping all findings: ${error}`);
    return { unique: findings, duplicates: [] };
  }
}

export function collectResolvedThreadIds(previousFindings?: PreviousFinding[]): Set<string> {
  return new Set(
    (previousFindings ?? [])
      .filter((f): f is PreviousFinding & { threadId: string } =>
        f.status === 'resolved' && f.threadId != null)
      .map(f => f.threadId),
  );
}

export { DuplicateMatch, PreviousFinding, RecapState, OpenThreadsState, classifyAuthorReply, collectInPrSuppressions, fingerprintFinding, fetchPriorRoundContexts, fetchRecapState, isOverrideCandidate, isSecurityThread, mayClearSecurityThread, recordedSecurityOverride, REOPENED_MARKER, securityOverrideMarker, securityOverrideOf, securityOverridesIn, judgeAddressedThreadIds, deduplicateFindings, titlesOverlap, titleOverlapType, refreshAuthorReplyClass, llmDeduplicateFindings, parseFindingFromComment };
