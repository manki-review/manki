import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

import { changeThreadThroughService, createAuthenticatedOctokit, fetchPrState, reportPrState, resolveGitHubToken, tokenServiceCalls, TokenResult, TokenServiceError } from './auth';

jest.mock('@actions/core');
jest.mock('@actions/github');

const mockGetInput = core.getInput as jest.MockedFunction<typeof core.getInput>;

const TOKEN_URL = 'https://manki-api.dustinface.me/token';
const OWNER = 'test-owner';
const REPO = 'test-repo';
const APP_TOKEN = 'ghs_app_token_456';

function mockFetch(impl: (url: string, opts?: RequestInit) => Promise<Response>) {
  global.fetch = jest.fn(impl) as jest.Mock;
}

describe('resolveGitHubToken', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns app token when OIDC and token service succeed', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => {
      return new Response(
        JSON.stringify({ token: APP_TOKEN, expires_at: '2026-03-28T12:00:00Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await resolveGitHubToken(TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: APP_TOKEN });
    expect(core.setSecret).toHaveBeenCalledWith(APP_TOKEN);
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('manki-review[bot]'));

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe(TOKEN_URL);
    expect(call[1].headers['Authorization']).toBe('Bearer fake-oidc-token');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ owner: OWNER, repo: REPO });
  });

  const tokenReply = () => Response.json({ token: APP_TOKEN, expires_at: '2026-03-28T12:00:00Z' });

  /** Runs `resolveGitHubToken` past the wait before its retry. */
  async function resolveWithRetryWait(): Promise<TokenResult> {
    jest.useFakeTimers();
    try {
      const result = resolveGitHubToken(TOKEN_URL, OWNER, REPO);
      result.catch(() => {});
      await jest.advanceTimersByTimeAsync(2000);
      return await result;
    } finally {
      jest.useRealTimers();
    }
  }

  it('fails without retrying when the run has no OIDC token, the service refuses or the reply has no token', async () => {
    jest.spyOn(core, 'getIDToken').mockRejectedValueOnce(new Error('OIDC not available'));
    await expect(resolveGitHubToken(TOKEN_URL, OWNER, REPO)).rejects.toThrow(
      new TokenServiceError('no OIDC token, so the workflow needs `id-token: write`'),
    );

    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    for (const [reply, reason] of [
      [new Response('Not Found', { status: 404 }), 'HTTP 404'],
      [Response.json({ token: '' }), 'a reply without a token'],
      [Response.json({ expires_at: '2026-03-28T12:00:00Z' }), 'a reply without a token'],
      [Response.json({ token: 12345 }), 'a reply without a token'],
    ] as const) {
      mockFetch(async () => reply);
      await expect(resolveGitHubToken(TOKEN_URL, OWNER, REPO))
        .rejects.toThrow(`Could not get a token from the Manki token service (${reason}). Retry the run.`);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['a timeout', () => Promise.reject(new DOMException('This operation was aborted', 'AbortError'))],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 5xx', async () => new Response('Bad Gateway', { status: 502 })],
  ])('tries once more after %s, and uses the token of the retry', async (_case, firstReply) => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    global.fetch = jest.fn().mockImplementationOnce(firstReply).mockImplementationOnce(async () => tokenReply()) as jest.Mock;

    expect(await resolveWithRetryWait()).toEqual<TokenResult>({ token: APP_TOKEN });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('trying again'));
  });

  it('fails after the retry fails too', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => new Response('Service Unavailable', { status: 503 }));
    await expect(resolveWithRetryWait()).rejects.toThrow('Could not get a token from the Manki token service (HTTP 503). Retry the run.');

    mockFetch(async () => { throw new TypeError('fetch failed'); });
    await expect(resolveWithRetryWait()).rejects.toThrow('(TypeError: fetch failed)');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

const mockGetOctokit = github.getOctokit as jest.MockedFunction<typeof github.getOctokit>;
const mockCreateAppAuth = createAppAuth as jest.MockedFunction<typeof createAppAuth>;

