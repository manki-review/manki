import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

import { createAuthenticatedOctokit, getMemoryToken, resolveGitHubToken, TokenResult } from './auth';

jest.mock('@actions/core');
jest.mock('@actions/github');

const mockGetInput = core.getInput as jest.MockedFunction<typeof core.getInput>;

describe('getMemoryToken', () => {
  beforeEach(() => {
    mockGetInput.mockReset();
  });

  it('returns memory_repo_token when set', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'memory_repo_token') return 'memory-token-123';
      if (name === 'github_token') return 'github-token-456';
      return '';
    });

    expect(getMemoryToken(null)).toBe('memory-token-123');
  });

  it('falls back to github_token when memory_repo_token is empty', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'memory_repo_token') return '';
      if (name === 'github_token') return 'github-token-456';
      return '';
    });

    expect(getMemoryToken(null)).toBe('github-token-456');
  });

  it('returns null when both tokens are empty', () => {
    mockGetInput.mockImplementation(() => '');

    expect(getMemoryToken(null)).toBeNull();
  });

  it('prefers memory_repo_token over github_token', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'memory_repo_token') return 'memory-token';
      if (name === 'github_token') return 'github-token';
      return '';
    });

    expect(getMemoryToken(null)).toBe('memory-token');
  });

  it('prefers resolved app token over raw github_token', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_token') return 'github-token';
      return '';
    });

    expect(getMemoryToken('app-token-resolved')).toBe('app-token-resolved');
  });

  it('prefers memory_repo_token over resolved app token', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'memory_repo_token') return 'explicit-memory-token';
      if (name === 'github_token') return 'github-token';
      return '';
    });

    expect(getMemoryToken('app-token-resolved')).toBe('explicit-memory-token');
  });

  it('falls back to github_token when resolved token is not set', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_token') return 'github-token';
      return '';
    });

    expect(getMemoryToken(null)).toBe('github-token');
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

  it('uses GitHub App auth when appId and privateKey are provided', async () => {
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
    expect(mockAuth).toHaveBeenCalledWith({ type: 'installation', installationId: 999 });
    expect(core.setSecret).toHaveBeenCalledWith('app-jwt-token');
    expect(core.setSecret).toHaveBeenCalledWith('installation-token-abc');
    expect(result.octokit).toBeDefined();
    expect(result.resolvedToken).toBe('installation-token-abc');
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
    expect(result.resolvedToken).toBe('ghp_fallback');
    expect(result.identity).toBe('actions');
    expect(result.bot).toEqual({ logins: ['manki-review[bot]', 'github-actions[bot]', 'review-user'] });
    expect(mockGetOctokit).toHaveBeenCalledWith('ghp_fallback', expect.anything(), retry, throttling);
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

  it('returns resolved app token for use with getMemoryToken', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github_app_id') return '';
      if (name === 'github_app_private_key') return '';
      if (name === 'github_token') return 'ghp_test';
      if (name === 'manki_token_url') return '';
      return '';
    });

    jest.spyOn(core, 'getIDToken').mockResolvedValue('oidc-token');
    mockFetch(async () => new Response(
      JSON.stringify({ token: 'resolved-app-token', expires_at: '2026-12-31T00:00:00Z' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    mockGetOctokit.mockReturnValue({} as ReturnType<typeof github.getOctokit>);

    const result = await createAuthenticatedOctokit();

    expect(result.resolvedToken).toBe('resolved-app-token');
    expect(result.identity).toBe('app');
    expect(result.bot).toEqual({ logins: ['manki-review[bot]', 'github-actions[bot]'] });
    expect(getMemoryToken(result.resolvedToken)).toBe('resolved-app-token');
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
