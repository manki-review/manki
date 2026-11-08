import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import OpenAI from 'openai';
import * as core from '@actions/core';

import {
  buildOpenAIAuth,
  OpenAIClient,
  readCodexLimits,
  resetCLIInstallPromise,
  resolveCodexHome,
  resolveReasoningEffort,
  sanitizeLogOutput,
  STALE_TIMEOUT_MS,
} from './openai';
import { QuotaError, RefusalError } from './types';

// Seeding `$CODEX_HOME/auth.json` is exercised separately in `cli-utils.test.ts`.
// Stub it out here so the provider tests don't touch the filesystem.
jest.mock('./cli-utils', () => ({
  ...jest.requireActual('./cli-utils'),
  seedAuthFile: jest.fn(),
  registerAuthFileSecrets: jest.fn(),
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

describe('resolveReasoningEffort', () => {
  it.each([
    ['o1', 'high'],
    ['o3', 'high'],
    ['o3-mini', 'high'],
    ['o4-mini', 'high'],
    ['gpt-5', 'high'],
    ['gpt-5-mini', 'high'],
    ['gpt-5-nano-2025-08-07', 'high'],
    ['gpt-5.1', 'high'],
    ['gpt-5.2', 'xhigh'],
    ['gpt-5.3-codex', 'xhigh'],
    ['gpt-5.4-nano', 'xhigh'],
    ['gpt-5.5', 'xhigh'],
    ['gpt-5.6-sol', 'max'],
    ['gpt-5.6-luna', 'max'],
    ['GPT-6-Luna', 'max'],
    ['gpt-6-astra', 'max'],
    ['gpt-6.1-sol', 'max'],
    ['gpt-6.1-terra', 'max'],
  ])('maps max to the highest effort %s accepts', (model, expected) => {
    expect(resolveReasoningEffort(model, 'max')).toBe(expected);
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(resolveReasoningEffort(model, tier)).toBe(tier);
    }
  });

  it.each([
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-3.5-turbo',
    'gpt-5-chat-latest',
    'gpt-5.3-chat-latest',
    'gpt-5-pro',
    'o3-pro-2025-06-10',
    'gpt-realtime-2.1',
    'gpt-image-2.5',
    'claude-opus-4-6',
    'overlord',
  ])('returns undefined for %s, which rejects reasoning effort', (model) => {
    expect(resolveReasoningEffort(model, 'high')).toBeUndefined();
    expect(resolveReasoningEffort(model, 'max')).toBeUndefined();
  });
});

describe('readCodexLimits', () => {
  const tokenCount = (rateLimits: unknown) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rateLimits } });
  let home: string;
  const writeSession = (name: string, lines: string[], mtimeSeconds: number) => {
    const dir = join(home, 'sessions', '2026', '11', '09');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `${lines.join('\n')}\n`);
    utimesSync(path, mtimeSeconds, mtimeSeconds);
  };

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'manki-codex-limits-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reads the last recorded limits of the newest session written since the call started that has any', () => {
    writeSession('rollout-old.jsonl', [tokenCount({ primary: { used_percent: 99, window_minutes: 300 } })], 1000);
    writeSession('rollout-new.jsonl', [
      tokenCount({ primary: { used_percent: 10, window_minutes: 300 } }),
      tokenCount({ primary: { used_percent: 72.4, window_minutes: 300, resets_at: 1794000000 }, secondary: { used_percent: 91, window_minutes: 10080 } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
    ], 2000);
    // A call running in parallel started a newer session that has no readings yet.
    writeSession('rollout-parallel.jsonl', [JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } })], 3000);

    expect(readCodexLimits(home, 1500 * 1000)).toEqual([
      { account: 'ChatGPT subscription', window: '5-hour', usedPercent: 72, resetsAt: 1794000000 },
      { account: 'ChatGPT subscription', window: 'weekly', usedPercent: 91 },
    ]);
    expect(readCodexLimits(home, 2500 * 1000)).toEqual([]);
  });

  it('names other window lengths by days or hours, and skips a window without a length or share', () => {
    writeSession('rollout.jsonl', [tokenCount({ primary: { used_percent: 5, window_minutes: 2880 }, secondary: { used_percent: 6, window_minutes: 60 } })], 2000);
    expect(readCodexLimits(home, 0).map(l => l.window)).toEqual(['2-day', '1-hour']);

    writeSession('rollout.jsonl', ['{"rate_limits": not json', tokenCount({ primary: { used_percent: 5 }, secondary: null }), tokenCount(null)], 2000);
    expect(readCodexLimits(home, 0)).toEqual([]);
  });

  it('returns none when Codex wrote no sessions', () => {
    expect(readCodexLimits(home, 0)).toEqual([]);
    expect(readCodexLimits(join(home, 'missing'), 0)).toEqual([]);
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

  it('maps max effort to the highest reasoning_effort the model accepts', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'o3' });
    await client.sendMessage('sys', 'user', { effort: 'max' });
    const gpt6 = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-6.1-sol' });
    await gpt6.sendMessage('sys', 'user', { effort: 'max' });

    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('high');
    expect(mockCreate.mock.calls[1][0].reasoning_effort).toBe('max');
  });

  it('sends reasoning_effort to GPT-5 family models', async () => {
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-5.6-terra' });
    await client.sendMessage('sys', 'user', { effort: 'low' });

    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('low');
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
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 15,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it.each<[string | undefined, boolean]>([
    ['length', true],
    ['stop', false],
    [undefined, false],
  ])('reports truncated for finish_reason %s', async (finishReason, expected) => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '[' }, finish_reason: finishReason }] });
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });
    const result = await client.sendMessage('sys', 'user');
    expect(result.truncated).toBe(expected);
  });

  it.each([
    [{ message: { content: '' }, finish_reason: 'content_filter' }, 'content_filter'],
    [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: 'stop' }, 'refusal'],
  ])('throws a `RefusalError` for a policy refusal (%j)', async (choice, reason) => {
    mockCreate.mockResolvedValueOnce({ choices: [choice] });
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as RefusalError).reason).toBe(reason);
  });

  it('returns zero usage when the SDK omits the usage block', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'response text' } }] });
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-4o' });
    const result = await client.sendMessage('sys', 'user');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
  });

  it('throws when client is not initialized (oauth path called via API method)', async () => {
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    const sendViaAPI = (OpenAIClient.prototype as unknown as Record<string, unknown>)['sendViaAPI'] as (
      systemPrompt: string,
      userMessage: string,
    ) => Promise<unknown>;

    await expect(sendViaAPI.call(client, 'sys', 'user')).rejects.toThrow('OpenAI client not initialized');
  });

  it.each<[string, object, object]>([
    ['a used-up quota', { status: 429, code: 'insufficient_quota', message: '429 You exceeded your current quota, please check your plan and billing details.' }, { limit: 'OpenAI API quota exhausted', resetsAt: undefined }],
    ['a rate limit', { status: 429, code: 'rate_limit_exceeded', message: '429 Rate limit reached for gpt-5.5. Please try again in 20s. Visit the docs.' }, { limit: 'OpenAI API rate limit reached', resetsAt: 'in 20s' }],
  ])('throws a `QuotaError` on %s', async (_case, fields, expected) => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error(), fields));
    const client = new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-5.5' });

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toMatchObject({ ...expected, credential: 'key' });
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

  const instructionsPath = (args: string[]): string => JSON.parse(args.at(-2)!.replace(/^model_instructions_file=/, ''));

  /** Mocks the CLI and returns its stdin and the instructions file of each call, which is gone once the call returns. */
  function setupSpawnMock(stdout: string, opts: { exitCode?: number; stderr?: string } = {}): { stdin: jest.Mock; instructions: string[] } {
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

    const instructions: string[] = [];
    mockSpawn.mockImplementation((_command, args) => {
      instructions.push(readFileSync(instructionsPath(args as string[]), 'utf8'));
      return proc as unknown as ReturnType<typeof spawn>;
    });
    return { stdin: proc.stdin.write, instructions };
  }

  it('runs `codex exec` read-only with no built-in tool and Manki\'s instructions in a file, in an empty temp directory', async () => {
    const { stdin, instructions } = setupSpawnMock('hello\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await client.sendMessage('sys', 'user');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual([
      'exec', '--skip-git-repo-check', '--model=o3', '--sandbox', 'read-only', '-c', 'approval_policy=never',
      '-c', 'features.shell_tool=false', '-c', 'features.view_image=false', '-c', 'web_search=disabled', '-c', 'features.apps=false',
      '-c', 'features.plugins=false', '-c', 'features.multi_agent=false', '-c', 'features.image_generation=false',
      '-c', expect.stringMatching(/^model_instructions_file=".*\/instructions\.md"$/), '-',
    ]);
    expect(instructions).toEqual(['sys']);
    expect(existsSync(instructionsPath(spawnArgs))).toBe(false);
    expect(stdin.mock.calls.map(c => String(c[0])).join('')).toBe('user');
    const { cwd } = mockSpawn.mock.calls[0][2] as { cwd: string };
    expect(cwd.startsWith(join(tmpdir(), 'manki-cli-'))).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it('gives Codex Manki\'s tool server with the file tools, and tells it about them, only when asked', async () => {
    const { stdin, instructions } = setupSpawnMock('[]\n');
    const savedRunnerTemp = process.env.RUNNER_TEMP;
    const savedApiUrl = process.env.GITHUB_API_URL;
    const savedProxy = process.env.HTTPS_PROXY;
    const savedSecret = process.env.OPENAI_API_KEY;
    process.env.RUNNER_TEMP = '/runner/temp';
    process.env.GITHUB_API_URL = 'https://ghe.example/api/v3';
    process.env.HTTPS_PROXY = 'http://user:secret@proxy:3128';
    process.env.OPENAI_API_KEY = 'sk-not-for-the-server';
    try {
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-5.5' });
      expect(client.repoTools).toBe(true);
      expect(new OpenAIClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'gpt-5.5' }).repoTools).toBe(false);

      await client.sendMessage('Review the diff.', 'the diff', { repoTools: { root: '/work/repo', steps: 15 } });
      await client.sendMessage('Review the diff.', 'the diff');
    } finally {
      if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = savedRunnerTemp;
      if (savedApiUrl === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = savedApiUrl;
      if (savedProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = savedProxy;
      if (savedSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedSecret;
    }

    const [withTools, without] = mockSpawn.mock.calls.map(call => call[1] as string[]);
    expect(withTools.join(' ')).toContain([
      `-c mcp_servers.manki.command=${JSON.stringify(process.execPath)}`,
      `-c mcp_servers.manki.args=${JSON.stringify([process.argv[1], 'mcp-server', '/work/repo', '--file-tools', '--steps', '15'])}`,
      '-c mcp_servers.manki.default_tools_approval_mode="approve"',
    ].join(' '));
    // The server gets the CLI's own environment by name, so no value, such as a proxy password, is on the command line.
    const envVars = JSON.parse(withTools.find(arg => arg.startsWith('mcp_servers.manki.env_vars='))!.slice('mcp_servers.manki.env_vars='.length)) as string[];
    expect(envVars).toEqual(expect.arrayContaining(['RUNNER_TEMP', 'HTTPS_PROXY', 'GITHUB_API_URL']));
    expect(envVars).not.toContain('OPENAI_API_KEY');
    expect(withTools.join(' ')).not.toContain('secret@proxy');
    expect(withTools.some(arg => arg.startsWith('mcp_servers.manki.env.'))).toBe(false);
    const { env: codexEnv } = mockSpawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(codexEnv).toMatchObject({ RUNNER_TEMP: '/runner/temp', HTTPS_PROXY: 'http://user:secret@proxy:3128', GITHUB_API_URL: 'https://ghe.example/api/v3' });
    expect(codexEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(withTools).toContain('features.shell_tool=false');
    expect(without.join(' ')).not.toContain('mcp_servers');
    expect(instructions[0]).toMatch(/^Review the diff\.\n\n## Tools\n\nThe PR's head commit is checked out at `\/work\/repo`\. `read_file`, `grep` and `glob` read files/);
    expect(instructions[0]).not.toContain('## Related repos');
    expect(instructions[1]).toBe('Review the diff.');
    expect(stdin.mock.calls.map(c => String(c[0]))).toEqual(['the diff', 'the diff']);
  });

  it('reads back how often the tool server read each related repo, and passes no reads file without related repos', async () => {
    setupSpawnMock('[]\n');
    const spawnFromHelper = mockSpawn.getMockImplementation()!;
    mockSpawn.mockImplementation((...spawnArgs: Parameters<typeof spawnFromHelper>) => {
      const serverArgs = JSON.parse((spawnArgs[1] as string[]).find(arg => arg.startsWith('mcp_servers.manki.args='))!.slice('mcp_servers.manki.args='.length)) as string[];
      const at = serverArgs.indexOf('--reads-file');
      if (at !== -1) writeFileSync(serverArgs[at + 1], JSON.stringify({ 'dashpay/dash': 2 }));
      return spawnFromHelper(...spawnArgs);
    });
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-5.5' });
    const related = { repos: [{ repo: 'dashpay/dash', kind: 'reference' as const }], cacheDir: '/runner/temp/related', stateDir: '/runner/temp/state' };

    const withRelated = await client.sendMessage('Review the diff.', 'the diff', { repoTools: { root: '/work/repo', steps: 15, related } });
    const withoutRelated = await client.sendMessage('Review the diff.', 'the diff', { repoTools: { root: '/work/repo', steps: 15 } });

    expect(withRelated.relatedReads).toEqual({ 'dashpay/dash': 2 });
    expect(withoutRelated.relatedReads).toBeUndefined();
    expect((mockSpawn.mock.calls[1][1] as string[]).join(' ')).not.toContain('--reads-file');

    // A call that fails still reports the reads it made, on its error.
    setupSpawnMock('', { exitCode: 1, stderr: 'ERROR: something broke' });
    const failingSpawn = mockSpawn.getMockImplementation()!;
    mockSpawn.mockImplementation((...spawnArgs: Parameters<typeof failingSpawn>) => {
      const serverArgs = JSON.parse((spawnArgs[1] as string[]).find(arg => arg.startsWith('mcp_servers.manki.args='))!.slice('mcp_servers.manki.args='.length)) as string[];
      writeFileSync(serverArgs[serverArgs.indexOf('--reads-file') + 1], JSON.stringify({ 'dashpay/dash': 4 }));
      return failingSpawn(...spawnArgs);
    });
    const failure = await client.sendMessage('Review the diff.', 'the diff', { repoTools: { root: '/work/repo', steps: 15, related } }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: expect.stringContaining('Codex CLI invocation failed'), relatedReads: { 'dashpay/dash': 4 } });
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

  it('seeds `$CODEX_HOME/auth.json` from the OAuth secret before invoking the CLI, and registers its tokens again after', async () => {
    const { seedAuthFile, registerAuthFileSecrets } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock; registerAuthFileSecrets: jest.Mock };
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
      expect(registerAuthFileSecrets).toHaveBeenCalledWith('/tmp/manki-codex-seed-fixture/auth.json');
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

  it('maps max effort to the highest model_reasoning_effort the model accepts on CLI invocation', async () => {
    setupSpawnMock('ok\n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-5.4' });

    await client.sendMessage('sys', 'user', { effort: 'max' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort=xhigh');
  });

  it('returns trimmed stdout content on success', async () => {
    setupSpawnMock('  hello world  \n');
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('hello world');
    expect(result.usage).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects on non-zero exit code with rich diagnostics', async () => {
    setupSpawnMock('', { exitCode: 1, stderr: 'something broke' });
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await expect(client.sendMessage('sys', 'user', { effort: 'high' })).rejects.toThrow(
      /Codex CLI invocation failed.*model=o3.*effort=high.*promptChars=\d+.*elapsedMs=\d+.*stderrChars=\d+/s,
    );
  });

  it('throws a `QuotaError` on a ChatGPT usage limit, reading only the `ERROR:` line', async () => {
    const stderr = "user\nreview this: rate limit reached\nERROR: You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at 20 Aug 2026, 16:29.\n";
    setupSpawnMock('', { exitCode: 1, stderr });
    jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-5.5' });
    // The session Codex wrote before it stopped records the limit that ran out.
    const savedCodexHome = process.env.CODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), 'manki-codex-quota-'));
    process.env.CODEX_HOME = home;
    const session = join(home, 'sessions', 'rollout.jsonl');
    mkdirSync(join(home, 'sessions'));
    writeFileSync(session, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { secondary: { used_percent: 100, window_minutes: 10080 } } } })}\n`);
    const later = Date.now() / 1000 + 60;
    utimesSync(session, later, later);

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e).finally(() => {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      rmSync(home, { recursive: true, force: true });
    });
    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toMatchObject({ limit: 'ChatGPT subscription limit reached', resetsAt: 'at 20 Aug 2026, 16:29', credential: 'token' });
    expect(error).toMatchObject({ limits: [{ account: 'ChatGPT subscription', window: 'weekly', usedPercent: 100 }] });

    setupSpawnMock('', { exitCode: 1, stderr: 'user\nreview this: rate limit reached\nERROR: stream disconnected\n' });
    const other = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(other).not.toBeInstanceOf(QuotaError);
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
