/**
 * Writes draft benchmark cases from Manki's round records and review threads on merged pull requests. A round whose
 * blockers sit on code the round before it already reviewed marks a miss of that earlier round, so a draft reviews the
 * commit that round reviewed. Every follow-up round also becomes a draft that reviews its commit after the rounds before
 * it, keyed by the threads it resolved, found partly fixed and left open. Each draft has `key_version: 0` until the
 * owner confirms its items. It only reads from GitHub.
 *
 * Usage:
 *   npm run missed-blockers -- --repo <owner/repo> [--last <n>] [--out <dir>]
 *
 * Reads the GitHub token from `GITHUB_TOKEN`, or from `gh auth token` when that is unset.
 */

import * as github from '@actions/github';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { stringify as stringifyYaml } from 'yaml';

import { fetchReviewThreadNodes } from '../src/github';
import { replyOutcome } from '../src/interaction';
import type { EarlierFinding } from '../src/local-review';
import { FOUND_AGAIN_MARKER, isSecurityThread, parseFindingData, parseFindingFromComment, titlesOverlap } from '../src/recap';
import { fixedMarker } from '../src/state';
import { FindingFingerprintEntry, FindingSeverity, PRE_EXISTING_TAG, RoundContext } from '../src/types';
import { githubToken } from './review-history';
import { fetchPrRecords, listMergedPrs, PrRecords } from './review-stats';

const DEFAULT_LAST = 40;
const DEFAULT_OUT = 'bench/drafts';
const MAX_MECHANISM_CHARS = 800;
/** Owners whose issue and pull request references may be written as links. Any other owner's become plain text. */
const LINKABLE_OWNERS = new Set(['manki-review', 'xdustinface']);

/** The blockers of rounds that sit on code an earlier round reviewed, by the commit that earlier round reviewed. */
export interface Miss {
  /** The round that reviewed `head` and raised none of `blockers`. */
  missedBy: number;
  /** The rounds that raised them. */
  foundIn: number[];
  head: string;
  blockers: FindingFingerprintEntry[];
}

function findingKey(entry: FindingFingerprintEntry): string {
  return `${entry.fingerprint.file}:${entry.fingerprint.slug}`;
}

/**
 * Returns the misses in a pull request's rounds: blockers on code the previous round already reviewed, which no earlier
 * round raised as a blocker. A pre-existing finding is left out, since the pull request did not write that code.
 */
export function collectMisses(rounds: RoundContext[]): Miss[] {
  const sorted = [...rounds].sort((a, b) => a.meta.round - b.meta.round);
  const raised = new Set<string>();
  const byHead = new Map<string, Miss>();
  for (const [i, round] of sorted.entries()) {
    const entries = round.findings?.entries ?? [];
    const previous = sorted[i - 1];
    const missed = entries.filter(e => e.severity === 'blocker' && e.origin === 'reviewed' && !e.tags?.includes(PRE_EXISTING_TAG)
      && !raised.has(findingKey(e)) && !(e.threadId && raised.has(e.threadId)));
    if (previous && missed.length > 0) {
      const head = previous.meta.commitSha;
      const miss = byHead.get(head) ?? { missedBy: previous.meta.round, foundIn: [], head, blockers: [] };
      miss.foundIn.push(round.meta.round);
      miss.blockers.push(...missed);
      byHead.set(head, miss);
    }
    for (const entry of entries.filter(e => e.severity === 'blocker')) {
      raised.add(findingKey(entry));
      if (entry.threadId) raised.add(entry.threadId);
    }
  }
  return [...byHead.values()];
}

type ThreadComment = PrRecords['threadComments'][number];

const DRAFT_SEVERITIES = new Set(['blocker', 'warning', 'suggestion', 'nitpick']);