describe('fetchPrState', () => {
  beforeEach(() => {
    mockGetInput.mockReset().mockReturnValue('');
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads the settings, the last reviewed commit, the modes of this run and the modes still queued', async () => {
    mockFetch(async () => Response.json({
      active: [{ run_id: 7, modes: ['full', 'bogus'] }, { run_id: 8, modes: ['deeper'] }],
      queue: [{ modes: ['force'] }, { modes: 'draft' }, null],
      settings: { paused: true },
      last_reviewed: { commit: 'a'.repeat(40), run_id: 6, at: '2026-11-07T00:00:00.000Z' },
    }));

    expect(await fetchPrState(OWNER, REPO, 12, 7)).toEqual({
      settings: { paused: true }, lastReviewed: 'a'.repeat(40), runModes: new Set(['full']), queuedModes: new Set(['force']),
    });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://manki-api.dustinface.me/state');
    expect(init.headers['Authorization']).toBe('Bearer fake-oidc-token');
    expect(JSON.parse(init.body)).toEqual({ owner: OWNER, repo: REPO, pr: 12 });
  });

  it('reads the state next to a custom token URL, and counts settings that are not a boolean pause as not paused', async () => {
    mockGetInput.mockImplementation((name: string) => (name === 'manki_token_url' ? 'https://custom.example.com/api/token' : ''));
    mockFetch(async () => Response.json({ active: [], queue: [], settings: { paused: 'yes' }, last_reviewed: null }));

    expect(await fetchPrState(OWNER, REPO, 12, 7)).toEqual({ settings: { paused: false }, runModes: new Set(), queuedModes: new Set() });
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('https://custom.example.com/api/state');
  });

  it.each([
    ['the run has no OIDC token', () => jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('no OIDC'))],
    ['the service has no `/state`', () => mockFetch(async () => new Response('Not Found', { status: 404 }))],
    ['the request fails', () => mockFetch(async () => { throw new Error('network down'); })],
    ['the reply is not JSON', () => mockFetch(async () => new Response('oops', { status: 200 }))],
  ])('returns null with one warning when %s', async (_case, arrange) => {
    jest.mocked(core.warning).mockClear();
    arrange();
    expect(await fetchPrState(OWNER, REPO, 12, 7)).toBeNull();
    expect(core.warning).toHaveBeenCalledTimes(1);
  });

  it('gives up on a reply whose body never arrives', async () => {
    jest.useFakeTimers();
    try {
      mockFetch(async (_url, init) => ({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      }) as unknown as Response);
      const state = fetchPrState(OWNER, REPO, 12, 7);
      await jest.advanceTimersByTimeAsync(10000);
      expect(await state).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('reportPrState', () => {
  beforeEach(() => {
    mockGetInput.mockReset().mockReturnValue('');
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    jest.mocked(core.warning).mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts the report for the PR to `/state/report` with the OIDC token', async () => {
    mockFetch(async () => Response.json({ changed: ['reviewed', 'pause'] }));
    const report = { reviewed: { commit: 'b'.repeat(40) }, approval: { commit: 'b'.repeat(40), held: true }, pause: null };

    await reportPrState(OWNER, REPO, 12, report);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://manki-api.dustinface.me/state/report');
    expect(init.headers['Authorization']).toBe('Bearer fake-oidc-token');
    expect(JSON.parse(init.body)).toEqual({ owner: OWNER, repo: REPO, pr: 12, ...report });
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    ['the run has no OIDC token', () => jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('no OIDC'))],
    ['the service refuses the report', () => mockFetch(async () => Response.json({ error: 'run 7 is not active on this PR' }, { status: 403 }))],
    ['the request fails', () => mockFetch(async () => { throw new Error('network down'); })],
  ])('warns once and goes on when %s', async (_case, arrange) => {
    arrange();
    await expect(reportPrState(OWNER, REPO, 12, { pause: { reason: 'Paused.' } })).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledTimes(1);
  });
});

describe('tokenServiceCalls', () => {
  beforeEach(() => {
    mockGetInput.mockReset().mockReturnValue('');
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs every call with its endpoint and status, and why a failed one failed, with the service\'s request id', async () => {
    const before = tokenServiceCalls().length;
    mockFetch(async () => Response.json({ active: [], queue: [], settings: {}, last_reviewed: null }));
    await fetchPrState(OWNER, REPO, 12, 7);
    mockFetch(async () => Response.json({ error: 'Too many requests', request_id: 'req-1' }, { status: 429 }));
    await reportPrState(OWNER, REPO, 12, { pause: null });
    mockFetch(async () => { throw new TypeError('fetch failed'); });
    await reportPrState(OWNER, REPO, 12, { pause: null });
    mockFetch(async () => new Response('Bad gateway', { status: 502 }));
    await fetchPrState(OWNER, REPO, 12, 7);
    jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('no OIDC'));
    await reportPrState(OWNER, REPO, 12, { pause: null });

    expect(tokenServiceCalls().slice(before)).toEqual([
      { endpoint: 'state', status: 200, durationMs: expect.any(Number) },
      { endpoint: 'state/report', status: 429, error: 'Too many requests', requestId: 'req-1', durationMs: expect.any(Number) },
      { endpoint: 'state/report', error: 'TypeError: fetch failed', durationMs: expect.any(Number) },
      { endpoint: 'state', status: 502, durationMs: expect.any(Number) },
      { endpoint: 'state/report', error: 'no OIDC token', durationMs: expect.any(Number) },
    ]);
  });
});

describe('createAuthenticatedOctokit', () => {
  beforeEach(() => {
    mockGetInput.mockReset();
    mockGetOctokit.mockReset();
    mockCreateAppAuth.mockReset();
    jest.restoreAllMocks();

    // Default context.repo
    Object.defineProperty(github.context, 'repo', {
      value: { owner: 'test-owner', repo: 'test-repo' },
      configurable: true,
    });
  });

  it('uses GitHub App auth scoped to the reviewed repo when appId and privateKey are provided', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_app_id') return '12345';
      if (name === 'github_app_private_key') return 'fake-private-key';
      if (name === 'github_token') return '';
      return '';
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockAuth: any = jest.fn()
      .mockResolvedValueOnce({ token: 'app-jwt-token' })
      .mockResolvedValueOnce({ token: 'installation-token-abc' });
    mockAuth.hook = jest.fn();
    mockCreateAppAuth.mockReturnValue(mockAuth);

    const fakeOctokit = {
      rest: {
        apps: {
          getAuthenticated: jest.fn().mockResolvedValue({ data: { slug: 'acme-reviewer' } }),
          getRepoInstallation: jest.fn().mockResolvedValue({ data: { id: 999 } }),
        },
      },
    };
    mockGetOctokit.mockReturnValue(fakeOctokit as unknown as ReturnType<typeof github.getOctokit>);

    const result = await createAuthenticatedOctokit();

    expect(mockCreateAppAuth).toHaveBeenCalledWith({ appId: 12345, privateKey: 'fake-private-key' });
    expect(mockAuth).toHaveBeenCalledWith({ type: 'app' });
    expect(mockAuth).toHaveBeenCalledWith({ type: 'installation', installationId: 999, repositoryNames: ['test-repo'] });
    expect(core.setSecret).toHaveBeenCalledWith('app-jwt-token');
    expect(core.setSecret).toHaveBeenCalledWith('installation-token-abc');
    expect(result.octokit).toBeDefined();
    expect(result.bot).toEqual({ logins: ['acme-reviewer[bot]'] });

  });

  it('throws when github_app_id is not a number', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_app_id') return 'not-a-number';
      if (name === 'github_app_private_key') return 'fake-private-key';
      if (name === 'github_token') return '';
      return '';
    });

    await expect(createAuthenticatedOctokit()).rejects.toThrow('Invalid github_app_id: "not-a-number" is not a number');
  });

  it('fails cleanly when the token service gives no token, and never falls back to github_token', async () => {
    mockGetInput.mockImplementation((name: string) => (name === 'github_token' ? 'ghs_workflow' : ''));
    jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('No OIDC'));

    await expect(createAuthenticatedOctokit()).rejects.toBeInstanceOf(TokenServiceError);
    expect(mockGetOctokit).not.toHaveBeenCalled();
  });

  it('retries a rate-limited request at most twice', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('oidc-token');
    mockFetch(async () => Response.json({ token: 'resolved-app-token' }));
    mockGetOctokit.mockReturnValue({} as ReturnType<typeof github.getOctokit>);

    await createAuthenticatedOctokit();

    const { throttle } = mockGetOctokit.mock.calls[0][1] as {
      throttle: Record<'onRateLimit' | 'onSecondaryRateLimit', (retryAfter: number, options: { method: string; url: string }, octokit: unknown, retryCount: number) => boolean>;
    };
    const request = { method: 'POST', url: '/repos/o/r/pulls/1/reviews' };
    for (const handler of [throttle.onRateLimit, throttle.onSecondaryRateLimit]) {
      expect(handler(5, request, {}, 0)).toBe(true);
      expect(handler(5, request, {}, 1)).toBe(true);
      expect(handler(5, request, {}, 2)).toBe(false);
    }
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('giving up after 2 retries'));
  });

  it('posts as the manki-review App with the token service\'s token', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_app_id') return '';
      if (name === 'github_app_private_key') return '';
      if (name === 'github_token') return 'ghp_test';
      if (name === 'manki_token_url') return '';
      return '';
    });

    jest.spyOn(core, 'getIDToken').mockResolvedValue('oidc-token');
    mockFetch(async () => Response.json({ token: 'resolved-app-token', expires_at: '2026-12-31T00:00:00Z' }));
    mockGetOctokit.mockReturnValue({} as ReturnType<typeof github.getOctokit>);

    const result = await createAuthenticatedOctokit();

    expect(result.bot).toEqual({ logins: ['manki-review[bot]'] });
    expect(mockGetOctokit).toHaveBeenCalledWith('resolved-app-token', expect.anything(), retry, throttling, expect.any(Function));
  });

  it('uses custom manki_token_url when provided', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_app_id') return '';
      if (name === 'github_app_private_key') return '';
      if (name === 'github_token') return 'ghp_test';
      if (name === 'manki_token_url') return 'https://custom.example.com/token';
      return '';
    });

    jest.spyOn(core, 'getIDToken').mockResolvedValue('oidc-token');
    mockFetch(async () => new Response(
      JSON.stringify({ token: 'custom-app-token', expires_at: '2026-12-31T00:00:00Z' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    mockGetOctokit.mockReturnValue({} as ReturnType<typeof github.getOctokit>);

    await createAuthenticatedOctokit();

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    expect(fetchCall[0]).toBe('https://custom.example.com/token');
  });

  it('wraps app auth failure in descriptive error', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_app_id') return '12345';
      if (name === 'github_app_private_key') return 'fake-private-key';
      if (name === 'github_token') return '';
      return '';
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockAuth: any = jest.fn()
      .mockResolvedValueOnce({ token: 'app-jwt-token' });
    mockAuth.hook = jest.fn();
    mockCreateAppAuth.mockReturnValue(mockAuth);

    const fakeOctokit = {
      rest: {
        apps: {
          getAuthenticated: jest.fn().mockResolvedValue({ data: { slug: 'acme-reviewer' } }),
          getRepoInstallation: jest.fn().mockRejectedValue(new Error('Not installed')),
        },
      },
    };
    mockGetOctokit.mockReturnValue(fakeOctokit as unknown as ReturnType<typeof github.getOctokit>);

    await expect(createAuthenticatedOctokit()).rejects.toThrow('GitHub App authentication failed');
  });
});

