import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

import { ClaudeClient } from './claude';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('@anthropic-ai/sdk');

jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => jest.fn().mockResolvedValue({ stdout: '/usr/bin/claude' }),
}));

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe('ClaudeClient', () => {
  it('throws without either token', () => {
    expect(() => new ClaudeClient({ model: 'claude-opus-4-6' })).toThrow(
      'Either claude_code_oauth_token or anthropic_api_key must be provided'
    );
  });

  it('accepts oauthToken only', () => {
    const client = new ClaudeClient({ oauthToken: 'test-token', model: 'claude-opus-4-6' });
    expect(client).toBeDefined();
  });

  it('accepts apiKey only', () => {
    const client = new ClaudeClient({ apiKey: 'sk-test-key', model: 'claude-opus-4-6' });
    expect(client).toBeDefined();
  });

  it('accepts both oauthToken and apiKey', () => {
    const client = new ClaudeClient({
      oauthToken: 'test-token',
      apiKey: 'sk-test-key',
      model: 'claude-opus-4-6',
    });
    expect(client).toBeDefined();
  });

  // Spawn behavior (stdin drain handling, timeout, output limits) is tested via
  // integration in the GitHub Action workflow rather than unit tests. Mocking
  // child_process.spawn deeply enough to exercise those paths reliably would
  // couple tests to implementation details without catching real regressions.
});

describe('sendMessage effort option (CLI path)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  function setupSpawnMock(stdout: string): void {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    // Simulate stdout data and close event
    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') {
        setTimeout(() => cb(Buffer.from(stdout)), 0);
      }
    });
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') {
        setTimeout(() => cb(0, null), 5);
      }
    });

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  }

  it('includes --effort flag when effort option is set', async () => {
    setupSpawnMock('response text');
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user', { effort: 'high' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--effort');
    expect(spawnArgs[spawnArgs.indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort flag when no options provided', async () => {
    setupSpawnMock('response text');
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--effort');
  });

  it('omits --effort flag when effort is undefined', async () => {
    setupSpawnMock('response text');
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user', {});

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--effort');
  });
});

describe('sendMessage effort option (API path)', () => {
  let mockCreate: jest.Mock;

  beforeEach(() => {
    mockCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'response' }],
    });
    (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
      messages: { create: mockCreate },
    }));
  });

  it('includes thinking param when effort is high', async () => {
    const client = new ClaudeClient({ apiKey: 'sk-key', model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user', { effort: 'high' });

    const params = mockCreate.mock.calls[0][0];
    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
    expect(params.max_tokens).toBe(32768);
  });

  it('includes thinking param when effort is max', async () => {
    const client = new ClaudeClient({ apiKey: 'sk-key', model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user', { effort: 'max' });

    const params = mockCreate.mock.calls[0][0];
    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    expect(params.max_tokens).toBe(32768);
  });

  it('includes thinking param when effort is medium', async () => {
    const client = new ClaudeClient({ apiKey: 'sk-key', model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user', { effort: 'medium' });

    const params = mockCreate.mock.calls[0][0];
    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
    expect(params.max_tokens).toBe(32768);
  });

  it('omits thinking param when effort is low', async () => {
    const client = new ClaudeClient({ apiKey: 'sk-key', model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user', { effort: 'low' });

    const params = mockCreate.mock.calls[0][0];
    expect(params.thinking).toBeUndefined();
    expect(params.max_tokens).toBe(16384);
  });

  it('omits thinking param when no options provided', async () => {
    const client = new ClaudeClient({ apiKey: 'sk-key', model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user');

    const params = mockCreate.mock.calls[0][0];
    expect(params.thinking).toBeUndefined();
    expect(params.max_tokens).toBe(16384);
  });
});
