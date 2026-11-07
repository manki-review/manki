import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';

import { AnthropicClient, buildAnthropicAuth, CLAUDE_CLI_VERSION, extractAnthropicCLIUsage, sanitizeLogOutput, STALE_TIMEOUT_MS } from './anthropic';
import { installPinned } from '../tool-install';
import { RelatedRepoTools } from '../types';
import { QuotaError, RefusalError, SendMessageOptions } from './types';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('@anthropic-ai/sdk');

jest.mock('../tool-install', () => ({ ...jest.requireActual('../tool-install'), installPinned: jest.fn() }));
const mockInstallPinned = installPinned as jest.MockedFunction<typeof installPinned>;

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

describe('AnthropicClient', () => {
  it('accepts oauth auth', () => {
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'test-token' }, model: 'claude-opus-4-6' });
    expect(client).toBeDefined();
  });

  it('accepts apiKey auth', () => {
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-test-key' }, model: 'claude-opus-4-6' });
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
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user', { effort: 'high' });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--effort');
    expect(spawnArgs[spawnArgs.indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort flag when no options provided', async () => {
    setupSpawnMock('response text');
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--effort');
  });

  it('omits --effort flag when effort is undefined', async () => {
    setupSpawnMock('response text');
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await client.sendMessage('system', 'user', {});

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--effort');
  });
});

describe('sendMessage effort option (API path)', () => {
  let mockStream: jest.Mock;
  let mockFinalMessage: jest.Mock;

  beforeEach(() => {
    mockFinalMessage = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'response' }],
    });
    mockStream = jest.fn(() => ({ finalMessage: mockFinalMessage, on: jest.fn() }));
    (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
      messages: { stream: mockStream },
    }));
  });

  async function sentParams(model: string, effort?: SendMessageOptions['effort']): Promise<Record<string, unknown>> {
    mockStream.mockClear();
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model });
    await client.sendMessage('system', 'user', effort ? { effort } : undefined);
    return mockStream.mock.calls[0][0];
  }

  it('sends adaptive thinking with the native effort level on models after the 4.5 generation', async () => {
    const models = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-future-9'];
    for (const model of models) {
      for (const effort of ['low', 'medium', 'high', 'max'] as const) {
        const params = await sentParams(model, effort);
        expect(params.thinking).toEqual({ type: 'adaptive' });
        expect(params.output_config).toEqual({ effort });
        expect(params.max_tokens).toBe(32768);
      }
    }
  });

  it('sends budget_tokens on the 4.5 generation', async () => {
    const models = ['claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
    for (const model of models) {
      expect((await sentParams(model, 'medium')).thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
      expect((await sentParams(model, 'high')).thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
      const params = await sentParams(model, 'max');
      expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
      expect(params.output_config).toBeUndefined();
      expect(params.max_tokens).toBe(32768);
    }
  });

  it('bounds the API call with an abort signal only when `timeoutMs` is set', async () => {
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model: 'claude-opus-5-5' });
    await client.sendMessage('system', 'user', { timeoutMs: 300_000 });
    await client.sendMessage('system', 'user');

    expect(mockStream.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(mockStream.mock.calls[1][1]).toBeUndefined();
  });

  it('omits thinking on the 4.5 generation when effort is low', async () => {
    const params = await sentParams('claude-sonnet-4-5', 'low');
    expect(params.thinking).toBeUndefined();
    expect(params.output_config).toBeUndefined();
    expect(params.max_tokens).toBe(16384);
  });

  it('omits thinking and effort when no options provided', async () => {
    for (const model of ['claude-opus-4-7', 'claude-sonnet-4-5']) {
      const params = await sentParams(model);
      expect(params.thinking).toBeUndefined();
      expect(params.output_config).toBeUndefined();
      expect(params.max_tokens).toBe(16384);
    }
  });

  it('concatenates multiple text blocks', async () => {
    mockFinalMessage.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });

    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model: 'claude-opus-4-6' });
    const result = await client.sendMessage('system', 'user');

    expect(result.content).toBe('first\nsecond');
  });

  it('throws when Anthropic client is not initialized', async () => {
    // Create with oauthToken only — no Anthropic client
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    // Access private sendViaAPI directly via prototype
    const sendViaAPI = (AnthropicClient.prototype as unknown as Record<string, unknown>)['sendViaAPI'] as (
      systemPrompt: string,
      userMessage: string,
    ) => Promise<unknown>;

    await expect(sendViaAPI.call(client, 'sys', 'user')).rejects.toThrow('Anthropic client not initialized');
  });
});

