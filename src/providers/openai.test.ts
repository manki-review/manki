import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import OpenAI from 'openai';
import * as core from '@actions/core';

import {
  buildOpenAIAuth,
  OpenAIClient,
  readCodexLimits,
  resetCLIInstallPromise,
  resolveReasoningEffort,
  STALE_TIMEOUT_MS,
} from './openai';
import { cliEnv, cliHome } from './cli-utils';
import { QuotaError, RefusalError, TimeoutError, UnreachableError } from './types';

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

// Codex's `--json` events as Codex 0.166.0 printed them on stdout against a stand-in endpoint, one JSON object per line.
const SESSION = '01a1e7b6-908c-7750-8dcd-e6fdb23319de';
const started = (session = SESSION) => ({ type: 'thread.started', thread_id: session });
const TURN = { type: 'turn.started' };
const message = (text: string, id = 'item_0') => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const COMPLETED = { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 1 } };
const error = (text: string) => ({ type: 'error', message: text });
const failed = (text: string) => ({ type: 'turn.failed', error: { message: text } });
const jsonl = (...events: object[]): string => events.map(event => `${JSON.stringify(event)}\n`).join('');
/** The stdout of a turn that completed with `text` as its last message, after the events `before`. */
const answered = (text: string, ...before: object[]): string => jsonl(started(), TURN, ...before, message(text), COMPLETED);
/** The stdout of a turn Codex failed with its error `text`, after the events `before`. Codex prints the error twice. */
const failedTurn = (text: string, ...before: object[]): string => jsonl(started(), TURN, ...before, error(text), failed(text));

/**
 * Writes the session file of `SESSION` into this process's Codex home, with the `token_count` event Codex writes after
 * each request for each `[session input, request input]` of `counts`. Returns a function that removes it.
 */
function writeSessionFile(counts: [number, number][]): () => void {
  const sessions = join(cliHome('codex'), 'sessions');
  const today = new Date();
  const folder = join(sessions, String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0'));
  mkdirSync(folder, { recursive: true });
  const usage = (input: number) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: input });
  const lines = counts.map(([total, last]) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(total), last_token_usage: usage(last), model_context_window: 258400 } } }));
  writeFileSync(join(folder, `rollout-2026-11-18T17-15-29-${SESSION}.jsonl`), `${lines.join('\n')}\n`);
  return () => rmSync(sessions, { recursive: true, force: true });
}

// A test may point `RUNNER_TEMP` at a folder that does not exist, so the Codex home of this process is made first.
beforeAll(() => cliHome('codex'));

describe('buildOpenAIAuth', () => {
  it('throws when neither token is present', () => {
    expect(() => buildOpenAIAuth('', '', '')).toThrow(
      'Either openai_oauth_token, openai_oauth_file or openai_api_key must be provided',
    );
  });

  it('returns oauth kind when only oauth token is present', () => {
    expect(buildOpenAIAuth('oauth-tok', '', '')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });

  it('returns apiKey kind when only api key is present', () => {
    expect(buildOpenAIAuth('', 'sk-key', '')).toEqual({ kind: 'apiKey', key: 'sk-key' });
  });

  it('oauth wins when both tokens are present', () => {
    expect(buildOpenAIAuth('oauth-tok', 'sk-key', '')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });

  it.each(['https://llm.example/v1', 'http://localhost:4000/v1'])('returns endpoint kind for the API key with the base URL %s', baseUrl => {
    expect(buildOpenAIAuth('', 'sk-key', baseUrl)).toEqual({ kind: 'endpoint', key: 'sk-key', baseUrl });
  });

  it.each([
    ['has no API key', '', '', 'https://llm.example/v1', 'openai_base_url is set but openai_api_key is missing. Set openai_api_key to the key of that endpoint.'],
    ['comes with an OAuth token', 'oauth-tok', '', 'https://llm.example/v1', 'openai_base_url cannot be used with openai_oauth_token: a ChatGPT login works only on the servers of OpenAI. Remove openai_oauth_token and set openai_api_key to the key of that endpoint.'],
    ['comes with an OAuth token and an API key', 'oauth-tok', 'sk-key', 'https://llm.example/v1', 'openai_base_url cannot be used with openai_oauth_token'],
    ['has no scheme', '', 'sk-key', 'llm.example/v1', 'openai_base_url must be an http or https URL, such as https://host/v1'],
    ['has another scheme', '', 'sk-key', 'ftp://llm.example/v1', 'openai_base_url must be an http or https URL'],
    ['is no URL', '', 'sk-key', 'not a url', 'openai_base_url must be an http or https URL'],
    ['comes with a login file', '', 'sk-key', 'https://llm.example/v1', 'openai_base_url cannot be used with openai_oauth_file: a ChatGPT login works only on the servers of OpenAI. Remove openai_oauth_file', '/runner/login/auth.json'],
  ])('throws when the base URL %s', (_case, oauthToken, apiKey, baseUrl, message, oauthFile = '') => {
    expect(() => buildOpenAIAuth(oauthToken, apiKey, baseUrl, oauthFile)).toThrow(message);
  });

  it('throws when the OAuth token comes with a login file', () => {
    expect(() => buildOpenAIAuth('oauth-tok', 'sk-key', '', '/runner/login/auth.json')).toThrow('openai_oauth_token and openai_oauth_file are both set. Set only one of them');
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
    ['gpt-6.2-sol', 'max'],
    ['gpt-6.1-terra', 'max'],
  ])('maps max to the highest effort %s accepts, and xhigh to at most that', (model, expected) => {
    expect(resolveReasoningEffort(model, 'max')).toBe(expected);
    expect(resolveReasoningEffort(model, 'xhigh')).toBe(expected === 'high' ? 'high' : 'xhigh');
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(resolveReasoningEffort(model, tier)).toBe(tier);
    }
    for (const auth of [{ kind: 'apiKey', key: 'k' }, { kind: 'oauth', token: 't' }] as const) {
      expect(new OpenAIClient({ auth, model }).sentEffort('max')).toBe(expected);
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
    expect(resolveReasoningEffort(model, 'xhigh')).toBeUndefined();
    expect(resolveReasoningEffort(model, 'max')).toBeUndefined();
    expect(new OpenAIClient({ auth: { kind: 'apiKey', key: 'k' }, model }).sentEffort('max')).toBeUndefined();
  });
});

describe('readCodexLimits', () => {
  const tokenCount = (rateLimits: unknown) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rateLimits } });
  const NOW = Date.UTC(2026, 10, 9, 12);
  const T = NOW / 1000;
  let home: string;
  const writeSession = (name: string, lines: string[], mtimeSeconds: number, folder = '2026/11/09') => {
    const dir = join(home, 'sessions', ...folder.split('/'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `${lines.join('\n')}\n`);
    utimesSync(path, mtimeSeconds, mtimeSeconds);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'manki-codex-limits-'));
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('reads the last recorded limits of the newest session written since the call started that has any', () => {
    writeSession('rollout-old.jsonl', [tokenCount({ primary: { used_percent: 99, window_minutes: 300 } })], T - 3000);
    writeSession('rollout-new.jsonl', [
      tokenCount({ primary: { used_percent: 10, window_minutes: 300 } }),
      tokenCount({ primary: { used_percent: 72.4, window_minutes: 300, resets_at: 1794000000 }, secondary: { used_percent: 91, window_minutes: 10080 } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
    ], T - 1000);
    // A call running in parallel started a newer session that has no readings yet.
    writeSession('rollout-parallel.jsonl', [JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } })], T - 500);
    // A folder of an earlier day is never read, even with a file touched since the call started.
    writeSession('rollout-history.jsonl', [tokenCount({ primary: { used_percent: 50, window_minutes: 300 } })], T - 100, '2026/11/07');

    expect(readCodexLimits(home, (T - 2000) * 1000)).toEqual([
      { account: 'ChatGPT subscription', window: '5-hour', usedPercent: 72, resetsAt: 1794000000 },
      { account: 'ChatGPT subscription', window: 'weekly', usedPercent: 91 },
    ]);
    expect(readCodexLimits(home, (T - 800) * 1000)).toEqual([]);
  });

  it.each([
    ['the day the call runs', '2026/11/09'],
    ['the day before, for a CLI at UTC-12', '2026/11/08'],
    ['the day after, for a CLI at UTC+14', '2026/11/10'],
  ])('reads the folder of %s', (_case, folder) => {
    writeSession('rollout.jsonl', [tokenCount({ primary: { used_percent: 40, window_minutes: 300 } })], T - 60, folder);
    expect(readCodexLimits(home, (T - 600) * 1000)).toEqual([{ account: 'ChatGPT subscription', window: '5-hour', usedPercent: 40 }]);
  });

  it('names other window lengths by days or hours, and skips a window without a length or share', () => {
    writeSession('rollout.jsonl', [tokenCount({ primary: { used_percent: 5, window_minutes: 2880 }, secondary: { used_percent: 6, window_minutes: 60 } })], T - 10);
    expect(readCodexLimits(home, (T - 60) * 1000).map(l => l.window)).toEqual(['2-day', '1-hour']);

    writeSession('rollout.jsonl', ['{"rate_limits": not json', tokenCount({ primary: { used_percent: 5 }, secondary: null }), tokenCount(null)], T - 10);
    expect(readCodexLimits(home, (T - 60) * 1000)).toEqual([]);
  });

  it('returns none when Codex wrote no sessions', () => {
    expect(readCodexLimits(home, (T - 60) * 1000)).toEqual([]);
    expect(readCodexLimits(join(home, 'missing'), (T - 60) * 1000)).toEqual([]);
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
        largestRequestInputTokens: 200,
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

    // The SDK's error for a request that ran past its limit on the last try is a timeout like any other.
    const sdkTimeout = new OpenAI.APIConnectionTimeoutError();
    mockCreate.mockRejectedValueOnce(sdkTimeout);
    const error = await client.sendMessage('sys', 'user', { timeoutMs: 900_000 }).then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ name: 'TimeoutError', message: 'OpenAI API timed out after 900s per request', cause: sdkTimeout });
    // The SDK's limit for one request is the call's own, so its timer never ends a request before the call's signal does.
    expect(mockCreate.mock.calls.map(call => call[1])).toEqual([{ timeout: 300_000 }, { timeout: 900_000, signal: expect.any(AbortSignal) }]);
  });
});

