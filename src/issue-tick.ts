import * as core from '@actions/core';
import * as github from '@actions/github';

import { BotIdentity, buildLineLink, findingLocation, linked, sanitizeMarkdown } from './github';
import { FILED_ISSUE_OPENER, filedIssueMarker, ISSUE_BOX_ANCHOR, issueBoxLine, issueBoxOffset, replaceIssueBox, tickedIssueBoxes, withoutFences } from './issue-box';
import { findingFile, findingLineOf, isGuarded, parseFindingData, withoutDetachedNote } from './recap';
import { BOT_MARKER, fetchBotReviewThreads, replyToReviewThread, resolveReviewThread } from './state';
import { ownMarker, withMarkers } from './utils';

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
  for (const creator of bot.logins) {
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, { owner, repo, creator, state: 'open', per_page: 100 });
    const filed = issues.find(issue => !issue.pull_request && ownMarker(issue.body ?? '', FILED_ISSUE_OPENER) === id);
    if (filed) return filed.number;
  }
  return undefined;
}

/**
 * Returns `posted` up to the anchor of the box of `id`, without Manki's hidden markers. The line that opens a detached
 * thread is left out too, since it is about the thread and the issue names the finding's place itself.
 */
function postedText(posted: string, id: string): string {
  const text = withoutDetachedNote(posted);
  const box = issueBoxOffset(text, id);
  const anchor = box >= 0 ? text.lastIndexOf(ISSUE_BOX_ANCHOR, box) : -1;
  return (anchor >= 0 ? text.slice(0, anchor) : text).replace(/^<!-- manki[^\n]*-->\r?\n?/gm, '').trim();
}

/** Files `source` as an issue with a permalink to its line and a link to where it was posted, or links the open one. */
async function fileOrLink(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, id: string, source: IssueSource,
): Promise<{ number: number; existing: boolean }> {
  const existing = await findFiledIssue(octokit, bot, owner, repo, id);
  if (existing !== undefined) return { number: existing, existing: true };
  const permalink = buildLineLink(owner, repo, source.commit, github.context.serverUrl)(source.file, source.line);
  const where = source.file ? ` at ${linked(`\`${findingLocation(source)}\``, permalink)}` : '';
  const body = [
    postedText(source.text, id),
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
  if (ids.length === 0) return;
  const finding = parseFindingData(comment.body);
  const source: IssueSource = {
    title: finding?.title ?? 'Manki finding',
    text: comment.body,
    file: findingFile(comment.body, comment.path),
    // A finding outside the diff is posted on another line, so the finding data names its own line.
    line: finding?.line ?? findingLineOf(comment.body, comment.original_line),
    commit: comment.original_commit_id,
    postedAt: comment.html_url,
    postedIn: 'review thread',
  };
  const thread = (await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber)).find(t => t.rootCommentId === comment.id);
  let allFiled = true;
  for (const id of ids) {
    let filed: { number: number; existing: boolean } | undefined;
    try {
      filed = await fileOrLink(octokit, bot, owner, repo, prNumber, id, source);
      core.info(`${filed.existing ? 'Linked' : 'Filed'} issue #${filed.number} for finding ${id}`);
    } catch (error) {
      core.warning(`Failed to file an issue for finding ${id}: ${error}`);
      allFiled = false;
      // The box is cleared for a retry even when the reply fails, and the other boxes are still handled.
      if (thread) {
        await replyToReviewThread(octokit, thread.id, `Could not file an issue for this finding: ${sanitizeMarkdown(String(error).slice(0, 200))}. Tick the box again to retry.`)
          .catch((replyError: unknown) => core.warning(`Failed to report the failed filing of ${id}: ${replyError}`));
      }
    }
    // Each box is saved as soon as it is handled, on the comment as it is now, so a tick made meanwhile stays.
    const { data: current } = await octokit.rest.pulls.getReviewComment({ owner, repo, comment_id: comment.id });
    await octokit.rest.pulls.updateReviewComment({ owner, repo, comment_id: comment.id, body: replaceIssueBox(current.body, id, filedLine(id, filed, editor)) });
    // Opening with "Agreed." records the deferral, so a later round does not raise the finding in a new thread.
    if (filed && thread) await replyToReviewThread(octokit, thread.id, `Agreed. Filed as #${filed.number} for later work.`);
  }
  // A deferred finding no longer needs this PR, but only someone other than the author clears a blocker or a security finding.
  if (thread && allFiled && !isGuarded(thread) && !thread.isResolved) await resolveReviewThread(octokit, thread.id, 'WONT_FIX');
}

const BLOCK_HEADER_RE = /^\*\*(?:Blocker|Warning|Suggestion|Nitpick)\b/gm;

