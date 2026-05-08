import { spawn } from 'child_process';
import OpenAI from 'openai';
import * as core from '@actions/core';

import {
  buildOpenAIAuth,
  isReasoningModel,
  OpenAIClient,
  resetCLIInstallPromise,
  resolveCLIEffort,
  sanitizeLogOutput,
  STALE_TIMEOUT_MS,
} from './openai';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('openai');

// Container for the execFileAsync mock — must be a plain object so the
// hoisted jest.mock factory can capture a reference before const initialization.
const _execMock = { fn: null as jest.Mock | null };
jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: unknown[]) => _execMock.fn!(...args),
}));

const mockExecFileAsync = jest.fn().mockResolvedValue({ stdout: '/usr/bin/codex' });
_execMock.fn = mockExecFileAsync;

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe('buildOpenAIAuth', () => {
  it('throws when neither token is present', () => {
    expect(() => buildOpenAIAuth('', '')).toThrow(
      'Either openai_oauth_token or openai_api_key must be provided',
    );
  });

  it('returns oauth kind when only oauth token is present', () => {
    expect(buildOpenAIAuth('oauth-tok', '')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });

  it('returns apiKey kind when only api key is present', () => {
    expect(buildOpenAIAuth('', 'sk-key')).toEqual({ kind: 'apiKey', key: 'sk-key' });
  });

  it('oauth wins when both tokens are present', () => {
    expect(buildOpenAIAuth('oauth-tok', 'sk-key')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });
});

describe('isReasoningModel', () => {
  it('detects o-series models', () => {
    expect(isReasoningModel('o1')).toBe(true);
    expect(isReasoningModel('o3')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
    expect(isReasoningModel('o4-mini')).toBe(true);
  });

  it('rejects gpt-family models', () => {
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isReasoningModel('gpt-4.1')).toBe(false);
    expect(isReasoningModel('gpt-4o-mini')).toBe(false);
  });

  it('rejects unrelated names', () => {
    expect(isReasoningModel('claude-opus-4-6')).toBe(false);
    expect(isReasoningModel('overlord')).toBe(false);
  });
});

describe('OpenAIClient', () => {
  it('accepts oauth auth', () => {
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    expect(client).toBeDefined();
  });

  it('accepts apiKey auth', () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model: 'gpt-4o' });
    expect(client).toBeDefined();
  });
});

describe('sendMessage (API path)', () => {
  let mockCreate: jest.Mock;

  beforeEach(() => {
    mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'response text' } }],
    });
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));
  });

  it('sends model, system message, and user message in chat completions request', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });
    await client.sendMessage('sys-prompt', 'user-msg');

    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe('gpt-4o');
    expect(params.messages).toEqual([
      { role: 'system', content: 'sys-prompt' },
      { role: 'user', content: 'user-msg' },
    ]);
  });

  it('omits reasoning_effort for non-reasoning models', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });
    await client.sendMessage('sys', 'user');

    const params = mockCreate.mock.calls[0][0];
    expect(params.reasoning_effort).toBeUndefined();
  });

  it('warns and ignores effort on non-reasoning models', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });

    await client.sendMessage('sys', 'user', { effort: 'high' });

    const params = mockCreate.mock.calls[0][0];
    expect(params.reasoning_effort).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring effort=high'));
    warnSpy.mockRestore();
  });

  it('maps low effort to reasoning_effort=low for o3', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'o3' });
    await client.sendMessage('sys', 'user', { effort: 'low' });

    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('low');
  });

  it('maps medium effort to reasoning_effort=medium for o3', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'o3' });
    await client.sendMessage('sys', 'user', { effort: 'medium' });

    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('medium');
  });

  it('maps high effort to reasoning_effort=high for o3', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'o3' });
    await client.sendMessage('sys', 'user', { effort: 'high' });

    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('high');
  });

  it('maps max effort to reasoning_effort=high (the highest tier the API exposes)', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'o4-mini' });
    await client.sendMessage('sys', 'user', { effort: 'max' });

    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('high');
  });

  it('omits reasoning_effort when no effort is provided on a reasoning model', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'o3' });
    await client.sendMessage('sys', 'user');

    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBeUndefined();
  });

  it('returns the assistant content from the first choice', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });
    const result = await client.sendMessage('sys', 'user');

    expect(result.content).toBe('response text');
  });

  it('returns empty string when the response has no content', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: {} }] });
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('');
  });

  it('throws when client is not initialized (oauth path called via API method)', async () => {
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    const sendViaAPI = (OpenAIClient.prototype as unknown as Record<string, unknown>)['sendViaAPI'] as (
      systemPrompt: string,
      userMessage: string,
    ) => Promise<unknown>;

    await expect(sendViaAPI.call(client, 'sys', 'user')).rejects.toThrow('OpenAI client not initialized');
  });
});

