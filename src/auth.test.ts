import * as core from '@actions/core';

import { getMemoryToken, resolveGitHubToken, TokenResult } from './auth';

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

    expect(getMemoryToken()).toBe('memory-token-123');
  });

  it('falls back to github_token when memory_repo_token is empty', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'memory_repo_token') return '';
      if (name === 'github_token') return 'github-token-456';
      return '';
    });

    expect(getMemoryToken()).toBe('github-token-456');
  });

  it('returns null when both tokens are empty', () => {
    mockGetInput.mockImplementation(() => '');

    expect(getMemoryToken()).toBeNull();
  });

  it('prefers memory_repo_token over github_token', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'memory_repo_token') return 'memory-token';
      if (name === 'github_token') return 'github-token';
      return '';
    });

    expect(getMemoryToken()).toBe('memory-token');
  });
});

const GITHUB_TOKEN = 'ghp_test_token_123';
const TOKEN_URL = 'https://manki.dustinface.me/token';
const OWNER = 'test-owner';
const REPO = 'test-repo';
const APP_TOKEN = 'ghs_app_token_456';
const INSTALLATION_ID = 42;

function mockFetch(impl: (url: string, opts?: RequestInit) => Promise<Response>) {
  global.fetch = jest.fn(impl) as jest.Mock;
}

describe('resolveGitHubToken', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns app token when manki-labs is installed', async () => {
    mockFetch(async (url: string) => {
      if (url.includes('/installation')) {
        return new Response(
          JSON.stringify({ id: INSTALLATION_ID, app_slug: 'manki-labs' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ token: APP_TOKEN, expires_at: '2026-03-28T12:00:00Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: APP_TOKEN, identity: 'app' });
    expect(core.setSecret).toHaveBeenCalledWith(APP_TOKEN);
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('manki-labs[bot]'));

    const tokenCall = (global.fetch as jest.Mock).mock.calls[1];
    expect(tokenCall[0]).toBe(TOKEN_URL);
    expect(JSON.parse(tokenCall[1].body)).toEqual({ installation_id: INSTALLATION_ID });
  });

  it('falls back when app is not installed (404)', async () => {
    mockFetch(async () => {
      return new Response('Not Found', { status: 404 });
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('not installed'));
  });

  it('falls back when a different app is installed', async () => {
    mockFetch(async () => {
      return new Response(
        JSON.stringify({ id: 99, app_slug: 'some-other-app' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('not installed'));
  });

  it('falls back when token service returns an error', async () => {
    mockFetch(async (url: string) => {
      if (url.includes('/installation')) {
        return new Response(
          JSON.stringify({ id: INSTALLATION_ID, app_slug: 'manki-labs' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Internal Server Error', { status: 500 });
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Token service error (500)'));
  });

  it('falls back when token service returns invalid response (empty token)', async () => {
    mockFetch(async (url: string) => {
      if (url.includes('/installation')) {
        return new Response(
          JSON.stringify({ id: INSTALLATION_ID, app_slug: 'manki-labs' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
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
    mockFetch(async (url: string) => {
      if (url.includes('/installation')) {
        return new Response(
          JSON.stringify({ id: INSTALLATION_ID, app_slug: 'manki-labs' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
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
    mockFetch(async () => {
      throw new Error('Network failure');
    });

    const result = await resolveGitHubToken(GITHUB_TOKEN, TOKEN_URL, OWNER, REPO);

    expect(result).toEqual<TokenResult>({ token: GITHUB_TOKEN, identity: 'actions' });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('App token resolution failed'));
  });
});
