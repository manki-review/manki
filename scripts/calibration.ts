/**
 * Labels the findings Manki posted as real, false or unclear from what happened to them, reports blocker precision
 * per repository, and exports a labelled set for judge replay.
 *
 * Usage:
 *   npm run review-history -- <owner/repo> > history.jsonl
 *   npm run calibration -- <history.jsonl> [--fix-rate <fix-rate.jsonl>] [--export <set.jsonl>] [--limit <n>]
 *
 * Reads the GitHub token from `GITHUB_TOKEN`, or from `gh auth token` when that is unset.
 */

import { readFileSync, writeFileSync } from 'fs';

import * as github from '@actions/github';

import { parsePRDiff } from '../src/diff';
import { postedFindings, touchesFinding } from '../src/fix-rate';
import { fetchInterRoundDiff, fetchReviewThreadNodes } from '../src/github';
import { classifyAuthorReply, judgeAddressedThreadIds } from '../src/recap';
import { FindingFingerprintEntry, ParsedDiff, RoundContext } from '../src/types';
import { aggregate } from './fix-rate-report';
import { githubToken, HistoryLine as RecordLine } from './review-history';

type Octokit = ReturnType<typeof github.getOctokit>;

export type Label = 'real' | 'false' | 'unclear';

export type LabelSource =
  | 'reply-fixed' | 'reply-withdrawn' | 'author-fixed' | 'author-declined' | 'judge-addressed' | 'line-changed'
  | 'reply-agreed' | 'reply-unverified' | 'reply-kept' | 'untouched';

/** One line of `npm run review-history`. Only a `round` line holds a round context. */
export type HistoryLine = Pick<RecordLine, 'repo' | 'pr'> & { kind?: RecordLine['kind']; record: Partial<RoundContext> };

export interface ThreadComment {
  body: string;
  bot: boolean;
  url?: string;
}

export interface Thread {
  id: string;
  path: string;
  comments: ThreadComment[];
}

/** What happened to one posted finding, as read from GitHub. */
export interface Evidence {
  thread?: Thread;
  lineChanged: boolean;
  judgeAddressed: boolean;
}

export interface LabelledFinding {
  repo: string;
  pr: number;
  commitSha: string;
  entry: FindingFingerprintEntry;
  label: Label;
  source: LabelSource;
  thread?: Thread;
}

/** One finding of the exported set, with the posted comment the judge replays. */
export interface SetEntry {
  id: string;
  repo: string;
  pr: number;
  commitSha: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: string;
  title: string;
  comment: string;
  judgeNotes?: string;
  judgeConfidence?: string;
  label: 'real' | 'false';
  labelSource: LabelSource;
  threadUrl?: string;
}

const PRECISION_TARGET = 0.8;
const DEFAULT_SET_LIMIT = 60;
const MIN_SET_SIZE = 40;
const SEVERITIES = ['blocker', 'warning', 'suggestion', 'nitpick', 'unknown'];
const REPLY_OUTCOME = /^\**(Fixed|Agreed|Withdrawn|Unverified|Still open|Kept)\b/;
// A person's reply that opens with one of these says the finding was acted on, or turned down.
const AUTHOR_FIXED = /^\**(Fixed|Applied|Added|Adopted|Addressed|Done|Switched|Restructured)\b/i;
const AUTHOR_DECLINED = /^\**(Pushing back|Declin|Skipping|Not applied|Not fixing|Won't fix|Keeping|Leaving)/i;
const FINDING_MARKER = /<!-- manki:[a-z]+:(\S+) -->/;
// The posted grade would anchor a replayed judge, so the export drops the severity header, a cap note under it and the
// `AI context` block.
const SEVERITY_HEADER = /^[^\n]*\*\*(Blocker|Warning|Suggestion|Nitpick)\b[^\n]*\n*(<sub>\[[^\]\n]*\]<\/sub>\n*)?/;
const AI_CONTEXT_BLOCK = /<details>\s*<summary>AI context<\/summary>[\s\S]*?<\/details>/g;
const THREAD_FIELDS = 'id path comments(first: 100) { nodes { body url author { __typename } } }';

