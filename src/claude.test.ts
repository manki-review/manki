import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

import { ClaudeClient, resetCLIInstallPromise, sanitizeLogOutput, STALE_TIMEOUT_MS } from './claude';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('@anthropic-ai/sdk');

// Container for the execFileAsync mock — must be a plain object so the
// hoisted jest.mock factory can capture a reference to it before const
// declarations are initialized.
const _execMock = { fn: null as jest.Mock | null };
jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: unknown[]) => _execMock.fn!(...args),
}));

// Now assign the actual mock function (runs after hoisting)
const mockExecFileAsync = jest.fn().mockResolvedValue({ stdout: '/usr/bin/claude' });
_execMock.fn = mockExecFileAsync;

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

/** Encode a plain text response as stream-json output (newline-delimited JSON). */
function toStreamJson(text: string): string {
  return [
    JSON.stringify({ type: 'message_start', message: {} }),
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    JSON.stringify({ type: 'content_block_stop', index: 0 }),
    JSON.stringify({ type: 'result', result: text }),
    '',
  ].join('\n');
}

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
        setTimeout(() => cb(Buffer.from(toStreamJson(stdout))), 0);
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

  it('concatenates multiple text blocks', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });

    const client = new ClaudeClient({ apiKey: 'sk-key', model: 'claude-opus-4-6' });
    const result = await client.sendMessage('system', 'user');

    expect(result.content).toBe('first\nsecond');
  });

  it('throws when Anthropic client is not initialized', async () => {
    // Create with oauthToken only — no Anthropic client
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    // Access private sendViaAPI directly via prototype
    const sendViaAPI = (ClaudeClient.prototype as unknown as Record<string, unknown>)['sendViaAPI'] as (
      systemPrompt: string,
      userMessage: string,
    ) => Promise<unknown>;

    await expect(sendViaAPI.call(client, 'sys', 'user')).rejects.toThrow('Anthropic client not initialized');
  });
});

