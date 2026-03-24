import * as core from '@actions/core';
import * as github from '@actions/github';
import { Finding } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- claude-review';

interface PreviousFinding {
  title: string;
  file: string;
  line: number;
  severity: string;
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
  severity: string;
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

      const severityMatch = firstComment?.body?.match(/claude-review:(blocking|suggestion|question):/);
      const severity = severityMatch?.[1] ?? 'unknown';

      const titleMatch = firstComment?.body?.match(/\*\*(?:Blocking|Suggestion|Question)\*\*:\s*(.+?)(?:\n|$)/);
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
 * Filter out findings that duplicate previous ones.
 * Returns only genuinely new findings.
 */
function deduplicateFindings(
  newFindings: Finding[],
  previousFindings: PreviousFinding[],
): { unique: Finding[]; duplicates: Finding[] } {
  const unique: Finding[] = [];
  const duplicates: Finding[] = [];

  for (const finding of newFindings) {
    const isDuplicate = previousFindings.some(prev =>
      prev.status === 'open' && matchesPrevious(finding, prev)
    );

    if (isDuplicate) {
      duplicates.push(finding);
    } else {
      unique.push(finding);
    }
  }

  return { unique, duplicates };
}

function matchesPrevious(finding: Finding, previous: PreviousFinding): boolean {
  if (!previous.title || previous.title.length < 3) return false;
  if (!finding.title || finding.title.length < 3) return false;

  const titleMatch = finding.title.toLowerCase().includes(previous.title.toLowerCase()) ||
    previous.title.toLowerCase().includes(finding.title.toLowerCase());

  if (!titleMatch) return false;

  if (finding.file !== previous.file) return false;

  if (Math.abs(finding.line - previous.line) > 5) return false;

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

export { PreviousFinding, RecapState, fetchRecapState, deduplicateFindings, buildRecapSummary };
