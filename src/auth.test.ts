import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

import { createAuthenticatedOctokit, fetchPrState, reportPrState, resolveGitHubToken, TokenResult } from './auth';

jest.mock('@actions/core');
jest.mock('@actions/github');

const mockGetInput = core.getInput as jest.MockedFunction<typeof core.getInput>;

const GITHUB_TOKEN = 'ghp_test_token_123';
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

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: APP_TOKEN, identity: 'app' });
    expect(core.setSecret).toHaveBeenCalledWith(APP_TOKEN);
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('manki-review[bot]'));

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe(TOKEN_URL);
    expect(call[1].headers['Authorization']).toBe('Bearer fake-oidc-token');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ owner: OWNER, repo: REPO });
  });

  it('falls back to github_token when OIDC token is not available', async () => {
    jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('OIDC not available'));

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('OIDC token not available'));
  });

  it('falls back when token service returns not found', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => {
      return new Response('Not Found', { status: 404 });
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('not available'));
  });

  it('falls back when token service returns an error', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => {
      return new Response('Internal Server Error', { status: 500 });
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('not available'));
  });

  it('falls back when token service returns invalid response (empty token)', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => {
      return new Response(
        JSON.stringify({ token: '', expires_at: '2026-03-28T12:00:00Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('invalid response'));
  });

  it('falls back when token service returns invalid response (missing token)', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => {
      return new Response(
        JSON.stringify({ expires_at: '2026-03-28T12:00:00Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('invalid response'));
  });

  it('falls back on network error', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => {
      throw new Error('Network failure');
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('App token resolution failed'));
  });

  it('falls back when token is not a string type', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => {
      return new Response(
        JSON.stringify({ token: 12345, expires_at: '2026-03-28T12:00:00Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('invalid response'));
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
    expect(result.identity).toBe('app');
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

  it('throws when no auth is configured', async () => {
    mockGetInput.mockImplementation(() => '');

    await expect(createAuthenticatedOctokit()).rejects.toThrow('No authentication configured');
  });

  it('falls back to resolveGitHubToken when no app credentials', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_app_id') return '';
      if (name === 'github_app_private_key') return '';
      if (name === 'github_token') return 'ghp_fallback';
      if (name === 'manki_token_url') return '';
      return '';
    });

    // OIDC not available — forces fallback to github_token
    jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('No OIDC'));
    const getAuthenticated = jest.fn().mockResolvedValue({ data: { login: 'review-user' } });
    mockGetOctokit.mockReturnValue({ rest: { users: { getAuthenticated } } } as unknown as ReturnType<typeof github.getOctokit>);

    const result = await createAuthenticatedOctokit();

    expect(result.octokit).toBeDefined();
    expect(result.identity).toBe('actions');
    expect(result.bot).toEqual({ logins: ['manki-review[bot]', 'github-actions[bot]', 'review-user'] });
    expect(mockGetOctokit).toHaveBeenCalledWith('ghp_fallback', expect.anything(), retry, throttling, expect.any(Function));
  });

  it('keeps the default identity for the workflow token and when the token user cannot be resolved', async () => {
    jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('No OIDC'));
    const getAuthenticated = jest.fn().mockRejectedValue(new Error('Bad credentials'));
    mockGetOctokit.mockReturnValue({ rest: { users: { getAuthenticated } } } as unknown as ReturnType<typeof github.getOctokit>);

    mockGetInput.mockImplementation((name: string) => (name === 'github_token' ? 'ghs_workflow' : ''));
    expect((await createAuthenticatedOctokit()).bot).toEqual({ logins: ['manki-review[bot]', 'github-actions[bot]'] });
    expect(getAuthenticated).not.toHaveBeenCalled();

    jest.mocked(core.warning).mockClear();
    mockGetInput.mockImplementation((name: string) => (name === 'github_token' ? 'github_pat_broken' : ''));
    expect((await createAuthenticatedOctokit()).bot).toEqual({ logins: ['manki-review[bot]', 'github-actions[bot]'] });
    expect(getAuthenticated).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Bad credentials'));
  });

  it('retries a rate-limited request at most twice', async () => {
    mockGetInput.mockImplementation((name: string) => (name === 'github_token' ? 'ghp_fallback' : ''));
    jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('No OIDC'));
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

    expect(result.identity).toBe('app');
    expect(result.bot).toEqual({ logins: ['manki-review[bot]', 'github-actions[bot]'] });
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