/** What a follow-up round had before it, and how it treated the earlier findings, for a follow-up draft. */
export interface FollowUp {
  /** The commit the round before it reviewed. */
  priorHead: string;
  /** The findings of every round before it, the latest of each, with each thread's state before the round. */
  findings: EarlierFinding[];
  /** Open threads the round resolved. */
  mustResolve: string[];
  /** Open threads the round found partly fixed, or resolved and a later round found again, with what is left of each. */
  mustKeepOpen: Array<{ id: string; severity: FindingSeverity; mechanism: string }>;
  /** Open threads the round left open, and body findings it posted again. */
  mustNotRepeat: string[];
}

/** A review thread as GraphQL shows it, by the database id of its first comment. */
export interface ThreadState {
  /** The thread's node id, which the round records' thread evaluations name. */
  id: string;
  isResolved: boolean;
}

/**
 * Returns each follow-up round of a pull request, by round number, with what its draft needs. The round's own thread
 * evaluations decide where an earlier open thread goes. Without one, Manki's replies do, and a thread that is resolved
 * now with no reply that dates it is left out.
 */
export function collectFollowUps(rounds: RoundContext[], comments: ThreadComment[], states: ReadonlyMap<number, ThreadState> = new Map()): Map<number, FollowUp> {
  const sorted = [...rounds].sort((a, b) => a.meta.round - b.meta.round);
  const byBot = comments.filter(c => c.user?.type === 'Bot' && c.body);
  const threads = byBot.filter(c => !c.in_reply_to_id).flatMap((root) => {
    const data = parseFindingData(root.body!);
    return data?.title && data.file ? [{ root, title: data.title, file: data.file, replies: byBot.filter(c => c.in_reply_to_id === root.id) }] : [];
  });
  const before = (c: ThreadComment, time: string) => (c.created_at ?? '') < time;
  const followUps = new Map<number, FollowUp>();
  for (const [i, round] of sorted.entries()) {
    if (i === 0) continue;
    const latest = new Map<string, FindingFingerprintEntry>();
    for (const entry of sorted.slice(0, i).flatMap(r => r.findings.entries ?? [])) {
      if (DRAFT_SEVERITIES.has(entry.severity)) latest.set(`${entry.fingerprint.file}:${entry.fingerprint.slug}`, entry);
    }
    const { timestamp, commitSha } = round.meta;
    const next = sorted[i + 1]?.meta.timestamp ?? '\uffff';
    const followUp: FollowUp = { priorHead: sorted[i - 1].meta.commitSha, findings: [], mustResolve: [], mustKeepOpen: [], mustNotRepeat: [] };
    const fixedByRound = sorted.slice(0, i).map(r => fixedMarker(r.meta.commitSha));
    for (const [n, entry] of [...latest.values()].entries()) {
      const id = `P${n + 1}`;
      const title = entry.title ?? entry.fingerprint.slug;
      const thread = threads.find(t => t.file === entry.fingerprint.file && t.title.slice(0, 200) === title && before(t.root, timestamp));
      const state = thread && states.get(thread.root.id);
      const evaluations = (r: RoundContext) => (state ? r.judge.threadEvaluations?.filter(e => e.threadId === state.id) ?? [] : []);
      const last = thread?.replies.filter(c => before(c, timestamp)).at(-1)?.body ?? '';
      // The thread's latest verdict before the round decides, unless a later round found the problem again.
      const verdict = sorted.slice(0, i).flatMap(r => evaluations(r).map(e => ({ status: e.status, at: r.meta.timestamp }))).at(-1);
      const reopened = !!verdict && !!thread?.replies.some(c => !before(c, verdict.at) && before(c, timestamp) && c.body!.includes(FOUND_AGAIN_MARKER));
      const fixedEarlier = verdict?.status === 'addressed' && !reopened;
      const open = !!thread && !replyOutcome(last.trim()) && !fixedEarlier;
      const fixed = !open && (fixedEarlier || !!thread?.replies.some(c => before(c, timestamp) && fixedByRound.some(marker => c.body!.includes(marker))));
      const meta = thread ? parseFindingFromComment(thread.root.body!) : {};
      followUp.findings.push({
        // A file-level finding has line 0, and a case line starts at 1.
        id, severity: entry.severity as FindingSeverity, title, file: entry.fingerprint.file, line: Math.max(1, entry.fingerprint.lineStart),
        ...(entry.gradeIfConfirmed && { gradeIfConfirmed: entry.gradeIfConfirmed }),
        ...(meta.description && { description: meta.description }), ...(meta.howToFix && { howToFix: meta.howToFix }),
        ...((meta.suggestedFix ?? entry.suggestedFix) && { suggestedFix: meta.suggestedFix ?? entry.suggestedFix }),
        ...(thread && isSecurityThread(thread.root.body!) && { security: true }), ...(thread && { thread: open ? 'open' : fixed ? 'fixed' : 'resolved' }),
      });
      if (open) {
        const evaluation = evaluations(round).at(-1);
        const resolved = evaluation
          ? evaluation.status === 'addressed'
          : thread.replies.some(c => !before(c, timestamp) && before(c, next) && c.body!.includes(fixedMarker(commitSha)));
        const foundAgain = resolved && thread.replies.some(c => !before(c, next) && c.body!.includes(FOUND_AGAIN_MARKER));
        if (evaluation?.status === 'partly_addressed') {
          const grade = evaluation.grade && DRAFT_SEVERITIES.has(evaluation.grade) ? evaluation.grade : entry.severity as FindingSeverity;
          followUp.mustKeepOpen.push({ id, severity: grade, mechanism: evaluation.remaining || title });
        } else if (foundAgain) {
          followUp.mustKeepOpen.push({ id, severity: entry.severity as FindingSeverity, mechanism: title });
        } else if (resolved) {
          followUp.mustResolve.push(id);
        } else if (evaluation || !state?.isResolved) {
          followUp.mustNotRepeat.push(id);
        }
      } else if (!thread && (round.findings.entries ?? []).some(e => e.fingerprint.file === entry.fingerprint.file && titlesOverlap(e.title ?? e.fingerprint.slug, title))) {
        followUp.mustNotRepeat.push(id);
      }
    }
    if (followUp.mustResolve.length + followUp.mustKeepOpen.length + followUp.mustNotRepeat.length > 0) followUps.set(round.meta.round, followUp);
  }
  return followUps;
}

