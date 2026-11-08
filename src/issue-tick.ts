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

/** The parts of Manki's review a tick of an issue box in its body needs. */
interface TickedReview {
  id: number;
  body: string;
  commit_id: string;
  html_url: string;
}

/** A finding to file as an issue: its title, the text Manki posted for it, where it sits and where it was posted. */
interface IssueSource {
  title: string;
  text: string;
  file: string;
  line: number;
  commit: string;
  /** The thread or review the finding was posted in, and which of the two it is. */
  postedAt: string;
  postedIn: 'review thread' | 'review';
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

/** Returns `text` without the issue box after its anchor and without Manki's hidden markers. */
function postedText(text: string): string {
  const anchor = text.indexOf(ISSUE_BOX_ANCHOR);
  return (anchor >= 0 ? text.slice(0, anchor) : text).replace(/^<!-- manki[^\n]*-->\n?/gm, '').trim();
}

/** Files `source` as an issue with a permalink to its line and a link to where it was posted, or links the open one. */
async function fileOrLink(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, id: string, source: IssueSource,
): Promise<{ number: number; existing: boolean }> {
  const existing = await findFiledIssue(octokit, bot, owner, repo, id);
  if (existing !== undefined) return { number: existing, existing: true };
  const location = `${source.file}${source.line > 0 ? `:${source.line}` : ''}`;
  const permalink = `${github.context.serverUrl}/${owner}/${repo}/blob/${source.commit}/${source.file}${source.line > 0 ? `#L${source.line}` : ''}`;
  const where = source.file ? ` at [\`${location}\`](${permalink})` : '';
  const body = [
    postedText(source.text),
    `Found by Manki in #${prNumber}${where}. See the [${source.postedIn}](${source.postedAt}).`,
    filedIssueMarker(id),
  ].join('\n\n');
  const { data } = await octokit.rest.issues.create({ owner, repo, title: source.title, body });
  return { number: data.number, existing: false };
}

/** Returns the line that replaces a ticked box once the finding is filed, or the unticked box again when filing failed. */
function filedLine(id: string, filed: { number: number; existing: boolean } | undefined, editor: string): string {
  if (!filed) return issueBoxLine(id);
  return filed.existing ? `Issue #${filed.number} already tracks this, linked by @${editor}` : `Issue #${filed.number} created by @${editor}`;
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
  const finding = parseFindingData(comment.body);
  const source: IssueSource = {
    title: finding?.title ?? 'Manki finding',
    text: comment.body,
    file: comment.path,
    // A finding outside the diff is posted on another line, so the finding data names its own line.
    line: finding?.line ?? comment.original_line ?? 0,
    commit: comment.original_commit_id,
    postedAt: comment.html_url,
    postedIn: 'review thread',
  };
  const thread = (await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber)).find(t => t.rootCommentId === comment.id);
  let body = comment.body;
  let allFiled = true;
  for (const id of ids) {
    let filed: { number: number; existing: boolean } | undefined;
    try {
      filed = await fileOrLink(octokit, bot, owner, repo, prNumber, id, source);
      core.info(`${filed.existing ? 'Linked' : 'Filed'} issue #${filed.number} for finding ${id}`);
    } catch (error) {
      core.warning(`Failed to file an issue for finding ${id}: ${error}`);
      allFiled = false;
      if (thread) await replyToReviewThread(octokit, thread.id, `Could not file an issue for this finding: ${String(error).slice(0, 200)}. Tick the box again to retry.`);
    }
    // Each box is saved as soon as it is handled, so a later failure keeps the issues already filed.
    body = replaceIssueBox(body, id, filedLine(id, filed, editor));
    await octokit.rest.pulls.updateReviewComment({ owner, repo, comment_id: comment.id, body });
    // Opening with "Agreed." records the deferral, so a later round does not raise the finding in a new thread.
    if (filed && thread) await replyToReviewThread(octokit, thread.id, `Agreed. Filed as #${filed.number} for later work.`);
  }
  // A deferred finding no longer needs this PR, but only someone other than the author clears a blocker.
  if (thread && allFiled && !thread.isBlocking && !thread.isResolved) await resolveReviewThread(octokit, thread.id, 'WONT_FIX');
}

