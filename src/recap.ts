import * as core from '@actions/core';
import * as github from '@actions/github';
import { ClaudeClient } from './claude';
import { matchesSuppression, Suppression } from './memory';
import { Finding, FindingSeverity, ParsedDiff } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- manki';

interface PreviousFinding {
  title: string;
  file: string;
  line: number;
  severity: FindingSeverity | 'unknown';
  status: 'open' | 'resolved' | 'replied';
  threadId?: string;
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
      severity: t.severity,
      status: t.isResolved ? 'resolved' as const : (t.hasHumanReply ? 'replied' as const : 'open' as const),
      threadId: t.threadId,
    }));

  const resolved = previousFindings.filter(f => f.status === 'resolved');
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
      parts.push(`\n### Still Open (${open.length} findings -- already flagged, do NOT duplicate):`);
      for (const f of open) {
        parts.push(`- [${f.severity}] "${f.title}" at ${f.file}:${f.line}`);
      }
    }

    parts.push('\nFocus ONLY on genuinely new issues in the code changes. Do not re-flag anything listed above.');
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
  severity: FindingSeverity | 'unknown';
}

async function fetchReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
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

      const hasHumanReply = thread.comments.nodes.some((c, i) =>
        i > 0 && c.author?.login !== 'github-actions[bot]'
      );

      const severityMatch = firstComment?.body?.match(/manki:(required|suggestion|nit|ignore):/);
      const severity = (severityMatch?.[1] ?? 'unknown') as FindingSeverity | 'unknown';

      const titleMatch = firstComment?.body?.match(/\*\*(?:Required|Suggestion|Nit|Ignore)\*\*:\s*(.+?)(?:\n|$)/);
      const findingTitle = titleMatch?.[1]?.trim() ?? '';

      return {
        threadId: thread.id,
        isBotThread,
        isResolved: thread.isResolved,
        hasHumanReply,
        findingTitle,
        file: thread.path ?? '',
        line: thread.line ?? 0,
        severity,
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
function deduplicateFindings(
  newFindings: Finding[],
  previousFindings: PreviousFinding[],
  suppressions?: Suppression[],
): { unique: Finding[]; duplicates: Finding[] } {
  if (suppressions && suppressions.length > 0) {
    newFindings = newFindings.filter(f => {
      const match = suppressions.some(s => matchesSuppression(f, s));
      if (match) core.info(`Suppressed by memory: "${f.title}"`);
      return !match;
    });
  }

  const unique: Finding[] = [];
  const duplicates: Finding[] = [];

  for (const finding of newFindings) {
    const isDuplicate = previousFindings.some(prev =>
      matchesPrevious(finding, prev)
    );

    if (isDuplicate) {
      duplicates.push(finding);
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

/**
 * Build a review summary that includes deduplication stats.
 */
function buildRecapSummary(
  newCount: number,
  duplicateCount: number,
  resolvedCount: number,
  openCount: number,
): string {
  const parts: string[] = [];

  if (newCount > 0) parts.push(`${newCount} new`);
  if (openCount > 0) parts.push(`${openCount} previously flagged`);
  if (resolvedCount > 0) parts.push(`${resolvedCount} resolved`);
  if (duplicateCount > 0) parts.push(`${duplicateCount} skipped (already flagged)`);

  return parts.length > 0 ? `Findings: ${parts.join(', ')}` : 'No findings';
}

/**
 * Auto-resolve review threads whose findings were addressed in the new diff.
 * Candidates are identified by hunk overlap, then validated by Claude to
 * confirm the code change actually addresses the finding.
 */
async function resolveAddressedThreads(
  octokit: Octokit,
  client: ClaudeClient | null,
  owner: string,
  repo: string,
  prNumber: number,
  previousFindings: PreviousFinding[],
  diff: ParsedDiff,
): Promise<number> {
  let resolvedCount = 0;

  const openFindings = previousFindings.filter(f => f.status === 'open' && f.threadId);

  const candidates: Array<{ finding: PreviousFinding; hunkContent: string }> = [];

  for (const finding of openFindings) {
    const diffFile = diff.files.find(f => f.path === finding.file);
    if (!diffFile) continue;

    for (const hunk of diffFile.hunks) {
      const hunkEnd = hunk.newStart + hunk.newLines - 1;
      if (finding.line >= hunk.newStart - 3 && finding.line <= hunkEnd + 3) {
        candidates.push({ finding, hunkContent: hunk.content });
        break;
      }
    }
  }

  if (candidates.length === 0) return 0;

  if (!client) {
    core.info(`${candidates.length} findings may have been addressed but cannot validate without Claude client`);
    return 0;
  }

  const prompt = candidates.map((c, i) =>
    `### Finding ${i + 1}: "${c.finding.title}" at ${c.finding.file}:${c.finding.line} [${c.finding.severity}]\n\nNew code at that location:\n\`\`\`\n${c.hunkContent}\n\`\`\``
  ).join('\n\n');

  try {
    const response = await client.sendMessage(
      'You are checking if code review findings were addressed by new code changes. For each finding, respond with a JSON array where each element is: { "index": <number>, "addressed": true/false, "reason": "<brief reason>" }. Only mark as addressed if the code change ACTUALLY fixes the issue — not just cosmetic changes near the same lines. Respond with ONLY the JSON array.',
      prompt,
    );

    let jsonText = response.content.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const results = JSON.parse(jsonText) as Array<{ index: number; addressed: boolean; reason: string }>;

    for (const result of results) {
      if (result.addressed && result.index >= 0 && result.index < candidates.length) {
        const candidate = candidates[result.index];
        if (candidate.finding.threadId) {
          try {
            await octokit.graphql(`
              mutation($threadId: ID!) {
                resolveReviewThread(input: { threadId: $threadId }) {
                  thread { isResolved }
                }
              }
            `, { threadId: candidate.finding.threadId });

            resolvedCount++;
            core.info(`Auto-resolved: "${candidate.finding.title}" — ${result.reason}`);
          } catch (error) {
            core.debug(`Failed to resolve thread: ${error}`);
          }
        }
      }
    }
  } catch (error) {
    core.warning(`Failed to validate addressed findings: ${error}`);
  }

  return resolvedCount;
}

async function llmDeduplicateFindings(
  findings: Finding[],
  previousFindings: PreviousFinding[],
  client: ClaudeClient,
): Promise<{ unique: Finding[]; duplicates: Finding[] }> {
  const dismissed = previousFindings.filter(f => f.status === 'resolved');
  if (findings.length === 0 || dismissed.length === 0) {
    return { unique: findings, duplicates: [] };
  }

  const sanitize = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/"/g, '\\"');

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
    const duplicates: Finding[] = [];
    for (let i = 0; i < findings.length; i++) {
      if (matchedIndices.has(i)) {
        const match = matches.find(m => m.index - 1 === i);
        const dismissedIdx = match ? match.matchedDismissed - 1 : -1;
        const dismissedTitle = dismissedIdx >= 0 && dismissedIdx < dismissed.length ? dismissed[dismissedIdx].title : 'unknown';
        core.info(`LLM dedup: "${findings[i].title}" matches dismissed "${dismissedTitle}"`);
        duplicates.push(findings[i]);
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

export { PreviousFinding, RecapState, fetchRecapState, deduplicateFindings, buildRecapSummary, resolveAddressedThreads, titlesOverlap, llmDeduplicateFindings };
