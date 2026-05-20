import { spawn } from 'child_process';

import { GoogleGenerativeAI } from '@google/generative-ai';
import * as core from '@actions/core';

import { buildGeminiAuth, GeminiClient, geminiThinkingBudget, resetGeminiCLIInstallPromise, resolveGeminiCredsDir } from './gemini';
import { parseModelSpec } from './model-registry';

// Seeding `~/.gemini/oauth_creds.json` is exercised separately in `cli-utils.test.ts`.
// Stub it out here so the provider tests don't touch the filesystem.
jest.mock('./cli-utils', () => ({
  ...jest.requireActual('./cli-utils'),
  seedAuthFile: jest.fn(),
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('@google/generative-ai');

// Container for the execFileAsync mock — must be a plain object so the
// hoisted jest.mock factory can capture a reference to it before const
// declarations are initialized.
const _execMock = { fn: null as jest.Mock | null };
jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: unknown[]) => _execMock.fn!(...args),
}));

const mockExecFileAsync = jest.fn().mockResolvedValue({ stdout: '/usr/bin/gemini' });
_execMock.fn = mockExecFileAsync;

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe('GeminiClient', () => {
  it('accepts oauth auth', () => {
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    expect(client).toBeDefined();
  });

  it('accepts apiKey auth', () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'key' }, model: 'gemini-3.1-flash-lite' });
    expect(client).toBeDefined();
  });

  it('does not expose warmupCLI (planner does not run on this provider)', () => {
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    expect((client as { warmupCLI?: unknown }).warmupCLI).toBeUndefined();
  });
});

describe('geminiThinkingBudget', () => {
  it('returns undefined for low (no thinking)', () => {
    expect(geminiThinkingBudget('low')).toBeUndefined();
  });

  it('returns undefined when effort is omitted', () => {
    expect(geminiThinkingBudget(undefined)).toBeUndefined();
  });

  it('returns 5000 for medium', () => {
    expect(geminiThinkingBudget('medium')).toBe(5000);
  });

  it('returns 10000 for high', () => {
    expect(geminiThinkingBudget('high')).toBe(10000);
  });

  it('returns 10000 for max (clamped to high)', () => {
    expect(geminiThinkingBudget('max')).toBe(10000);
  });
});

describe('sendMessage effort option (API path)', () => {
  let mockGenerateContent: jest.Mock;
  let mockGetGenerativeModel: jest.Mock;

  beforeEach(() => {
    mockGenerateContent = jest.fn().mockResolvedValue({
      response: { text: () => 'response text' },
    });
    mockGetGenerativeModel = jest.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    });
    (GoogleGenerativeAI as unknown as jest.Mock).mockImplementation(() => ({
      getGenerativeModel: mockGetGenerativeModel,
    }));
  });

  it('passes model name and system instruction to getGenerativeModel', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-flash-lite' });

    await client.sendMessage('system', 'user');

    expect(mockGetGenerativeModel).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-lite',
      systemInstruction: 'system',
    });
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    expect(seedAuthFile).not.toHaveBeenCalled();
  });

  it('passes user message as content with role user', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-flash-lite' });

    await client.sendMessage('system', 'hello world');

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.contents).toEqual([{ role: 'user', parts: [{ text: 'hello world' }] }]);
  });

  it('includes thinkingConfig when effort is high', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-pro-preview' });

    await client.sendMessage('system', 'user', { effort: 'high' });

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 10000 });
  });

  it('includes thinkingConfig when effort is medium', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-flash-lite' });

    await client.sendMessage('system', 'user', { effort: 'medium' });

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 5000 });
  });

  it('omits thinkingConfig when effort is low', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-flash-lite' });

    await client.sendMessage('system', 'user', { effort: 'low' });

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('omits thinkingConfig when no options provided', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-flash-lite' });

    await client.sendMessage('system', 'user');

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('sets maxOutputTokens to 16384 when thinking is disabled', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-flash-lite' });

    await client.sendMessage('system', 'user', { effort: 'low' });

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.maxOutputTokens).toBe(16384);
  });

  it('sets maxOutputTokens to 32768 when thinking is enabled', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-pro-preview' });

    await client.sendMessage('system', 'user', { effort: 'high' });

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.maxOutputTokens).toBe(32768);
  });

  it('returns the response text', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'hello there' },
    });
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-flash-lite' });

    const result = await client.sendMessage('system', 'user');
    expect(result.content).toBe('hello there');
  });

  it('wraps GoogleGenerativeAIResponseError from .text() with a descriptive message', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => { throw new Error('SAFETY'); } },
    });
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-flash-lite' });

    await expect(client.sendMessage('system', 'user')).rejects.toThrow('Gemini API returned no usable content: SAFETY');
  });

  it('propagates SDK errors from generateContent', async () => {
    mockGenerateContent.mockRejectedValue(new Error('quota exceeded'));
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-3.1-flash-lite' });

    await expect(client.sendMessage('system', 'user')).rejects.toThrow('quota exceeded');
  });

  it('throws when SDK client is not initialized (oauth-only construction)', async () => {
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });

    const sendViaAPI = (GeminiClient.prototype as unknown as Record<string, unknown>)['sendViaAPI'] as (
      systemPrompt: string,
      userMessage: string,
    ) => Promise<unknown>;

    await expect(sendViaAPI.call(client, 'sys', 'user')).rejects.toThrow('Gemini client not initialized');
  });
});