const REPLY_LABELS: Record<string, [Label, LabelSource]> = {
  Fixed: ['real', 'reply-fixed'],
  Withdrawn: ['false', 'reply-withdrawn'],
  Agreed: ['unclear', 'reply-agreed'],
  Unverified: ['unclear', 'reply-unverified'],
  'Still open': ['unclear', 'reply-kept'],
  Kept: ['unclear', 'reply-kept'],
};

/**
 * Returns the label of a posted finding. Manki's own "Fixed." or "Withdrawn." reply decides first, then the last reply
 * from a person, the judge marking the thread addressed in a later round, and a change to the flagged lines. A finding
 * a person turned down is false, since it did not hold them up. GitHub keeps no reason when a person resolves a
 * thread, so anything else is unclear.
 */
export function labelFinding({ thread, lineChanged, judgeAddressed }: Evidence): [Label, LabelSource] {
  const replies = thread?.comments.slice(1) ?? [];
  const outcome = replies.filter(c => c.bot).map(c => REPLY_OUTCOME.exec(c.body.trim())?.[1]).filter(Boolean).at(-1);
  if (outcome === 'Fixed' || outcome === 'Withdrawn') return REPLY_LABELS[outcome];
  const reply = replies.filter(c => !c.bot).at(-1)?.body.trim();
  if (reply !== undefined) {
    if (AUTHOR_FIXED.test(reply)) return ['real', 'author-fixed'];
    if (AUTHOR_DECLINED.test(reply)) return ['false', 'author-declined'];
    if (classifyAuthorReply(reply) === 'disagree') return ['false', 'author-declined'];
  }
  if (judgeAddressed) return ['real', 'judge-addressed'];
  if (lineChanged) return ['real', 'line-changed'];
  return outcome ? REPLY_LABELS[outcome] : ['unclear', 'untouched'];
}

/**
 * Returns the completed rounds of each pull request in the history, oldest first, keyed by `owner/repo#number`.
 * An incomplete round posted no finding and resolved no thread, so it is left out.
 */
export function roundsByPullRequest(lines: HistoryLine[]): Map<string, RoundContext[]> {
  const rounds = new Map<string, RoundContext[]>();
  for (const { kind, repo, pr, record } of lines) {
    if (kind === 'reply' || !record.meta?.commitSha || record.meta.incomplete) continue;
    const round = { ...record, judge: record.judge ?? {}, findings: { ...record.findings, entries: record.findings?.entries ?? [] } } as RoundContext;
    const key = `${repo}#${pr}`;
    rounds.set(key, [...(rounds.get(key) ?? []), round]);
  }
  for (const list of rounds.values()) list.sort((a, b) => a.meta.round - b.meta.round);
  return rounds;
}

/**
 * Returns the thread a finding was posted in: the one its record names, or else a thread Manki started on the same file
 * whose `<!-- manki:<severity>:<slug> -->` marker holds the finding's slug.
 */
export function findThread(threads: Thread[], entry: FindingFingerprintEntry): Thread | undefined {
  return (entry.threadId ? threads.find(t => t.id === entry.threadId) : undefined) ?? threads.find(t =>
    t.path === entry.fingerprint.file && t.comments[0]?.bot && FINDING_MARKER.exec(t.comments[0].body)?.[1] === entry.fingerprint.slug);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-';
}

function count(findings: LabelledFinding[], label: Label): number {
  return findings.filter(f => f.label === label).length;
}

/**
 * Renders the calibration report. Blocker precision is real blockers divided by blockers raised, and the target is
 * 80%. `fixRateLines` are lines of a memory repo's `metrics/fix-rate.jsonl`, whose blocker row is shown next to it.
 */
