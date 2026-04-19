import * as core from '@actions/core';
import * as github from '@actions/github';
import { ClaudeClient } from './claude';
import { titleToSlug } from './github';
import { matchesSuppression, Suppression } from './memory';
import { AuthorReplyClass, Finding, FindingFingerprint, FindingSeverity, InPrSuppression, InPrSuppressionReason, migrateLegacySeverity, SEVERITY_TOKEN_PATTERN } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- manki';

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
  const tokens = tokenize(text.toLowerCase());
  if (AGREE_SIGNALS.some(s => hasSignalWithoutNegation(tokens, s))) return 'agree';
  if (DISAGREE_SIGNALS.some(s => hasSignalWithoutNegation(tokens, s))) return 'disagree';
  if (PARTIAL_SIGNALS.some(s => hasSignalWithoutNegation(tokens, s))) return 'partial';
  return 'none';
}

interface PreviousFinding {
  title: string;
  file: string;
  line: number;
  lineStart?: number;
  severity: FindingSeverity | 'unknown';
  status: 'open' | 'resolved' | 'replied';
  threadId?: string;
  authorReplyText?: string;
}

/**
 * Build suppression entries from the current PR's review threads. Returns one
 * entry per manki-authored thread that is either resolved or whose latest
 * author reply is classified `agree`. Threads without a parseable title
 * (missing severity marker) are skipped.
 */
function collectInPrSuppressions(previousFindings: PreviousFinding[]): InPrSuppression[] {
  const suppressions: InPrSuppression[] = [];
  for (const pf of previousFindings) {
    if (!pf.title || pf.title.length < 3) continue;
    if (!pf.line) continue;
    const reason = inPrSuppressionReasonFor(pf);
    if (!reason) continue;
    const lineStart = pf.lineStart ?? pf.line;
    const lineEnd = pf.line;
    suppressions.push({
      fingerprint: fingerprintFinding(pf.title, pf.file, lineStart, lineEnd),
      reason,
    });
  }
  return suppressions;
}

function inPrSuppressionReasonFor(pf: PreviousFinding): InPrSuppressionReason | undefined {
  if (pf.status === 'resolved') return 'resolved-thread';
  if (classifyAuthorReply(pf.authorReplyText) === 'agree') return 'agree-reply';
  return undefined;
}

interface RecapState {
  previousFindings: PreviousFinding[];
  recapContext: string;
}

/**
 * Fetch previous review state for a PR.
 */
