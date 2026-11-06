import * as core from '@actions/core';

import { BOT_MARKER, CANCELLED_MARKER, FORCE_CAP_MARKER, RUN_ID_MARKER_PREFIX } from './github';
import { _resetOctokitCache, handlePullRequest, main, runFullReview } from './index';
import type { SendMessageOptions } from './providers';
import { STALE_APPROVE_MARKER_PREFIX } from './state';
import { RoundContext } from './types';

jest.mock('@actions/core', () => ({
  ...jest.requireActual('@actions/core'),
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  setSecret: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
  getIDToken: jest.fn(),
  getState: jest.fn(),
  saveState: jest.fn(),
}));

// The real `@actions/github` client, with every request answered by the in-memory GitHub below.
jest.mock('@actions/github', () => {
  const actual = jest.requireActual('@actions/github');
  return {
    get context() { return mockContext; },
    getOctokit: (token: string, options: Record<string, unknown> = {}, ...plugins: unknown[]) => actual.getOctokit(token, {
      ...options,
      request: { fetch: (url: string, init: RequestInit) => mockGitHub.fetch(url, init) },
      throttle: { ...(options.throttle as object), enabled: false },
      retry: { retryAfterBaseValue: 1 },
    }, ...plugins),
  };
});

jest.mock('./providers', () => ({
  ...jest.requireActual('./providers'),
  createLLMClient: () => ({ sendMessage: (system: string, user: string, options?: SendMessageOptions) => mockLLM.sendMessage(system, user, options) }),
}));

const OWNER = 'acme';
const REPO = 'widgets';
const PR_NUMBER = 42;
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const APP_LOGIN = 'manki-review[bot]';
const ACTIONS_LOGIN = 'github-actions[bot]';
const TOKEN_URL = 'https://token.test/token';
const TOKEN_LOGINS: Record<string, string> = { ghs_app: APP_LOGIN, ghs_workflow: ACTIONS_LOGIN };

const mockContext = {
  eventName: 'pull_request',
  payload: {} as Record<string, unknown>,
  repo: { owner: OWNER, repo: REPO },
  runId: 7001,
  actor: APP_LOGIN,
  job: 'review',
  serverUrl: 'https://github.com',
};

const PR_DIFF = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index 1111111..2222222 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1,3 +1,4 @@',
  ' export function add(a: number, b: number): number {',
  '-  return a + b;',
  '+  const sum = a + b;',
  '+  return sum;',
  ' }',
  '',
].join('\n');

const MATH_TS = 'export function add(a: number, b: number): number {\n  const sum = a + b;\n  return sum;\n}\n';

interface FakeUser { login: string; type: string }
interface FakeComment { id: number; body: string; user: FakeUser; created_at: string; updated_at: string }
interface FakeReview { id: number; body: string; state: string; commit_id: string; user: FakeUser; submitted_at: string }
interface FakeThreadComment { databaseId: number; body: string; url: string; authorAssociation: string; author: { login: string } }
interface FakeThread { id: string; isResolved: boolean; resolvedBy: { login: string } | null; path: string; line: number; startLine: number | null; originalLine: number; comments: FakeThreadComment[] }
interface FakeFailure { method: string; path: RegExp; status: number }

const REVIEW_STATES: Record<string, string> = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };

/** An in-memory GitHub REST and GraphQL API holding one pull request, its comments, reviews and review threads. */
class FakeGitHub {
  comments: FakeComment[] = [];
  reviews: FakeReview[] = [];
  threads: FakeThread[] = [];
  failures: FakeFailure[] = [];
  /** Every request that changes something, as `METHOD route`. */
  writes: string[] = [];
  /** Runs before a write is answered, which waits for it. */
  onWrite?: (write: string) => void | Promise<void>;
  headSha = HEAD_SHA;
  mergeable: boolean | null = true;
  /** The config file the PR carries at its head commit. */
  headConfig?: string;
  activeRuns: number[] = [];
  private nextId = 1000;

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const { pathname, searchParams, origin } = new URL(url);
    const headers = new Headers(init.headers);
    const login = TOKEN_LOGINS[(headers.get('authorization') ?? '').replace(/^(token|bearer) /i, '')] ?? 'anonymous';
    const body = init.body ? JSON.parse(String(init.body)) : {};

    if (`${origin}${pathname}` === TOKEN_URL) return json({ token: 'ghs_app', expires_at: '2099-01-01T00:00:00Z' });
    if (pathname === '/graphql' ? String(body.query).trimStart().startsWith('mutation') : method !== 'GET') {
      const write = `${method} ${pathname}`;
      this.writes.push(write);
      await this.onWrite?.(write);
    }
    const failure = this.failures.find(f => f.method === method && f.path.test(pathname));
    if (failure) return json({ message: 'Server Error' }, failure.status);
    if (pathname === '/graphql') return json({ data: this.graphql(body.query, body.variables ?? {}, login) });

