import { spawn } from 'child_process';
import OpenAI from 'openai';
import * as core from '@actions/core';

import {
  buildOpenAIAuth,
  isReasoningModel,
  OpenAIClient,
  resetCLIInstallPromise,
  resolveCodexHome,
  resolveEffortTier,
  sanitizeLogOutput,
  STALE_TIMEOUT_MS,
} from './openai';

// Seeding `$CODEX_HOME/auth.json` is exercised separately in `cli-utils.test.ts`.
// Stub it out here so the provider tests don't touch the filesystem.
jest.mock('./cli-utils', () => ({
  ...jest.requireActual('./cli-utils'),
  seedAuthFile: jest.fn(),
}));

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

  it('does not expose warmupCLI (planner does not run on this provider)', () => {
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    expect((client as { warmupCLI?: unknown }).warmupCLI).toBeUndefined();
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

  afterEach(() => {
    jest.restoreAllMocks();
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
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    expect(seedAuthFile).not.toHaveBeenCalled();
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
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring effort=high'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Effort has no effect via the OpenAI API'));
  });

  it('warns and ignores non-high effort on non-reasoning models', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });

    await client.sendMessage('sys', 'user', { effort: 'low' });

    const params = mockCreate.mock.calls[0][0];
    expect(params.reasoning_effort).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring effort=low'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Effort has no effect via the OpenAI API'));
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

  it('returns empty string when choices array is empty', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [] });
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('');
  });

  it('lifts usage and measures latency on the SDK path', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'response text' } }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 60,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 15 },
      },
    });
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'o3' });
    const result = await client.sendMessage('sys', 'user', { effort: 'high' });
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 60,
      cachedTokens: 40,
      reasoningTokens: 15,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns zero usage when the SDK omits the usage block', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'response text' } }] });
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });
    const result = await client.sendMessage('sys', 'user');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 });
  });

  it('throws when client is not initialized (oauth path called via API method)', async () => {
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    const sendViaAPI = (OpenAIClient.prototype as unknown as Record<string, unknown>)['sendViaAPI'] as (
      systemPrompt: string,
      userMessage: string,
    ) => Promise<unknown>;

    await expect(sendViaAPI.call(client, 'sys', 'user')).rejects.toThrow('OpenAI client not initialized');
  });

  it('propagates SDK errors from chat.completions.create to the caller', async () => {
    mockCreate.mockRejectedValueOnce(new Error('rate limited'));
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('rate limited');
  });
});