describe('sendViaOAuth — error paths', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetCLIInstallPromise();
  });

  function setupSpawnMock(opts: {
    exitCode?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
    closeDelay?: number;
    rawStdout?: boolean;
  }): void {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data' && opts.stdout) {
        const payload = opts.rawStdout ? opts.stdout! : toStreamJson(opts.stdout!);
        setTimeout(() => cb(Buffer.from(payload)), 0);
      }
    });
    proc.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data' && opts.stderr) {
        setTimeout(() => cb(Buffer.from(opts.stderr!)), 0);
      }
    });
    proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close' && !opts.error) {
        setTimeout(() => cb(opts.exitCode ?? 0, opts.signal ?? null), opts.closeDelay ?? 5);
      }
      if (event === 'error' && opts.error) {
        setTimeout(() => cb(opts.error), 0);
      }
    });

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  }

  it('rejects on non-zero exit code', async () => {
    setupSpawnMock({ exitCode: 1, stderr: 'something went wrong' });
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('Claude CLI invocation failed');
  });

  it('rejects on spawn error', async () => {
    setupSpawnMock({ error: new Error('ENOENT') });
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('Claude CLI spawn failed: ENOENT');
  });

  it('returns trimmed content on success', async () => {
    setupSpawnMock({ stdout: '  hello world  \n' });
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('hello world');
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN in spawn env', async () => {
    setupSpawnMock({ stdout: 'ok' });
    const client = new ClaudeClient({ oauthToken: 'my-oauth-token', model: 'claude-opus-4-6' });

    await client.sendMessage('sys', 'user');

    const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOpts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('my-oauth-token');
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN env var when oauthToken is provided', async () => {
    setupSpawnMock({ stdout: 'ok' });
    // Both tokens provided — oauthToken takes precedence
    const client = new ClaudeClient({ oauthToken: 'tok', apiKey: 'sk-key', model: 'claude-opus-4-6' });

    await client.sendMessage('sys', 'user');

    const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOpts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });

  it('passes --verbose, --output-format stream-json, and --include-partial-messages to CLI', async () => {
    setupSpawnMock({ stdout: 'ok' });
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await client.sendMessage('sys', 'user');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const fmtIdx = spawnArgs.indexOf('--output-format');
    expect(fmtIdx).toBeGreaterThan(-1);
    expect(spawnArgs[fmtIdx + 1]).toBe('stream-json');
    expect(spawnArgs).toContain('--verbose');
    expect(spawnArgs).toContain('--include-partial-messages');
  });

  it('extracts text from content_block_delta events', async () => {
    const streamOutput = [
      JSON.stringify({ type: 'message_start', message: {} }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } }),
      JSON.stringify({ type: 'content_block_stop', index: 0 }),
      '',
    ].join('\n');
    setupSpawnMock({ stdout: streamOutput, rawStdout: true });
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('hello world');
  });

  it('uses result event text when present (overrides deltas)', async () => {
    const streamOutput = [
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
      JSON.stringify({ type: 'result', result: 'final answer' }),
      '',
    ].join('\n');
    setupSpawnMock({ stdout: streamOutput, rawStdout: true });
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('final answer');
  });

  it('silently skips non-JSON lines (e.g. verbose debug output)', async () => {
    setupSpawnMock({ stdout: 'plain text fallback\n', rawStdout: true });
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('');
  });

  it('includes exit signal in error message when present', async () => {
    setupSpawnMock({ exitCode: 1, signal: 'SIGTERM', stderr: 'killed' });
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('signal SIGTERM');
  });

  it('handles stdin.write returning false (drain path)', async () => {
    const proc = {
      stdin: {
        write: jest.fn().mockReturnValue(false),
        end: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
      },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') {
        setTimeout(() => cb(Buffer.from(toStreamJson('drain response'))), 0);
      }
    });
    proc.stderr.on.mockImplementation(() => {});

    // Simulate drain event firing, then close
    proc.stdin.once.mockImplementation((event: string, cb: () => void) => {
      if (event === 'drain') {
        setTimeout(() => cb(), 1);
      }
    });
    proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') {
        setTimeout(() => cb(0, null), 10);
      }
    });

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('drain response');
    expect(proc.stdin.once).toHaveBeenCalledWith('drain', expect.any(Function));
  });

  it('rejects with 600s timeout and includes stderr snippet', async () => {
    jest.useFakeTimers();
    try {
      const proc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      let stdoutCb: ((data: Buffer) => void) | undefined;
      let stderrCb: ((data: Buffer) => void) | undefined;
      let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutCb = cb;
      });
      proc.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stderrCb = cb;
      });
      proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as typeof closeCb;
      });

      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      // Flush microtasks so ensureCLI resolves and spawn is called
      await jest.advanceTimersByTimeAsync(0);

      // Emit stderr before timeout
      stderrCb!(Buffer.from('some diagnostic output'));

      // Keep stdout alive to prevent the stale checker from firing before hard timeout
      for (let i = 0; i < 7; i++) {
        await jest.advanceTimersByTimeAsync(80_000);
        stdoutCb!(Buffer.from(`keepalive-${i}`));
      }

      // Fire the 600s timeout (advance remaining ~40s)
      await jest.advanceTimersByTimeAsync(40_000);

      // Simulate process exit after SIGTERM
      closeCb!(null, 'SIGTERM');

      const err: Error = await promise.then(() => { throw new Error('expected rejection'); }, (e) => e);
      expect(err.message).toContain('Claude CLI timed out after 600s');
      expect(err.message).toContain('stderr: some diagnostic output');
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects with plain 600s timeout when stderr is empty', async () => {
    jest.useFakeTimers();
    try {
      const proc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      let stdoutCb: ((data: Buffer) => void) | undefined;
      let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutCb = cb;
      });
      proc.stderr.on.mockImplementation(() => {});
      proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as typeof closeCb;
      });

      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Keep stdout alive to prevent the stale checker from firing
      for (let i = 0; i < 7; i++) {
        await jest.advanceTimersByTimeAsync(80_000);
        stdoutCb!(Buffer.from(`keepalive-${i}`));
      }

      await jest.advanceTimersByTimeAsync(40_000);
      closeCb!(null, 'SIGTERM');

      await expect(promise).rejects.toThrow('Claude CLI timed out after 600s');
    } finally {
      jest.useRealTimers();
    }
  });

  it('handles stdin.write throwing an error', async () => {
    const proc = {
      stdin: {
        write: jest.fn().mockImplementation(() => { throw new Error('write EPIPE'); }),
        end: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
      },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    proc.stdout.on.mockImplementation(() => {});
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation(() => {});

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('stdin write failed: write EPIPE');
  });

  it('rejects when stdout exceeds 50MB output limit', async () => {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    let stdoutCb: ((data: Buffer) => void) | undefined;
    let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') stdoutCb = cb;
    });
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') closeCb = cb as typeof closeCb;
    });

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const promise = client.sendMessage('sys', 'user');

    // Wait for ensureCLI to resolve
    await new Promise((r) => setTimeout(r, 0));

    // Send a massive chunk to exceed the 50MB limit
    const bigChunk = Buffer.alloc(51 * 1024 * 1024, 'x');
    stdoutCb!(bigChunk);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Simulate process exit
    closeCb!(null, 'SIGTERM');

    await expect(promise).rejects.toThrow('Claude CLI output exceeded 50MB limit');
  });

  it('flushes remaining decoder bytes in close handler', async () => {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    let stdoutCb: ((data: Buffer) => void) | undefined;
    let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') stdoutCb = cb;
    });
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') closeCb = cb as typeof closeCb;
    });

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const promise = client.sendMessage('sys', 'user');

    // Wait for ensureCLI to resolve
    await new Promise((r) => setTimeout(r, 0));

    // Send a complete result line first so we have baseline output
    const resultLine = JSON.stringify({ type: 'result', result: 'base' }) + '\n';
    stdoutCb!(Buffer.from(resultLine));

    // Send the first byte of a 2-byte UTF-8 char "ñ" (0xC3 0xB1). The StringDecoder
    // holds 0xC3, waiting for the second byte. When close fires, end() returns the
    // replacement character (U+FFFD), proving the flush path in the close handler runs.
    stdoutCb!(Buffer.from([0xC3]));

    closeCb!(0, null);

    const result = await promise;
    // The flush produces a replacement character which is non-JSON, so the flush block
    // runs processJsonLine but JSON.parse fails — output stays as "base"
    expect(result.content).toBe('base');
  });

  it('flushes incomplete multi-byte char from decoder on close', async () => {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    let stdoutCb: ((data: Buffer) => void) | undefined;
    let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') stdoutCb = cb;
    });
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') closeCb = cb as typeof closeCb;
    });

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const promise = client.sendMessage('sys', 'user');
    await new Promise((r) => setTimeout(r, 0));

    // Send a complete result line first so we have output
    const resultLine = JSON.stringify({ type: 'result', result: 'base' }) + '\n';
    stdoutCb!(Buffer.from(resultLine));

    // Send an incomplete multi-byte character — StringDecoder will hold the
    // partial bytes and flush them (as a replacement char) when end() is called.
    // This is a partial 3-byte UTF-8 sequence (first 2 bytes of €).
    const partialEuro = Buffer.from([0xE2, 0x82]);
    stdoutCb!(partialEuro);

    closeCb!(0, null);

    const result = await promise;
    // The flush produces a replacement character which is non-JSON, so it
    // enters the flush block but fails JSON.parse — output stays as "base"
    expect(result.content).toBe('base');
  });


  it('logs stdin error events as warnings', async () => {
    const proc = {
      stdin: {
        write: jest.fn().mockReturnValue(true),
        end: jest.fn(),
        on: jest.fn(),
      },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    let stdinErrorCb: ((err: Error) => void) | undefined;

    proc.stdin.on.mockImplementation((event: string, cb: (err: Error) => void) => {
      if (event === 'error') stdinErrorCb = cb;
    });
    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') {
        setTimeout(() => cb(Buffer.from(toStreamJson('ok'))), 0);
      }
    });
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') {
        setTimeout(() => cb(0, null), 5);
      }
    });

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const promise = client.sendMessage('sys', 'user');

    // Wait for ensureCLI to resolve
    await new Promise((r) => setTimeout(r, 0));

    // Fire the stdin error handler
    stdinErrorCb!(new Error('EPIPE'));

    const result = await promise;
    expect(result.content).toBe('ok');
  });
});