describe('buildGeminiAuth', () => {
  it('throws when neither token is present', () => {
    expect(() => buildGeminiAuth('', '')).toThrow(
      'Either gemini_oauth_token or gemini_api_key must be provided',
    );
  });

  it('returns oauth kind when only oauth token is present', () => {
    expect(buildGeminiAuth('oauth-tok', '')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });

  it('returns apiKey kind when only api key is present', () => {
    expect(buildGeminiAuth('', 'gem-key')).toEqual({ kind: 'apiKey', key: 'gem-key' });
  });

  it('oauth wins when both tokens are present', () => {
    expect(buildGeminiAuth('oauth-tok', 'gem-key')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });
});

describe('parseModelSpec — gemini detection', () => {
  it('detects gemini-3.1-flash-lite as gemini provider', () => {
    expect(parseModelSpec('gemini-3.1-flash-lite')).toEqual({ provider: 'gemini', model: 'gemini-3.1-flash-lite' });
  });

  it('detects gemini-3.1-pro-preview as gemini provider', () => {
    expect(parseModelSpec('gemini-3.1-pro-preview')).toEqual({ provider: 'gemini', model: 'gemini-3.1-pro-preview' });
  });

  it('parses gemini/<model> explicit syntax', () => {
    expect(parseModelSpec('gemini/gemini-3.1-flash-lite')).toEqual({ provider: 'gemini', model: 'gemini-3.1-flash-lite' });
  });
});

interface MockProc {
  stdin: { write: jest.Mock; end: jest.Mock; on: jest.Mock };
  stdout: { on: jest.Mock };
  stderr: { on: jest.Mock };
  on: jest.Mock;
  kill: jest.Mock;
}

function setupOAuthSpawnMock(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: string | null;
}): MockProc {
  const proc: MockProc = {
    stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
    kill: jest.fn(),
  };

  proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
    if (event === 'data' && opts.stdout) {
      setTimeout(() => cb(Buffer.from(opts.stdout!)), 0);
    }
  });
  proc.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
    if (event === 'data' && opts.stderr) {
      setTimeout(() => cb(Buffer.from(opts.stderr!)), 0);
    }
  });
  proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
    if (event === 'close') {
      setTimeout(() => cb(opts.exitCode ?? 0, opts.signal ?? null), 5);
    }
  });

  mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  return proc;
}