    const route = decodeURIComponent(pathname).replace(`/repos/${OWNER}/${REPO}`, '');
    const user = { login, type: 'Bot' };
    const now = new Date().toISOString();
    let match: RegExpMatchArray | null;

    if (method === 'GET' && route === `/pulls/${PR_NUMBER}`) {
      if (headers.get('accept')?.includes('diff')) return text(PR_DIFF);
      return json({ number: PR_NUMBER, title: 'Keep the sum in a variable', body: 'Small refactor.', draft: false, head: { sha: this.headSha, ref: 'feature', repo: { full_name: `${OWNER}/${REPO}` } }, base: { ref: 'main', repo: { full_name: `${OWNER}/${REPO}` } }, user: { login: 'alice', type: 'User' }, mergeable: this.mergeable, mergeable_state: this.mergeable === false ? 'dirty' : 'clean' });
    }
    if ((match = route.match(/^\/pulls\/comments\/(\d+)(\/reactions)?$/))) {
      const id = Number(match[1]);
      const thread = this.threads.find(t => t.comments.some(c => c.databaseId === id));
      const comment = thread?.comments.find(c => c.databaseId === id);
      if (!thread || !comment) return json({ message: 'Not Found' }, 404);
      if (match[2]) return json({ id: this.nextId++, content: body.content }, 201);
      const isBot = `${comment.author.login}[bot]` === APP_LOGIN;
      return json({
        id, body: comment.body, path: thread.path, line: thread.line, author_association: comment.authorAssociation,
        user: { login: isBot ? APP_LOGIN : comment.author.login, type: isBot ? 'Bot' : 'User' },
        in_reply_to_id: comment === thread.comments[0] ? undefined : thread.comments[0].databaseId,
        pull_request_url: `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`,
      });
    }
    if (method === 'POST' && (match = route.match(new RegExp(`^/pulls/${PR_NUMBER}/comments/(\\d+)/replies$`)))) {
      const thread = this.threads.find(t => t.comments.some(c => c.databaseId === Number(match![1])));
      if (!thread) return json({ message: 'Not Found' }, 404);
      const reply = { databaseId: this.nextId++, body: body.body, url: `${thread.comments[0].url}-reply`, authorAssociation: 'NONE', author: { login: login.replace(/\[bot\]$/, '') } };
      thread.comments.push(reply);
      return json({ id: reply.databaseId }, 201);
    }
    if (method === 'GET' && route === `/issues/${PR_NUMBER}/comments`) return this.page(url, this.comments, searchParams);
    if (method === 'POST' && route === `/issues/${PR_NUMBER}/comments`) {
      const comment = { id: this.nextId++, body: body.body, user, created_at: now, updated_at: now };
      this.comments.push(comment);
      return json(comment, 201);
    }
    if ((match = route.match(/^\/issues\/comments\/(\d+)$/))) {
      const index = this.comments.findIndex(c => c.id === Number(match![1]));
      if (index === -1) return json({ message: 'Not Found' }, 404);
      if (method === 'DELETE') {
        this.comments.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      Object.assign(this.comments[index], { body: body.body, updated_at: now });
      return json(this.comments[index]);
    }
    if (method === 'GET' && route === `/pulls/${PR_NUMBER}/reviews`) return this.page(url, this.reviews, searchParams);
    if (method === 'POST' && route === `/pulls/${PR_NUMBER}/reviews`) {
      const review = { id: this.nextId++, body: body.body, state: REVIEW_STATES[body.event], commit_id: body.commit_id, user, submitted_at: now };
      this.reviews.push(review);
      for (const c of body.comments ?? []) this.addThread(c.path, c.line, c.body, login);
      return json(review);
    }
    if ((match = route.match(/^\/pulls\/\d+\/reviews\/(\d+)(\/dismissals)?$/))) {
      const review = this.reviews.find(r => r.id === Number(match![1]));
      if (!review) return json({ message: 'Not Found' }, 404);
      if (match[2]) review.state = 'DISMISSED';
      else review.body = body.body;
      return json(review);
    }
    if (method === 'POST' && route === `/pulls/${PR_NUMBER}/comments`) {
      this.addThread(body.path, 0, body.body, login);
      return json({ id: this.nextId++ }, 201);
    }
    if (method === 'GET' && route.startsWith('/compare/') && headers.get('accept')?.includes('diff')) return text(PR_DIFF);
    if (method === 'GET' && route === `/contents/${INPUTS.config_path}` && this.headConfig && searchParams.get('ref') === this.headSha) {
      return json({ type: 'file', encoding: 'base64', size: this.headConfig.length, content: Buffer.from(this.headConfig).toString('base64') });
    }
    if (method === 'GET' && route === `/contents/src/math.ts`) {
      return json({ type: 'file', encoding: 'base64', size: MATH_TS.length, content: Buffer.from(MATH_TS).toString('base64') });
    }
    if (method === 'GET' && (match = route.match(/^\/actions\/runs\/(\d+)$/))) {
      return json({ id: Number(match[1]), status: this.activeRuns.includes(Number(match[1])) ? 'in_progress' : 'completed', conclusion: null });
    }
    if (method === 'GET' && route === '') return json({ full_name: `${OWNER}/${REPO}`, description: null });
    return json({ message: 'Not Found' }, 404);
  };

