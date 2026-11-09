/**
 * Writes a draft benchmark case for each round whose blockers sit on code the round before it already reviewed, read
 * from Manki's round records on merged pull requests. Such a blocker is a miss of the earlier round, so the case
 * reviews the commit that round reviewed. Each draft has `key_version: 0` until the owner confirms its items. It only
 * reads from GitHub.
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

import { FindingFingerprintEntry, PRE_EXISTING_TAG, RoundContext } from '../src/types';
import { githubToken } from './review-history';
import { fetchPrRecords, listMergedPrs } from './review-stats';

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

/** Rewrites references to issues, pull requests and people of other owners as plain text, so a case file links to none. */
export function plainReferences(text: string): string {
  return text
    .replace(/(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(pull|issues)\/(\d+))?[^\s)\]>]*/g, (url, owner: string, name: string, kind?: string, n?: string) => {
      if (LINKABLE_OWNERS.has(owner)) return url;
      // Punctuation right after a link ends the sentence, not the link.
      const trailing = url.match(/[.,;:!?]+$/)?.[0] ?? '';
      return `${n ? `${name} upstream ${kind === 'pull' ? 'PR' : 'issue'} ${n}` : `${name} upstream link`}${trailing}`;
    })
    .replace(/\b([\w.-]+)\/([\w.-]+)#(\d+)/g, (ref, owner: string, name: string, n: string) => (LINKABLE_OWNERS.has(owner) ? ref : `${name} upstream PR ${n}`))
    .replace(/(^|[^\w`/])@([A-Za-z0-9][\w-]*)/g, '$1$2');
}

/** What a draft needs from the pull request. */
export interface DraftPr {
  number: number;
  title: string;
  body: string | null;
}

/** Returns the draft case file for `miss`, with one `must_catch` blocker per missed finding, for the owner to confirm. */
export function draftCase(repo: string, pr: DraftPr, miss: Miss, base: string): { id: string; text: string } {
  const [owner, name] = repo.split('/');
  const id = `${name}-${pr.number}-r${miss.missedBy}`;
  const where = LINKABLE_OWNERS.has(owner) ? `${repo}#${pr.number}` : `${name} upstream PR ${pr.number}`;
  const rounds = miss.foundIn.join(', ');
  const doc = {
    id,
    repo,
    source: plainReferences(`${where}: round ${rounds} raised blockers on code round ${miss.missedBy} had reviewed`),
    base,
    head: miss.head,
    title: plainReferences(pr.title),
    body: plainReferences(pr.body ?? ''),
    key_version: 0,
    must_catch: miss.blockers.map((entry, i) => ({
      id: `K${i + 1}`,
      severity: 'blocker',
      mechanism: plainReferences([entry.title, entry.judgeNotes].filter(Boolean).join('. ')).slice(0, MAX_MECHANISM_CHARS),
      locations: [entry.fingerprint.file],
    })),
    nice_to_have: [],
  };
  const header = [
    `# Draft from Manki's round records: round ${rounds} found these blockers on code round ${miss.missedBy} reviewed at ${miss.head}.`,
    '# The body is the pull request body as it is now. Check each item, its severity and locations, then set key_version',
    '# to 1 and move the file to bench/cases.',
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
    const { rounds } = await fetchPrRecords(octokit, owner, repo, pr.number);
    for (const miss of collectMisses(rounds)) {
      let base: string;
      try {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${pr.base.ref}...${miss.head}`, per_page: 1 });
        base = data.merge_base_commit.sha;
      } catch (error) {
        console.error(`PR ${pr.number}: skipped round ${miss.missedBy}, the merge base of ${miss.head} is not found: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      const { id, text } = draftCase(`${owner}/${repo}`, pr, miss, base);
      writeFileSync(join(out, `${id}.yml`), text);
      written++;
      console.log(`${id}: ${miss.blockers.length} missed ${miss.blockers.length === 1 ? 'blocker' : 'blockers'}`);
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