describe('sendViaCLI (Codex CLI path)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetCLIInstallPromise();
    mockExecFileAsync.mockReset();
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/codex' });
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const instructionsPath = (args: string[]): string => JSON.parse(args.find(arg => arg.startsWith('model_instructions_file='))!.replace(/^model_instructions_file=/, ''));

  /** One run of the mocked CLI. It ends after `ms`, or `RUN_MS`, and with `hangs` only once it is killed. */
  interface CodexRun { stdout?: string; exitCode?: number; signal?: NodeJS.Signals; stderr?: string; ms?: number; hangs?: true }
  const RUN_MS = 5;

  /**
   * Mocks the CLI and returns its stdin, the instructions file of each run, which is gone once the call returns, and
   * when each run started. Runs after the first take the `later` ones in order, and the last one repeats.
   */
  function setupSpawnMock(stdout: string, opts: CodexRun = {}, ...later: CodexRun[]): { stdin: jest.Mock; instructions: string[]; starts: number[] } {
    const stdin = { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() };
    const procs = [{ stdout, ...opts }, ...later].map((run) => {
      const proc = { stdin, stdout: { on: jest.fn() }, stderr: { on: jest.fn() }, on: jest.fn(), kill: jest.fn() };
      proc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data' && run.stdout) {
          setTimeout(() => cb(Buffer.from(run.stdout!)), 0);
        }
      });
      proc.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data' && run.stderr) {
          setTimeout(() => cb(Buffer.from(run.stderr!)), 0);
        }
      });
      proc.on.mockImplementation((event: string, cb: (code: number | null, signal: string | null) => void) => {
        if (event !== 'close') return;
        if (run.hangs) proc.kill.mockImplementationOnce(() => cb(null, 'SIGTERM'));
        else setTimeout(() => cb(run.signal ? null : run.exitCode ?? 0, run.signal ?? null), run.ms ?? RUN_MS);
      });
      return proc;
    });

    const instructions: string[] = [];
    const starts: number[] = [];
    mockSpawn.mockImplementation((_command, args) => {
      instructions.push(readFileSync(instructionsPath(args as string[]), 'utf8'));
      starts.push(Date.now());
      return procs[Math.min(starts.length, procs.length) - 1] as unknown as ReturnType<typeof spawn>;
    });
    return { stdin: stdin.write, instructions, starts };
  }

  it('runs `codex exec` read-only with every built-in tool it can switch off turned off, no analytics, no built-in skills and Manki\'s instructions in a file, in an empty temp directory', async () => {
    const { stdin, instructions } = setupSpawnMock(answered('hello'));
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await client.sendMessage('sys', 'user');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--model=o3', '--sandbox', 'read-only', '-c', 'approval_policy=never',
      '-c', 'features.shell_tool=false', '-c', 'features.view_image=false', '-c', 'web_search=disabled', '-c', 'features.apps=false',
      '-c', 'features.plugins=false', '-c', 'features.multi_agent=false', '-c', 'features.image_generation=false',
      '-c', 'agents.enabled=false', '-c', 'features.goals=false', '-c', 'features.sleep_tool=false',
      '-c', 'tools.experimental_request_user_input.enabled=false',
      '-c', 'analytics.enabled=false', '-c', 'skills.bundled.enabled=false',
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
    const { stdin, instructions } = setupSpawnMock(answered('[]'));
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

      await client.sendMessage('Review the diff.', 'the diff', { repoTools: { root: '/work/repo', steps: 15, related: undefined } });
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
      '-c mcp_servers.manki.required=true',
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

  it('runs an endpoint call with Manki\'s own model provider, home and key, without the runner\'s home or a login file', async () => {
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    const setSecret = jest.spyOn(core, 'setSecret').mockImplementation(() => {});
    setupSpawnMock(answered('[]'));
    const key = 'sk-endpoint-key-for-codex-only';
    const savedEnv = process.env;
    process.env = {
      PATH: '/usr/bin',
      HOME: '/runner-home',
      CODEX_HOME: '/runner-home/.codex',
      GITHUB_API_URL: 'https://api.github.com',
      OPENAI_API_KEY: 'sk-ambient-key',
      OPENAI_OAUTH_TOKEN: 'ambient-login',
      GITHUB_TOKEN: 'ghs_ambient',
    };
    try {
      const client = new OpenAIClient({ auth: { kind: 'endpoint', key, baseUrl: 'https://llm.example/v1' }, model: 'gpt-5.5' });
      expect(client.repoTools).toBe(true);
      await client.sendMessage('Review the diff.', 'the diff', { repoTools: { root: '/work/repo', steps: 15, related: undefined } });
    } finally {
      process.env = savedEnv;
    }
    const [, args, { env }] = mockSpawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--model=gpt-5.5', '--sandbox', 'read-only', '-c', 'approval_policy=never',
      '-c', 'features.shell_tool=false', '-c', 'features.view_image=false', '-c', 'web_search=disabled', '-c', 'features.apps=false',
      '-c', 'features.plugins=false', '-c', 'features.multi_agent=false', '-c', 'features.image_generation=false',
      '-c', 'agents.enabled=false', '-c', 'features.goals=false', '-c', 'features.sleep_tool=false',
      '-c', 'tools.experimental_request_user_input.enabled=false',
      '-c', 'analytics.enabled=false', '-c', 'skills.bundled.enabled=false',
      '-c', 'model_provider="manki"',
      '-c', 'model_providers.manki.name="OpenAI-compatible endpoint"',
      '-c', 'model_providers.manki.base_url="https://llm.example/v1"',
      '-c', 'model_providers.manki.wire_api="responses"',
      '-c', 'model_providers.manki.env_key="OPENAI_API_KEY"',
      '-c', 'model_providers.manki.stream_max_retries=0',
      '-c', `mcp_servers.manki.command=${JSON.stringify(process.execPath)}`,
      // The tool server counts its steps in the call's own folder, so the server of a resumed run counts on.
      '-c', `mcp_servers.manki.args=${JSON.stringify([process.argv[1], 'mcp-server', '/work/repo', '--file-tools', '--steps', '15', '--steps-dir', join(dirname(instructionsPath(args)), 'steps')])}`,
      '-c', 'mcp_servers.manki.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.manki.required=true',
      '-c', expect.stringMatching(/^mcp_servers\.manki\.env_vars=/),
      '-c', expect.stringMatching(/^model_instructions_file=".*\/instructions\.md"$/), '-',
    ]);
    expect(args.join(' ')).not.toContain(key);
    // Codex reads skills, `AGENTS.md` and `config.toml` from both homes, so the runner's own stay out.
    const home = env.CODEX_HOME!;
    expect(env).toEqual({ ...cliEnv('codex', {}, undefined, { PATH: '/usr/bin' }), GITHUB_API_URL: 'https://api.github.com', OPENAI_API_KEY: key });
    expect(env.HOME).toBe(home);
    expect(home).not.toMatch(/^\/runner-home/);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    // Codex gives its tool server only the variables `env_vars` names, so the key stays with Codex.
    const envVars = JSON.parse(args.find(arg => arg.startsWith('mcp_servers.manki.env_vars='))!.slice('mcp_servers.manki.env_vars='.length)) as string[];
    expect(envVars.sort()).toEqual(['APPDATA', 'GITHUB_API_URL', 'HOME', 'LOCALAPPDATA', 'PATH', 'USERPROFILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
    expect(seedAuthFile).not.toHaveBeenCalled();
    expect(setSecret).toHaveBeenCalledWith(key);
  });

  describe('an endpoint call whose stream failed', () => {
    const RESUME = 'The connection to the model failed. Continue the task where it stopped, and give your answer in the format the task asked for.';
    // A run that got a part of the answer before its stream failed printed that part as a message first.
    const failedRun = (text: string, ...before: object[]): CodexRun => ({ exitCode: 1, stdout: failedTurn(text, ...before) });
    const PART = message('ERROR: half an answer');
    const CAPACITY = 'Selected model is at capacity. Please try a different model.';
    const DROPPED = 'stream disconnected before completion: stream closed before response.completed';
    const RATE_LIMIT = 'rate limit exceeded: Rate limit reached for gpt-5.5 on tokens per min (TPM): Limit 30000, Used 29500, Requested 2000.';
    // Codex counts the whole session in `turn.completed`, so a resumed run reports the tokens of the runs before it too.
    const SESSION_USAGE = { input_tokens: 4000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 4 };
    const answer: CodexRun = { stdout: jsonl(started(), TURN, message('[]'), { type: 'turn.completed', usage: SESSION_USAGE }) };
    const tools = { repoTools: { root: '/work/repo', steps: 15, related: undefined } };
    let endpoint: OpenAIClient;
    let info: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
      jest.spyOn(core, 'setSecret').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      info = jest.spyOn(core, 'info').mockImplementation(() => {});
      endpoint = new OpenAIClient({ auth: { kind: 'endpoint', key: 'sk-endpoint-key', baseUrl: 'https://llm.example/v1' }, model: 'gpt-5.5' });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** Runs `call` to its end on the fake clock and returns its outcome and how long it took. */
    async function settle<T>(call: Promise<T>): Promise<{ value?: T; error?: Error; tookMs: number }> {
      const started = Date.now();
      const outcome = call.then(value => ({ value, tookMs: Date.now() - started }), (error: Error) => ({ error, tookMs: Date.now() - started }));
      await jest.advanceTimersByTimeAsync(2_000_000);
      return outcome;
    }

    it('resumes the session after a pause that fits the reason, and returns the resumed run\'s answer', async () => {
      const [first, ...resumed] = [
        failedRun(CAPACITY), failedRun(CAPACITY, PART), failedRun(DROPPED, PART),
        failedRun('stream disconnected before completion: Transport error: network error: error decoding response body', PART),
        failedRun('stream disconnected before completion: idle timeout waiting for SSE'),
        failedRun(`${RATE_LIMIT} Please try again in 3s. Visit https://platform.openai.com/account/rate-limits to learn more.`, PART),
        failedRun(`${RATE_LIMIT} Please try again in 1m0.5s.`),
        // Codex gave up on a request the endpoint kept answering with 429, and the endpoint named no wait.
        failedRun('exceeded retry limit, last status: 429 Too Many Requests'), answer,
      ];
      const { stdin, instructions, starts } = setupSpawnMock('', first, ...resumed);
      // As Codex wrote it for a run whose first request answered and whose second failed, and a resumed run's request.
      // A failed run repeats its last count.
      const removeSession = writeSessionFile([[1000, 1000], [1000, 1000], [4000, 3000]]);

      const { value, tookMs } = await settle(endpoint.sendMessage('Review the diff.', 'the diff', { effort: 'high', ...tools })).finally(removeSession);

      expect(value?.content).toBe('[]');
      expect(value?.usage).toEqual({ inputTokens: 4000, outputTokens: 40, cacheReadTokens: 400, cacheWriteTokens: 0, reasoningTokens: 4, largestRequestInputTokens: 3000 });
      const pauses = [5_000, 15_000, 0, 0, 0, 3_000, 60_500, 60_000];
      expect(starts.slice(1).map((start, i) => start - starts[i] - RUN_MS)).toEqual(pauses);
      expect(tookMs).toBe(143_500 + 9 * RUN_MS);
      // A resumed run gets every option of the first one, so the sandbox, the model, the effort and the tool server are the same.
      const [firstArgs, ...resumedArgs] = mockSpawn.mock.calls.map(call => call[1] as string[]);
      expect(firstArgs).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--model=gpt-5.5', 'model_reasoning_effort=high', 'model_providers.manki.stream_max_retries=0']));
      expect(firstArgs.at(-1)).toBe('-');
      for (const args of resumedArgs) expect(args).toEqual([...firstArgs.slice(0, -1), 'resume', SESSION, '-']);
      expect(instructions).toHaveLength(9);
      expect(new Set(instructions).size).toBe(1);
      expect(stdin.mock.calls.map(c => String(c[0]))).toEqual(['the diff', ...resumedArgs.map(() => RESUME)]);
      const reasons = ['model at capacity', 'model at capacity', 'connection dropped', 'connection dropped', 'connection dropped', 'rate limit', 'rate limit', 'rate limit'];
      expect(info.mock.calls.map(c => String(c[0]))).toEqual(
        reasons.map((reason, i) => `Codex stream failed (${reason}). Resuming the session in ${pauses[i] / 1000}s, resume ${i + 1} of 8.`));
    });

    it('fails with the last run\'s error once the resumes or the time limit are used up, and ends a pause when the run is cancelled', async () => {
      // Eight resumes: pauses of 15 s, 30 s and six of 60 s.
      let mock = setupSpawnMock('', failedRun(CAPACITY));
      let outcome = await settle(endpoint.sendMessage('sys', 'the diff'));
      expect(outcome.error).toBeInstanceOf(QuotaError);
      expect(outcome.error).toMatchObject({ message: `OpenAI model at capacity: ${CAPACITY}`, limit: 'OpenAI model at capacity' });
      expect(mock.starts).toHaveLength(9);
      expect(outcome.tookMs).toBe(350_000 + 9 * RUN_MS);

      // The third pause of 30 s would leave the resumed run under 30 s of a limit of 60 s, so the call fails when the third run does.
      mock = setupSpawnMock('', failedRun(CAPACITY));
      outcome = await settle(endpoint.sendMessage('sys', 'the diff', { timeoutMs: 60_000 }));
      expect(outcome.error).toMatchObject({ limit: 'OpenAI model at capacity' });
      expect(mock.starts).toHaveLength(3);
      expect(outcome.tookMs).toBe(20_000 + 3 * RUN_MS);

      // An advised wait is not sat out when it is longer than the time left, or leaves the resumed run under 30 s.
      const wait58 = failedRun(`${RATE_LIMIT} Please try again in 58s.`);
      for (const [run, timeoutMs, resetsAt] of [
        [failedRun(`${RATE_LIMIT} Please try again in 3s.`), 2_000, 'in 3s'],
        [{ ...wait58, ms: 57_900 }, 60_000, 'in 58s'],
        [wait58, 60_000, 'in 58s'],
      ] as const) {
        mock = setupSpawnMock('', run, answer);
        outcome = await settle(endpoint.sendMessage('sys', 'the diff', { timeoutMs }));
        expect(outcome.error).toBeInstanceOf(QuotaError);
        expect(outcome.error).toMatchObject({ limit: 'OpenAI endpoint limit reached', resetsAt });
        expect(mock.starts).toHaveLength(1);
        expect(outcome.tookMs).toBe(run.ms ?? RUN_MS);
      }

      // A resume with no pause needs the same 30 s: with exactly that left it starts, with less the call fails.
      mock = setupSpawnMock('', { ...failedRun(DROPPED), ms: 30_000 }, answer);
      outcome = await settle(endpoint.sendMessage('sys', 'the diff', { timeoutMs: 60_000 }));
      expect(outcome.value?.content).toBe('[]');
      expect(mock.starts).toHaveLength(2);
      for (const ms of [30_001, 57_900]) {
        mock = setupSpawnMock('', { ...failedRun(DROPPED), ms }, answer);
        outcome = await settle(endpoint.sendMessage('sys', 'the diff', { timeoutMs: 60_000 }));
        expect(outcome.error).not.toBeInstanceOf(QuotaError);
        expect(outcome.error?.message).toContain(`Codex CLI invocation failed (exit 1: <empty stderr> [`);
        expect(outcome.error?.message).toContain(`result.text=${JSON.stringify(DROPPED)}`);
        expect(mock.starts).toHaveLength(1);
        expect(outcome.tookMs).toBe(ms);
      }

      // A resumed run has only the time the call has left. When it runs out, the call fails as the limit that made it
      // resume, and the timeout it carries names the call's whole limit.
      mock = setupSpawnMock('', failedRun(CAPACITY), { hangs: true });
      outcome = await settle(endpoint.sendMessage('sys', 'the diff', { timeoutMs: 60_000 }));
      expect(outcome.error).toBeInstanceOf(QuotaError);
      expect(outcome.error).toMatchObject({ message: `OpenAI model at capacity: ${CAPACITY}`, limit: 'OpenAI model at capacity' });
      expect(outcome.error?.cause).toBeInstanceOf(TimeoutError);
      expect((outcome.error?.cause as Error).message).toContain('Codex CLI timed out after 60s');
      expect(mock.starts).toHaveLength(2);
      expect(outcome.tookMs).toBe(60_000);

      // A dropped connection is no limit, so the timeout stays the error.
      mock = setupSpawnMock('', failedRun(DROPPED), { hangs: true });
      outcome = await settle(endpoint.sendMessage('sys', 'the diff', { timeoutMs: 60_000 }));
      expect(outcome.error).toBeInstanceOf(TimeoutError);
      expect(outcome.error?.message).toContain('Codex CLI timed out after 60s');
      expect(mock.starts).toHaveLength(2);
      expect(outcome.tookMs).toBe(60_000);

      mock = setupSpawnMock('', failedRun(CAPACITY), answer);
      const controller = new AbortController();
      const cancelled = settle(endpoint.sendMessage('sys', 'the diff', { signal: controller.signal }));
      setTimeout(() => controller.abort(new Error('run cancelled')), 5_000);
      outcome = await cancelled;
      expect(outcome.error?.message).toBe('run cancelled');
      expect(outcome.tookMs).toBe(5_000);
      expect(mock.starts).toHaveLength(1);
    });

    it('resumes no other failure, and never a ChatGPT login call', async () => {
      const others: CodexRun[] = [
        failedRun('unexpected status 401 Unauthorized: Incorrect API key provided., url: https://llm.example/v1/responses'),
        failedRun('The model `gpt-5.5` does not exist or you do not have access to it.'),
        failedRun("Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."),
        // A content filter, an error the endpoint words itself and a request the endpoint reset read like a dropped connection.
        failedRun('stream disconnected before completion: Incomplete response returned, reason: content_filter', message('partial answer')),
        failedRun('stream disconnected before completion: Your request was rejected by the safety system.'),
        failedRun('stream disconnected before completion: error sending request'),
        failedRun('Quota exceeded. Check your plan and billing details.'),
        failedRun(`${RATE_LIMIT} Visit https://platform.openai.com/account/rate-limits to learn more.`),
        failedRun('You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:13 PM.'),
        failedRun('We’re currently experiencing high demand, which may cause temporary errors.'),
        // Without `thread.started`, or with an id in another form, there is no session to resume.
        { exitCode: 1, stdout: jsonl(TURN, error(CAPACITY), failed(CAPACITY)) },
        { exitCode: 1, stdout: jsonl(started('--last'), TURN, error(CAPACITY), failed(CAPACITY)) },
        // Only Codex's own error in a sequence it was measured to print names a failed stream, never the model's text.
        { exitCode: 1, stdout: jsonl(started(), TURN, message(`ERROR: ${CAPACITY}`)) },
        { exitCode: 1, stdout: `${failedTurn(CAPACITY)}ERROR: ${CAPACITY}\n` },
        { exitCode: 1, stdout: jsonl(started(), TURN, error(CAPACITY), failed(CAPACITY), message('more')) },
        { exitCode: 2, stdout: failedTurn(CAPACITY) },
        { ...failedRun(CAPACITY), signal: 'SIGTERM' },
      ];
      for (const run of others) {
        const { starts } = setupSpawnMock('', run, answer);
        expect((await settle(endpoint.sendMessage('sys', 'the diff', tools))).error).toBeInstanceOf(Error);
        expect(starts).toHaveLength(1);
      }

      const login = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-5.5' });
      for (const run of [failedRun(CAPACITY), failedRun(DROPPED), failedRun(`${RATE_LIMIT} Please try again in 3s.`)]) {
        const { starts } = setupSpawnMock('', run, answer);
        const { error, tookMs } = await settle(login.sendMessage('sys', 'the diff', tools));
        expect(error).toBeInstanceOf(Error);
        expect(starts).toHaveLength(1);
        expect(tookMs).toBe(RUN_MS);
        const args = (mockSpawn.mock.calls.at(-1)![1] as string[]).join(' ');
        expect(args).not.toContain('stream_max_retries');
        expect(args).not.toContain('--steps-dir');
      }
      expect(info).not.toHaveBeenCalled();
    });
  });

  it('reads back how often the tool server read each related repo, and passes no reads file without related repos', async () => {
    setupSpawnMock(answered('[]'));
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
    const withoutRelated = await client.sendMessage('Review the diff.', 'the diff', { repoTools: { root: '/work/repo', steps: 15, related: undefined } });

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
    setupSpawnMock(answered('ok'));
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await client.sendMessage('sys', 'user', { effort: 'high' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort=high');
  });

  it('warns and skips reasoning override on non-reasoning models', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    setupSpawnMock(answered('ok'));
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
    setupSpawnMock(answered('ok'));
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    await client.sendMessage('sys', 'user', { effort: 'low' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.find(a => a.startsWith('model_reasoning_effort'))).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring effort=low'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Codex CLI will apply its own default effort'));
  });

  it('does not pass the OAuth secret as a CLI env var (auth flows via $CODEX_HOME/auth.json)', async () => {
    setupSpawnMock(answered('ok'));
    const savedKey = process.env.OPENAI_API_KEY;
    const savedOauthToken = process.env.OPENAI_OAUTH_TOKEN;
    const savedCodexOauth = process.env.CODEX_OAUTH_TOKEN;
    const savedInputOpenAI = process.env.INPUT_OPENAI_API_KEY;
    const savedInputGemini = process.env.INPUT_GEMINI_API_KEY;
    const savedActionsRuntime = process.env.ACTIONS_RUNTIME_TOKEN;
    const savedActionsIdToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const savedActionsResults = process.env.ACTIONS_RESULTS_URL;
    process.env.OPENAI_API_KEY = 'sk-ambient-key';
    process.env.OPENAI_OAUTH_TOKEN = 'legacy-oauth-blob';
    process.env.CODEX_OAUTH_TOKEN = 'legacy-codex-blob';
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
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
      if (savedOauthToken === undefined) delete process.env.OPENAI_OAUTH_TOKEN; else process.env.OPENAI_OAUTH_TOKEN = savedOauthToken;
      if (savedCodexOauth === undefined) delete process.env.CODEX_OAUTH_TOKEN; else process.env.CODEX_OAUTH_TOKEN = savedCodexOauth;
      if (savedInputOpenAI === undefined) delete process.env.INPUT_OPENAI_API_KEY; else process.env.INPUT_OPENAI_API_KEY = savedInputOpenAI;
      if (savedInputGemini === undefined) delete process.env.INPUT_GEMINI_API_KEY; else process.env.INPUT_GEMINI_API_KEY = savedInputGemini;
      if (savedActionsRuntime === undefined) delete process.env.ACTIONS_RUNTIME_TOKEN; else process.env.ACTIONS_RUNTIME_TOKEN = savedActionsRuntime;
      if (savedActionsIdToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN; else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = savedActionsIdToken;
      if (savedActionsResults === undefined) delete process.env.ACTIONS_RESULTS_URL; else process.env.ACTIONS_RESULTS_URL = savedActionsResults;
    }
  });

  it('seeds `auth.json` in Manki\'s own Codex home, whatever `CODEX_HOME` and `HOME` say, and registers its tokens again after', async () => {
    const { seedAuthFile, registerAuthFileSecrets } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock; registerAuthFileSecrets: jest.Mock };
    seedAuthFile.mockClear();
    setupSpawnMock(answered('ok'));
    const savedEnv = process.env;
    process.env = { ...savedEnv, HOME: '/runner-home', CODEX_HOME: '/runner-home/.codex' };

    try {
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'b64-blob' }, model: 'gpt-4o' });
      await client.sendMessage('sys', 'user');
      await client.sendMessage('sys', 'user');
    } finally {
      process.env = savedEnv;
    }
    const envs = mockSpawn.mock.calls.map(call => (call[2] as { env: NodeJS.ProcessEnv }).env);
    const home = envs[0].CODEX_HOME!;
    // The calls of a run share the home, so a later call reads the tokens an earlier one refreshed.
    expect(envs.map(env => [env.HOME, env.CODEX_HOME])).toEqual([[home, home], [home, home]]);
    expect(home).not.toMatch(/^\/runner-home/);
    expect(seedAuthFile).toHaveBeenCalledWith({
      secret: 'b64-blob',
      inputName: 'openai_oauth_token',
      targetPath: join(home, 'auth.json'),
      requiredFields: ['tokens.access_token', 'tokens.refresh_token'],
      bootstrapHint: expect.stringContaining('codex login'),
    });
    expect(registerAuthFileSecrets).toHaveBeenCalledWith(join(home, 'auth.json'));
  });

  it('propagates seedAuthFile errors (e.g. legacy single-token shape) to the caller', async () => {
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockImplementationOnce(() => {
      throw new Error('openai_oauth_token did not decode to JSON. Bootstrap with `codex login` ...');
    });
    setupSpawnMock(answered('ok'));

    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'sk-legacy' }, model: 'gpt-4o' });
    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(
      /openai_oauth_token did not decode to JSON.*codex login/,
    );
  });

  it('maps low effort to model_reasoning_effort=low on o-series CLI invocation', async () => {
    setupSpawnMock(answered('ok'));
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await client.sendMessage('sys', 'user', { effort: 'low' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort=low');
  });

  it('maps medium effort to model_reasoning_effort=medium on o-series CLI invocation', async () => {
    setupSpawnMock(answered('ok'));
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await client.sendMessage('sys', 'user', { effort: 'medium' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort=medium');
  });

  it('maps max effort to the highest model_reasoning_effort the model accepts on CLI invocation', async () => {
    setupSpawnMock(answered('ok'));
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-5.4' });

    await client.sendMessage('sys', 'user', { effort: 'max' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const overrideIdx = spawnArgs.findIndex(a => a.startsWith('model_reasoning_effort'));
    expect(spawnArgs[overrideIdx]).toBe('model_reasoning_effort=xhigh');
  });

  it('returns the trimmed text of the last message of a completed turn', async () => {
    setupSpawnMock(answered('  hello world  '));
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('hello world');
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 1 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    // Codex printed the last message of the turn on stdout before `--json`, so earlier messages, reasoning, a tool call
    // and its result, and a warning before the turn are not the answer. A turn without a message answers nothing.
    const toolCall = { id: 'item_2', type: 'mcp_tool_call', server: 'manki', tool: 'read_file', arguments: { path: 'README.md' }, error: null };
    for (const [stdout, content] of [
      [answered('second message', message('first message')), 'second message'],
      [answered('after reasoning', { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'ERROR: thinking' } }), 'after reasoning'],
      [jsonl(
        started(), { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `gpt-5.4` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } },
        TURN, message('Let me read a file.', 'item_1'), { type: 'item.started', item: { ...toolCall, result: null, status: 'in_progress' } },
        { type: 'item.completed', item: { ...toolCall, result: { content: [{ type: 'text', text: '1\tERROR: a line of the file' }] }, status: 'completed' } },
        message('[]', 'item_3'), COMPLETED,
      ), '[]'],
      [jsonl(started(), TURN, COMPLETED), ''],
    ]) {
      setupSpawnMock(stdout);
      expect((await client.sendMessage('sys', 'user')).content).toBe(content);
    }

    // A turn that reports no token counts leaves them unknown.
    setupSpawnMock(jsonl(started(), TURN, message('[]'), { type: 'turn.completed' }));
    expect((await client.sendMessage('sys', 'user')).usage).toBeUndefined();

    // The session file gives the input of each request, but only requests that add up to the turn's input say which
    // was the largest.
    for (const [counts, largest] of [
      [[[1000, 1000]], 1000],
      [[[600, 600]], undefined],
      [[[600, 600], [1000, 300]], undefined],
    ] as [[number, number][], number | undefined][]) {
      const removeSession = writeSessionFile(counts);
      setupSpawnMock(answered('[]'));
      const { usage } = await client.sendMessage('sys', 'user').finally(removeSession);
      expect(usage?.largestRequestInputTokens).toBe(largest);
    }
  });

  it('rejects on non-zero exit code with rich diagnostics', async () => {
    setupSpawnMock('', { exitCode: 1, stderr: 'something broke' });
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'o3' });

    await expect(client.sendMessage('sys', 'user', { effort: 'high' })).rejects.toThrow(
      /Codex CLI invocation failed.*model=o3.*effort=high.*promptChars=\d+.*elapsedMs=\d+.*stderrChars=\d+/s,
    );
  });

  it('throws a `QuotaError` on a usage limit or a model at capacity, reading only Codex\'s own error from its `turn.failed` event', async () => {
    const usageLimit = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:13 PM.';
    setupSpawnMock('', { exitCode: 1, stdout: failedTurn(usageLimit) });
    jest.spyOn(core, 'warning').mockImplementation(() => {});
    jest.spyOn(core, 'info').mockImplementation(() => {});
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-5.5' });
    // The session Codex wrote before it stopped records the limit that ran out.
    const home = cliHome('codex');
    const today = new Date();
    const folder = join(home, 'sessions', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0'));
    const session = join(folder, 'rollout.jsonl');
    mkdirSync(folder, { recursive: true });
    writeFileSync(session, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { secondary: { used_percent: 100, window_minutes: 10080 } } } })}\n`);
    const later = Date.now() / 1000 + 60;
    utimesSync(session, later, later);

    const limited = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e).finally(() => {
      rmSync(join(home, 'sessions'), { recursive: true, force: true });
    });
    expect(limited).toBeInstanceOf(QuotaError);
    expect(limited).toMatchObject({ message: `ChatGPT subscription limit reached: ${usageLimit}`, limit: 'ChatGPT subscription limit reached', resetsAt: 'at 1:13 PM', credential: 'token' });
    expect(limited).toMatchObject({ limits: [{ account: 'ChatGPT subscription', window: 'weekly', usedPercent: 100 }] });

    // An endpoint has no ChatGPT subscription behind it, so the limit is named as the endpoint's. The time limit leaves
    // no room for the pause before a resume.
    jest.spyOn(core, 'setSecret').mockImplementation(() => {});
    const endpoint = new OpenAIClient({ auth: { kind: 'endpoint', key: 'sk-endpoint-key', baseUrl: 'https://llm.example/v1' }, model: 'gpt-5.5' });
    const capacity = 'Selected model is at capacity. Please try a different model.';
    const rateLimit = 'rate limit exceeded: Rate limit reached for gpt-5.5 on tokens per min (TPM): Limit 30000, Used 29500, Requested 2000. Please try again in 3s. Visit https://platform.openai.com/account/rate-limits to learn more.';
    // A reply and a tool call can come before the error.
    const toolCall = { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'manki', tool: 'read_file', arguments: { path: 'README.md' }, result: { content: [] }, error: null, status: 'completed' } };
    const capacityTyped = { limit: 'OpenAI model at capacity', resetsAt: undefined, credential: undefined };
    for (const [busy, stdout, text, typed] of [
      [endpoint, failedTurn('exceeded retry limit, last status: 429 Too Many Requests'), 'exceeded retry limit, last status: 429 Too Many Requests', { limit: 'OpenAI endpoint limit reached', credential: 'key' }],
      [endpoint, failedTurn('Quota exceeded. Check your plan and billing details.'), 'Quota exceeded. Check your plan and billing details.', { limit: 'OpenAI endpoint limit reached', credential: 'key' }],
      [endpoint, failedTurn(rateLimit, message('ERROR: half an answer')), rateLimit, { limit: 'OpenAI endpoint limit reached', resetsAt: 'in 3s', credential: 'key' }],
      // No other credential gets past a model at capacity, so the error names none.
      [client, failedTurn(capacity), capacity, capacityTyped],
      [endpoint, failedTurn(capacity), capacity, capacityTyped],
      [client, failedTurn(capacity, message('Let me read a file.'), toolCall), capacity, capacityTyped],
    ] as const) {
      setupSpawnMock('', { exitCode: 1, stdout });
      const full = await busy.sendMessage('sys', 'user', { timeoutMs: 1_000 }).then(() => null, (e: Error) => e);
      expect(full).toBeInstanceOf(QuotaError);
      expect(full).toMatchObject({ message: `${typed.limit}: ${text}`, ...typed });
    }

    // The model's text arrives inside a JSON string, so a reply made of `ERROR:` lines is never a limit, whatever the
    // exit. A completed turn returns it as the answer.
    const reply = ['I looked at the diff.', `ERROR: ${capacity}`, `ERROR: ${usageLimit}`, 'ERROR: exceeded retry limit, last status: 429 Too Many Requests', `ERROR: ${capacity}`].join('\n');
    for (const busy of [client, endpoint]) {
      setupSpawnMock(answered(reply));
      expect((await busy.sendMessage('sys', 'user')).content).toBe(reply);
    }
    const dropped = 'stream disconnected before completion: Transport error: network error: error decoding response body';
    for (const [run, exit] of [
      // The turn failed after the reply on an error that is no limit.
      [{ exitCode: 1, stdout: failedTurn(dropped, message(reply)) }, 'exit 1'],
      // A signal or Manki ended the run, maybe in the middle of a line.
      [{ signal: 'SIGTERM', stdout: jsonl(started(), TURN, message(reply)) }, 'exit null, signal SIGTERM'],
      [{ signal: 'SIGKILL', stdout: `${jsonl(started(), TURN, message(reply))}{"type":"error","message":"${capacity}` }, 'exit null, signal SIGKILL'],
      // Codex exited without an event that ends the turn.
      [{ exitCode: 1, stdout: jsonl(started(), TURN, message(reply)) }, 'exit 1'],
    ] as const) {
      setupSpawnMock('', run);
      const plain = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
      expect(plain).not.toBeInstanceOf(QuotaError);
      expect(plain?.message).toContain(`Codex CLI invocation failed (${exit}: <empty stderr> [`);
    }

    // Codex's own error counts only in the sequence it was measured to print. A line that is no event, another exit, or
    // events missing, doubled, out of order or unknown leave a plain failure, and no answer either.
    for (const [stdout, exitCode] of [
      [`${failedTurn(capacity)}ERROR: ${capacity}\n`, 1],
      [`ERROR: ${capacity}\n${failedTurn(capacity)}`, 1],
      [`${failedTurn(capacity)}\n`, 1],
      [failedTurn(capacity), 2],
      [failedTurn(capacity), 0],
      [failedTurn(capacity).slice(0, -1), 1],
      [jsonl(TURN, error(capacity), failed(capacity)), 1],
      [jsonl(started(), error(capacity), failed(capacity)), 1],
      [jsonl(started(), TURN, TURN, error(capacity), failed(capacity)), 1],
      [jsonl(started(), TURN, failed(capacity), error(capacity)), 1],
      [jsonl(started(), TURN, error(capacity), failed(capacity), failed(capacity)), 1],
      [jsonl(started(), TURN, error(capacity), failed(capacity), { type: 'turn.diff' }), 1],
      [jsonl(started(), TURN, message(reply), COMPLETED, failed(capacity)), 1],
      [`${answered(reply)}done\n`, 0],
      [answered(reply), 1],
      [jsonl(started(), TURN, message(reply)), 0],
      [jsonl(started(), TURN, message(reply), COMPLETED, COMPLETED), 0],
    ] as const) {
      setupSpawnMock('', { exitCode, stdout });
      const plain = await endpoint.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
      expect(plain).not.toBeInstanceOf(QuotaError);
      expect(plain?.message).toContain(`Codex CLI invocation failed (exit ${exitCode}: <empty stderr> [`);
      expect(plain?.message).toContain('<no result event>');
    }
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

describe('sendViaCLI — extended coverage', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetCLIInstallPromise();
    mockExecFileAsync.mockReset();
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/codex' });
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockReset();
  });

  afterEach(() => {
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

  it('keeps a call that prints nothing for longer than STALE_TIMEOUT_MS, since Codex is silent while the model thinks', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      const wiring = makeProc();
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
      const promise = client.sendMessage('sys', 'user');

      await waitForListeners(wiring);
      wiring.stderrHandlers['data']?.(Buffer.from('reasoning effort: high\n'));
      jest.advanceTimersByTime(STALE_TIMEOUT_MS * 5);
      expect(wiring.proc.kill).not.toHaveBeenCalled();
      wiring.stdoutHandlers['data']?.(Buffer.from(answered('late answer')));
      wiring.procHandlers['close']?.(0, null);

      expect((await promise).content).toContain('late answer');
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
      // Output up to the end, so only the hard 1200s deadline can end the call.
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
    wiring.stdoutHandlers['data']?.(Buffer.from(answered('ok')));
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

    wiring.stdoutHandlers['data']?.(Buffer.from(answered('ok')));
    wiring.procHandlers['close']?.(0, null);
    await promise;
  });

  it('reads events that arrive in chunks split anywhere, also inside a character', async () => {
    const wiring = makeProc();
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    const promise = client.sendMessage('sys', 'user');
    promise.catch(() => {});

    await waitForListeners(wiring);
    const text = `short ${'A'.repeat(600)} ✓`;
    const stdout = Buffer.from(answered(text));
    const cuts = [10, stdout.indexOf('✓') + 1, stdout.length - 3];
    [0, ...cuts].forEach((from, i) => wiring.stdoutHandlers['data']?.(stdout.subarray(from, cuts[i])));
    wiring.procHandlers['close']?.(0, null);
    expect((await promise).content).toBe(text);
  });

  it('includes last 500 bytes of stdout, or that Codex was reconnecting, in the timeout error message', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      const wiring = makeProc();
      const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
      const promise = client.sendMessage('sys', 'user');
      promise.catch(() => {});

      await waitForListeners(wiring);
      wiring.stdoutHandlers['data']?.(Buffer.from('UNIQUE_DIAGNOSTIC_MARKER'));
      jest.advanceTimersByTime(1_200_000 + 100);
      wiring.procHandlers['close']?.(null, 'SIGTERM');

      await expect(promise).rejects.toThrow(/timed out after 1200s.*UNIQUE_DIAGNOSTIC_MARKER/s);

      const waiting = makeProc();
      const waitingPromise = client.sendMessage('sys', 'user', { timeoutMs: 900_000 });
      waitingPromise.catch(() => {});
      await waitForListeners(waiting);
      const retry = (n: number) => error(`Reconnecting... ${n}/5 (stream disconnected before completion: idle timeout waiting for SSE)`);
      waiting.stdoutHandlers['data']?.(Buffer.from(jsonl(started(), TURN, retry(1), retry(2))));
      jest.advanceTimersByTime(900_000 + 100);
      waiting.procHandlers['close']?.(null, 'SIGTERM');

      await expect(waitingPromise).rejects.toThrow(`. The CLI was waiting on the provider and retrying a failed request (${retry(2).message})`);

      // A retry that an event or the model's text followed, or that a line cut short follows, is no wait at the end.
      for (const stdout of [
        jsonl(started(), TURN, retry(1), message('back')),
        jsonl(started(), TURN, message(`ERROR: ${retry(1).message}`), message(retry(2).message)),
        `${jsonl(started(), TURN, retry(1))}{"type":"item.comp`,
      ]) {
        const after = makeProc();
        const afterPromise = client.sendMessage('sys', 'user', { timeoutMs: 900_000 }).then(() => null, (e: Error) => e);
        await waitForListeners(after);
        after.stdoutHandlers['data']?.(Buffer.from(stdout));
        jest.advanceTimersByTime(900_000 + 100);
        after.procHandlers['close']?.(null, 'SIGTERM');
        expect((await afterPromise)?.message).not.toContain('retrying a failed request');
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('ends a run that shows only that Codex waits for the network for two minutes, as unreachable only when no request reached the model', async () => {
    jest.spyOn(core, 'warning').mockImplementation(() => {});
    jest.spyOn(core, 'info').mockImplementation(() => {});
    // What Codex 0.166.0 printed when the connection to the endpoint was refused, its host did not resolve or TLS failed.
    const noNetwork = error('Reconnecting... waiting for network (Connection failed: error sending request)');
    const waitedOut = 'Codex CLI was waiting for the network for 120s, so the call ends as a failed connection: Reconnecting... waiting for network';
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      const client = new OpenAIClient({ auth: { kind: 'endpoint', key: 'sk-test', baseUrl: 'http://127.0.0.1:1/v1' }, model: 'gpt-4o' });
      const lost = makeProc();
      const lostPromise = client.sendMessage('sys', 'the prompt', { timeoutMs: 900_000 }).then(() => null, (e: Error) => e);
      await waitForListeners(lost);
      lost.stdoutHandlers['data']?.(Buffer.from(jsonl(started(), TURN, noNetwork)));
      jest.advanceTimersByTime(60_000);
      // A repeat of the note keeps the first one's clock, and so does Codex's log on stderr.
      lost.stdoutHandlers['data']?.(Buffer.from(jsonl(noNetwork)));
      lost.stderrHandlers['data']?.(Buffer.from('2026-11-18T02:14:40.709531Z ERROR codex_models_manager::manager: failed to refresh available models\n'));
      jest.advanceTimersByTime(59_000);
      expect(lost.proc.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1_000);
      expect(lost.proc.kill).toHaveBeenCalledWith('SIGTERM');
      lost.procHandlers['close']?.(null, 'SIGTERM');
      const failure = await lostPromise;
      expect(failure).toBeInstanceOf(UnreachableError);
      expect(failure).toMatchObject({ message: waitedOut, limit: 'OpenAI endpoint unreachable', credential: undefined });
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      /** Starts a call on `on` whose run prints `stdout` and then waits out the network, and returns its error. */
      const waitOut = async (stdout: string, on = client): Promise<Error | null> => {
        const run = makeProc();
        const call = on.sendMessage('sys', 'the prompt', { timeoutMs: 900_000 }).then(() => null, (e: Error) => e);
        await waitForListeners(run);
        run.stdoutHandlers['data']?.(Buffer.from(stdout));
        jest.advanceTimersByTime(120_000);
        run.procHandlers['close']?.(null, 'SIGTERM');
        return call;
      };
      // A ChatGPT login names OpenAI itself. A model Codex has no metadata for adds a warning before the turn, and Codex
      // can word the cause of a failed connect otherwise. A known model has no warning.
      const chatgpt = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-5.5' });
      expect(await waitOut(jsonl(started(), TURN, noNetwork, noNetwork), chatgpt)).toMatchObject({ name: 'UnreachableError', limit: 'OpenAI unreachable' });
      const noMetadata = (model: string, text = 'not found. Defaulting to fallback metadata; this can degrade performance and cause issues.') =>
        ({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: `Model metadata for \`${model}\` ${text}` } });
      for (const stdout of [
        jsonl(started(), noMetadata('gpt-4o'), TURN, noNetwork),
        jsonl(started(), TURN, error('Reconnecting... waiting for network (Connection failed: error sending request for url (http://127.0.0.1:1/v1/responses))'), noNetwork),
      ]) {
        expect(await waitOut(stdout)).toMatchObject({ name: 'UnreachableError', limit: 'OpenAI endpoint unreachable', message: waitedOut });
      }
      // Any other event, such as a message, a retry of a request, another warning or one in another place, can follow a
      // request the provider received. A server that received the request can make Codex print the retries over
      // WebSocket that a refused login connection prints, the fallback to HTTPS too.
      const refused = 'stream disconnected before completion: Connection refused (os error 61)';
      const fallback = { type: 'item.completed', item: { id: 'item_0', type: 'error', message: `Falling back from WebSockets to HTTPS transport. ${refused}` } };
      const waits = (event: object) => [event, noNetwork];
      for (const [stdout, on] of [
        [jsonl(started(), TURN, message('I looked at the diff.'), noNetwork), client],
        [jsonl(started(), TURN, error(`Reconnecting... 2/5 (${refused})`), noNetwork), client],
        [jsonl(started(), TURN, error(`Reconnecting... 2/5 (${refused})`), error(`Reconnecting... 5/5 (${refused})`), ...waits(fallback)), chatgpt],
        [jsonl(started(), noMetadata('gpt-4o', 'not found.'), TURN, noNetwork), client],
        [jsonl(started(), noMetadata('gpt-4o'), noMetadata('gpt-4o'), TURN, noNetwork), client],
        [jsonl(started(), TURN, noMetadata('gpt-4o'), noNetwork), client],
        [jsonl(noMetadata('gpt-4o'), started(), TURN, noNetwork), client],
        [jsonl(started(), TURN, error('Reconnecting... waiting for network (Transport error)'), noNetwork), client],
        [jsonl(TURN, noNetwork), client],
        [`${jsonl(started(), TURN)}ERROR: Reconnecting... waiting for network\n${jsonl(noNetwork)}`, client],
        [jsonl(started(), TURN, message(noNetwork.message), noNetwork), client],
      ] as const) {
        const other = await waitOut(stdout, on);
        expect([other?.message, other instanceof QuotaError]).toEqual([waitedOut, false]);
      }
      // A wait whose cause Codex words otherwise still ends after 2 minutes, as a plain failed connection.
      expect(await waitOut(jsonl(started(), TURN, error('Reconnecting... waiting for network (dns error)')))).toMatchObject({ name: 'Error', message: waitedOut });

      // A resumed run follows a run that reached the model, so its wait fails as a plain connection failure.
      mockSpawn.mockClear();
      const dropped = makeProc();
      const resumedPromise = client.sendMessage('sys', 'the prompt', { timeoutMs: 900_000 }).then(() => null, (e: Error) => e);
      await waitForListeners(dropped);
      dropped.stdoutHandlers['data']?.(Buffer.from(failedTurn('stream disconnected before completion: stream closed before response.completed')));
      const resumed = makeProc();
      dropped.procHandlers['close']?.(1, null);
      await waitForListeners(resumed);
      resumed.stdoutHandlers['data']?.(Buffer.from(jsonl(started(), TURN, noNetwork)));
      jest.advanceTimersByTime(120_000);
      resumed.procHandlers['close']?.(null, 'SIGTERM');
      const afterResume = await resumedPromise;
      expect([mockSpawn.mock.calls.length, afterResume?.message, afterResume instanceof QuotaError]).toEqual([2, waitedOut, false]);

      // Any other output in between starts the clock again, a line cut short too, and a run that answers keeps its answer.
      const back = makeProc();
      const backPromise = client.sendMessage('sys', 'the prompt', { timeoutMs: 900_000 });
      await waitForListeners(back);
      back.stdoutHandlers['data']?.(Buffer.from(jsonl(started(), TURN, noNetwork)));
      jest.advanceTimersByTime(100_000);
      back.stdoutHandlers['data']?.(Buffer.from(jsonl(message('I looked at the diff.'), noNetwork)));
      jest.advanceTimersByTime(100_000);
      back.stdoutHandlers['data']?.(Buffer.from('{"type":"item.comp'));
      jest.advanceTimersByTime(100_000);
      back.stdoutHandlers['data']?.(Buffer.from(`leted","item":${JSON.stringify(message('[]').item)}}\n${jsonl(COMPLETED)}`));
      jest.advanceTimersByTime(100_000);
      expect(back.proc.kill).not.toHaveBeenCalled();
      back.procHandlers['close']?.(0, null);
      expect((await backPromise).content).toBe('[]');
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails a call Manki ended itself on the time limit or the abort reason, whatever the run printed', async () => {
    jest.spyOn(core, 'warning').mockImplementation(() => {});
    const capacity = 'Selected model is at capacity. Please try a different model.';
    const stdout = Buffer.from(failedTurn(capacity, message(`ERROR: ${capacity}`)));
    const client = new OpenAIClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gpt-4o' });
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      const late = makeProc();
      const latePromise = client.sendMessage('sys', 'user', { timeoutMs: 900_000 }).then(() => null, (e: Error) => e);
      await waitForListeners(late);
      late.stdoutHandlers['data']?.(stdout);
      jest.advanceTimersByTime(900_000 + 100);
      expect(late.proc.kill).toHaveBeenCalledWith('SIGTERM');
      late.procHandlers['close']?.(null, 'SIGTERM');
      const timedOut = await latePromise;
      expect(timedOut).not.toBeInstanceOf(QuotaError);
      expect(timedOut).toBeInstanceOf(TimeoutError);
      expect(timedOut?.message).toMatch(/^Codex CLI timed out after 900s\. Last stdout: .*"turn\.failed"/s);
    } finally {
      jest.useRealTimers();
    }

    const cancelled = makeProc();
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    const cancelledPromise = client.sendMessage('sys', 'user', { signal: controller.signal }).then(() => null, (e: Error) => e);
    await waitForListeners(cancelled);
    cancelled.stdoutHandlers['data']?.(stdout);
    controller.abort(reason);
    expect(cancelled.proc.kill).toHaveBeenCalledWith('SIGTERM');
    cancelled.procHandlers['close']?.(null, 'SIGTERM');
    expect(await cancelledPromise).toBe(reason);
  });
});

describe('ensureCLI auto-install', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetCLIInstallPromise();
    mockExecFileAsync.mockReset();
    const { seedAuthFile } = jest.requireMock('./cli-utils') as { seedAuthFile: jest.Mock };
    seedAuthFile.mockReset();
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
      if (event === 'data') setTimeout(() => cb(Buffer.from(answered('ok'))), 0);
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