const FOLD_TAG_RE = /<\/?details>/g;

/**
 * Returns where the fold that ends right before `at` opens, or -1 when what comes before `at` is no fold. A fold can
 * hold folds of its own, so the tags are balanced from its end backwards.
 */
function foldOpenBefore(body: string, at: number): number {
  const before = body.slice(0, at).trimEnd();
  if (!before.endsWith('</details>')) return -1;
  let depth = 0;
  for (const match of [...before.slice(0, before.length - '</details>'.length).matchAll(FOLD_TAG_RE)].reverse()) {
    if (match[0] === '</details>') depth++;
    else if (depth === 0) return match.index;
    else depth--;
  }
  return -1;
}

function decodeHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * Returns the finding of the review body whose box carries `id`: its title and the text Manki posted for it. The box
 * sits right under it: a listed finding is a fold, and a blocker without a thread is a block that opens with its
 * severity.
 */
function bodyFinding(body: string, id: string): { title: string; text: string } | undefined {
  const box = issueBoxOffset(body, id);
  if (box < 0) return undefined;
  const anchor = body.lastIndexOf(ISSUE_BOX_ANCHOR, box);
  // Tags and headers inside a fenced fix are a model's text, never Manki's structure.
  const plain = withoutFences(body);
  const open = foldOpenBefore(plain, anchor);
  if (open >= 0) {
    const fold = body.slice(open, plain.slice(0, anchor).trimEnd().length - '</details>'.length);
    const end = fold.indexOf('</summary>');
    // The title is the bold text before the line break, and it can hold bold text of its own.
    const title = fold.slice(0, end).match(/<summary>[^<]*<b>(.*)<\/b><br>/)?.[1];
    if (title) return { title: decodeHtml(title), text: fold.slice(end + '</summary>'.length) };
    // A blocker block can end with its own fold of fix and checks, which is no finding.
  }
  const start = [...plain.slice(0, anchor).matchAll(BLOCK_HEADER_RE)].pop()?.index;
  if (start === undefined) return undefined;
  const block = body.slice(start, anchor);
  const title = block.split(/\r?\n/)[1]?.match(/^\*\*(.+)\*\*$/)?.[1];
  return title ? { title, text: block } : undefined;
}

/**
 * Files each finding whose issue box `editor` ticked in Manki's review body, or links the issue Manki already filed for
 * it, and replaces each box line with the issue. Everything else in the body, its round record included, stays as is.
 * The caller has checked that `editor` has write access.
 */
export async function handleReviewBoxTick(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, review: TickedReview, editor: string,
): Promise<void> {
  for (const id of tickedIssueBoxes(review.body)) {
    // The review has no thread to reply in, so the PR gets the reason. The box is cleared either way.
    const sayNotFiled = (text: string): Promise<unknown> => octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: withMarkers(text, BOT_MARKER) })
      .catch((reportError: unknown) => core.warning(`Failed to report the failed filing of ${id}: ${reportError}`));
    const finding = bodyFinding(review.body, id);
    // The id names the finding's file and line, which a listed finding has no hidden data for.
    const [, encodedFile = '', line = '0'] = id.match(/^(.*):(\d+):[^:]*$/) ?? [];
    const file = decodeURIComponent(encodedFile);
    let filed: { number: number; existing: boolean } | undefined;
    if (!finding) {
      core.warning(`Found no finding for the ticked issue box ${id} in review ${review.id}`);
      await sayNotFiled(`No issue was filed for the box ticked in [this review](${review.html_url}): Manki could not find the finding it belongs to. Create the issue by hand.`);
    } else {
      try {
        filed = await fileOrLink(octokit, bot, owner, repo, prNumber, id, {
          title: finding.title, text: finding.text, file, line: Number(line), commit: review.commit_id, postedAt: review.html_url, postedIn: 'review',
        });
        core.info(`${filed.existing ? 'Linked' : 'Filed'} issue #${filed.number} for finding ${id}`);
      } catch (error) {
        core.warning(`Failed to file an issue for finding ${id}: ${error}`);
        await sayNotFiled(`Could not file an issue for **${sanitizeMarkdown(finding.title)}**: ${sanitizeMarkdown(String(error).slice(0, 200))}. Tick its box in the review again to retry.`);
      }
    }
    // Each box is saved as soon as it is handled, on the review as it is now, so a tick made meanwhile stays.
    const { data: current } = await octokit.rest.pulls.getReview({ owner, repo, pull_number: prNumber, review_id: review.id });
    await octokit.rest.pulls.updateReview({ owner, repo, pull_number: prNumber, review_id: review.id, body: replaceIssueBox(current.body, id, filedLine(id, filed, editor)) });
  }
}