export function renderReport(findings: LabelledFinding[], fixRateLines: string[] = []): string {
  const sections: string[] = [];
  const repos = [...new Set(findings.map(f => f.repo))].sort();
  sections.push([
    '# Blocker calibration',
    '',
    `${findings.length} posted findings on ${new Set(findings.map(f => `${f.repo}#${f.pr}`)).size} pull requests. `
      + 'A finding is real when Manki replied "Fixed.", a person said they fixed it, a later judge marked its thread addressed, '
      + 'or the flagged lines changed. It is false when Manki replied "Withdrawn." or a person turned it down. Anything else is '
      + `unclear, because GitHub does not say why a person resolved a thread. The target is a blocker precision of ${PRECISION_TARGET * 100}%.`,
  ].join('\n'));

  const blockerRows = repos.map(repo => {
    const blockers = findings.filter(f => f.repo === repo && f.entry.severity === 'blocker');
    const real = count(blockers, 'real');
    const labelled = real + count(blockers, 'false');
    return `| ${repo} | ${blockers.length} | ${real} | ${count(blockers, 'false')} | ${count(blockers, 'unclear')} | ${percent(real, blockers.length)} | ${percent(real, labelled)} |`;
  });
  sections.push([
    '## Blocker precision',
    '',
    '| repo | blockers | real | false | unclear | precision | precision of labelled |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...blockerRows,
  ].join('\n'));

  const fixRateBlockers = aggregate(fixRateLines).get('severity')?.get('blocker');
  if (fixRateBlockers) {
    sections.push([
      '## Blockers in fix-rate.jsonl',
      '',
      '| posted | fixed | dismissed | untouched | precision |',
      '| ---: | ---: | ---: | ---: | ---: |',
      `| ${fixRateBlockers.posted} | ${fixRateBlockers.fixed} | ${fixRateBlockers.dismissed} | ${fixRateBlockers.untouched} | ${percent(fixRateBlockers.fixed, fixRateBlockers.posted)} |`,
    ].join('\n'));
  }

  sections.push([
    '## Labels by severity',
    '',
    '| severity | posted | real | false | unclear |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...SEVERITIES.flatMap(severity => {
      const rows = findings.filter(f => f.entry.severity === severity);
      return rows.length === 0 ? [] : [`| ${severity} | ${rows.length} | ${count(rows, 'real')} | ${count(rows, 'false')} | ${count(rows, 'unclear')} |`];
    }),
  ].join('\n'));

  const sources = new Map<string, number>();
  for (const f of findings) sources.set(f.source, (sources.get(f.source) ?? 0) + 1);
  sections.push([
    '## Label sources',
    '',
    '| source | findings |',
    '| --- | ---: |',
    ...[...sources].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([source, n]) => `| ${source} | ${n} |`),
  ].join('\n'));

  const missed = findings.filter(f => f.label === 'real' && f.entry.severity !== 'blocker')
    .sort((a, b) => SEVERITIES.indexOf(a.entry.severity) - SEVERITIES.indexOf(b.entry.severity));
  sections.push([
    '## Missed blockers',
    '',
    'Findings graded below blocker that were fixed. Check whether each one should have blocked.',
    '',
    ...(missed.length === 0 ? ['None.'] : missed.map(f => {
      const where = `\`${f.entry.fingerprint.file}:${f.entry.fingerprint.lineStart}\``;
      const link = f.thread?.comments[0]?.url ? `[${f.repo}#${f.pr}](${f.thread.comments[0].url})` : `${f.repo}#${f.pr}`;
      return `- ${link} ${where} ${f.entry.severity}: ${f.entry.title ?? f.entry.fingerprint.slug} (${f.source})`;
    })),
  ].join('\n'));
  return `${sections.join('\n\n')}\n`;
}

/**
 * Returns up to `limit` labelled findings for judge replay: every false one first, then real blockers, then other
 * real findings, newest pull request first within each group. Findings without a posted comment are left out.
 */
export function selectSet(findings: LabelledFinding[], limit = DEFAULT_SET_LIMIT): SetEntry[] {
  const rank = (f: LabelledFinding) => f.label === 'false' ? 0 : f.entry.severity === 'blocker' ? 1 : 2;
  return findings
    .filter(f => f.label !== 'unclear' && f.thread?.comments[0])
    .sort((a, b) => rank(a) - rank(b) || b.pr - a.pr)
    .slice(0, limit)
    .map(f => ({
      id: `${f.repo}#${f.pr}:${f.entry.fingerprint.file}:${f.entry.fingerprint.slug}`,
      repo: f.repo,
      pr: f.pr,
      commitSha: f.commitSha,
      file: f.entry.fingerprint.file,
      lineStart: f.entry.fingerprint.lineStart,
      lineEnd: f.entry.fingerprint.lineEnd,
      severity: f.entry.severity,
      title: f.entry.title ?? f.entry.fingerprint.slug,
      comment: f.thread!.comments[0].body.replace(/<!--[\s\S]*?-->/g, '').replace(AI_CONTEXT_BLOCK, '').trim().replace(SEVERITY_HEADER, '').trim(),
      ...(f.entry.judgeNotes && { judgeNotes: f.entry.judgeNotes }),
      ...(f.entry.judgeConfidence && { judgeConfidence: f.entry.judgeConfidence }),
      label: f.label as 'real' | 'false',
      labelSource: f.source,
      ...(f.thread!.comments[0].url && { threadUrl: f.thread!.comments[0].url }),
    }));
}