describe('GeminiClient OAuth path', () => {
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = '/tmp/manki-gemini-test-home';
    mockSpawn.mockReset();
    mockExecFileAsync.mockReset();
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/gemini' });
    resetGeminiCLIInstallPromise();
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockReset();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it('returns trimmed stdout content on success', async () => {
    setupOAuthSpawnMock({ stdout: '  hello there  \n' });
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });

    const result = await client.sendMessage('system', 'user');
    expect(result.content).toBe('hello there');
  });

  it('strips known provider secrets from forwarded env and does not pass the OAuth secret as an env var', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-tok';
    process.env.REVIEW_MEMORY_TOKEN = 'mem-tok';
    process.env.GITHUB_TOKEN = 'gh-tok';
    process.env.GEMINI_API_KEY = 'gem-api';
    process.env.GITHUB_APP_PRIVATE_KEY = 'pem-key';
    process.env.INPUT_ANTHROPIC_API_KEY = 'input-sk';
    process.env.INPUT_GEMINI_API_KEY = 'input-gem';
    process.env.INPUT_GITHUB_TOKEN = 'input-ghtok';
    process.env.GOOGLE_CLOUD_ACCESS_TOKEN = 'ambient-gcp-tok';
    process.env.ACTIONS_RUNTIME_TOKEN = 'art';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'oidc-tok';
    process.env.ACTIONS_RESULTS_URL = 'https://results.actions.githubusercontent.com/';
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.OPENAI_OAUTH_TOKEN = 'openai-oauth';
    process.env.CODEX_OAUTH_TOKEN = 'codex-oauth';
    process.env.INPUT_GEMINI_OAUTH_TOKEN = 'input-gem-oauth';
    try {
      setupOAuthSpawnMock({ stdout: 'ok' });
      const client = new GeminiClient({ auth: { kind: 'oauth', token: 'gem-tok' }, model: 'gemini-3.1-flash-lite' });

      await client.sendMessage('sys', 'user');

      const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(spawnOpts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(spawnOpts.env.REVIEW_MEMORY_TOKEN).toBeUndefined();
      expect(spawnOpts.env.GITHUB_TOKEN).toBeUndefined();
      expect(spawnOpts.env.GEMINI_API_KEY).toBeUndefined();
      expect(spawnOpts.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
      expect(spawnOpts.env.INPUT_ANTHROPIC_API_KEY).toBeUndefined();
      expect(spawnOpts.env.INPUT_GEMINI_API_KEY).toBeUndefined();
      expect(spawnOpts.env.INPUT_GEMINI_OAUTH_TOKEN).toBeUndefined();
      expect(spawnOpts.env.INPUT_GITHUB_TOKEN).toBeUndefined();
      expect(spawnOpts.env.GOOGLE_CLOUD_ACCESS_TOKEN).toBeUndefined();
      expect(spawnOpts.env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
      expect(spawnOpts.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(spawnOpts.env.ACTIONS_RESULTS_URL).toBeUndefined();
      expect(spawnOpts.env.OPENAI_API_KEY).toBeUndefined();
      expect(spawnOpts.env.OPENAI_OAUTH_TOKEN).toBeUndefined();
      expect(spawnOpts.env.CODEX_OAUTH_TOKEN).toBeUndefined();
      // GOOGLE_GENAI_USE_GCA selects the LOGIN_WITH_GOOGLE auth type non-interactively.
      // The actual credentials come from the seeded `~/.gemini/oauth_creds.json` file.
      expect(spawnOpts.env.GOOGLE_GENAI_USE_GCA).toBe('true');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.REVIEW_MEMORY_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.INPUT_ANTHROPIC_API_KEY;
      delete process.env.INPUT_GEMINI_API_KEY;
      delete process.env.INPUT_GITHUB_TOKEN;
      delete process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
      delete process.env.ACTIONS_RUNTIME_TOKEN;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      delete process.env.ACTIONS_RESULTS_URL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_OAUTH_TOKEN;
      delete process.env.CODEX_OAUTH_TOKEN;
      delete process.env.INPUT_GEMINI_OAUTH_TOKEN;
    }
  });

  it('seeds `$HOME/.gemini/oauth_creds.json` from the OAuth secret before invoking the CLI', async () => {
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockClear();
    setupOAuthSpawnMock({ stdout: 'ok' });
    const savedHome = process.env.HOME;
    process.env.HOME = '/tmp/manki-gemini-home-fixture';

    try {
      const client = new GeminiClient({ auth: { kind: 'oauth', token: 'b64-blob' }, model: 'gemini-3.1-flash-lite' });
      await client.sendMessage('sys', 'user');

      expect(seedAuthFile).toHaveBeenCalledWith({
        secret: 'b64-blob',
        inputName: 'gemini_oauth_token',
        targetPath: '/tmp/manki-gemini-home-fixture/.gemini/oauth_creds.json',
        requiredFields: ['access_token', 'refresh_token'],
        bootstrapHint: expect.stringContaining('gemini'),
      });
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  });

  it('throws a clear error when $HOME is not set', async () => {
    setupOAuthSpawnMock({ stdout: 'ok' });
    const savedHome = process.env.HOME;
    delete process.env.HOME;

    try {
      const client = new GeminiClient({ auth: { kind: 'oauth', token: 'b64-blob' }, model: 'gemini-3.1-flash-lite' });
      await expect(client.sendMessage('sys', 'user')).rejects.toThrow(
        /Cannot seed Gemini OAuth credentials.*\$HOME is not set/,
      );
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
    }
  });

  it('propagates seedAuthFile errors (e.g. legacy single-token shape) to the caller', async () => {
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockImplementationOnce(() => {
      throw new Error('gemini_oauth_token did not decode to JSON. Bootstrap with `gemini` ...');
    });
    setupOAuthSpawnMock({ stdout: 'ok' });

    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'legacy' }, model: 'gemini-3.1-flash-lite' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(
      /gemini_oauth_token did not decode to JSON.*gemini/,
    );
  });

  it('passes --model flag with the configured model name to the CLI', async () => {
    setupOAuthSpawnMock({ stdout: 'ok' });
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-pro-preview' });

    await client.sendMessage('sys', 'user');

    const args = mockSpawn.mock.calls[0][1] as string[];
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('gemini-3.1-pro-preview');
  });

  it('uses untrusted-content delimiter when concatenating prompts on stdin', async () => {
    const proc = setupOAuthSpawnMock({ stdout: 'ok' });
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });

    await client.sendMessage('SYS_CONTENT', 'USER_CONTENT');

    const written = (proc.stdin.write.mock.calls[0][0] ?? '') as string;
    expect(written).toContain('SYS_CONTENT');
    expect(written).toContain('=== USER CONTENT (untrusted) ===');
    expect(written).toContain('USER_CONTENT');
    expect(written).toContain('=== END USER CONTENT ===');
  });

  it('warns when CLI fails with non-zero exit and sanitizes stderr', async () => {
    setupOAuthSpawnMock({
      stderr: '::error::leaked\nplain error',
      exitCode: 2,
    });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(/Gemini CLI invocation failed/);

    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarnings).toContain('[redacted-workflow-cmd]');
    expect(allWarnings).not.toContain('::error::leaked');
    warnSpy.mockRestore();
  });

  it.each(['medium', 'high', 'max'] as const)(
    'warns and proceeds when effort is %s on OAuth path',
    async (effort) => {
      setupOAuthSpawnMock({ stdout: 'ok' });
      const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
      const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });

      const result = await client.sendMessage('sys', 'user', { effort });

      expect(result.content).toBe('ok');
      const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(allWarnings).toContain(`does not support effort=${effort}`);
      warnSpy.mockRestore();
    },
  );

  it('does not warn when effort is low or omitted', async () => {
    setupOAuthSpawnMock({ stdout: 'ok' });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });

    await client.sendMessage('sys', 'user', { effort: 'low' });
    const lowWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('does not support effort'));
    expect(lowWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('falls back to npm install when `which` fails', async () => {
    mockExecFileAsync.mockReset();
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '/usr/local/bin/gemini' });
    setupOAuthSpawnMock({ stdout: 'installed-ok' });

    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    const result = await client.sendMessage('sys', 'user');

    expect(result.content).toBe('installed-ok');
    const installCall = mockExecFileAsync.mock.calls.find((c) => c[0] === 'npm');
    expect(installCall).toBeDefined();
  });

  it('rejects when the CLI install ultimately fails', async () => {
    mockExecFileAsync.mockReset();
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(new Error('which still fails'));

    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(/Failed to install Gemini CLI/);
  });

  it('rejects with stderr details when CLI fails on stale timeout', async () => {
    jest.useFakeTimers();
    try {
      const proc: MockProc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };
      const handlers: Record<string, (code: number | null, signal: string | null) => void> = {};
      proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
        handlers[event] = cb;
      });
      // Emit some stdout first, then go stale.
      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from('partial output')), 1);
      });
      proc.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from('some stderr')), 2);
      });
      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

      const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
      const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(5);
      // STALE_TIMEOUT_MS is 90s; advance past it to fire handleStale.
      await jest.advanceTimersByTimeAsync(91_000);
      // Now invoke close handler with SIGTERM signal as if kill('SIGTERM') landed.
      handlers.close?.(null, 'SIGTERM');

      await expect(promise).rejects.toThrow(/Gemini CLI stale/);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(allWarnings).toContain('Gemini CLI stale');
      warnSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects with timeout message when overall timer fires', async () => {
    jest.useFakeTimers();
    try {
      const proc: MockProc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };
      const handlers: Record<string, (code: number | null, signal: string | null) => void> = {};
      proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
        handlers[event] = cb;
      });
      // Keep emitting stdout to bypass the stale timer until the overall timer fires.
      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') {
          for (let i = 0; i < 30; i++) setTimeout(() => cb(Buffer.from(`keepalive-${i}`)), i * 60_000);
        }
      });
      proc.stderr.on.mockImplementation(() => {});
      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

      const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
      const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(1_201_000);
      handlers.close?.(null, 'SIGTERM');

      await expect(promise).rejects.toThrow(/Gemini CLI timed out after 1200s/);
      warnSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects when child emits a spawn error before settle', async () => {
    const proc: MockProc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };
    proc.stdout.on.mockImplementation(() => {});
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (arg: unknown) => void) => {
      if (event === 'error') {
        setTimeout(() => cb(new Error('ENOENT')), 1);
      }
    });
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(/Gemini CLI spawn failed: ENOENT/);
  });

  it('handles stdin backpressure by waiting for drain before ending', async () => {
    const proc: MockProc = {
      stdin: { write: jest.fn().mockReturnValue(false), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };
    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') setTimeout(() => cb(Buffer.from('ok')), 0);
    });
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') setTimeout(() => cb(0, null), 10);
    });

    const drainCallbacks: Array<() => void> = [];
    const stdinOnce = jest.fn((event: string, cb: () => void) => {
      if (event === 'drain') drainCallbacks.push(cb);
    });
    (proc.stdin as unknown as { once: jest.Mock }).once = stdinOnce;

    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    const promise = client.sendMessage('sys', 'user');

    // Allow microtasks to register the drain listener, then fire it.
    await new Promise((r) => setTimeout(r, 1));
    expect(stdinOnce).toHaveBeenCalledWith('drain', expect.any(Function));
    drainCallbacks.forEach((cb) => cb());

    const result = await promise;
    expect(result.content).toBe('ok');
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it('rejects when stdin.write throws synchronously', async () => {
    const proc: MockProc = {
      stdin: {
        write: jest.fn().mockImplementation(() => { throw new Error('EPIPE'); }),
        end: jest.fn(),
        on: jest.fn(),
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

    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(/stdin write failed: EPIPE/);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    warnSpy.mockRestore();
  });

  it('rejects when output exceeds the 50MB limit', async () => {
    const proc: MockProc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };
    const closeHandlers: Array<(code: number | null, signal: string | null) => void> = [];
    proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') closeHandlers.push(cb);
    });
    // Emit a 51MB stdout chunk to trip the limit, then close.
    const big = Buffer.alloc(51 * 1024 * 1024, 'a');
    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') {
        setTimeout(() => {
          cb(big);
          closeHandlers.forEach((h) => h(null, 'SIGTERM'));
        }, 0);
      }
    });
    proc.stderr.on.mockImplementation(() => {});
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(/exceeded 50MB limit/);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('truncates lastStdoutChunk when a single chunk exceeds 500 chars (used in stale diagnostics)', async () => {
    jest.useFakeTimers();
    try {
      const proc: MockProc = {
        stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };
      const handlers: Record<string, (code: number | null, signal: string | null) => void> = {};
      proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
        handlers[event] = cb;
      });
      // Send a single chunk longer than 500 chars to exercise the slice(-500) branch.
      const longChunk = 'A'.repeat(600) + 'TAIL';
      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from(longChunk)), 1);
      });
      proc.stderr.on.mockImplementation(() => {});
      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

      const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
      const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
      const promise = client.sendMessage('sys', 'user');
      await jest.advanceTimersByTimeAsync(2);
      await jest.advanceTimersByTimeAsync(91_000);
      handlers.close?.(null, 'SIGTERM');

      await expect(promise).rejects.toThrow(/Gemini CLI stale/);
      const warnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnings).toContain('TAIL');
      warnSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('logs a warning when stdin emits an async error event', async () => {
    const stdinHandlers: Record<string, (err: Error) => void> = {};
    const proc: MockProc = {
      stdin: {
        write: jest.fn().mockReturnValue(true),
        end: jest.fn(),
        on: jest.fn().mockImplementation((event: string, cb: (err: Error) => void) => {
          stdinHandlers[event] = cb;
        }),
      },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };
    proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') setTimeout(() => cb(Buffer.from('ok')), 0);
    });
    proc.stderr.on.mockImplementation(() => {});
    proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') setTimeout(() => cb(0, null), 5);
    });
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    const promise = client.sendMessage('sys', 'user');
    await new Promise((r) => setTimeout(r, 1));
    stdinHandlers.error?.(new Error('broken pipe'));
    await promise;
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('stdin write error: broken pipe'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('uses cached CLI path on second invocation', async () => {
    setupOAuthSpawnMock({ stdout: 'first' });
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-3.1-flash-lite' });
    await client.sendMessage('sys', 'user');

    mockExecFileAsync.mockClear();
    setupOAuthSpawnMock({ stdout: 'second' });
    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('second');
    // No additional `which`/`npm` calls — path is cached on the instance.
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

describe('resolveGeminiCredsDir', () => {
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it('returns $HOME/.gemini when HOME is set', () => {
    process.env.HOME = '/h';
    expect(resolveGeminiCredsDir()).toBe('/h/.gemini');
  });

  it('throws when HOME is not set', () => {
    delete process.env.HOME;
    expect(() => resolveGeminiCredsDir()).toThrow(/\$HOME is not set/);
  });
});