/**
 * Rewrites references to issues, pull requests and people of other owners as plain text, so a case file links to none.
 * A bare `owner/name` of `owner`, the owner of the drafted repository, becomes just the name.
 */
export function plainReferences(text: string, owner?: string): string {
  const plain = text
    .replace(/(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(pull|issues)\/(\d+))?[^\s)\]>]*/g, (url, owner: string, name: string, kind?: string, n?: string) => {
      if (LINKABLE_OWNERS.has(owner)) return url;
      // Punctuation right after a link ends the sentence, not the link.
      const trailing = url.match(/[.,;:!?]+$/)?.[0] ?? '';
      return `${n ? `${name} upstream ${kind === 'pull' ? 'PR' : 'issue'} ${n}` : `${name} upstream link`}${trailing}`;
    })
    .replace(/\b([\w.-]+)\/([\w.-]+)#(\d+)/g, (ref, owner: string, name: string, n: string) => (LINKABLE_OWNERS.has(owner) ? ref : `${name} upstream PR ${n}`))
    .replace(/(^|[^\w`/])@([A-Za-z0-9][\w-]*)/g, '$1$2');
  if (!owner || LINKABLE_OWNERS.has(owner)) return plain;
  return plain.split(/(?<![\w./-])/).map(part => (part.startsWith(`${owner}/`) ? part.slice(owner.length + 1) : part)).join('');
}

/** What a draft needs from the pull request. */
export interface DraftPr {
  number: number;
  title: string;
  body: string | null;
  /** Whether `body` is the text as it was at the drafted round, rather than as it is now. */
  bodyAtRound?: boolean;
}

/** One version of a pull request body, from GraphQL's `userContentEdits`: the full text after an edit at `editedAt`. */
export interface BodyEdit {
  editedAt: string;
  /** Unset when the edit was deleted from the history. */
  diff?: string | null;
}

/**
 * Returns the body as it was at `time`: the latest version edited at or before it. A body never edited is the same at
 * any time. Without a version from before `time`, the body cannot be recovered, and `known` is false.
 */
export function bodyAt(current: string | null, edits: BodyEdit[], time: string): { body: string | null; known: boolean } {
  if (edits.length === 0) return { body: current, known: true };
  const version = [...edits].sort((a, b) => b.editedAt.localeCompare(a.editedAt)).find(e => e.editedAt <= time);
  return typeof version?.diff === 'string' ? { body: version.diff, known: true } : { body: current, known: false };
}

/**
 * Returns the draft case file for `miss`, with one `must_catch` blocker per missed finding, for the owner to confirm.
 * With `followUp`, the draft reviews the round as a follow-up of the rounds before it.
 */
export function draftCase(repo: string, pr: DraftPr, miss: Miss, base: string, followUp?: FollowUp): { id: string; text: string } {
  const [owner, name] = repo.split('/');
  const plain = (text: string) => plainReferences(text, owner);
  const id = `${name}-${pr.number}-r${miss.missedBy}`;
  const where = LINKABLE_OWNERS.has(owner) ? `${repo}#${pr.number}` : `${name} upstream PR ${pr.number}`;
  const rounds = miss.foundIn.join(', ');
  const found = miss.blockers.length > 0 ? `round ${rounds} raised blockers on code round ${miss.missedBy} had reviewed` : '';
  const earlier = (finding: string) => followUp!.findings.find(f => f.id === finding)!;
  const doc = {
    id,
    repo,
    source: plain(followUp ? `${where}: round ${miss.missedBy}, a follow-up of the rounds before it${found ? `, and ${found}` : ''}` : `${where}: ${found}`),
    base,
    head: miss.head,
    title: plain(pr.title),
    body: plain(pr.body ?? ''),
    key_version: 0,
    ...(followUp && {
      prior_round: {
        head: followUp.priorHead,
        findings: followUp.findings.map(f => ({
          id: f.id, severity: f.severity, title: plain(f.title), file: f.file, line: f.line, ...(f.gradeIfConfirmed && { grade_if_confirmed: f.gradeIfConfirmed }),
          posted: f.thread ? 'thread' : 'body', ...(f.thread && { state: f.thread }),
          ...(f.description && { description: plain(f.description) }), ...(f.howToFix && { how_to_fix: plain(f.howToFix) }),
          ...(f.suggestedFix && { suggested_fix: f.suggestedFix }), ...(f.security && { security: true }),
        })),
      },
      must_resolve: followUp.mustResolve,
      must_keep_open: followUp.mustKeepOpen.map(({ id: finding, severity, mechanism }) => ({ id: finding, severity, mechanism: plain(mechanism), locations: [earlier(finding).file] })),
      must_not_repeat: followUp.mustNotRepeat,
    }),
    must_catch: miss.blockers.map((entry, i) => ({
      id: `K${i + 1}`,
      severity: 'blocker',
      mechanism: plain([entry.title ?? entry.fingerprint.slug, entry.judgeNotes].filter(Boolean).join('. ')).slice(0, MAX_MECHANISM_CHARS),
      locations: [entry.fingerprint.file],
    })),
    nice_to_have: [],
  };
  const header = [
    ...(found ? [`# Draft from Manki's round records: round ${rounds} found these blockers on code round ${miss.missedBy} reviewed at ${miss.head}.`] : []),
    ...(followUp ? [
      `# Draft from Manki's round records and threads: round ${miss.missedBy} reviewed ${miss.head} after the round at ${followUp.priorHead}.`,
      `# must_resolve lists the earlier threads round ${miss.missedBy} resolved, must_keep_open those it found partly fixed, with what it`,
      '# said is left, or resolved and a later round found again, and must_not_repeat the threads it left open and the body findings',
      '# it posted again. A thread resolved at a time no record shows is left out.',
    ] : []),
    pr.bodyAtRound
      ? `# The body is the pull request body as it was when round ${miss.missedBy} reviewed. Check each item, its severity and locations, then set key_version`
      : `# The body is the pull request body as it is now, since its text at round ${miss.missedBy} could not be recovered. Check each item, its severity and locations, then set key_version`,
    '# to 1 and move the file to bench/cases or bench/holdout.',
  ].join('\n');
  return { id, text: `${header}\n${stringifyYaml(doc, { lineWidth: 0 })}` };
}

function parseArgs(args: string[]): { owner: string; repo: string; last: number; out: string } | undefined {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [owner, repo, ...rest] = (value('--repo') ?? '').split('/');
  const last = Number(value('--last') ?? DEFAULT_LAST);
  return owner && repo && rest.length === 0 && Number.isInteger(last) && last > 0 ? { owner, repo, last, out: value('--out') ?? DEFAULT_OUT } : undefined;
}

async function fetchBodyEdits(octokit: ReturnType<typeof github.getOctokit>, owner: string, repo: string, number: number): Promise<BodyEdit[]> {
  const data = await octokit.graphql<{ repository: { pullRequest: { userContentEdits: { nodes: Array<BodyEdit | null> | null } | null } | null } }>(
    'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { userContentEdits(first: 100) { nodes { editedAt diff } } } } }',
    { owner, repo, number },
  );
  return (data.repository.pullRequest?.userContentEdits?.nodes ?? []).filter((e): e is BodyEdit => !!e);
}

async function main(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error('Usage: npm run missed-blockers -- --repo <owner/repo> [--last <n>] [--out <dir>]');
    return 1;
  }
  const { owner, repo, last, out } = parsed;
  const octokit = github.getOctokit(githubToken());
  mkdirSync(out, { recursive: true });
  let written = 0;
  for (const pr of await listMergedPrs(octokit, owner, repo, last)) {
    const { rounds, threadComments } = await fetchPrRecords(octokit, owner, repo, pr.number);
    const misses = collectMisses(rounds);
    const nodes = await fetchReviewThreadNodes<{ id: string; isResolved: boolean; comments: { nodes: Array<{ databaseId?: number | null }> } }>(
      octokit, owner, repo, pr.number, 'id isResolved comments(first: 1) { nodes { databaseId } }',
    );
    const states = new Map(nodes.flatMap(t => (t.comments.nodes[0]?.databaseId ? [[t.comments.nodes[0].databaseId, { id: t.id, isResolved: t.isResolved }] as const] : [])));
    const followUps = collectFollowUps(rounds, threadComments, states);
    const edits = await fetchBodyEdits(octokit, owner, repo, pr.number);
    const drafted = [...new Set([...misses.map(m => m.missedBy), ...followUps.keys()])].sort((a, b) => a - b);
    for (const round of drafted) {
      const miss = misses.find(m => m.missedBy === round) ?? { missedBy: round, foundIn: [], head: rounds.find(r => r.meta.round === round)!.meta.commitSha, blockers: [] };
      let base: string;
      try {
        // The base commit the PR recorded at merge, since the branch now holds the PR's own commits after a merge commit.
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${pr.base.sha}...${miss.head}`, per_page: 1 });
        base = data.merge_base_commit.sha;
      } catch (error) {
        console.error(`PR ${pr.number}: skipped round ${miss.missedBy}, the merge base of ${miss.head} is not found: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      const followUp = followUps.get(round);
      const { body, known } = bodyAt(pr.body, edits, rounds.find(r => r.meta.round === round)!.meta.timestamp);
      const { id, text } = draftCase(`${owner}/${repo}`, { number: pr.number, title: pr.title, body, bodyAtRound: known }, miss, base, followUp);
      writeFileSync(join(out, `${id}.yml`), text);
      written++;
      console.log(`${id}: ${miss.blockers.length} missed ${miss.blockers.length === 1 ? 'blocker' : 'blockers'}${followUp ? `, a follow-up of ${followUp.findings.length} earlier ${followUp.findings.length === 1 ? 'finding' : 'findings'}` : ''}`);
    }
  }
  console.log(`${written} draft ${written === 1 ? 'case' : 'cases'} in ${out}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
