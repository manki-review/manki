import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { getOctokitOptions, GitHub } from '@actions/github/lib/utils';

import { AuthorReplyClass, FindingFingerprint, FindingFingerprintEntry, FindingSeverity, ParsedDiff, RoundContext } from './types';
import { BotIdentity, CodeLinks, titleToSlug } from './github';
import { parsePRDiff } from './diff';

/** Runs git in `cwd` with a fixed author and returns its trimmed output. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** Commits `base` in a new git repo, writes `head` over it and returns the repo with the staged diff between the two. */
export function gitWorkspace(base: Record<string, string>, head: Record<string, string>): { root: string; diff: ParsedDiff } {
  const root = mkdtempSync(join(tmpdir(), 'manki-workspace-'));
  const write = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  write(base);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  write(head);
  git(root, 'add', '-A');
  return { root, diff: parsePRDiff(git(root, 'diff', '--cached', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/')) };
}

/** How many times larger the large input of `expectLinearTime` is than the small one, unless the caller gives both. */
const SIZE_RATIO = 16;
/** A small input faster than this is mostly fixed cost and timer noise, so the bound is taken from this time instead. */
const TIME_FLOOR_MS = 50;

/** How many times the size ratio the large input may take. A linear step takes the ratio itself, and a busy runner more. */
const MARGIN = 4;

/**
 * Checks that a step takes time linear in its input size. `time` runs the step on an input of the given size and returns
 * the milliseconds the step took. A linear step takes `size / smaller` times as long on `size` as on `smaller`, and
 * `MARGIN` times that is allowed. Throws when `smaller` is not between 0 and `size`, since such a pair compares nothing.
 */
export async function expectLinearTime(
  time: (size: number) => number | Promise<number>, size: number, { smaller = Math.round(size / SIZE_RATIO) } = {},
): Promise<void> {
  if (!(smaller > 0 && smaller < size)) throw new Error(`expectLinearTime needs 0 < smaller < size, got smaller ${smaller} and size ${size}`);
  // Load only adds time, so the fastest of three runs is the closest to the step's own time.
  let small = Infinity;
  for (let i = 0; i < 3; i++) small = Math.min(small, await time(smaller));
  const bound = MARGIN * (size / smaller) * Math.max(small, TIME_FLOOR_MS);
  // One stretched run fails nothing: a large run over the bound is timed again, twice at most.
  let large = await time(size);
  for (let i = 0; i < 2 && large >= bound; i++) large = Math.min(large, await time(size));
  expect(large).toBeLessThan(bound);
}

/** Runs `call` with fake timers moved on by `ms`, which by default passes the wait before a token service retry. */
export async function pastRetryWait<T>(call: () => Promise<T>, ms = 2000): Promise<T> {
  jest.useFakeTimers();
  try {
    const result = call();
    result.catch(() => {});
    await jest.advanceTimersByTimeAsync(ms);
    return await result;
  } finally {
    jest.useRealTimers();
  }
}

/** `pageInfo` of the last page of a GraphQL connection. */
export const LAST_PAGE = { hasNextPage: false, endCursor: null };

let realClients = 0;

/**
 * Builds the client `github.getOctokit` builds, with every request answered by `fetch` and the retry and rate limit waits
 * a thousandth as long. The throttling plugin shares its limiters by `id` across clients, so each client gets its own.
 */
export function realOctokit(
  fetch: (url: string, init: RequestInit) => Promise<Response>, token: string, options: { retry?: object; throttle?: object } = {}, ...plugins: Parameters<typeof GitHub.plugin>
): InstanceType<typeof GitHub> {
  const scaled: Record<string, unknown> = {
    ...options,
    request: { fetch },
    retry: { ...options.retry, retryAfterBaseValue: 1 },
    throttle: { ...options.throttle, retryAfterBaseValue: 1, id: `client-${realClients++}` },
  };
  const WithPlugins = GitHub.plugin(...plugins);
  return new WithPlugins(getOctokitOptions(token, scaled));
}

/** Stands in for `octokit.paginate` over a mocked list method that resolves one page as `{ data }`. */
export function paginateSinglePage(method: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown): Promise<unknown[]> {
  return method(params).then(response => response.data);
}

/**
 * Build a `RoundContext` test fixture. Required-but-uninteresting fields are
 * filled with neutral defaults so each test only declares the slice it cares
 * about. `meta.round` always reflects the explicit `round` argument, even when
 * `overrides.meta` is provided.
 *
 * Shared across `judge.test.ts`, `review.test.ts`, and `index.test.ts` so all
 * call sites read off the same baseline shape.
 */
export function makeRoundContext(round: number, overrides: Partial<RoundContext> = {}): RoundContext {
  const base: RoundContext = {
    meta: {
      prNumber: 1,
      commitSha: `sha${round}`,
      round,
      timestamp: `2025-01-0${round}T00:00:00Z`,
      mankiVersion: '5.0.0-test',
    },
    config: { reviewLevel: 'medium', memoryEnabled: false },
    diff: { lines: 0, additions: 0, deletions: 0, filesReviewed: 0, fileTypes: {} },
    models: { reviewer: 'r', judge: 'j' },
    planner: { source: 'disabled', used: false },
    reviewers: { agents: [] },
    judge: { summary: '' },
    dedup: {},
    memory: {},
    findings: { count: 0, severityCounts: {}, entries: [] },
    usage: {},
    verdict: 'COMMENT',
  };
  return {
    ...base,
    ...overrides,
    meta: { ...base.meta, ...(overrides.meta ?? {}), round },
  };
}

/**
 * Build a `FindingFingerprintEntry` test fixture. Defaults mirror what the
 * pre-migration `HandoverFinding` literals carried, so tests can declare just
 * the slice they care about.
 */
export function makeFindingFingerprintEntry(
  overrides: Partial<FindingFingerprintEntry> & { title?: string; file?: string; lineStart?: number; lineEnd?: number } = {},
): FindingFingerprintEntry {
  const title = overrides.title ?? 'Sample finding';
  const file = overrides.file ?? 'src/a.ts';
  const lineStart = overrides.lineStart ?? 10;
  const lineEnd = overrides.lineEnd ?? lineStart;
  const fingerprint = overrides.fingerprint ?? {
    file,
    lineStart,
    lineEnd,
    slug: titleToSlug(title),
  };
  return {
    fingerprint,
    severity: overrides.severity ?? 'warning',
    authorReplyClass: overrides.authorReplyClass ?? 'none',
    ...(overrides.threadId !== undefined && { threadId: overrides.threadId }),
    ...(overrides.reviewers !== undefined && { reviewers: overrides.reviewers }),
    ...(overrides.specialist !== undefined && { specialist: overrides.specialist }),
    ...(overrides.suggestedFix !== undefined && { suggestedFix: overrides.suggestedFix }),
    ...(overrides.posted !== undefined && { posted: overrides.posted }),
    title,
  };
}

/**
 * Shape accepted by `roundContextFromLegacy` mirroring the pre-migration
 * `HandoverRound` fixture shape. Lets tests written against the old
 * `priorRounds: HandoverRound[]` payload keep their literal structure while
 * feeding `RoundContext[]` consumers.
 */
export interface LegacyHandoverRoundFixture {
  round: number;
  commitSha: string;
  timestamp: string;
  findings: LegacyHandoverFindingFixture[];
  agents?: string[];
  judgeSummary?: string;
}

export interface LegacyHandoverFindingFixture {
  fingerprint: FindingFingerprint;
  severity: FindingSeverity | 'unknown';
  title: string;
  authorReply: AuthorReplyClass;
  threadId?: string;
  specialist?: string;
  suggestedFix?: string;
}

/**
 * Project a legacy `HandoverRound`-shaped fixture into a `RoundContext`.
 * `authorReply` becomes `authorReplyClass`; per-round metadata maps onto
 * `meta` / `judge` / `reviewers`.
 */
/**
 * Project a list of legacy `HandoverRound`-shaped fixtures into a `RoundContext[]`.
 * Variadic so call sites read `legacyRounds({ round: 1, ... }, { round: 2, ... })`.
 */
export function legacyRounds(...inputs: LegacyHandoverRoundFixture[]): RoundContext[] {
  return inputs.map(roundContextFromLegacy);
}

export function roundContextFromLegacy(input: LegacyHandoverRoundFixture): RoundContext {
  return makeRoundContext(input.round, {
    meta: {
      prNumber: 1,
      commitSha: input.commitSha,
      round: input.round,
      timestamp: input.timestamp,
      mankiVersion: '5.0.0-test',
    },
    reviewers: { agents: input.agents ?? [] },
    judge: { summary: input.judgeSummary ?? '' },
    findings: {
      count: input.findings.length,
      severityCounts: {},
      entries: input.findings.map(legacyFindingToFingerprintEntry),
    },
  });
}

/** Project a list of legacy finding fixtures into `FindingFingerprintEntry[]`. */
export function fingerprintEntriesFromLegacy(findings: LegacyHandoverFindingFixture[]): FindingFingerprintEntry[] {
  return findings.map(legacyFindingToFingerprintEntry);
}

function legacyFindingToFingerprintEntry(f: LegacyHandoverFindingFixture): FindingFingerprintEntry {
  return {
    fingerprint: f.fingerprint,
    severity: f.severity,
    authorReplyClass: f.authorReply,
    ...(f.threadId !== undefined && { threadId: f.threadId }),
    ...(f.specialist !== undefined && { specialist: f.specialist }),
    ...(f.suggestedFix !== undefined && { suggestedFix: f.suggestedFix }),
    title: f.title,
  };
}

/** The identity a run without custom App credentials resolves to. */
export const TEST_BOT: BotIdentity = { logins: ['manki-review[bot]'] };

const numberedLines = (count: number): string[] => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

/** Links a finding comment's code to a fixed commit, with the lines of two files. */
export const TEST_LINKS: CodeLinks = {
  linkTo: (file, line, end = line) => `https://github.com/o/r/blob/sha/${file}#L${line}${end > line ? `-L${end}` : ''}`,
  files: new Map([['src/main.ts', numberedLines(60)], ['src/util.ts', numberedLines(30)]]),
  related: new Map(),
};