  /** Adds a review thread whose first comment is `body`. GraphQL reports a bot without its `[bot]` suffix. */
  addThread(path: string, line: number, body: string, login: string, isResolved = false): FakeThread {
    const id = `PRRT_${this.threads.length + 1}`;
    const thread = {
      id, isResolved, resolvedBy: null, path, line, startLine: null, originalLine: line,
      comments: [{ databaseId: this.nextId++, body, url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}#discussion_${id}`, authorAssociation: 'NONE', author: { login: login.replace(/\[bot\]$/, '') } }],
    };
    this.threads.push(thread);
    return thread;
  }

  addComment(body: string, login: string, at = new Date(Date.now() - 3_600_000).toISOString()): void {
    this.comments.push({ id: this.nextId++, body, user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' }, created_at: at, updated_at: at });
  }

  addReview(body: string, state: string, commitId: string, login: string): FakeReview {
    const review = { id: this.nextId++, body, state, commit_id: commitId, user: { login, type: 'Bot' }, submitted_at: new Date().toISOString() };
    this.reviews.push(review);
    return review;
  }

  /** The `RoundContext` a posted review carries in its body. */
  roundContext(review: FakeReview): RoundContext {
    const raw = review.body.match(/<!-- manki-context: (.+?) -->/)?.[1] ?? review.body.match(/```json\s*([\s\S]*?)```/)?.[1];
    if (!raw) throw new Error(`review #${review.id} has no context block`);
    return JSON.parse(raw);
  }

  private page(url: string, items: unknown[], params: URLSearchParams): Response {
    const perPage = Number(params.get('per_page') ?? 30);
    const page = Number(params.get('page') ?? 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < items.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      next.searchParams.set('per_page', String(perPage));
      headers.link = `<${next}>; rel="next"`;
    }
    return json(slice, 200, headers);
  }

  private graphql(query: string, variables: Record<string, unknown>, login: string): unknown {
    const after = (cursor: unknown) => (typeof cursor === 'string' ? Number(cursor) : 0);
    const connection = <T>(items: T[], first: number, start: number) => ({
      nodes: items.slice(start, start + first),
      pageInfo: { hasNextPage: start + first < items.length, endCursor: String(start + first) },
    });
    if (query.includes('unresolveReviewThread') || query.includes('resolveReviewThread')) {
      const thread = this.threads.find(t => t.id === variables.threadId);
      if (thread) {
        thread.isResolved = !query.includes('unresolveReviewThread');
        thread.resolvedBy = thread.isResolved ? { login: login.replace(/\[bot\]$/, '') } : null;
      }
      return { resolveReviewThread: { thread: { isResolved: thread?.isResolved } }, unresolveReviewThread: { thread: { isResolved: thread?.isResolved } } };
    }
    if (query.includes('addPullRequestReviewThreadReply')) {
      const thread = this.threads.find(t => t.id === variables.threadId);
      thread?.comments.push({ databaseId: this.nextId++, body: String(variables.body), url: `${thread.comments[0].url}-reply`, authorAssociation: 'NONE', author: { login: login.replace(/\[bot\]$/, '') } });
      return { addPullRequestReviewThreadReply: { comment: { id: 'C_reply' } } };
    }
    if (query.includes('reviewThreads(')) {
      const page = connection(this.threads, 100, after(variables.cursor));
      const nodes = page.nodes.map(t => ({ ...t, comments: connection(t.comments, 10, 0) }));
      return { repository: { pullRequest: { reviewThreads: { ...page, nodes } } } };
    }
    if (query.includes('node(id: $threadId)')) {
      const thread = this.threads.find(t => t.id === variables.threadId);
      return { node: { comments: connection(thread?.comments ?? [], 100, after(variables.cursor)) } };
    }
    throw new Error(`Unexpected GraphQL query: ${query}`);
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function text(data: string): Response {
  return new Response(data, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

type Stage = 'planner' | 'reviewer' | 'judge' | 'verdict' | 'dedup';

const READY_REPLIES: Record<Stage, string> = {
  planner: JSON.stringify({ trivial: false, subtle: true, paired: false, judgeEffort: 'low', prType: 'refactor', language: 'typescript', context: 'math library' }),
  reviewer: '[]',
  judge: JSON.stringify({ summary: 'Nothing blocks merge.', findings: [] }),
  verdict: JSON.stringify({ verdict: 'READY', blockers: [], summary: 'Ready to merge.', whatThisDoes: 'Keeps the sum in a variable before returning it.', whatToTest: { steps: ['Call `add(1, 2)`. Expect 3.'] } }),
  dedup: '[]',
};

const BLOCKER = { severity: 'blocker', title: 'Sum is never range checked', file: 'src/math.ts', line: 2, description: 'Large inputs overflow silently.', suggestedFix: 'Check the range before adding.' };
const BLOCKER_REPLIES: Partial<Record<Stage, string>> = {
  reviewer: JSON.stringify([BLOCKER]),
  judge: JSON.stringify({ summary: 'One blocker.', findings: [{ id: 1, title: BLOCKER.title, severity: 'blocker', reasoning: 'Reachable from any caller.', confidence: 'high', reachability: 'reachable' }] }),
};

/**
 * An LLM client that answers each pipeline stage with a canned reply, picked by the stage's system prompt.
 * A call to the `hold` stage runs until `hold.until` settles. Every call rejects once its signal aborts.
 */
class FakeLLM {
  replies: Record<Stage, string> = { ...READY_REPLIES };
  calls: Stage[] = [];
  aborted: Stage[] = [];
  hold?: { stage: Stage; until: Promise<void> };
  onCall?: (stage: Stage) => void;

  async sendMessage(system: string, _user: string, options?: SendMessageOptions): Promise<{ content: string }> {
    const stage: Stage = system.startsWith('You give the final merge-readiness verdict') ? 'verdict'
      : system.startsWith('You are a code review judge') ? 'judge'
        : system.startsWith('You are deduplicating') ? 'dedup'
          : system.includes('"judgeEffort"') ? 'planner'
            : 'reviewer';
    this.calls.push(stage);
    this.onCall?.(stage);
    const signal = options?.signal;
    try {
      if (stage === this.hold?.stage) {
        const { until } = this.hold;
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
          until.then(resolve);
        });
      }
      signal?.throwIfAborted();
    } catch (error) {
      this.aborted.push(stage);
      throw error;
    }
    return { content: this.replies[stage] };
  }
}

// Fakes only `setInterval`, so a test moves the head watcher on by hand while everything else runs in real time.
const FAKE_INTERVALS: Parameters<typeof jest.useFakeTimers>[0] = {
  doNotFake: ['Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout'],
};

let mockGitHub: FakeGitHub;
let mockLLM: FakeLLM;

const INPUTS: Record<string, string> = {
  github_token: 'ghs_workflow',
  anthropic_api_key: 'sk-ant-test',
  config_path: 'manki-e2e-absent.yml',
  manki_token_url: TOKEN_URL,
};

function reviewRound(trigger = 'pull_request:opened', force = false): Promise<void> {
  return runFullReview(OWNER, REPO, PR_NUMBER, mockGitHub.headSha, 'main', { title: 'Keep the sum in a variable', body: 'Small refactor.', baseBranch: 'main' }, {
    prAuthorLogin: 'alice',
    headRepoFullName: `${OWNER}/${REPO}`,
    trigger: { event: trigger, sender: 'alice' },
    ...(force && { forceReview: true, skipCap: true, bypassHint: 'manual_review_command' as const }),
  });
}

/** Runs a second round on the same commit, as `@manki review` does. */
function forcedRound(): Promise<void> {
  return reviewRound('issue_comment:created:@manki review', true);
}

function postedReviews(login = APP_LOGIN): FakeReview[] {
  return mockGitHub.reviews.filter(r => r.user.login === login);
}

describe('runFullReview end to end', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.mocked(core.warning).mockReset();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
    mockContext.eventName = 'pull_request';
    mockContext.payload = {};
    mockGitHub = new FakeGitHub();
    mockLLM = new FakeLLM();
    jest.mocked(core.getInput).mockImplementation((name: string) => INPUTS[name] ?? '');
    jest.mocked(core.getIDToken).mockResolvedValue('oidc-token');
    jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => mockGitHub.fetch(String(url), init));
  });

  it('approves a clean round, records it, and retires the notices the verdict makes stale', async () => {
    const pauseNotice = `The last Manki round found a blocker that came back after a fix. Automatic review is paused. Tick the box to run another round:\n\n- [x] Force review\n\n${BOT_MARKER}\n${FORCE_CAP_MARKER}`;
    mockGitHub.addComment(pauseNotice, APP_LOGIN);
    mockGitHub.addComment(`**Auto-approve withheld** for \`a1b2c3d\`.\n\n${STALE_APPROVE_MARKER_PREFIX}${HEAD_SHA} -->`, APP_LOGIN);
    mockGitHub.addComment(`**Auto-approve withheld** for \`0f0f0f0\`.\n\n${STALE_APPROVE_MARKER_PREFIX}${'0f'.repeat(20)} -->`, APP_LOGIN);
    mockGitHub.addComment(`Quoting it: ${STALE_APPROVE_MARKER_PREFIX}${HEAD_SHA} -->`, 'alice');
    mockGitHub.addComment(pauseNotice, 'alice');

    await reviewRound();

    expect(core.setFailed).not.toHaveBeenCalled();
    const [review] = postedReviews();
    expect(review).toMatchObject({ state: 'APPROVED', commit_id: HEAD_SHA });
    // Only Manki's notice for the reviewed head goes. The one for another head and a quote of the marker stay.
    expect(mockGitHub.comments.filter(c => c.body.includes(STALE_APPROVE_MARKER_PREFIX)).map(c => c.user.login)).toEqual([APP_LOGIN, 'alice']);
    expect(mockGitHub.comments.filter(c => c.body.includes(FORCE_CAP_MARKER)).map(c => c.body)).toEqual([
      `Automatic review was paused. Review resumed on \`a1b2c3d\`.\n\n${BOT_MARKER}\n${FORCE_CAP_MARKER}`,
      pauseNotice,
    ]);
    expect(mockGitHub.roundContext(review)).toMatchObject({
      meta: { round: 1, outcome: 'READY' },
      verdict: 'APPROVE',
      routing: { class: 'internal', classSource: 'triage', group: 'solo', groupSource: 'routing', configSource: 'builtin', reviewers: [expect.objectContaining({ effort: 'high' })] },
    });
    expect(mockLLM.calls).toEqual(['planner', 'reviewer', 'judge', 'verdict']);
    expect(core.setOutput).toHaveBeenCalledWith('verdict', 'APPROVE');
  });

  it('ends INCOMPLETE and never approves when a reviewer reply does not parse', async () => {
    mockLLM.replies.reviewer = 'I could not finish the review.';

    await reviewRound();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Review incomplete'));
    expect(postedReviews().map(r => r.state)).toEqual(['COMMENTED']);
    expect(mockLLM.calls).not.toContain('judge');
  });

  it('ends INCOMPLETE and never approves when the judge reply does not parse', async () => {
    Object.assign(mockLLM.replies, BLOCKER_REPLIES, { judge: 'The findings look fine to me.' });

    await reviewRound();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('The judge failed'));
    expect(postedReviews().map(r => r.state)).toEqual(['COMMENTED']);
    expect(mockLLM.calls).not.toContain('verdict');
  });

  it('fails the run and keeps the previous review when posting the review returns 5xx', async () => {
    const previous = mockGitHub.addReview(`${BOT_MARKER}\nChanges requested.`, 'CHANGES_REQUESTED', 'old0000000000000000000000000000000000000', APP_LOGIN);
    mockGitHub.failures.push({ method: 'POST', path: /\/pulls\/\d+\/reviews$/, status: 502 });

    await reviewRound();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Review failed'));
    expect(mockGitHub.reviews).toEqual([previous]);
    expect(previous.state).toBe('CHANGES_REQUESTED');
    expect(mockGitHub.comments.at(-1)?.body).toContain('Review failed');
  });

  it.each([
    ['the finders run', 'reviewer', ['planner', 'reviewer']],
    ['the verdict reader runs', 'verdict', ['planner', 'reviewer', 'judge', 'verdict']],
  ] as const)('posts no verdict and marks the progress comment superseded when a push lands while %s', async (_label, pushDuring, calls) => {
    mockLLM.onCall = stage => {
      if (stage === pushDuring) mockGitHub.headSha = 'f00dfeed00000000000000000000000000000000';
    };

    await reviewRound();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(mockGitHub.reviews).toEqual([]);
    expect(mockLLM.calls).toEqual(calls);
    expect(mockGitHub.comments.at(-1)?.body).toContain('**Review superseded** by the new commit `f00dfee`');
  });

  it('aborts a model call still running once the watcher sees the head move, and posts no review', async () => {
    jest.useFakeTimers(FAKE_INTERVALS);
    mockLLM.hold = { stage: 'verdict', until: new Promise(() => {}) };
    mockLLM.onCall = stage => {
      if (stage !== 'verdict') return;
      mockGitHub.headSha = 'f00dfeed00000000000000000000000000000000';
      jest.advanceTimersByTime(30_000);
    };

    await reviewRound();

    expect(mockLLM.aborted).toEqual(['verdict']);
    expect(mockLLM.calls).toEqual(['planner', 'reviewer', 'judge', 'verdict']);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(mockGitHub.reviews).toEqual([]);
    expect(mockGitHub.comments.at(-1)?.body).toContain('**Review superseded** by the new commit `f00dfee`. No verdict was posted');
  });

  it('completes the round when the head moves once the previous review is being dismissed', async () => {
    jest.useFakeTimers(FAKE_INTERVALS);
    const previous = mockGitHub.addReview(`${BOT_MARKER}\nChanges requested.`, 'CHANGES_REQUESTED', 'old0000000000000000000000000000000000000', APP_LOGIN);
    mockGitHub.onWrite = async write => {
      if (!write.endsWith('/dismissals')) return;
      mockGitHub.headSha = 'f00dfeed00000000000000000000000000000000';
      jest.advanceTimersByTime(30_000);
      // Gives the head check the watcher just started time to finish before the dismissal returns.
      await new Promise(resolve => setTimeout(resolve, 50));
    };

    await reviewRound();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(previous.state).toBe('DISMISSED');
    expect(postedReviews().map(r => r.state)).toEqual(['DISMISSED', 'APPROVED']);
    expect(mockGitHub.comments.at(-1)?.body).toContain('**Review complete**');
    expect(core.setOutput).toHaveBeenCalledWith('verdict', 'APPROVE');
  });

  it('keeps reviewing when a head check of the watcher fails', async () => {
    jest.useFakeTimers(FAKE_INTERVALS);
    const pollFailed = new Promise<void>(resolve => jest.mocked(core.warning).mockImplementation(message => {
      if (String(message).includes('Head SHA lookup failed, proceeding')) resolve();
    })).then(() => { mockGitHub.failures = []; });
    mockLLM.hold = { stage: 'verdict', until: pollFailed };
    mockLLM.onCall = stage => {
      if (stage !== 'verdict') return;
      mockGitHub.failures.push({ method: 'GET', path: new RegExp(`/pulls/${PR_NUMBER}$`), status: 502 });
      jest.advanceTimersByTime(30_000);
    };

    await reviewRound();

    expect(mockLLM.aborted).toEqual([]);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(postedReviews().map(r => r.state)).toEqual(['APPROVED']);
  });

  it.each([
    ['the verdict reader runs', 'verdict', ['verdict'], ['CHANGES_REQUESTED']],
    ['the review is just posted', 'posted', [], ['CHANGES_REQUESTED', 'APPROVED']],
  ] as const)('writes nothing more to GitHub once SIGTERM lands while %s', async (_label, moment, aborted, states) => {
    const listeners = new Map<string | symbol, (signal: NodeJS.Signals) => void>();
    jest.spyOn(process, 'on').mockImplementation(((event: string | symbol, listener: (signal: NodeJS.Signals) => void) => {
      listeners.set(event, listener);
      return process;
    }) as typeof process.on);
    const previous = mockGitHub.addReview(`${BOT_MARKER}\nChanges requested.`, 'CHANGES_REQUESTED', 'old0000000000000000000000000000000000000', APP_LOGIN);
    mockContext.payload = {
      action: 'opened',
      sender: { login: 'alice', type: 'User' },
      pull_request: { number: PR_NUMBER, title: 'Keep the sum in a variable', body: 'Small refactor.', draft: false, head: { sha: HEAD_SHA, repo: { full_name: `${OWNER}/${REPO}` } }, base: { ref: 'main' }, user: { login: 'alice' } },
    };
    let writesAtSignal = -1;
    const sigterm = () => {
      listeners.get('SIGTERM')!('SIGTERM');
      writesAtSignal = mockGitHub.writes.length;
    };
    if (moment === 'verdict') {
      mockLLM.onCall = stage => { if (stage === 'verdict') sigterm(); };
    } else {
      mockGitHub.onWrite = write => { if (write === `POST /repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`) sigterm(); };
    }

    await main();

    expect(writesAtSignal).toBeGreaterThan(0);
    expect(mockGitHub.writes).toHaveLength(writesAtSignal);
    expect(mockLLM.aborted).toEqual(aborted);
    expect(mockGitHub.reviews.map(r => r.state)).toEqual(states);
    expect(previous.state).toBe('CHANGES_REQUESTED');
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('The run was cancelled by SIGTERM, writing nothing more to GitHub');
  });

  it.each([
    ['an older commit, so the push run reviews the new head', 'deadbeef00000000000000000000000000000000', ['APPROVED']],
    ['the same commit, so the push run skips', HEAD_SHA, []],
  ])('handles a push while a `/manki review` run reviews %s', async (_label, reviewedSha, states) => {
    const oldProgress = `${BOT_MARKER}\n${RUN_ID_MARKER_PREFIX}6999 -->\n<!-- manki-commit:${reviewedSha} -->\n**Review started**`;
    mockGitHub.addComment(oldProgress, APP_LOGIN, new Date().toISOString());
    mockGitHub.activeRuns.push(6999);
    mockContext.payload = {
      action: 'synchronize',
      sender: { login: 'alice', type: 'User' },
      pull_request: { number: PR_NUMBER, title: 'Keep the sum in a variable', body: 'Small refactor.', draft: false, head: { sha: HEAD_SHA, repo: { full_name: `${OWNER}/${REPO}` } }, base: { ref: 'main' }, user: { login: 'alice' } },
    };

    await handlePullRequest();

    expect(postedReviews().map(r => [r.state, r.commit_id])).toEqual(states.map(state => [state, HEAD_SHA]));
    const skipped = mockGitHub.comments.some(c => c.body.includes('**Review skipped**'));
    expect(skipped).toBe(states.length === 0);
    // The older run's comment is its own: the push run neither takes it as its lock nor rewrites it.
    expect(mockGitHub.comments.find(c => c.body.includes(`${RUN_ID_MARKER_PREFIX}6999 -->`))?.body).toBe(oldProgress);
    expect(mockGitHub.comments.some(c => c.body.includes(CANCELLED_MARKER))).toBe(false);
  });

  it('reads past the first 100 comments and review threads', async () => {
    for (let i = 0; i < 150; i++) mockGitHub.addComment(`Comment ${i}`, 'alice');
    for (let i = 0; i < 120; i++) mockGitHub.addThread('src/math.ts', 2, `Question ${i}`, 'bob', true);
    Object.assign(mockLLM.replies, BLOCKER_REPLIES);
    await reviewRound();
    expect(postedReviews().map(r => r.state)).toEqual(['CHANGES_REQUESTED']);
    expect(mockGitHub.threads).toHaveLength(121);

    Object.assign(mockLLM.replies, READY_REPLIES);
    await forcedRound();

    const second = mockGitHub.roundContext(postedReviews()[1]);
    expect(second.meta.round).toBe(2);
    expect(second.judge.openThreadCount).toBe(1);

    // A live progress comment from another run, past the first page of comments, holds the PR.
    mockGitHub.addComment(`${BOT_MARKER}\n${RUN_ID_MARKER_PREFIX}6999 -->\n**Review started**`, APP_LOGIN, new Date().toISOString());
    await forcedRound();
    expect(postedReviews()).toHaveLength(2);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('another Manki run (id=6999)'));
  });