describe('sendViaOAuth — error paths', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
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

  it('rejects on non-zero exit code with rich diagnostics', async () => {
    setupSpawnMock({ exitCode: 1, stderr: 'something went wrong' });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await expect(client.sendMessage('sys', 'user', { effort: 'high' })).rejects.toThrow(
      /Claude CLI invocation failed.*model=claude-opus-4-6.*effort=high.*promptChars=\d+.*elapsedMs=\d+.*stderrChars=\d+/s,
    );
  });

  it('leads with the CLI error text and keeps the diagnostics when exit-1 has no stderr', async () => {
    const cliError = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
    const streamWithResultError = [
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial thinking emitted right before exit' } }),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: cliError }),
      '',
    ].join('\n');
    setupSpawnMock({
      exitCode: 1,
      stderr: '',
      stdout: streamWithResultError,
      rawStdout: true,
    });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(error?.message.startsWith(`Claude CLI error: ${cliError}. `)).toBe(true);
    expect(error?.message).toContain('claude setup-token');
    expect(error?.message).toMatch(/Claude CLI invocation failed \(exit 1: <empty stderr>/);
    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarnings).toContain(`Claude CLI error: ${cliError}`);
    expect(allWarnings).toContain('Claude CLI failed');
    expect(allWarnings).toContain('<empty stderr>');
    expect(allWarnings).toContain('stderrChars=0');
    expect(allWarnings).toContain('is_error=true');
    expect(allWarnings).toContain('subtype=error_during_execution');
    warnSpy.mockRestore();
  });

  it('leads with a non-auth CLI error without the token hint', async () => {
    const cliError = 'Prompt is too long: 250000 tokens > 200000 maximum';
    setupSpawnMock({
      exitCode: 1,
      stderr: '',
      stdout: `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: cliError })}\n`,
      rawStdout: true,
    });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(error?.message.startsWith(`Claude CLI error: ${cliError}. Claude CLI invocation failed`)).toBe(true);
    expect(error?.message).not.toContain('claude setup-token');
    expect(error).not.toBeInstanceOf(RefusalError);
    warnSpy.mockRestore();
  });

  it.each([
    ['exits 1', 1],
    ['exits 0 with `is_error`', 0],
  ])('throws a `QuotaError` with the reset time when the subscription limit is used up and the CLI %s', async (_case, exitCode) => {
    const limitText = "You've hit your weekly limit · resets Nov 6, 8pm (UTC)";
    setupSpawnMock({ exitCode, stderr: '', stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: limitText })}\n`, rawStdout: true });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-sonnet-5-5' });

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toMatchObject({ limit: 'Claude subscription limit reached', resetsAt: 'Nov 6, 8pm (UTC)', credential: 'token' });
    expect(error?.message).toContain(limitText);
    warnSpy.mockRestore();
  });

  const safeguardsText = "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations.";
  const refusedAssistant = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: safeguardsText }], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'reasoning_extraction', explanation: null } },
  });
  it.each<[string, string[], string]>([
    ['the assistant event names the category', [refusedAssistant, JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: safeguardsText })], 'refusal (reasoning_extraction)'],
    ['only the result event carries the stop reason', [JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: safeguardsText, stop_reason: 'refusal' })], 'refusal'],
  ])('throws a `RefusalError` when %s', async (_case, lines, reason) => {
    setupSpawnMock({ exitCode: 1, stderr: '', stdout: `${lines.join('\n')}\n`, rawStdout: true });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-5-5' });

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as RefusalError).reason).toBe(reason);
    expect(error?.message).toContain(`Claude CLI error: ${safeguardsText}`);
    warnSpy.mockRestore();
  });

  it('ignores a refused attempt when the CLI run still succeeds', async () => {
    setupSpawnMock({ stdout: `${refusedAssistant}\n${JSON.stringify({ type: 'result', subtype: 'success', result: 'answer', stop_reason: 'end_turn' })}\n`, rawStdout: true });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-5-5' });

    await expect(client.sendMessage('sys', 'user')).resolves.toMatchObject({ content: 'answer' });
  });

  it('throws a plain error when the run fails after recovering from a refused attempt', async () => {
    const authError = 'Invalid API key · Please run /login';
    const lines = [
      refusedAssistant,
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: authError }], stop_reason: 'stop_sequence', stop_details: null } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: authError }),
    ];
    setupSpawnMock({ exitCode: 1, stderr: '', stdout: `${lines.join('\n')}\n`, rawStdout: true });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-5-5' });

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(error?.message).toContain(authError);
    expect(error).not.toBeInstanceOf(RefusalError);
    warnSpy.mockRestore();
  });

  it('records <no result event> when exit-1 stream emits only text deltas with no terminal result', async () => {
    const streamWithoutResult = [
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streamed text but no terminal event' } }),
      '',
    ].join('\n');
    setupSpawnMock({
      exitCode: 1,
      stderr: '',
      stdout: streamWithoutResult,
      rawStdout: true,
    });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow(/^Claude CLI invocation failed/);
    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarnings).toContain('<no result event>');
    expect(allWarnings).not.toContain('is_error=');
    warnSpy.mockRestore();
  });

  it('rejects on spawn error', async () => {
    setupSpawnMock({ error: new Error('ENOENT') });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await expect(client.sendMessage('sys', 'user')).rejects.toThrow('Claude CLI spawn failed: ENOENT');
  });

  it('returns trimmed content on success', async () => {
    setupSpawnMock({ stdout: '  hello world  \n' });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('hello world');
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN and caps output at the API path\'s limit in spawn env', async () => {
    const ambient = {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
      CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth-token',
      GITHUB_TOKEN: 'ghs_workflow',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/oidc',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request',
      INPUT_GITHUB_TOKEN: 'ghs_input',
    };
    const saved = Object.fromEntries(Object.keys(ambient).map((name) => [name, process.env[name]]));
    Object.assign(process.env, ambient);
    setupSpawnMock({ stdout: 'ok' });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'my-oauth-token' }, model: 'claude-opus-4-6' });

    try {
      await client.sendMessage('sys', 'user');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOpts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('my-oauth-token');
    expect(spawnOpts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('32768');
    expect(spawnOpts.env.PATH).toBe(process.env.PATH);
    for (const name of ['GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'INPUT_GITHUB_TOKEN']) {
      expect(spawnOpts.env).not.toHaveProperty(name);
    }
  });

  it('passes the output and isolation flags and runs the CLI in an empty temp directory', async () => {
    setupSpawnMock({ stdout: 'ok' });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await client.sendMessage('sys', 'user');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const fmtIdx = spawnArgs.indexOf('--output-format');
    expect(fmtIdx).toBeGreaterThan(-1);
    expect(spawnArgs[fmtIdx + 1]).toBe('stream-json');
    expect(spawnArgs).toContain('--verbose');
    expect(spawnArgs).toContain('--include-partial-messages');
    expect(spawnArgs[spawnArgs.indexOf('--tools') + 1]).toBe('');
    expect(spawnArgs).toContain('--strict-mcp-config');
    expect(spawnArgs).not.toContain('--mcp-config');
    expect(spawnArgs).not.toContain('--restricted');
    expect(spawnArgs[spawnArgs.indexOf('--setting-sources') + 1]).toBe('');
    const { cwd } = mockSpawn.mock.calls[0][2] as { cwd: string };
    expect(cwd.startsWith(join(tmpdir(), 'manki-cli-'))).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it('gives the CLI read-only tools on the repository and Manki\'s tool server when asked for them, and reports the tool steps', async () => {
    const toolUse = (id: string, name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
    const toolResult = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] } });
    const events = [toolUse('t1', 'Read'), toolResult('t1'), toolUse('t2', 'mcp__manki__git_history'), toolResult('t2'), { type: 'result', result: '[]' }];
    setupSpawnMock({ stdout: `${events.map(e => JSON.stringify(e)).join('\n')}\n`, rawStdout: true });
    const spawnProc = mockSpawn.getMockImplementation()!;
    let systemPromptFile = '';
    let mcpConfig: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } | undefined;
    mockSpawn.mockImplementationOnce((...args: Parameters<typeof spawnProc>) => {
      const cliArgs = args[1] as string[];
      systemPromptFile = readFileSync(cliArgs[cliArgs.indexOf('--system-prompt-file') + 1], 'utf-8');
      mcpConfig = JSON.parse(readFileSync(cliArgs[cliArgs.indexOf('--mcp-config') + 1], 'utf-8'));
      return spawnProc(...args);
    });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-5-5' });
    expect(client.repoTools).toBe(true);
    expect(new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk' }, model: 'claude-opus-5-5' }).repoTools).toBe(false);

    const related: RelatedRepoTools = {
      repos: [{ repo: 'dashpay/dash', kind: 'reference', ref: 'v23.0.0', paths: ['src/'] }, { repo: 'dashpay/platform', kind: 'consumer' }],
      cacheDir: '/runner/temp/manki-related-repos',
      stateDir: '/runner/temp/manki-related-1',
    };
    const response = await client.sendMessage('Review the diff.', 'the diff', { repoTools: { root: '/work/repo', steps: 15, related } });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const valueOf = (flag: string) => spawnArgs[spawnArgs.indexOf(flag) + 1];
    expect(spawnArgs).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config']));
    expect([valueOf('--permission-mode'), valueOf('--tools'), valueOf('--add-dir'), valueOf('--allowedTools'), valueOf('--max-turns')])
      .toEqual(['dontAsk', 'Read,Grep,Glob', '/work/repo', 'mcp__manki__git_history,mcp__manki__ast_grep,mcp__manki__read_file,mcp__manki__grep,mcp__manki__glob', '20']);
    const hook = JSON.parse(valueOf('--settings')).hooks.PreToolUse;
    expect(hook).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: expect.stringMatching(/ 'step-hook' '[^']+\/steps' '15'$/) }] }]);
    expect(hook[0].hooks[0].command.startsWith(`'${process.execPath}' '${process.argv[1]}' `)).toBe(true);
    expect(valueOf('--setting-sources')).toBe('');
    expect(mcpConfig!.mcpServers.manki).toEqual({
      type: 'stdio', command: process.execPath, args: [process.argv[1], 'mcp-server', '/work/repo', '--related-repos', JSON.stringify(related)], env: { CLAUDE_CODE_OAUTH_TOKEN: '' },
    });
    expect(Object.keys(mcpConfig!.mcpServers)).toEqual(['manki']);
    expect(systemPromptFile).toMatch(/^Review the diff\.\n\n## Tools\n\nThe PR's head commit is checked out at `\/work\/repo`\./);
    expect(systemPromptFile).toContain('You have 15 tool steps, and each tool call takes one. When 3 are left, a note from Manki');
    expect(systemPromptFile).toContain([
      '## Related repos',
      '',
      '`read_file`, `grep`, `glob` and `ast_grep` read one of these repos instead when you name it in `repo`:',
      '',
      '- `dashpay/dash` at `v23.0.0`, reference: a codebase this one implements or ports. Only `src/` is fetched.',
      '- `dashpay/platform`, consumer: a codebase that depends on this one.',
    ].join('\n'));
    expect(systemPromptFile).toContain('A change that breaks a consumer is a `warning` that lists the consumer\'s call sites');
    expect(response.toolSteps).toEqual([{ tool: 'Read', durationMs: expect.any(Number) }, { tool: 'mcp__manki__git_history', durationMs: expect.any(Number) }]);
  });

  it('fails when the CLI uses all its turns before it answers', async () => {
    setupSpawnMock({ stdout: `${JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 16 })}\n`, rawStdout: true, exitCode: 1 });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-5-5' });

    await expect(client.sendMessage('sys', 'user', { repoTools: { root: '/work/repo', steps: 15 } })).rejects.toThrow('Claude CLI used all its turns before it answered');
  });

  it('sends the system prompt as the CLI system prompt and only the user message on stdin', async () => {
    setupSpawnMock({ stdout: 'ok' });
    const spawnProc = mockSpawn.getMockImplementation()!;
    let systemPromptFile = '';
    let stdinWrite: jest.Mock | undefined;
    mockSpawn.mockImplementationOnce((...args: Parameters<typeof spawnProc>) => {
      const promptArgs = args[1] as string[];
      systemPromptFile = readFileSync(promptArgs[promptArgs.indexOf('--system-prompt-file') + 1], 'utf-8');
      const proc = spawnProc(...args);
      stdinWrite = (proc.stdin as unknown as { write: jest.Mock }).write;
      return proc;
    });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-5-5' });

    await client.sendMessage('You give the final verdict.', 'the diff');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(systemPromptFile).toBe('You give the final verdict.');
    expect(existsSync(spawnArgs[spawnArgs.indexOf('--system-prompt-file') + 1])).toBe(false);
    expect(stdinWrite!.mock.calls.map(c => String(c[0])).join('')).toBe('the diff');
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
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

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
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('final answer');
  });

  it.each<[string | undefined, boolean]>([
    ['max_tokens', true],
    ['end_turn', false],
    [undefined, false],
  ])('reports truncated for result event stop_reason %s', async (stopReason, expected) => {
    const streamOutput = [
      JSON.stringify({ type: 'result', subtype: 'success', result: '[', stop_reason: stopReason }),
      '',
    ].join('\n');
    setupSpawnMock({ stdout: streamOutput, rawStdout: true });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.truncated).toBe(expected);
  });

  it('returns an empty truncated reply when the CLI run fails at the output limit', async () => {
    const cliError = "API Error: Claude's response exceeded the 32768 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";
    const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    const lines = [
      delta('x'.repeat(3000)),
      delta('Let me walk through every file, token ghp_abcdefghijklmnop, then'),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: cliError, api_error: 'max_output_tokens', usage: { output_tokens: 32768 } }),
    ];
    setupSpawnMock({ exitCode: 1, stdout: `${lines.join('\n')}\n`, rawStdout: true });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-5-5' });

    const result = await client.sendMessage('sys', 'user');
    expect(result).toMatchObject({ content: '', truncated: true, usage: { outputTokens: 32768 } });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('32768-token output limit'));
    const tailWarning = warnSpy.mock.calls.map(c => String(c[0])).find(w => w.startsWith('Claude CLI reply ended with: '));
    expect(tailWarning).toBeDefined();
    expect(tailWarning!.endsWith('Let me walk through every file, token [REDACTED], then')).toBe(true);
    expect(tailWarning!.length).toBeLessThanOrEqual('Claude CLI reply ended with: '.length + 2000);
    warnSpy.mockRestore();
  });

  it('silently skips non-JSON lines (e.g. verbose debug output)', async () => {
    setupSpawnMock({ stdout: 'plain text fallback\n', rawStdout: true });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('');
  });

  it('includes exit signal in error message when present', async () => {
    setupSpawnMock({ exitCode: 1, signal: 'SIGTERM', stderr: 'killed' });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

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
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('drain response');
    expect(proc.stdin.once).toHaveBeenCalledWith('drain', expect.any(Function));
  });

  it('rejects with 1200s timeout and includes stderr snippet', async () => {
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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      // Flush microtasks so ensureCLI resolves and spawn is called
      await jest.advanceTimersByTimeAsync(0);

      // Emit stderr before timeout
      stderrCb!(Buffer.from('some diagnostic output'));

      // Keep stdout alive to prevent the stale checker from firing before hard timeout
      for (let i = 0; i < 14; i++) {
        await jest.advanceTimersByTimeAsync(80_000);
        stdoutCb!(Buffer.from(`keepalive-${i}`));
      }

      // Fire the 1200s timeout (advance remaining ~80s)
      await jest.advanceTimersByTimeAsync(80_000);

      // Simulate process exit after SIGTERM
      closeCb!(null, 'SIGTERM');

      const err: Error = await promise.then(() => { throw new Error('expected rejection'); }, (e) => e);
      expect(err.message).toContain('Claude CLI timed out after 1200s');
      expect(err.message).toContain('Last stdout: keepalive');
      expect(err.message).toContain('stderr: some diagnostic output');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each<[number | undefined, number]>([
    [undefined, 1200],
    [300_000, 300],
  ])('rejects with plain timeout when stderr is empty (timeoutMs %s)', async (timeoutMs, limitSeconds) => {
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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user', { timeoutMs });

      await jest.advanceTimersByTimeAsync(0);

      // Keep stdout alive to prevent the stale checker from firing, stopping one step before the limit.
      for (let i = 0; i < Math.ceil(limitSeconds / 80) - 1; i++) {
        await jest.advanceTimersByTimeAsync(80_000);
        stdoutCb!(Buffer.from(`keepalive-${i}`));
      }
      expect(proc.kill).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(80_000);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      closeCb!(null, 'SIGTERM');

      await expect(promise).rejects.toThrow(`Claude CLI timed out after ${limitSeconds}s`);
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
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

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
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

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

  it('kills the CLI and rejects with the reason when the caller\'s signal aborts, and spawns none once it has aborted', async () => {
    const proc = {
      stdin: { write: jest.fn().mockReturnValue(true), end: jest.fn(), on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };
    let closeCb: ((code: number | null, signal: string | null) => void) | undefined;
    proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') closeCb = cb as typeof closeCb;
    });
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });
    const controller = new AbortController();
    const reason = new Error('head moved');

    const promise = client.sendMessage('sys', 'user', { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort(reason);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    closeCb!(null, 'SIGTERM');
    await expect(promise).rejects.toBe(reason);

    mockSpawn.mockClear();
    await expect(client.sendMessage('sys', 'user', { signal: controller.signal })).rejects.toBe(reason);
    expect(mockSpawn).not.toHaveBeenCalled();
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
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

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
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

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
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

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
    mockInstallPinned.mockReset();
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

  it('installs the pinned build of the Claude CLI when it is not on the path, and runs no other command', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('not found'));
    mockInstallPinned.mockResolvedValueOnce('/runner/temp/manki-pinned');

    setupSpawnForSuccess('installed ok');
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    const result = await client.sendMessage('sys', 'user');
    expect(result.content).toBe('installed ok');
    const name = `claude-code-${process.platform}-${process.arch}`;
    expect(mockInstallPinned).toHaveBeenCalledWith({
      url: `https://registry.npmjs.org/@anthropic-ai/${name}/-/${name}-${CLAUDE_CLI_VERSION}.tgz`,
      integrity: expect.stringMatching(/^sha512-[A-Za-z0-9+/]{86}==$/),
    });
    expect(mockExecFileAsync.mock.calls).toEqual([['which', ['claude']]]);
    expect(mockSpawn.mock.calls[0][0]).toBe(join('/runner/temp/manki-pinned', 'package', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  });

  it('throws when the install fails or no build is pinned for the platform, and installs again on the next call', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('not found'));
    mockInstallPinned.mockRejectedValueOnce(new Error('download does not match its pinned sha512 digest'));
    setupSpawnForSuccess('installed later');

    await expect(new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' }).sendMessage('sys', 'user'))
      .rejects.toThrow('Failed to install Claude CLI: download does not match its pinned sha512 digest');

    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'aix' });
    try {
      await expect(new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' }).sendMessage('sys', 'user'))
        .rejects.toThrow(`Failed to install Claude CLI: no pinned Claude CLI build for aix-${process.arch}`);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }

    mockInstallPinned.mockResolvedValueOnce('/runner/temp/manki-pinned');
    const result = await new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' }).sendMessage('sys', 'retry');
    expect(result.content).toBe('installed later');
    expect(mockInstallPinned).toHaveBeenCalledTimes(2);
  });

  it('reuses cached CLI path on second call', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/claude\n' });
    setupSpawnForSuccess('response');
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await client.sendMessage('sys', 'first');
    await client.sendMessage('sys', 'second');

    // execFileAsync (which) should only be called once, then cached
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

describe('warmupCLI', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExecFileAsync.mockReset();
    mockInstallPinned.mockReset();
  });

  it('invokes ensureCLI once for OAuth auth', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/claude\n' });
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await client.warmupCLI();
    await client.warmupCLI();

    // First call hits `which`; second call hits the cached path.
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['claude']);
  });

  it('installs the pinned build when the CLI is missing', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('not found'));
    mockInstallPinned.mockResolvedValueOnce('/runner/temp/manki-pinned');
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await client.warmupCLI();

    expect(mockInstallPinned).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for API-key auth', async () => {
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-test' }, model: 'claude-opus-4-6' });

    await client.warmupCLI();

    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('propagates ensureCLI errors when install fails', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('not found'));
    mockInstallPinned.mockRejectedValueOnce(new Error('download failed with HTTP 503'));
    const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

    await expect(client.warmupCLI()).rejects.toThrow('Failed to install Claude CLI');
  });
});