describe('sendViaOAuth (Codex CLI path)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetCLIInstallPromise();
  });

  function setupSpawnMock(stdout: string, opts: { exitCode?: number; stderr?: string } = {}): void {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data' && stdout) {
        setTimeout(() => cb(Buffer.from(stdout)), 0);
      }
    });
    proc.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data' && opts.stderr) {
        setTimeout(() => cb(Buffer.from(opts.stderr!)), 0);
      }
    });
    proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') {
        setTimeout(() => cb(opts.exitCode ?? 0, null), 5);
      }
    });

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  }

  it('passes --model and exec subcommand to codex CLI', async () => {
    setupSpawnMock('hello\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await client.sendMessage('sys', 'user');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs[0]).toBe('exec');
    const modelIdx = spawnArgs.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnArgs[modelIdx + 1]).toBe('o3');
  });

  it('passes model_reasoning_effort override when effort is set on o-series model', async () => {
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await client.sendMessage('sys', 'user', { effort: 'high' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort="high"');
  });

  it('warns and skips reasoning override on non-reasoning models', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    await client.sendMessage('sys', 'user', { effort: 'high' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.find(a => a.startsWith('model_reasoning_effort'))).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring effort=high'));
    warnSpy.mockRestore();
  });

  it('sets CODEX_OAUTH_TOKEN and OPENAI_OAUTH_TOKEN in spawn env', async () => {
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'my-tok' }, model: 'gpt-4o' });

    await client.sendMessage('sys', 'user');

    const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOpts.env.CODEX_OAUTH_TOKEN).toBe('my-tok');
    expect(spawnOpts.env.OPENAI_OAUTH_TOKEN).toBe('my-tok');
    // Aliasing an OAuth subscription token as OPENAI_API_KEY would cause
    // credential type confusion inside the CLI's bundled OpenAI SDK.
    expect(spawnOpts.env.OPENAI_API_KEY).not.toBe('my-tok');
  });

  it('maps max effort to model_reasoning_effort="high" on o-series CLI invocation', async () => {
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o4-mini' });

    await client.sendMessage('sys', 'user', { effort: 'max' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort="high"');
  });

  it('returns trimmed stdout content on success', async () => {
    setupSpawnMock('  hello world  \n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('hello world');
  });

  it('rejects on non-zero exit code', async () => {
    setupSpawnMock('', { exitCode: 1, stderr: 'something broke' });
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('Codex CLI invocation failed');
  });

  it('rejects on spawn error', async () => {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };
    proc.stdout.on.mockImplementation(() => {});
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'error') setTimeout(() => cb(new Error('ENOENT')), 0);
    });
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('Codex CLI spawn failed: ENOENT');
  });
});