const BLOCK_HEADER_RE = /^\*\*(?:Blocker|Warning|Suggestion|Nitpick)\b/gm;

const FOLD_TAG_RE = /<\/?details>/g;

/**
 * Returns where the fold that encloses `at` opens and closes, or -1 for both when none does. A fold can hold folds of
 * its own, such as "How this was checked", so the tags are balanced from `at` outwards.
 */
function enclosingFold(body: string, at: number): { open: number; close: number } {
  let depth = 0;
  let open = -1;
  for (const match of [...body.slice(0, at).matchAll(FOLD_TAG_RE)].reverse()) {
    if (match[0] === '</details>') depth++;
    else if (depth === 0) {
      open = match.index;
      break;
    } else depth--;
  }
  if (open < 0) return { open: -1, close: -1 };
  depth = 0;
  for (const match of body.slice(at).matchAll(FOLD_TAG_RE)) {
    if (match[0] === '<details>') depth++;
    else if (depth === 0) return { open, close: at + match.index };
    else depth--;
  }
  return { open: -1, close: -1 };
}

function decodeHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * Returns the finding of the review body whose box carries `id`: its title, the text Manki posted for it, and whether
 * its header names it a security finding. A listed finding is a fold, and a blocker without a thread is a block that
 * opens with its severity.
 */
function bodyFinding(body: string, id: string): { title: string; text: string; security: boolean } | undefined {
  const box = body.indexOf(`<!-- manki-box:issue:${id} -->`);
  if (box < 0) return undefined;
  const { open, close } = enclosingFold(body, box);
  if (open >= 0 && close > box) {
    const fold = body.slice(open, close);
    const end = fold.indexOf('</summary>');
    const summary = fold.slice(0, end);
    const title = summary.match(/<summary>[^<]*<b>(.*?)<\/b>/)?.[1];
    return title ? { title: decodeHtml(title), text: fold.slice(end + '</summary>'.length), security: / · Security\b/.test(decodeHtml(summary)) } : undefined;
  }
  const start = [...body.slice(0, box).matchAll(BLOCK_HEADER_RE)].pop()?.index;
  if (start === undefined) return undefined;
  const block = body.slice(start, box);
  const [header, titleLine] = block.split('\n');
  const title = titleLine?.match(/^\*\*(.+)\*\*$/)?.[1];
  return title ? { title, text: block, security: / · Security\b/.test(header) } : undefined;
}

/**
 * Files each finding whose issue box `editor` ticked in Manki's review body, or links the issue Manki already filed for
 * it, and replaces each box line with the issue. Everything else in the body, its round record included, stays as is.
 * The caller has checked that `editor` has write access.
 */
export async function handleReviewBoxTick(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, review: TickedReview, editor: string,
): Promise<void> {
  let body = review.body;
  for (const id of tickedIssueBoxes(review.body)) {
    const finding = bodyFinding(review.body, id);
    if (!finding) {
      core.warning(`Found no finding for the ticked issue box ${id} in review ${review.id}`);
      continue;
    }
    // A security finding never offers a box, so a box on one was added by hand and filing it would disclose the defect.
    if (finding.security) {
      core.warning(`Not filing ${id}: it is a security finding, and a public issue would disclose it`);
      continue;
    }
    // The id names the finding's file and line, which a listed finding has no hidden data for.
    const [, file = '', line = '0'] = id.match(/^(.*):(\d+):[^:]*$/) ?? [];
    let filed: { number: number; existing: boolean } | undefined;
    try {
      filed = await fileOrLink(octokit, bot, owner, repo, prNumber, id, {
        title: finding.title, text: finding.text, file, line: Number(line), commit: review.commit_id, postedAt: review.html_url, postedIn: 'review',
      });
      core.info(`${filed.existing ? 'Linked' : 'Filed'} issue #${filed.number} for finding ${id}`);
    } catch (error) {
      core.warning(`Failed to file an issue for finding ${id}: ${error}`);
    }
    body = replaceIssueBox(body, id, filedLine(id, filed, editor));
    await octokit.rest.pulls.updateReview({ owner, repo, pull_number: prNumber, review_id: review.id, body });
  }
}