describe('sendViaOAuth — stale process detection', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockExecFileAsync.mockResolvedValue({ stdout: '/usr/bin/claude' });
    _execMock.fn = mockExecFileAsync;
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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      // Flush microtasks so ensureCLI resolves and spawn is called
      await jest.advanceTimersByTimeAsync(0);

      // Advance past the stale timeout — self-resetting setTimeout fires exactly at 90s
      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      // Simulate process exit after SIGTERM
      closeCb!(null, 'SIGTERM');

      const err: Error = await promise.then(() => { throw new Error('expected rejection'); }, (e) => e);
      expect(err.message).toContain(`Claude CLI stale — no output for ${STALE_TIMEOUT_MS / 1000}s`);
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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Keep producing stdout every 80s — always under the 90s stale threshold
      for (let i = 0; i < 14; i++) {
        await jest.advanceTimersByTimeAsync(80_000);
        stdoutCb!(Buffer.from(`chunk-${i}`));
      }

      // At this point ~1120s have passed. The stale timer keeps resetting.
      // Advance to the hard 1200s timeout
      await jest.advanceTimersByTimeAsync(80_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      closeCb!(null, 'SIGTERM');

      await expect(promise).rejects.toThrow('Claude CLI timed out after 1200s');
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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Emit one stdout chunk then go silent
      stdoutCb!(Buffer.from('partial output here'));

      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Emit two small chunks — both should appear in the rolling buffer
      stdoutCb!(Buffer.from('first-part|'));
      stdoutCb!(Buffer.from('second-part'));

      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Emit a chunk larger than 500 chars, then a small one
      stdoutCb!(Buffer.from('A'.repeat(490)));
      stdoutCb!(Buffer.from('B'.repeat(20)));

      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      stderrCb!(Buffer.from('::warning::injected'));

      // Keep stdout alive past stale threshold until hard timeout.
      // The last keepalive contains a workflow command to verify stdout sanitization.
      for (let i = 0; i < 14; i++) {
        await jest.advanceTimersByTimeAsync(80_000);
        const payload = i === 13 ? 'stdout ::set-env name=X::val' : `keepalive-${i}`;
        stdoutCb!(Buffer.from(payload));
      }

      await jest.advanceTimersByTimeAsync(80_000);
      closeCb!(null, 'SIGTERM');

      const err = await promise.catch((e: unknown) => e) as Error;
      expect(err.message).toContain('[redacted-workflow-cmd]');
      expect(err.message).not.toContain('::warning');
      expect(err.message).not.toContain('::set-env');
    } finally {
      jest.useRealTimers();
    }
  });

  it('escalates to SIGKILL when process does not exit within 5s of stale SIGTERM', async () => {
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
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: 'token' }, model: 'claude-opus-4-6' });

      const promise = client.sendMessage('sys', 'user');

      await jest.advanceTimersByTimeAsync(0);

      // Fire the stale timeout
      await jest.advanceTimersByTimeAsync(STALE_TIMEOUT_MS);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      // Process does not exit — advance past the 5s SIGKILL escalation timeout
      await jest.advanceTimersByTimeAsync(5000);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

      // Simulate process exit after SIGKILL
      closeCb!(null, 'SIGKILL');

      await expect(promise).rejects.toThrow(`Claude CLI stale — no output for ${STALE_TIMEOUT_MS / 1000}s`);
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