describe('ensureCLI — install path', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExecFileAsync.mockReset();
    resetCLIInstallPromise();
  });

  function setupSpawnForSuccess(stdout: string): void {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') {
        setTimeout(() => cb(Buffer.from(toStreamJson(stdout))), 0);
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

  it('installs CLI when which fails, then succeeds', async () => {
    // First call: which claude fails; second call: npm install succeeds; third call: which claude succeeds
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ stdout: '' }) // npm install
      .mockResolvedValueOnce({ stdout: '/usr/local/bin/claude\n' }); // which after install

    setupSpawnForSuccess('installed ok');
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('installed ok');
  });

  it('throws when CLI install fails (which still fails after install)', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ stdout: '' }) // npm install
      .mockRejectedValueOnce(new Error('still not found')); // which after install

    setupSpawnForSuccess('should not reach');
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('Failed to install Claude CLI');
  });

  it('reuses cached CLI path on second call', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/claude\n' });
    setupSpawnForSuccess('response');
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await client.sendMessage('sys', 'first');
    await client.sendMessage('sys', 'second');

    // execFileAsync (which) should only be called once, then cached
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('clears install promise on install failure so retry is possible', async () => {
    // First attempt: which fails, npm install fails
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ stdout: '' }) // npm install
      .mockRejectedValueOnce(new Error('still not found')); // which after install

    setupSpawnForSuccess('should not reach');
    const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

    await expect(client.sendMessage('sys', 'first')).rejects.toThrow('Failed to install Claude CLI');

    // Second attempt: which succeeds (cliInstallPromise was cleared)
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/local/bin/claude\n' });

    // Need a fresh client since cachedCLIPath is instance-level
    const client2 = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });
    const result = await client2.sendMessage('sys', 'retry');
    expect(result.content).toBe('should not reach');
  });
});