describe('sendViaOAuth (Codex CLI path)', () => {
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/manki-test-codex';
    mockSpawn.mockReset();
    resetCLIInstallPromise();
    mockExecFileAsync.mockReset();
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/codex' });
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockReset();
  });

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    jest.restoreAllMocks();
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
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort=high');
  });

  it('warns and skips reasoning override on non-reasoning models', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    await client.sendMessage('sys', 'user', { effort: 'high' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.find(a => a.startsWith('model_reasoning_effort'))).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring effort=high'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Codex CLI will apply its own default effort'));
  });

  it('warns and skips reasoning override for non-high effort on non-reasoning models', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    await client.sendMessage('sys', 'user', { effort: 'low' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.find(a => a.startsWith('model_reasoning_effort'))).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring effort=low'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Codex CLI will apply its own default effort'));
  });

  it('does not pass the OAuth secret as a CLI env var (auth flows via $CODEX_HOME/auth.json)', async () => {
    setupSpawnMock('ok\n');
    const savedKey = process.env.OPENAI_API_KEY;
    const savedOauthToken = process.env.OPENAI_OAUTH_TOKEN;
    const savedCodexOauth = process.env.CODEX_OAUTH_TOKEN;
    const savedCodexHome = process.env.CODEX_HOME;
    const savedInputOpenAI = process.env.INPUT_OPENAI_API_KEY;
    const savedInputGemini = process.env.INPUT_GEMINI_API_KEY;
    const savedActionsRuntime = process.env.ACTIONS_RUNTIME_TOKEN;
    const savedActionsIdToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const savedActionsResults = process.env.ACTIONS_RESULTS_URL;
    process.env.OPENAI_API_KEY = 'sk-ambient-key';
    process.env.OPENAI_OAUTH_TOKEN = 'legacy-oauth-blob';
    process.env.CODEX_OAUTH_TOKEN = 'legacy-codex-blob';
    process.env.CODEX_HOME = '/tmp/manki-codex-fixture';
    process.env.INPUT_OPENAI_API_KEY = 'input-openai';
    process.env.INPUT_GEMINI_API_KEY = 'input-gemini';
    process.env.ACTIONS_RUNTIME_TOKEN = 'art';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'oidc-tok';
    process.env.ACTIONS_RESULTS_URL = 'https://results.actions.githubusercontent.com/';

    try {
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'my-tok' }, model: 'gpt-4o' });
      await client.sendMessage('sys', 'user');

      const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.CODEX_OAUTH_TOKEN).toBeUndefined();
      expect(spawnOpts.env.OPENAI_OAUTH_TOKEN).toBeUndefined();
      expect(spawnOpts.env.OPENAI_API_KEY).toBeUndefined();
      expect(spawnOpts.env.INPUT_OPENAI_API_KEY).toBeUndefined();
      expect(spawnOpts.env.INPUT_GEMINI_API_KEY).toBeUndefined();
      expect(spawnOpts.env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
      expect(spawnOpts.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(spawnOpts.env.ACTIONS_RESULTS_URL).toBeUndefined();
      expect(spawnOpts.env.CODEX_HOME).toBe('/tmp/manki-codex-fixture');
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
      if (savedOauthToken === undefined) delete process.env.OPENAI_OAUTH_TOKEN; else process.env.OPENAI_OAUTH_TOKEN = savedOauthToken;
      if (savedCodexOauth === undefined) delete process.env.CODEX_OAUTH_TOKEN; else process.env.CODEX_OAUTH_TOKEN = savedCodexOauth;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
      if (savedInputOpenAI === undefined) delete process.env.INPUT_OPENAI_API_KEY; else process.env.INPUT_OPENAI_API_KEY = savedInputOpenAI;
      if (savedInputGemini === undefined) delete process.env.INPUT_GEMINI_API_KEY; else process.env.INPUT_GEMINI_API_KEY = savedInputGemini;
      if (savedActionsRuntime === undefined) delete process.env.ACTIONS_RUNTIME_TOKEN; else process.env.ACTIONS_RUNTIME_TOKEN = savedActionsRuntime;
      if (savedActionsIdToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN; else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = savedActionsIdToken;
      if (savedActionsResults === undefined) delete process.env.ACTIONS_RESULTS_URL; else process.env.ACTIONS_RESULTS_URL = savedActionsResults;
    }
  });

  it('seeds `$CODEX_HOME/auth.json` from the OAuth secret before invoking the CLI', async () => {
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockClear();
    setupSpawnMock('ok\n');
    const savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/manki-codex-seed-fixture';

    try {
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'b64-blob' }, model: 'gpt-4o' });
      await client.sendMessage('sys', 'user');

      expect(seedAuthFile).toHaveBeenCalledWith({
        secret: 'b64-blob',
        inputName: 'openai_oauth_token',
        targetPath: '/tmp/manki-codex-seed-fixture/auth.json',
        requiredFields: ['tokens.access_token', 'tokens.refresh_token'],
        bootstrapHint: expect.stringContaining('codex login'),
      });
    } finally {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
    }
  });

  it('defaults `$CODEX_HOME` to `$HOME/.codex` when CODEX_HOME is unset', async () => {
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockClear();
    setupSpawnMock('ok\n');
    const savedHome = process.env.HOME;
    const savedCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    process.env.HOME = '/tmp/manki-home-fixture';

    try {
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'b64-blob' }, model: 'gpt-4o' });
      await client.sendMessage('sys', 'user');

      expect(seedAuthFile).toHaveBeenCalledWith(
        expect.objectContaining({ targetPath: '/tmp/manki-home-fixture/.codex/auth.json' }),
      );
      const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.CODEX_HOME).toBe('/tmp/manki-home-fixture/.codex');
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome; else delete process.env.HOME;
      if (savedCodexHome !== undefined) process.env.CODEX_HOME = savedCodexHome;
    }
  });

  it('throws a clear error when neither $CODEX_HOME nor $HOME is set', async () => {
    setupSpawnMock('ok\n');
    const savedHome = process.env.HOME;
    const savedCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    delete process.env.HOME;

    try {
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'b64-blob' }, model: 'gpt-4o' });
      await expect(client.sendMessage('sys', 'user')).rejects.toThrow(
        /Cannot resolve CODEX_HOME.*neither \$CODEX_HOME nor \$HOME is set/,
      );
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedCodexHome !== undefined) process.env.CODEX_HOME = savedCodexHome;
    }
  });

  it('propagates seedAuthFile errors (e.g. legacy single-token shape) to the caller', async () => {
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockImplementationOnce(() => {
      throw new Error('openai_oauth_token did not decode to JSON. Bootstrap with `codex login` ...');
    });
    setupSpawnMock('ok\n');

    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'sk-legacy' }, model: 'gpt-4o' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(
      /openai_oauth_token did not decode to JSON.*codex login/,
    );
  });

  it('maps low effort to model_reasoning_effort=low on o-series CLI invocation', async () => {
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await client.sendMessage('sys', 'user', { effort: 'low' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort=low');
  });

  it('maps medium effort to model_reasoning_effort=medium on o-series CLI invocation', async () => {
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await client.sendMessage('sys', 'user', { effort: 'medium' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort=medium');
  });

  it('maps max effort to model_reasoning_effort=high on o-series CLI invocation', async () => {
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o4-mini' });

    await client.sendMessage('sys', 'user', { effort: 'max' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort=high');
  });

  it('returns trimmed stdout content on success', async () => {
    setupSpawnMock('  hello world  \n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('hello world');
  });

  it('rejects on non-zero exit code with rich diagnostics', async () => {
    setupSpawnMock('', { exitCode: 1, stderr: 'something broke' });
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await expect(client.sendMessage('sys', 'user', { effort: 'high' })).rejects.toThrow(
      /Codex CLI invocation failed.*model=o3.*effort=high.*promptChars=\d+.*elapsedMs=\d+.*stderrChars=\d+/s,
    );
  });

  it('surfaces stdout tail and <empty stderr> marker when exit-1 has no stderr', async () => {
    setupSpawnMock('partial codex output before crash', { exitCode: 1, stderr: '' });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(/Codex CLI invocation failed/);
    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarnings).toContain('Codex CLI failed');
    expect(allWarnings).toContain('<empty stderr>');
    expect(allWarnings).toContain('lastStdout=partial codex output before crash');
    expect(allWarnings).toContain('stderrChars=0');
    warnSpy.mockRestore();
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

describe('resolveEffortTier', () => {
  it('passes through low/medium/high unchanged', () => {
    expect(resolveEffortTier('low')).toBe('low');
    expect(resolveEffortTier('medium')).toBe('medium');
    expect(resolveEffortTier('high')).toBe('high');
  });

  it('collapses max to high', () => {
    expect(resolveEffortTier('max')).toBe('high');
  });

});

describe('sendViaOAuth — extended coverage', () => {
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/manki-test-codex';
    mockSpawn.mockReset();
    resetCLIInstallPromise();
    mockExecFileAsync.mockReset();
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/codex' });
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockReset();
  });

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    jest.restoreAllMocks();
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
    stderrHandlers: Record<string, (data: Buffer) => void>;
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
    return { proc, procHandlers, stdoutHandlers, stderrHandlers, stdinHandlers };
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

  it('rejects with hard timeout error after 1200s even with periodic stdout', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      const wiring = makeProc();
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
      const promise = client.sendMessage('sys', 'user');
      promise.catch(() => {});

      await waitForListeners(wiring);
      // Emit stdout periodically so the stale timer keeps resetting; only the hard
      // 1200s deadline should fire. Step strictly shorter than STALE_TIMEOUT_MS, with
      // a final stdout chunk after the loop so stale always has > step time remaining.
      const step = STALE_TIMEOUT_MS - 10_000;
      let elapsed = 0;
      while (elapsed + step < 1_200_000) {
        wiring.stdoutHandlers['data']?.(Buffer.from('partial'));
        jest.advanceTimersByTime(step);
        elapsed += step;
      }
      wiring.stdoutHandlers['data']?.(Buffer.from('partial'));
      jest.advanceTimersByTime(1_200_000 - elapsed + 100);
      wiring.procHandlers['close']?.(null, 'SIGTERM');

      await expect(promise).rejects.toThrow(/timed out after 1200s/);
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
    expect(wiring.proc.kill).toHaveBeenCalledWith('SIGTERM');
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

  it('accumulates multi-chunk stdout and returns trimmed content on success', async () => {
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

  it('includes last 500 bytes of stdout in stale error message', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      const wiring = makeProc();
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
      const promise = client.sendMessage('sys', 'user');
      promise.catch(() => {});

      await waitForListeners(wiring);
      wiring.stdoutHandlers['data']?.(Buffer.from('UNIQUE_DIAGNOSTIC_MARKER'));
      jest.advanceTimersByTime(STALE_TIMEOUT_MS + 100);
      wiring.procHandlers['close']?.(null, 'SIGTERM');

      await expect(promise).rejects.toThrow(/UNIQUE_DIAGNOSTIC_MARKER/);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ensureCLI auto-install', () => {
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/manki-test-codex';
    mockSpawn.mockReset();
    resetCLIInstallPromise();
    mockExecFileAsync.mockReset();
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockReset();
  });

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
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

    // Pinning + `--ignore-scripts` are the supply-chain hardening for the auto-install path.
    const npmCall = mockExecFileAsync.mock.calls.find((c) => c[0] === 'npm');
    expect(npmCall).toBeDefined();
    const npmArgs = npmCall![1] as string[];
    expect(npmArgs).toContain('--ignore-scripts');
    expect(npmArgs.some((a) => /^@openai\/codex@\d+\.\d+\.\d+/.test(a))).toBe(true);
  });

  it('rejects when npm install succeeds but codex still cannot be located', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(new Error('still not found'));

    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('Failed to locate Codex CLI on PATH');
  });

  it('deduplicates concurrent installs so npm install runs once for parallel callers', async () => {
    let resolveInstall!: () => void;
    const installBarrier = new Promise<void>((r) => { resolveInstall = r; });

    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not found')) // which codex — client A
      .mockRejectedValueOnce(new Error('not found')) // which codex — client B
      .mockImplementationOnce(() => installBarrier.then(() => ({ stdout: '' }))) // npm install (shared)
      .mockResolvedValueOnce({ stdout: '/usr/local/bin/codex\n' }); // post-install which
    setupSpawnSuccess();

    const clientA = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    const clientB = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    const p1 = clientA.sendMessage('s', 'u');
    const p2 = clientB.sendMessage('s', 'u');
    resolveInstall();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.content).toBe('ok');
    expect(r2.content).toBe('ok');
    const npmCalls = mockExecFileAsync.mock.calls.filter((c) => c[0] === 'npm');
    expect(npmCalls).toHaveLength(1);
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

describe('resolveCodexHome', () => {
  let savedCodexHome: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedCodexHome = process.env.CODEX_HOME;
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it('returns CODEX_HOME when set', () => {
    process.env.CODEX_HOME = '/explicit';
    expect(resolveCodexHome()).toBe('/explicit');
  });

  it('returns $HOME/.codex when CODEX_HOME is unset', () => {
    delete process.env.CODEX_HOME;
    process.env.HOME = '/h';
    expect(resolveCodexHome()).toBe('/h/.codex');
  });

  it('throws when neither CODEX_HOME nor HOME is set', () => {
    delete process.env.CODEX_HOME;
    delete process.env.HOME;
    expect(() => resolveCodexHome()).toThrow(/neither \$CODEX_HOME nor \$HOME/);
  });
});