describe('buildAnthropicAuth', () => {
  it('throws when neither token is present', () => {
    expect(() => buildAnthropicAuth('', '')).toThrow(
      'Either claude_code_oauth_token or anthropic_api_key must be provided',
    );
  });

  it('returns oauth kind when only oauth token is present', () => {
    expect(buildAnthropicAuth('oauth-tok', '')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });

  it('returns apiKey kind when only api key is present', () => {
    expect(buildAnthropicAuth('', 'sk-key')).toEqual({ kind: 'apiKey', key: 'sk-key' });
  });

  it('oauth wins when both tokens are present', () => {
    expect(buildAnthropicAuth('oauth-tok', 'sk-key')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });
});

describe('extractAnthropicCLIUsage', () => {
  it('lifts standard usage fields from a result event, counting cache writes and reads as input', () => {
    expect(
      extractAnthropicCLIUsage({
        type: 'result',
        usage: {
          input_tokens: 3,
          output_tokens: 56,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 999,
        },
      }),
    ).toEqual({ inputTokens: 2202, outputTokens: 56, cacheReadTokens: 999, cacheWriteTokens: 1200, reasoningTokens: 0 });
  });

  it('coerces string-valued counters to integers', () => {
    expect(
      extractAnthropicCLIUsage({ usage: { input_tokens: '7', output_tokens: '13' } }),
    ).toEqual({ inputTokens: 7, outputTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
  });

  it('returns ZERO_USAGE when the event is missing or malformed', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    expect(extractAnthropicCLIUsage(null)).toEqual(zero);
    expect(extractAnthropicCLIUsage({})).toEqual(zero);
    expect(extractAnthropicCLIUsage({ usage: null })).toEqual(zero);
    expect(extractAnthropicCLIUsage({ usage: { input_tokens: -5 } })).toEqual(zero);
  });
});

describe('AnthropicClient API-path usage', () => {
  let mockFinalMessage: jest.Mock;

  beforeEach(() => {
    mockFinalMessage = jest.fn();
    (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
      messages: { stream: () => ({ finalMessage: mockFinalMessage, on: jest.fn() }) },
    }));
  });

  it('lifts usage and measures latency on the SDK path', async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 10 },
    });
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model: 'claude-opus-4-6' });
    const result = await client.sendMessage('sys', 'user');
    expect(result.usage).toEqual({ inputTokens: 110, outputTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 0 });
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it.each<[string | undefined, boolean]>([
    ['max_tokens', true],
    ['end_turn', false],
    [undefined, false],
  ])('reports truncated for stop_reason %s', async (stopReason, expected) => {
    mockFinalMessage.mockResolvedValue({ content: [{ type: 'text', text: '[' }], stop_reason: stopReason });
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model: 'claude-opus-4-6' });
    const result = await client.sendMessage('sys', 'user');
    expect(result.truncated).toBe(expected);
  });

  it('throws a `RefusalError` on `stop_reason: "refusal"`', async () => {
    mockFinalMessage.mockResolvedValue({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'This request was declined because it could enable cyber harm.' },
    });
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model: 'claude-opus-5-5' });

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as RefusalError).reason).toBe('refusal (cyber)');
    expect(error?.message).toBe('Claude API declined the request: refusal (cyber). This request was declined because it could enable cyber harm.');
  });

  it.each<[string, object, object]>([
    ['a 429', { status: 429, type: 'rate_limit_error' }, { limit: 'Anthropic API rate limit reached', credential: 'key' }],
    ['a streamed `rate_limit_error`', { status: undefined, type: 'rate_limit_error' }, { limit: 'Anthropic API rate limit reached', credential: 'key' }],
    ['an overload', { status: 529, type: 'overloaded_error' }, { limit: 'Anthropic API is overloaded', credential: undefined }],
  ])('throws a `QuotaError` on %s', async (_case, fields, expected) => {
    mockFinalMessage.mockRejectedValue(Object.assign(new Error('429 limited'), fields));
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model: 'claude-opus-5-5' });

    const error = await client.sendMessage('sys', 'user').then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toMatchObject(expected);
  });

  it('passes any other SDK error through unchanged', async () => {
    const failure = Object.assign(new Error('bad request'), { status: 400, type: 'invalid_request_error' });
    mockFinalMessage.mockRejectedValue(failure);
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model: 'claude-opus-5-5' });

    await expect(client.sendMessage('sys', 'user')).rejects.toBe(failure);
  });

  it('returns zero usage when the SDK omits the usage block', async () => {
    mockFinalMessage.mockResolvedValue({ content: [{ type: 'text', text: 'response' }] });
    const client = new AnthropicClient({ auth: { kind: 'apiKey', key: 'sk-key' }, model: 'claude-opus-4-6' });
    const result = await client.sendMessage('sys', 'user');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
  });
});