describe('changeThreadThroughService', () => {
  beforeEach(() => {
    mockGetInput.mockReset().mockImplementation((name: string) => (name === 'github_token' ? 'ghs_workflow' : ''));
    mockGetOctokit.mockReset().mockImplementation(() => ({}) as ReturnType<typeof github.getOctokit>);
    jest.restoreAllMocks();
    Object.defineProperty(github.context, 'repo', { value: { owner: OWNER, repo: REPO }, configurable: true });
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
  });

  /** Returns the client of a run whose review token came from the token service, then serves later calls with `reply`. */
  async function serviceClient(reply: (url: string, init?: RequestInit) => Promise<Response>) {
    mockFetch(async () => Response.json({ token: APP_TOKEN, expires_at: '2026-12-31T00:00:00Z' }));
    const { octokit } = await createAuthenticatedOctokit();
    mockFetch(reply);
    return octokit;
  }

  it('resolves and reopens a thread through `/resolve` with the OIDC token, for the token service\'s client only', async () => {
    const octokit = await serviceClient(async () => Response.json({ resolved: true }));
    expect(await changeThreadThroughService(octokit, 'PRRT_1', true, 'ADDRESSED')).toBe(true);
    expect(await changeThreadThroughService(octokit, 'PRRT_1', false)).toBe(true);
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.map(([url]) => url)).toEqual(['https://manki-api.dustinface.me/resolve', 'https://manki-api.dustinface.me/resolve']);
    expect(calls[0][1].headers['Authorization']).toBe('Bearer fake-oidc-token');
    expect(calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { owner: OWNER, repo: REPO, thread_id: 'PRRT_1', resolved: true, reason: 'ADDRESSED' },
      { owner: OWNER, repo: REPO, thread_id: 'PRRT_1', resolved: false },
    ]);

    // Any other client, such as a custom App's, changes its threads itself.
    mockFetch(async () => Response.json({ resolved: true }));
    expect(await changeThreadThroughService({} as ReturnType<typeof github.getOctokit>, 'PRRT_1', true)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['the service refuses the thread', () => mockFetch(async () => Response.json({ error: 'No Manki review thread' }, { status: 404 })), '(404)'],
    ['the run has lost its OIDC token', () => jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('no OIDC')), '(no OIDC token)'],
  ])('throws when %s, so the caller keeps the thread open', async (_case, arrange, detail) => {
    const octokit = await serviceClient(async () => Response.json({ resolved: true }));
    arrange();
    await expect(changeThreadThroughService(octokit, 'PRRT_1', true, 'ADDRESSED')).rejects.toThrow(`The token service did not resolve the thread ${detail}`);
  });
});
