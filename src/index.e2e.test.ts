import * as core from '@actions/core';

import { BOT_MARKER, CANCELLED_MARKER, FORCE_CAP_MARKER, RUN_ID_MARKER_PREFIX } from './github';
import { _resetOctokitCache, handlePullRequest, runFullReview } from './index';
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
  createLLMClient: () => ({ sendMessage: (system: string, user: string) => mockLLM.sendMessage(system, user) }),
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
interface FakeThreadComment { body: string; url: string; authorAssociation: string; author: { login: string } }
interface FakeThread { id: string; isResolved: boolean; resolvedBy: { login: string } | null; path: string; line: number; startLine: number | null; originalLine: number; comments: FakeThreadComment[] }
interface FakeFailure { method: string; path: RegExp; status: number }

const REVIEW_STATES: Record<string, string> = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };

/** An in-memory GitHub REST and GraphQL API holding one pull request, its comments, reviews and review threads. */
class FakeGitHub {
  comments: FakeComment[] = [];
  reviews: FakeReview[] = [];
  threads: FakeThread[] = [];
  failures: FakeFailure[] = [];
  headSha = HEAD_SHA;
  activeRuns: number[] = [];
  private nextId = 1000;

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const { pathname, searchParams, origin } = new URL(url);
    const headers = new Headers(init.headers);
    const login = TOKEN_LOGINS[(headers.get('authorization') ?? '').replace(/^(token|bearer) /i, '')] ?? 'anonymous';
    const body = init.body ? JSON.parse(String(init.body)) : {};

    if (`${origin}${pathname}` === TOKEN_URL) return json({ token: 'ghs_app', expires_at: '2099-01-01T00:00:00Z' });
    const failure = this.failures.find(f => f.method === method && f.path.test(pathname));
    if (failure) return json({ message: 'Server Error' }, failure.status);
    if (pathname === '/graphql') return json({ data: this.graphql(body.query, body.variables ?? {}, login) });

    const route = decodeURIComponent(pathname).replace(`/repos/${OWNER}/${REPO}`, '');
    const user = { login, type: 'Bot' };
    const now = new Date().toISOString();
    let match: RegExpMatchArray | null;

    if (method === 'GET' && route === `/pulls/${PR_NUMBER}`) {
      if (headers.get('accept')?.includes('diff')) return text(PR_DIFF);
      return json({ number: PR_NUMBER, title: 'Keep the sum in a variable', body: 'Small refactor.', draft: false, head: { sha: this.headSha, ref: 'feature', repo: { full_name: `${OWNER}/${REPO}` } }, base: { ref: 'main' }, user: { login: 'alice' } });
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
      comments: [{ body, url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}#discussion_${id}`, authorAssociation: 'NONE', author: { login: login.replace(/\[bot\]$/, '') } }],
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
      thread?.comments.push({ body: String(variables.body), url: `${thread.comments[0].url}-reply`, authorAssociation: 'NONE', author: { login: login.replace(/\[bot\]$/, '') } });
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

/** An LLM client that answers each pipeline stage with a canned reply, picked by the stage's system prompt. */
class FakeLLM {
  replies: Record<Stage, string> = { ...READY_REPLIES };
  calls: Stage[] = [];
  onCall?: (stage: Stage) => void;

  async sendMessage(system: string, _user: string): Promise<{ content: string }> {
    const stage: Stage = system.startsWith('You give the final merge-readiness verdict') ? 'verdict'
      : system.startsWith('You are a code review judge') ? 'judge'
        : system.startsWith('You are deduplicating') ? 'dedup'
          : system.includes('"judgeEffort"') ? 'planner'
            : 'reviewer';
    this.calls.push(stage);
    this.onCall?.(stage);
    return { content: this.replies[stage] };
  }
}

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
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
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
    mockGitHub.addComment(`Quoting it: ${STALE_APPROVE_MARKER_PREFIX}${HEAD_SHA} -->`, 'alice');
    mockGitHub.addComment(pauseNotice, 'alice');

    await reviewRound();

    expect(core.setFailed).not.toHaveBeenCalled();
    const [review] = postedReviews();
    expect(review).toMatchObject({ state: 'APPROVED', commit_id: HEAD_SHA });
    expect(mockGitHub.comments.filter(c => c.body.includes(STALE_APPROVE_MARKER_PREFIX)).map(c => c.user.login)).toEqual(['alice']);
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
});