  it('keeps a blocker in its open thread across a rebase, then resolves it once a round confirms the fix', async () => {
    Object.assign(mockLLM.replies, BLOCKER_REPLIES);
    await reviewRound();
    expect(mockGitHub.threads).toHaveLength(1);

    // A rebase with the thread open and unanswered: the judge names the same blocker in new words.
    mockGitHub.headSha = 'b2'.repeat(20);
    const reworded = { ...BLOCKER, title: 'Adding two numbers can overflow' };
    Object.assign(mockLLM.replies, {
      reviewer: JSON.stringify([reworded]),
      judge: JSON.stringify({
        summary: 'The range check is still missing.',
        findings: [{ id: 1, title: reworded.title, severity: 'blocker', reasoning: 'Still reachable.', confidence: 'high', reachability: 'reachable', sameAs: 'B1' }],
        threadEvaluations: [{ threadId: 'PRRT_1', status: 'not_addressed', reason: 'No range check yet.' }],
      }),
    });
    await reviewRound();

    const rebased = postedReviews()[1];
    expect(rebased.state).toBe('CHANGES_REQUESTED');
    expect(mockGitHub.roundContext(rebased).meta.outcome).toBe('ADDRESS_FIRST');
    expect(rebased.body).toContain('**Still open from earlier reviews:**\n- `src/math.ts:2`: Sum is never range checked ([view thread](https://github.com/acme/widgets/pull/42#discussion_PRRT_1))');
    expect(mockGitHub.threads).toHaveLength(1);

    mockGitHub.headSha = 'c3'.repeat(20);
    Object.assign(mockLLM.replies, READY_REPLIES, {
      judge: JSON.stringify({ summary: 'The range check is in place.', findings: [], threadEvaluations: [{ threadId: 'PRRT_1', status: 'addressed', reason: 'The sum is checked now.' }] }),
    });
    await reviewRound();

    expect(postedReviews()[2].state).toBe('APPROVED');
    const [thread] = mockGitHub.threads;
    expect(thread.isResolved).toBe(true);
    expect(thread.comments.at(-1)?.body).toMatch(/^Fixed in c3c3c3c\./);
  });

