import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

import { AppMemory, createAuthenticatedOctokit, fetchPrState, getMemoryToken, resolveGitHubToken, TokenResult } from './auth';

jest.mock('@actions/core');
jest.mock('@actions/github');

const mockGetInput = core.getInput as jest.MockedFunction<typeof core.getInput>;

describe('getMemoryToken', () => {
  const MEMORY_REPO = 'owner/review-memory';
  const SERVICE_MEMORY: AppMemory = { tokenFor: async (repo) => (repo === MEMORY_REPO ? 'app-memory-token' : null) };

  beforeEach(() => {
    mockGetInput.mockReset();
    jest.mocked(core.warning).mockClear();
  });

  it('prefers memory_repo_token over the App memory token, for any memory repo', async () => {
    mockGetInput.mockImplementation((name: string) => (name === 'memory_repo_token' ? 'memory-token-123' : 'github-token-456'));

    expect(await getMemoryToken(SERVICE_MEMORY, MEMORY_REPO)).toBe('memory-token-123');
    expect(await getMemoryToken(SERVICE_MEMORY, 'acme/team-memory')).toBe('memory-token-123');
    expect(await getMemoryToken(undefined, MEMORY_REPO)).toBe('memory-token-123');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('returns the App memory token for the repo it covers', async () => {
    mockGetInput.mockImplementation((name: string) => (name === 'github_token' ? 'github-token-456' : ''));

    expect(await getMemoryToken(SERVICE_MEMORY, MEMORY_REPO)).toBe('app-memory-token');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    ['no App memory token', undefined, MEMORY_REPO],
    ['an App memory token for another repo', SERVICE_MEMORY, 'acme/team-memory'],
  ])('returns null with one warning for %s instead of falling back to github_token', async (_case, appMemory, memoryRepo) => {
    mockGetInput.mockImplementation((name: string) => (name === 'github_token' ? 'github-token-456' : ''));

    expect(await getMemoryToken(appMemory, memoryRepo)).toBeNull();
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining(`\`${memoryRepo}\``));
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('memory_repo_token'));
  });
});

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
    expect(JSON.parse(call[1].body)).toEqual({ owner: OWNER, repo: REPO, memory: true });
  });

  it('returns the memory token next to the app token and masks both', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => Response.json({
      token: APP_TOKEN,
      expires_at: '2026-03-28T12:00:00Z',
      memory_token: 'ghs_memory',
      memory_expires_at: '2026-03-28T12:00:00Z',
    }));

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: APP_TOKEN, memoryToken: 'ghs_memory', identity: 'app' });
    expect(core.setSecret).toHaveBeenCalledWith(APP_TOKEN);
    expect(core.setSecret).toHaveBeenCalledWith('ghs_memory');
  });

  it.each([['an empty', ''], ['a numeric', 42], ['a null', null]])('ignores %s memory token', async (_case, memoryToken) => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('fake-oidc-token');
    mockFetch(async () => Response.json({ token: APP_TOKEN, expires_at: '2026-03-28T12:00:00Z', memory_token: memoryToken }));

    expect(await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO)).toEqual<TokenResult>({ token: APP_TOKEN, identity: 'app' });
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

  it('reads the settings, the modes of this run and the modes still queued', async () => {
    mockFetch(async () => Response.json({
      active: [{ run_id: 7, modes: ['full', 'bogus'] }, { run_id: 8, modes: ['deeper'] }],
      queue: [{ modes: ['force'] }, { modes: 'draft' }, null],
      settings: { paused: true },
      last_reviewed: null,
    }));

    expect(await fetchPrState(OWNER, REPO, 12, 7)).toEqual({
      settings: { paused: true }, runModes: new Set(['full']), queuedModes: new Set(['force']),
    });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://manki-api.dustinface.me/state');
    expect(init.headers['Authorization']).toBe('Bearer fake-oidc-token');
    expect(JSON.parse(init.body)).toEqual({ owner: OWNER, repo: REPO, pr: 12 });
  });

  it('reads the state next to a custom token URL, and leaves out settings a Worker does not send', async () => {
    mockGetInput.mockImplementation((name: string) => (name === 'manki_token_url' ? 'https://custom.example.com/api/token' : ''));
    mockFetch(async () => Response.json({ active: [], queue: [], settings: { paused: 'yes' } }));

    expect(await fetchPrState(OWNER, REPO, 12, 7)).toEqual({ runModes: new Set(), queuedModes: new Set() });
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('https://custom.example.com/api/state');
  });

  it.each([
    ['the run has no OIDC token', () => jest.spyOn(core, 'getIDToken').mockRejectedValue(new Error('no OIDC'))],
    ['the service has no `/state`', () => mockFetch(async () => new Response('Not Found', { status: 404 }))],
    ['the request fails', () => mockFetch(async () => { throw new Error('network down'); })],
    ['the reply is not JSON', () => mockFetch(async () => new Response('oops', { status: 200 }))],
  ])('returns null when %s', async (_case, arrange) => {
    arrange();
    expect(await fetchPrState(OWNER, REPO, 12, 7)).toBeNull();
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
      .mockResolvedValueOnce({ token: 'installation-token-abc' })
      .mockResolvedValueOnce({ token: 'memory-token-def' })
      .mockRejectedValueOnce(Object.assign(new Error('Not installed on that repo'), { status: 422 }))
      .mockRejectedValueOnce(Object.assign(new Error('Bad gateway'), { status: 502 }));
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

    // The memory token is minted per memory repo, with only `contents: write`, and never reuses the review token.
    expect(await getMemoryToken(result.appMemory, 'test-owner/team-memory')).toBe('memory-token-def');
    expect(mockAuth).toHaveBeenLastCalledWith({
      type: 'installation', installationId: 999, repositoryNames: ['team-memory'], permissions: { contents: 'write' },
    });
    expect(core.setSecret).toHaveBeenCalledWith('memory-token-def');

    jest.mocked(core.warning).mockClear();
    expect(await getMemoryToken(result.appMemory, 'test-owner/not-installed')).toBeNull();
    expect(await getMemoryToken(result.appMemory, 'other-owner/review-memory')).toBeNull();
    expect(core.warning).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('`test-owner/not-installed`'));
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('memory_repo_token'));

    // A transient failure names its cause instead of the setup advice.
    jest.mocked(core.warning).mockClear();
    expect(await getMemoryToken(result.appMemory, 'test-owner/team-memory-2')).toBeNull();
    expect(mockAuth).toHaveBeenCalledTimes(5);
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Bad gateway'));
    expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('memory_repo_token'));
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
    expect(result.appMemory).toBeUndefined();
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

  it.each([
    ['the service\'s memory token', { memory_token: 'ghs_memory' }, 'ghs_memory'],
    ['no memory token from a service that predates it', {}, null],
  ])('passes %s to getMemoryToken, never the review token', async (_case, extra, expected) => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_app_id') return '';
      if (name === 'github_app_private_key') return '';
      if (name === 'github_token') return 'ghp_test';
      if (name === 'manki_token_url') return '';
      return '';
    });

    jest.spyOn(core, 'getIDToken').mockResolvedValue('oidc-token');
    mockFetch(async () => Response.json({ token: 'resolved-app-token', expires_at: '2026-12-31T00:00:00Z', ...extra }));
    mockGetOctokit.mockReturnValue({} as ReturnType<typeof github.getOctokit>);

    const result = await createAuthenticatedOctokit();

    expect(result.identity).toBe('app');
    expect(result.bot).toEqual({ logins: ['manki-review[bot]', 'github-actions[bot]'] });
    expect(await getMemoryToken(result.appMemory, `${OWNER}/review-memory`)).toBe(expected);
    expect(await getMemoryToken(result.appMemory, 'Test-Owner/Review-Memory')).toBe(expected);
    expect(await getMemoryToken(result.appMemory, `${OWNER}/team-memory`)).toBeNull();
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