describe('sendViaOAuth — stale process detection', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/claude' });
    _execMock.fn = mockExecFileAsync;
    resetCLIInstallPromise();
  });

  it('kills process when no stdout for 90s', async () => {
    jest.useFakeTimers();
    try {
      const proc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

      proc.stdout.on.mockImplementation(() => {});
      proc.stderr.on.mockImplementation(() => {});
      proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as typeof closeCb;
      });

      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      // Flush microtasks so ensureCLI resolves and spawn is called
      await jest.advanceTimersByTimeAsync(0);

      // Advance past the stale timeout — self-resetting setTimeout fires exactly at 90s
      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      // Simulate process exit after SIGTERM
      closeCb!(null, 'SIGTERM');

      await expect(promise).rejects.toThrow(`Claude CLI stale — no output for ${STALE_TIMEOUT_MS / 1000}s`);
    } finally {
      jest.useRealTimers();
    }
  });

  it('resets stale timer when stdout data arrives, then hard timeout fires', async () => {
    jest.useFakeTimers();
    try {
      const proc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      let stdoutCb: ((data: Buffer) => void) | undefined;
      let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutCb = cb;
      });
      proc.stderr.on.mockImplementation(() => {});
      proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as typeof closeCb;
      });

      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Keep producing stdout every 80s — always under the 90s stale threshold
      for (let i = 0; i < 7; i++) {
        await jest.advanceTimersByTimeAsync(80_000);
        stdoutCb!(Buffer.from(`chunk-${i}`));
      }

      // At this point ~560s have passed. The stale timer keeps resetting.
      // Advance to the hard 600s timeout
      await jest.advanceTimersByTimeAsync(40_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      closeCb!(null, 'SIGTERM');

      await expect(promise).rejects.toThrow('Claude CLI timed out after 600s');
    } finally {
      jest.useRealTimers();
    }
  });

  it('includes last stdout chunk in stale error message', async () => {
    jest.useFakeTimers();
    try {
      const proc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      let stdoutCb: ((data: Buffer) => void) | undefined;
      let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutCb = cb;
      });
      proc.stderr.on.mockImplementation(() => {});
      proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as typeof closeCb;
      });

      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Emit one stdout chunk then go silent
      stdoutCb!(Buffer.from('partial output here'));

      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);

      closeCb!(null, 'SIGTERM');

      await expect(promise).rejects.toThrow('Last stdout: partial output here');
    } finally {
      jest.useRealTimers();
    }
  });

  it('accumulates rolling lastStdoutChunk across multiple data events', async () => {
    jest.useFakeTimers();
    try {
      const proc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      let stdoutCb: ((data: Buffer) => void) | undefined;
      let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutCb = cb;
      });
      proc.stderr.on.mockImplementation(() => {});
      proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as typeof closeCb;
      });

      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Emit two small chunks — both should appear in the rolling buffer
      stdoutCb!(Buffer.from('first-part|'));
      stdoutCb!(Buffer.from('second-part'));

      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);
      closeCb!(null, 'SIGTERM');

      await expect(promise).rejects.toThrow('Last stdout: first-part|second-part');
    } finally {
      jest.useRealTimers();
    }
  });

  it('caps rolling lastStdoutChunk at 500 chars', async () => {
    jest.useFakeTimers();
    try {
      const proc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      let stdoutCb: ((data: Buffer) => void) | undefined;
      let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutCb = cb;
      });
      proc.stderr.on.mockImplementation(() => {});
      proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as typeof closeCb;
      });

      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Emit a chunk larger than 500 chars, then a small one
      stdoutCb!(Buffer.from('A'.repeat(490)));
      stdoutCb!(Buffer.from('B'.repeat(20)));

      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);
      closeCb!(null, 'SIGTERM');

      const err = await promise.catch((e: unknown) => e) as Error;
      // The rolling buffer should keep the last 500 chars: 480 A's + 20 B's
      expect(err.message).toContain('A'.repeat(480) + 'B'.repeat(20));
    } finally {
      jest.useRealTimers();
    }
  });

  it('sanitizes workflow commands in stale warning output', async () => {
    jest.useFakeTimers();
    try {
      const proc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      let stdoutCb: ((data: Buffer) => void) | undefined;
      let stderrCb: ((data: Buffer) => void) | undefined;
      let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutCb = cb;
      });
      proc.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stderrCb = cb;
      });
      proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as typeof closeCb;
      });

      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      stdoutCb!(Buffer.from('before ::set-output::val'));
      stderrCb!(Buffer.from('err ::error::bad'));

      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);
      closeCb!(null, 'SIGTERM');

      const err = await promise.catch((e: unknown) => e) as Error;
      expect(err.message).toContain('before [redacted-workflow-cmd]');
      expect(err.message).toContain('err [redacted-workflow-cmd]');
      expect(err.message).not.toContain('::set-output');
      expect(err.message).not.toContain('::error');
    } finally {
      jest.useRealTimers();
    }
  });

  it('sanitizes workflow commands in timeout warning output', async () => {
    jest.useFakeTimers();
    try {
      const proc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      let stdoutCb: ((data: Buffer) => void) | undefined;
      let stderrCb: ((data: Buffer) => void) | undefined;
      let closeCb: ((code: number | null, signal: string | null) => void) | undefined;

      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutCb = cb;
      });
      proc.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stderrCb = cb;
      });
      proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as typeof closeCb;
      });

      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const client = new ClaudeClient({ oauthToken: 'token', model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      stderrCb!(Buffer.from('::warning::injected'));

      // Keep stdout alive past stale threshold until hard timeout.
      // The last keepalive contains a workflow command to verify stdout sanitization.
      for (let i = 0; i < 7; i++) {
        await jest.advanceTimersByTimeAsync(80_000);
        const payload = i === 6 ? 'stdout ::set-env name=X::val' : `keepalive-${i}`;
        stdoutCb!(Buffer.from(payload));
      }

      await jest.advanceTimersByTimeAsync(40_000);
      closeCb!(null, 'SIGTERM');

      const err = await promise.catch((e: unknown) => e) as Error;
      expect(err.message).toContain('[redacted-workflow-cmd]');
      expect(err.message).not.toContain('::warning');
      expect(err.message).not.toContain('::set-env');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('sanitizeLogOutput', () => {
  it('strips ::set-output workflow commands', () => {
    expect(sanitizeLogOutput('before ::set-output name=val::data'))
      .toBe('before [redacted-workflow-cmd]');
  });

  it('strips ::error commands', () => {
    expect(sanitizeLogOutput('::error::something bad')).toBe('[redacted-workflow-cmd]');
  });

  it('strips ::warning commands', () => {
    expect(sanitizeLogOutput('::warning::msg')).toBe('[redacted-workflow-cmd]');
  });

  it('strips ::set-env commands', () => {
    expect(sanitizeLogOutput('::set-env name=FOO::bar')).toBe('[redacted-workflow-cmd]');
  });

  it('consumes the entire line after :: message marker', () => {
    expect(sanitizeLogOutput('prefix ::error::msg trailing'))
      .toBe('prefix [redacted-workflow-cmd]');
  });

  it('handles multiple commands on separate lines', () => {
    const input = 'line1\n::error::bad\nline2\n::warning::also bad';
    const result = sanitizeLogOutput(input);
    expect(result).toBe('line1\n[redacted-workflow-cmd]\nline2\n[redacted-workflow-cmd]');
  });

  it('leaves normal text unchanged', () => {
    expect(sanitizeLogOutput('just normal output')).toBe('just normal output');
  });

  it('handles empty string', () => {
    expect(sanitizeLogOutput('')).toBe('');
  });

  it('is case-insensitive', () => {
    expect(sanitizeLogOutput('::SET-OUTPUT::val')).toBe('[redacted-workflow-cmd]');
  });

  it('handles colons in parameters', () => {
    expect(sanitizeLogOutput('::error file=src/foo.ts,line=5,col=10::Something failed: timeout'))
      .toBe('[redacted-workflow-cmd]');
  });

  it('strips command with complex parameter values containing colons', () => {
    expect(sanitizeLogOutput('prefix ::warning file=a:b::msg:with:colons'))
      .toBe('prefix [redacted-workflow-cmd]');
  });
});