  it('recognises its own comments, reviews and threads when it posts with the Actions token', async () => {
    jest.mocked(core.getIDToken).mockRejectedValue(new Error('no OIDC'));
    for (let i = 0; i < 40; i++) mockGitHub.addComment(`Comment ${i}`, 'alice');
    Object.assign(mockLLM.replies, BLOCKER_REPLIES);
    await reviewRound();

    Object.assign(mockLLM.replies, READY_REPLIES);
    await forcedRound();

    const [first, second] = postedReviews(ACTIONS_LOGIN);
    expect(first.state).toBe('DISMISSED');
    expect(mockGitHub.roundContext(second)).toMatchObject({ meta: { round: 2 }, judge: { openThreadCount: 1 } });
    expect(mockGitHub.comments.filter(c => c.body.includes('<!-- manki-app-warning -->'))).toHaveLength(1);
  });

  describe('dispatched by the webhook service', () => {
    const eventName = process.env.GITHUB_EVENT_NAME;
    beforeEach(() => { process.env.GITHUB_EVENT_NAME = 'workflow_dispatch'; });
    afterEach(() => {
      if (eventName === undefined) delete process.env.GITHUB_EVENT_NAME;
      else process.env.GITHUB_EVENT_NAME = eventName;
    });

    function dispatch(inputs: Record<string, string>): Promise<void> {
      Object.assign(mockContext, { eventName: 'workflow_dispatch', actor: APP_LOGIN, payload: { inputs, sender: { login: APP_LOGIN, type: 'Bot' } } });
      return main();
    }

    it('reviews a push with the config the PR carries at its head', async () => {
      mockGitHub.headConfig = 'planner:\n  enabled: false\n';

      await dispatch({ event: 'pull_request', action: 'synchronize', pr: String(PR_NUMBER), head_sha: HEAD_SHA, delivery_id: '72d3162e-cc78-11e3-81ab-4c9367dc0958' });

      expect(core.setFailed).not.toHaveBeenCalled();
      const [review] = postedReviews();
      expect(review).toMatchObject({ state: 'APPROVED', commit_id: HEAD_SHA });
      expect(mockGitHub.roundContext(review).meta.trigger).toEqual({ event: 'pull_request:synchronize', sender: 'alice' });
      expect(mockLLM.calls).not.toContain('planner');
    });

    it('writes nothing for a push the PR head has moved past', async () => {
      await dispatch({ event: 'pull_request', action: 'synchronize', pr: String(PR_NUMBER), head_sha: 'b2'.repeat(20) });

      expect(core.setFailed).not.toHaveBeenCalled();
      expect(mockGitHub.writes).toEqual([]);
      expect(mockLLM.calls).toEqual([]);
    });

    it('runs the auto-approve check when someone resolves the last open thread', async () => {
      Object.assign(mockLLM.replies, BLOCKER_REPLIES);
      await reviewRound();
      const [thread] = mockGitHub.threads;
      Object.assign(thread, { isResolved: true, resolvedBy: { login: 'bob' } });
      mockLLM.calls = [];

      await dispatch({ event: 'pull_request_review_thread', action: 'resolved', pr: String(PR_NUMBER), delivery_id: '72d3162e-cc78-11e3-81ab-4c9367dc0959' });

      expect(core.setFailed).not.toHaveBeenCalled();
      expect(mockLLM.calls).toEqual([]);
      expect(postedReviews().map(r => [r.state, r.commit_id])).toEqual([['DISMISSED', HEAD_SHA], ['APPROVED', HEAD_SHA]]);
    });

    it('never approves a PR that conflicts with its base, and says so once per head', async () => {
      mockGitHub.mergeable = false;
      const held = '**Approval held:** this PR conflicts with `main`. Rebase it, and Manki reviews the result.';
      Object.assign(mockLLM.replies, BLOCKER_REPLIES);
      await reviewRound();
      Object.assign(mockGitHub.threads[0], { isResolved: true, resolvedBy: { login: 'bob' } });

      for (const id of ['0a', '0b']) {
        await dispatch({ event: 'pull_request_review_thread', action: 'resolved', pr: String(PR_NUMBER), delivery_id: `72d3162e-cc78-11e3-81ab-4c9367dc09${id}` });
      }

      expect(core.setFailed).not.toHaveBeenCalled();
      expect(postedReviews().map(r => r.state)).toEqual(['CHANGES_REQUESTED']);
      expect(mockGitHub.comments.filter(c => c.body.startsWith(held)).map(c => c.user.login)).toEqual([APP_LOGIN]);

      Object.assign(mockLLM.replies, READY_REPLIES);
      await forcedRound();

      const ready = postedReviews()[1];
      expect(ready.state).toBe('COMMENTED');
      expect(ready.body.startsWith(`${held}\n\n\u2705 **Approved.**`)).toBe(true);
      expect(mockGitHub.roundContext(ready)).toMatchObject({ meta: { outcome: 'READY' }, verdict: 'APPROVE' });
      expect(mockGitHub.comments.filter(c => c.body.startsWith(held))).toEqual([]);
    });

    it('answers a reply in a Manki thread as the person who wrote it', async () => {
      Object.assign(mockLLM.replies, BLOCKER_REPLIES);
      await reviewRound();
      const [thread] = mockGitHub.threads;
      const reply = { databaseId: 9001, body: 'The inputs are bounded by the caller.', url: `${thread.comments[0].url}-9001`, authorAssociation: 'OWNER', author: { login: 'alice' } };
      thread.comments.push(reply);
      mockLLM.replies.reviewer = 'Agreed. The caller bounds the inputs, so the sum cannot overflow.';
      mockLLM.calls = [];

      await dispatch({ event: 'pull_request_review_comment', action: 'created', pr: String(PR_NUMBER), comment_id: String(reply.databaseId) });

      expect(core.setFailed).not.toHaveBeenCalled();
      expect(mockLLM.calls).toEqual(['reviewer']);
      expect(thread.comments.at(-1)?.body).toMatch(/^Agreed\. The caller bounds the inputs/);
      expect(thread.isResolved).toBe(true);
    });
  });
});