async function fetchRecapState(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<RecapState> {
  const threads = await fetchReviewThreads(octokit, owner, repo, prNumber);

  const previousFindings = threads
    .filter(t => t.isBotThread)
    .map(t => ({
      title: t.findingTitle,
      file: t.file,
      line: t.line,
      lineStart: t.lineStart,
      severity: t.severity,
      status: t.isResolved ? 'resolved' as const : (t.hasHumanReply ? 'replied' as const : 'open' as const),
      threadId: t.threadId,
      authorReplyText: t.authorReplyText,
    }));

  const resolved = previousFindings.filter(
    f => f.status === 'resolved' ||
    (f.status === 'replied' && classifyAuthorReply(f.authorReplyText) === 'agree'),
  );
  const open = previousFindings.filter(f => f.status === 'open');

  let recapContext = '';
  if (previousFindings.length > 0) {
    const parts: string[] = ['## Previous Review State\n'];

    if (resolved.length > 0) {
      parts.push(`### Resolved (${resolved.length} findings -- do NOT re-flag these):`);
      for (const f of resolved) {
        parts.push(`- "${f.title}" at ${f.file}:${f.line}`);
      }
    }

    if (open.length > 0) {
      parts.push(`\n### Still Open (${open.length} findings -- context only, may re-flag if still present):`);
      for (const f of open) {
        parts.push(`- [${f.severity}] "${f.title}" at ${f.file}:${f.line}`);
      }
    }

    parts.push('\nFocus on genuinely new issues in the code changes. Do not re-flag resolved findings.');
    recapContext = parts.join('\n');
  }

  core.info(`Recap: ${resolved.length} resolved, ${open.length} open, ${previousFindings.length} total previous findings`);

  return { previousFindings, recapContext };
}

interface ReviewThread {
  threadId: string;
  isBotThread: boolean;
  isResolved: boolean;
  hasHumanReply: boolean;
  findingTitle: string;
  file: string;
  line: number;
  lineStart: number;
  severity: FindingSeverity | 'unknown';
  authorReplyText?: string;
}

async function fetchReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  // Note: `comments(first: 10)` caps at 10 comments per thread — sufficient for
  // fingerprinting and reply extraction, but longer discussions are truncated.
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              path
              line
              startLine
              comments(first: 10) {
                nodes {
                  body
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const result: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              id: string;
              isResolved: boolean;
              path: string;
              line: number | null;
              startLine: number | null;
              comments: {
                nodes: Array<{
                  body: string;
                  author: { login: string } | null;
                }>;
              };
            }>;
          };
        };
      };
    } = await octokit.graphql(query, { owner, repo, prNumber });

    return result.repository.pullRequest.reviewThreads.nodes.map(thread => {
      const firstComment = thread.comments.nodes[0];
      const isBotThread = firstComment?.body?.includes(BOT_MARKER) ?? false;

      // Use the latest non-bot reply so evolving threads (e.g. initial
      // "Fixed!" followed by a retraction) classify by the author's current
      // stance rather than their first reaction. The `comments(first: 10)`
      // cap above means threads with more than 10 replies can still miss the
      // true last reply.
      const nonBotReplies = thread.comments.nodes.filter((c, i) =>
        i > 0 && c.author?.login !== 'github-actions[bot]'
      );
      const lastNonBotReply = nonBotReplies[nonBotReplies.length - 1];
      const hasHumanReply = lastNonBotReply !== undefined;
      const authorReplyText = lastNonBotReply?.body;

      const severityMatch = firstComment?.body?.match(new RegExp(`manki:(${SEVERITY_TOKEN_PATTERN}):`));
      const severity = (severityMatch?.[1]
        ? migrateLegacySeverity(severityMatch[1])
        : 'unknown') as FindingSeverity | 'unknown';

      const titleMatch = firstComment?.body?.match(/\*\*(?:Blocker|Warning|Suggestion|Nitpick|Ignore)\*\*(?:\s*<sub>\[[^\]]*\]<\/sub>)?\s*:\s*(.+?)(?:\n|$)/);
      const findingTitle = titleMatch?.[1]?.trim() ?? '';

      const line = thread.line ?? 0;
      const lineStart = thread.startLine ?? line;

      return {
        threadId: thread.id,
        isBotThread,
        isResolved: thread.isResolved,
        hasHumanReply,
        findingTitle,
        file: thread.path ?? '',
        line,
        lineStart,
        severity,
        authorReplyText,
      };
    });
  } catch (error) {
    core.warning(`Failed to fetch review threads: ${error}`);
    return [];
  }
}

/**
 * Filter out findings that duplicate previous ones or match stored suppressions.
 * Returns only genuinely new findings.
 */
interface DuplicateMatch {
  finding: Finding;
  matchedTitle: string;
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
  const engaged = previousFindings.filter(f => f.status === 'resolved');

  for (const finding of newFindings) {
    const matched = engaged.find(prev =>
      matchesPrevious(finding, prev)
    );

    if (matched) {
      duplicates.push({ finding, matchedTitle: matched.title });
    } else {
      unique.push(finding);
    }
  }

  return { unique, duplicates };
}

