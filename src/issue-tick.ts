import * as core from '@actions/core';
import * as github from '@actions/github';

import { BotIdentity } from './github';
import { filedIssueMarker, ISSUE_BOX_ANCHOR, issueBoxLine, replaceIssueBox, tickedIssueBoxes } from './issue-box';
import { isSecurityThread, parseFindingData } from './recap';
import { fetchBotReviewThreads, replyToReviewThread, resolveReviewThread } from './state';

type Octokit = ReturnType<typeof github.getOctokit>;

/** The parts of Manki's review comment a tick of its issue box needs. */
interface TickedComment {
  id: number;
  body: string;
  path: string;
  /** Where the comment was posted, which the issue links to. */
  original_commit_id: string;
  original_line?: number | null;
  html_url: string;
}

/** Returns the open issue Manki already filed for the finding `id`, if any. A closed one tracks nothing, so a tick files a new one. */
async function findFiledIssue(octokit: Octokit, bot: BotIdentity, owner: string, repo: string, id: string): Promise<number | undefined> {
  const marker = filedIssueMarker(id);
  for (const creator of bot.logins) {
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, { owner, repo, creator, state: 'open', per_page: 100 });
    const filed = issues.find(issue => !issue.pull_request && issue.body?.includes(marker));
    if (filed) return filed.number;
  }
  return undefined;
}

/** Returns the finding as Manki posted it: the comment without its issue box and its hidden markers. */
function postedFinding(body: string): string {
  const anchor = body.indexOf(ISSUE_BOX_ANCHOR);
  return (anchor >= 0 ? body.slice(0, anchor) : body).replace(/^<!-- manki[^\n]*-->\n?/gm, '').trim();
}

/** Files the finding in `comment` as an issue, with a permalink to its line and a link back to the thread. */
async function fileIssue(octokit: Octokit, owner: string, repo: string, prNumber: number, comment: TickedComment, id: string): Promise<number> {
  const finding = parseFindingData(comment.body);
  // A finding outside the diff is posted on another line, so the finding data names its own line.
  const line = finding?.line ?? comment.original_line ?? 0;
  const location = `${comment.path}${line > 0 ? `:${line}` : ''}`;
  const permalink = `${github.context.serverUrl}/${owner}/${repo}/blob/${comment.original_commit_id}/${comment.path}${line > 0 ? `#L${line}` : ''}`;
  const body = [
    postedFinding(comment.body),
    `Found by Manki in #${prNumber} at [\`${location}\`](${permalink}). See the [review thread](${comment.html_url}).`,
    filedIssueMarker(id),
  ].join('\n\n');
  const { data } = await octokit.rest.issues.create({ owner, repo, title: finding?.title ?? 'Manki finding', body });
  return data.number;
}

/**
 * Files each finding whose issue box `editor` ticked in Manki's `comment`, or links the issue Manki already filed for
 * it. The box line becomes a link to the issue, the thread gets a reply, and a thread that does not block is resolved.
 * The caller has checked that `editor` has write access.
 */
export async function handleIssueBoxTick(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, comment: TickedComment, editor: string,
): Promise<void> {
  const ids = tickedIssueBoxes(comment.body);
  // A security finding never offers a box, so a box on one was added by hand and filing it would disclose the defect.
  if (ids.length === 0 || isSecurityThread(comment.body)) return;
  const thread = (await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber)).find(t => t.rootCommentId === comment.id);
  let body = comment.body;
  let allFiled = true;
  for (const id of ids) {
    let line: string;
    let reply: string;
    try {
      const existing = await findFiledIssue(octokit, bot, owner, repo, id);
      const number = existing ?? await fileIssue(octokit, owner, repo, prNumber, comment, id);
      core.info(`${existing ? 'Linked' : 'Filed'} issue #${number} for finding ${id}`);
      line = existing ? `Issue #${number} already tracks this, linked by @${editor}` : `Issue #${number} created by @${editor}`;
      // Opening with "Agreed." records the deferral, so a later round does not raise the finding in a new thread.
      reply = `Agreed. Filed as #${number} for later work.`;
    } catch (error) {
      core.warning(`Failed to file an issue for finding ${id}: ${error}`);
      allFiled = false;
      // The box is cleared, so ticking it again tries again.
      line = issueBoxLine(id);
      reply = `Could not file an issue for this finding: ${String(error).slice(0, 200)}. Tick the box again to retry.`;
    }
    body = replaceIssueBox(body, id, line);
    // Each box is saved as soon as it is handled, so a later failure keeps the issues already filed.
    await octokit.rest.pulls.updateReviewComment({ owner, repo, comment_id: comment.id, body });
    if (thread) await replyToReviewThread(octokit, thread.id, reply);
  }
  // A deferred finding no longer needs this PR, but only someone other than the author clears a blocker.
  if (thread && allFiled && !thread.isBlocking && !thread.isResolved) await resolveReviewThread(octokit, thread.id, 'WONT_FIX');
}