describe('sanitizeLogOutput', () => {
  it('redacts workflow commands', () => {
    expect(sanitizeLogOutput('::set-env name=X::val')).toBe('[redacted-workflow-cmd]');
    expect(sanitizeLogOutput('::add-mask::secret')).toBe('[redacted-workflow-cmd]');
    expect(sanitizeLogOutput('::error file=foo.ts,line=5::message')).toBe('[redacted-workflow-cmd]');
  });

  it('does not touch regular text', () => {
    expect(sanitizeLogOutput('hello world')).toBe('hello world');
    expect(sanitizeLogOutput('A line :: with double colons mid-text')).toBe('A line :: with double colons mid-text');
  });

  it('does not redact `::identifier` patterns mid-line', () => {
    // `^` anchor (with multiline flag) ensures `std::io::Error` and similar
    // namespace syntax in code output is preserved.
    expect(sanitizeLogOutput('error: std::io::Error at module::path')).toBe('error: std::io::Error at module::path');
    expect(sanitizeLogOutput('caller foo::bar::baz failed')).toBe('caller foo::bar::baz failed');
  });

  it('redacts per line in multiline input', () => {
    const input = 'safe line\n::set-env name=X::val\nother safe';
    expect(sanitizeLogOutput(input)).toBe('safe line\n[redacted-workflow-cmd]\nother safe');
  });

  it('redacts case-insensitively', () => {
    expect(sanitizeLogOutput('::SET-ENV name=X::val')).toBe('[redacted-workflow-cmd]');
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeLogOutput('')).toBe('');
  });
});

describe('resolveCLIEffort', () => {
  it('passes through low/medium/high unchanged', () => {
    expect(resolveCLIEffort('low')).toBe('low');
    expect(resolveCLIEffort('medium')).toBe('medium');
    expect(resolveCLIEffort('high')).toBe('high');
  });

  it('collapses max to high', () => {
    expect(resolveCLIEffort('max')).toBe('high');
  });

  it('falls back to high for unknown inputs', () => {
    expect(resolveCLIEffort('extreme')).toBe('high');
  });
});