function titlesOverlap(a: string, b: string): boolean {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return true;

  // Substring match (keep for exact matches)
  const shorter = aLower.length <= bLower.length ? aLower : bLower;
  const longer = aLower.length > bLower.length ? aLower : bLower;
  if (shorter.length >= 5 && longer.includes(shorter)) return true;

  // Word overlap — 50% of words in the shorter title must appear in the longer
  return wordOverlapRatio(a, b) >= 0.5;
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

function matchesPrevious(finding: Finding, previous: PreviousFinding): boolean {
  if (!previous.title || previous.title.length < 3) return false;
  if (!finding.title || finding.title.length < 3) return false;

  const titleMatch = titlesOverlap(finding.title, previous.title);

  if (!titleMatch) return false;

  if (finding.file !== previous.file) return false;

  // Relax line proximity when word overlap is strong (>= 70%)
  const maxLineDelta = wordOverlapRatio(finding.title, previous.title) >= 0.7 ? 20 : 5;
  if (Math.abs(finding.line - previous.line) > maxLineDelta) return false;

  return true;
}

async function llmDeduplicateFindings(
  findings: Finding[],
  previousFindings: PreviousFinding[],
  client: ClaudeClient,
): Promise<{ unique: Finding[]; duplicates: DuplicateMatch[] }> {
  const dismissed = previousFindings.filter(f => f.status === 'resolved');
  if (findings.length === 0 || dismissed.length === 0) {
    return { unique: findings, duplicates: [] };
  }

  // Uses the module-level sanitize() function

  const dismissedList = dismissed.map((f, i) =>
    `${i + 1}. "${sanitize(f.title)}" (${sanitize(f.file)}:${f.line})`
  ).join('\n');

  const newList = findings.map((f, i) =>
    `${i + 1}. "${sanitize(f.title)}" (${sanitize(f.file)}:${f.line})`
  ).join('\n');

  try {
    const response = await client.sendMessage(
      'You are deduplicating code review findings. Given a list of new findings and a list of previously dismissed findings, determine which new findings are about the same issue as a dismissed one — even if phrased differently. Respond with ONLY a JSON array of objects: { "index": <1-based new finding index>, "matchedDismissed": <1-based dismissed finding index> }. Only include findings that match. If none match, return [].',
      `## Previously dismissed findings:\n${dismissedList}\n\n## New findings:\n${newList}`,
      { effort: 'low' },
    );

    let jsonText = response.content.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const matches = JSON.parse(jsonText) as Array<{ index: number; matchedDismissed: number }>;
    const matchedIndices = new Set(
      matches
        .filter(m => m.index - 1 >= 0 && m.index - 1 < findings.length
                  && m.matchedDismissed - 1 >= 0 && m.matchedDismissed - 1 < dismissed.length)
        .map(m => m.index - 1),
    );

    const unique: Finding[] = [];
    const duplicates: DuplicateMatch[] = [];
    for (let i = 0; i < findings.length; i++) {
      if (matchedIndices.has(i)) {
        const match = matches.find(m => m.index - 1 === i);
        const dismissedIdx = match ? match.matchedDismissed - 1 : -1;
        const dismissedTitle = dismissedIdx >= 0 && dismissedIdx < dismissed.length ? dismissed[dismissedIdx].title : 'unknown';
        core.info(`LLM dedup: "${findings[i].title}" matches dismissed "${dismissedTitle}"`);
        duplicates.push({ finding: findings[i], matchedTitle: dismissedTitle });
      } else {
        unique.push(findings[i]);
      }
    }

    if (duplicates.length > 0) {
      core.info(`LLM dedup removed ${duplicates.length} findings matching dismissed ones`);
    }

    return { unique, duplicates };
  } catch (error) {
    core.warning(`LLM dedup failed, keeping all findings: ${error}`);
    return { unique: findings, duplicates: [] };
  }
}

export { DuplicateMatch, PreviousFinding, RecapState, classifyAuthorReply, collectInPrSuppressions, fingerprintFinding, fetchRecapState, deduplicateFindings, titlesOverlap, llmDeduplicateFindings };
