import * as core from '@actions/core';

import { getMemoryToken } from './auth';

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