describe('sendViaOAuth — extended coverage', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetCLIInstallPromise();
    mockExecFileAsync.mockReset();
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/codex' });
  });

  interface MockProc {
    stdin: { write: jest.Mock; end: jest.Mock; on: jest.Mock; once: jest.Mock };
    stdout: { on: jest.Mock };
    stderr: { on: jest.Mock };
    on: jest.Mock;
    kill: jest.Mock;
  }
  interface MockProcWiring {
    proc: MockProc;
    procHandlers: Record<string, (...a: unknown[]) => void>;
    stdoutHandlers: Record<string, (data: Buffer) => void>;
    stdinHandlers: Record<string, (...a: unknown[]) => void>;
  }

  function makeProc(): MockProcWiring {
    const procHandlers: Record<string, (...a: unknown[]) => void> = {};
    const stdoutHandlers: Record<string, (data: Buffer) => void> = {};
    const stderrHandlers: Record<string, (data: Buffer) => void> = {};
    const stdinHandlers: Record<string, (...a: unknown[]) => void> = {};
    const proc: MockProc = {
      stdin: {
        write: jest.fn().mockReturnValue(true),
        end: jest.fn(),
        on: jest.fn().mockImplementation((event: string, cb: (...a: unknown[]) => void) => {
          stdinHandlers[event] = cb;
        }),
        once: jest.fn().mockImplementation((event: string, cb: (...a: unknown[]) => void) => {
          stdinHandlers[event] = cb;
        }),
      },
      stdout: {
        on: jest.fn().mockImplementation((event: string, cb: (data: Buffer) => void) => {
          stdoutHandlers[event] = cb;
        }),
      },
      stderr: {
        on: jest.fn().mockImplementation((event: string, cb: (data: Buffer) => void) => {
          stderrHandlers[event] = cb;
        }),
      },
      on: jest.fn().mockImplementation((event: string, cb: (...a: unknown[]) => void) => {
        procHandlers[event] = cb;
      }),
      kill: jest.fn(),
    };
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    return { proc, procHandlers, stdoutHandlers, stdinHandlers };
  }

  // Wait for the OpenAIClient to finish ensureCLI() and wire up its listeners on the mock proc.
  // Uses setImmediate so it stays alive when fake timers are active (callers keep setImmediate real).
  async function waitForListeners(wiring: MockProcWiring): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (wiring.procHandlers['close']) return;
      await new Promise(r => setImmediate(r));
    }
    throw new Error('Listeners were never wired up');
  }

  it('rejects with stale error when no stdout for STALE_TIMEOUT_MS', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      const wiring = makeProc();
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
      const promise = client.sendMessage('sys', 'user');
      promise.catch(() => {});

      await waitForListeners(wiring);
      jest.advanceTimersByTime(STALE_TIMEOUT_MS + 100);
      wiring.procHandlers['close']?.(null, 'SIGTERM');

      await expect(promise).rejects.toThrow(/stale/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects when output exceeds the 50 MB cap', async () => {
    const wiring = makeProc();
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    const promise = client.sendMessage('sys', 'user');
    promise.catch(() => {});

    await waitForListeners(wiring);
    const chunk = Buffer.alloc(30 * 1024 * 1024, 0x61);
    wiring.stdoutHandlers['data']?.(chunk);
    wiring.stdoutHandlers['data']?.(chunk);
    wiring.procHandlers['close']?.(null, 'SIGTERM');

    await expect(promise).rejects.toThrow(/exceeded 50MB/);
  });

  it('warns and continues on stdin error event', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const wiring = makeProc();
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    const promise = client.sendMessage('sys', 'user');
    promise.catch(() => {});

    await waitForListeners(wiring);
    wiring.stdinHandlers['error']?.(new Error('EPIPE'));
    wiring.procHandlers['close']?.(0, null);

    await promise;
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stdin write error'));
    warnSpy.mockRestore();
  });

  it('rejects when stdin.write throws synchronously', async () => {
    const wiring = makeProc();
    wiring.proc.stdin.write.mockImplementation(() => { throw new Error('EBADF'); });

    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    const promise = client.sendMessage('sys', 'user');

    await expect(promise).rejects.toThrow(/stdin write failed: EBADF/);
    // close still arriving must be tolerated as a no-op
    wiring.procHandlers['close']?.(0, null);
  });

  it('waits for drain before ending stdin when write returns false', async () => {
    const wiring = makeProc();
    wiring.proc.stdin.write.mockReturnValueOnce(false);

    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    const promise = client.sendMessage('sys', 'user');
    promise.catch(() => {});

    await waitForListeners(wiring);
    expect(wiring.proc.stdin.end).not.toHaveBeenCalled();
    wiring.stdinHandlers['drain']?.();
    expect(wiring.proc.stdin.end).toHaveBeenCalled();

    wiring.procHandlers['close']?.(0, null);
    await promise;
  });

  it('preserves last 500 bytes of stdout for diagnostic snippets', async () => {
    const wiring = makeProc();
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    const promise = client.sendMessage('sys', 'user');
    promise.catch(() => {});

    await waitForListeners(wiring);
    // Small chunk exercises the < 500 branch; large chunk exercises the >= 500 branch.
    wiring.stdoutHandlers['data']?.(Buffer.from('short '));
    wiring.stdoutHandlers['data']?.(Buffer.from('A'.repeat(600)));
    wiring.procHandlers['close']?.(0, null);
    const result = await promise;
    expect(result.content).toContain('A');
  });
});

describe('ensureCLI auto-install', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetCLIInstallPromise();
    mockExecFileAsync.mockReset();
  });

  function setupSpawnSuccess(): void {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn(), once: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };
    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') setTimeout(() => cb(Buffer.from('ok\n')), 0);
    });
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (...a: unknown[]) => void) => {
      if (event === 'close') setTimeout(() => cb(0, null), 5);
    });
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  }

  it('installs codex CLI via npm when not found, then caches the path', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found')) // initial `which codex`
      .mockResolvedValueOnce({ stdout: '' }) // npm install -g
      .mockResolvedValueOnce({ stdout: '/usr/local/bin/codex\n' }); // post-install `which`
    setupSpawnSuccess();

    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('ok');

    const spawnPath = mockSpawn.mock.calls[0][0];
    expect(spawnPath).toBe('/usr/local/bin/codex');
  });

  it('rejects when npm install succeeds but codex still cannot be located', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(new Error('still not found'));

    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('Failed to locate Codex CLI on PATH');
  });

  it('clears the cached install promise on failure so retries can succeed', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found'))
      .mockRejectedValueOnce(new Error('npm fail'));

    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow();

    // Second call: install path now succeeds → must not re-use the cached failed promise
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '/usr/local/bin/codex\n' });
    setupSpawnSuccess();

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('ok');
  });
});
