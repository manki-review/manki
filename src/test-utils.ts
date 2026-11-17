import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { gzipSync } from 'zlib';

import { getOctokitOptions, GitHub } from '@actions/github/lib/utils';

import { AuthorReplyClass, FindingFingerprint, FindingFingerprintEntry, FindingSeverity, ParsedDiff, RoundContext } from './types';
import { BotIdentity, CodeLinks, gitBlobSha, reviewedCommit, titleToSlug } from './github';
import { parsePRDiff } from './diff';
import { BASE_READS_FILE, BASE_REF } from './workspace';
import type { LLMClient, LLMResponse, SendMessageOptions } from './providers';

/** Time limit for a test that starts real `git` processes. Under parallel load each one can take far longer than alone. */
export const GIT_TEST_TIMEOUT_MS = 30_000;

/** Runs git in `cwd` with a fixed author and returns its trimmed output. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

/**
 * Commits `base` in a new git repo, writes `head` over it and returns the repo with the staged diff between the two.
 * With `baseExcludes`, the repo holds the base commit at `BASE_REF` for reads at the base, which leave out those paths.
 */
export function gitWorkspace(base: Record<string, string>, head: Record<string, string>, baseExcludes?: readonly string[]): { root: string; diff: ParsedDiff } {
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
  if (baseExcludes) {
    git(root, 'update-ref', BASE_REF, 'HEAD');
    writeFileSync(join(root, '.git', BASE_READS_FILE), JSON.stringify({ excludePaths: baseExcludes }));
  }
  write(head);
  git(root, 'add', '-A');
  return { root, diff: parsePRDiff(git(root, 'diff', '--cached', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/')) };
}

/** A recorded round whose blockers a refuter checked against the PR's base, from `src/refute.fixtures`. */
export interface BaseProofFixture {
  repository: string;
  base: string;
  head: string;
  /** How many lines each file holds at the base and the head, which size the files of `baseProofWorkspace`. */
  lineCounts: Record<string, { base: number | null; head: number | null }>;
  /** The headers of the PR's diff of each file without context, as `-start,count +start,count`. */
  hunks: Record<string, string[]>;
  findings: Array<{
    title: string; file: string; line: number; description: string; security?: true; proof: string[];
    /** What two refuters on different models that both give the recorded answer post: a pre-existing warning, or the blocker. */
    expected: 'pre-existing' | 'blocker';
    /** The refuter's answer, with its answer about the base from the code at the base commit. */
    recorded: Record<string, unknown>;
  }>;
}

/** Returns the fixture `name` of `src/refute.fixtures`. */
export function baseProofFixture(name: string): BaseProofFixture {
  return JSON.parse(readFileSync(join(__dirname, 'refute.fixtures', `${name}.json`), 'utf8')) as BaseProofFixture;
}

/**
 * Returns a workspace for `fixture` with the base at `BASE_REF`, without its code. Each line of the base names its own
 * number, and the head is the base with the lines `fixture.hunks` removes dropped and the lines it adds written new.
 * So the diff of the workspace places every line as the PR's diff does.
 */
export function baseProofWorkspace(fixture: BaseProofFixture): { root: string; diff: ParsedDiff } {
  const base: Record<string, string> = {};
  const head: Record<string, string> = {};
  for (const [path, counts] of Object.entries(fixture.lineCounts)) {
    const old = Array.from({ length: counts.base ?? 0 }, (_, i) => `// base line ${i + 1}`);
    const next: string[] = [];
    let at = 0;
    for (const header of fixture.hunks[path] ?? []) {
      const [, oldStart, oldCount = '1', newStart, newCount = '1'] = header.match(/^-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?$/)!;
      // A side with no lines names the line before the hunk.
      const removedFrom = Number(oldCount) === 0 ? Number(oldStart) : Number(oldStart) - 1;
      next.push(...old.slice(at, removedFrom));
      const addedFrom = Number(newCount) === 0 ? Number(newStart) : Number(newStart) - 1;
      next.push(...Array.from({ length: Number(newCount) }, (_, i) => `// head line ${addedFrom + i + 1}`));
      at = removedFrom + Number(oldCount);
    }
    next.push(...old.slice(at));
    if (counts.base !== null) base[path] = `${old.join('\n')}\n`;
    if (counts.head !== null) head[path] = `${next.join('\n')}\n`;
    if (counts.head !== null && next.length !== counts.head) throw new Error(`the hunks of ${path} give ${next.length} lines, not ${counts.head}`);
  }
  return gitWorkspace(base, head, []);
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

/** The reply of a `fakeClient` call that waits until the call's signal aborts it. */
export const HANG = 'hang until aborted';

export interface FakeCall {
  system: string;
  user: string;
  options?: SendMessageOptions;
}

/**
 * Returns a client that answers each call with what `reply` picks for its user message and the calls so far, and keeps
 * every call. A string is the reply's text, an `Error` is thrown, a reply with `truncated` is returned as it is, `HANG`
 * waits for the call's signal, and any other value is sent as its JSON.
 */
export function fakeClient(reply: (user: string, calls: FakeCall[]) => unknown, repoTools = true): LLMClient & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    repoTools,
    calls,
    async sendMessage(system, user, options) {
      calls.push({ system, user, options });
      const answer = reply(user, calls);
      if (answer instanceof Error) throw answer;
      if (answer === HANG) return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      if (typeof answer === 'object' && answer !== null && 'truncated' in answer) return answer as LLMResponse;
      return { content: typeof answer === 'string' ? answer : JSON.stringify(answer) };
    },
  };
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

/**
 * Returns the contents API's answer for a file holding `content`. With `link`, the path is a symlink whose text is
 * `link` and whose target holds `content`: GitHub answers it with the target's content and the link's own blob id.
 */
export function contentAnswer(content: string | Buffer, link?: string): { type: 'file'; sha: string; content: string; encoding: 'base64'; size: number } {
  const sha = gitBlobSha(Buffer.from(link ?? content));
  return { type: 'file', sha, content: Buffer.from(content).toString('base64'), encoding: 'base64', size: Buffer.byteLength(content) };
}

/** The identity a run without custom App credentials resolves to. */
export const TEST_BOT: BotIdentity = { logins: ['manki-review[bot]'] };

/** A full commit hash that starts with the hex digits `start`. Manki reads a commit only from a full hash. */
export function testSha(start: string): string {
  return start.padEnd(40, '0');
}

/** The footer line in which a Manki round review names `sha` as the commit it reviewed. */
export function reviewedLine(sha: string): string {
  return `- Reviewed [\`${sha.slice(0, 7)}\`](https://github.com/owner/repo/commit/${sha})`;
}

/**
 * Returns `reviews` as GitHub lists real Manki reviews: each one that has a `commit_id` names that commit in its body,
 * unless its body already names a commit.
 */
export function namingCommit<R extends { body?: string | null; commit_id?: string | null }>(reviews: R[]): R[] {
  return reviews.map(r => (r.commit_id && !reviewedCommit(r) ? { ...r, body: `${r.body ?? ''}\n\n${reviewedLine(r.commit_id)}` } : r));
}

const numberedLines = (count: number): string[] => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

const testLinkAt = (commit: string): CodeLinks['linkTo'] => (file, line, end = line) => `https://github.com/o/r/blob/${commit}/${file}#L${line}${end > line ? `-L${end}` : ''}`;

/** Links a finding comment's code to a fixed commit, or to another one with `linkAt`, with the lines of two files. */
export const TEST_LINKS: CodeLinks = {
  linkTo: testLinkAt('sha'),
  linkAt: testLinkAt,
  files: new Map([['src/main.ts', numberedLines(60)], ['src/util.ts', numberedLines(30)]]),
  related: new Map(),
};

/** One entry of a test tar archive: a file by default, or a folder (`5`), hard link (`1`), symlink (`2`) or pax header (`x`). */
export interface TarEntry {
  name: string;
  data?: string | Buffer;
  type?: '0' | '1' | '2' | '5' | 'x';
  linkname?: string;
}

/** Builds a gzipped ustar archive of `entries`, as a package registry serves one. */
export function tarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, data = '', type = '0', linkname = '' } of entries) {
    const body = Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write(type, 156);
    header.write(linkname, 157, 100);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.fill(0x20, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** The hex SHA-256 of `data`, the checksum `Cargo.lock` and the crates.io index state. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The SHA-512 of `data` in Subresource Integrity form, the checksum npm states. */
export function sha512Integrity(data: Buffer): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}

/** A package registry on the loopback interface that serves fixed answers, so no test reaches the network. */
export interface FakeRegistry {
  origin: string;
  /** The paths asked for, in order. */
  requests: string[];
  close(): Promise<void>;
}

/** Starts a `FakeRegistry` that answers each path of `routes` with its body, a redirect, or 404 for any other path. */
export async function fakeRegistry(routes: Record<string, Buffer | string | { redirect: string }>): Promise<FakeRegistry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? '');
    requests.push(path);
    const answer = routes[path];
    if (answer === undefined) {
      response.writeHead(404).end();
    } else if (typeof answer === 'object' && !Buffer.isBuffer(answer)) {
      response.writeHead(302, { location: answer.redirect }).end();
    } else {
      response.writeHead(200).end(answer);
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requests, close: () => new Promise(done => server.close(() => done())) };
}