async function fetchThreads(octokit: Octokit, owner: string, repo: string, pr: number): Promise<Thread[]> {
  type Node = { id: string; path: string; comments: { nodes: Array<{ body: string; url: string; author: { __typename: string } | null }> } };
  const nodes = await fetchReviewThreadNodes<Node>(octokit, owner, repo, pr, THREAD_FIELDS);
  return nodes.map(n => ({
    id: n.id,
    path: n.path,
    comments: n.comments.nodes.map(c => ({ body: c.body, url: c.url, bot: c.author?.__typename === 'Bot' })),
  }));
}

/** Labels every finding posted on one pull request, compared with its latest head. */
async function labelPullRequest(octokit: Octokit, key: string, rounds: RoundContext[]): Promise<LabelledFinding[]> {
  const [fullName, prText] = key.split('#');
  const [owner, repo] = fullName.split('/');
  const pr = Number(prText);
  const [{ data: pull }, threads] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: pr }),
    fetchThreads(octokit, owner, repo, pr),
  ]);
  const posted = postedFindings(rounds);
  const later = new Map<string, ParsedDiff>();
  for (const sha of new Set(posted.map(p => p.commitSha))) {
    try {
      later.set(sha, parsePRDiff(await fetchInterRoundDiff(octokit, owner, repo, sha, pull.head.sha)));
    } catch (error) {
      console.error(`Could not compare ${sha.slice(0, 7)} with the head of ${key}, line changes are not counted: ${error}`);
    }
  }
  const addressed = judgeAddressedThreadIds(rounds);
  return posted.map(({ entry, commitSha }) => {
    const thread = findThread(threads, entry);
    const [label, source] = labelFinding({
      thread, lineChanged: touchesFinding(later.get(commitSha), entry.fingerprint), judgeAddressed: !!thread && addressed.has(thread.id),
    });
    return { repo: fullName, pr, commitSha, entry, label, source, ...(thread && { thread }) };
  });
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(args: string[]): Promise<number> {
  const [historyPath] = args;
  const limit = Number(option(args, '--limit') ?? DEFAULT_SET_LIMIT);
  if (!historyPath || historyPath.startsWith('--') || !Number.isInteger(limit) || limit < 1) {
    console.error('Usage: npm run calibration -- <history.jsonl> [--fix-rate <fix-rate.jsonl>] [--export <set.jsonl>] [--limit <n>]');
    return 1;
  }
  const lines = readFileSync(historyPath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as HistoryLine);
  const octokit = github.getOctokit(githubToken());
  const findings: LabelledFinding[] = [];
  const skipped: string[] = [];
  for (const [key, rounds] of roundsByPullRequest(lines)) {
    try {
      findings.push(...await labelPullRequest(octokit, key, rounds));
    } catch (error) {
      skipped.push(key);
      console.error(`Skipping ${key}: ${error instanceof Error ? error.message : error}`);
    }
  }
  const fixRatePath = option(args, '--fix-rate');
  process.stdout.write(renderReport(findings, fixRatePath ? readFileSync(fixRatePath, 'utf-8').split('\n') : []));

  // A partial set would replace a full one, so nothing is exported after a skipped pull request.
  if (skipped.length > 0) {
    console.error(`${skipped.length} pull request(s) could not be read, so the report is partial and nothing is exported.`);
    return 1;
  }
  const exportPath = option(args, '--export');
  if (exportPath) {
    const set = selectSet(findings, limit);
    writeFileSync(exportPath, set.map(entry => `${JSON.stringify(entry)}\n`).join(''));
    if (set.length < MIN_SET_SIZE) console.error(`The set has ${set.length} findings, fewer than the ${MIN_SET_SIZE} a calibration needs.`);
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
