import { execFile } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { promisify } from 'util';

import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';

import { installPinned } from '../tool-install';
import { appendReplyTail, buildExitDiagnostics, callWithTimeout, carryReadings, cliEnv, MankiCommand, matchQuotaText, readRelatedReads, relatedReadsFile, repoToolsPrompt, runCli, sanitizeLogOutput, STALE_TIMEOUT_MS, stepHookCommand, toolServerCommand, warnReplyTail, withPromptDir } from './cli-utils';
import { AnthropicAuth, LimitUsage, LLMClient, LLMResponse, LLMUsage, QuotaError, readCount, RefusalError, SendMessageOptions, ToolStep, ZERO_USAGE } from './types';

// Re-export for backward compatibility with existing test imports.
export { sanitizeLogOutput, STALE_TIMEOUT_MS };

const execFileAsync = promisify(execFile);

// Pinned because a future release makes `--bare` the default for `-p`, and bare mode never reads
// `CLAUDE_CODE_OAUTH_TOKEN`.
export const CLAUDE_CLI_VERSION = '2.1.318';

// The digest of each platform's native build of `CLAUDE_CLI_VERSION`. The `@anthropic-ai/claude-code` package only
// copies one of these into place in an install script, so Manki downloads the build itself and runs no script.
const CLAUDE_CLI_BUILDS: Record<string, string> = {
  'linux-x64': 'sha512-GX+7CUng2R5f7SsA2w0LaXlH2f62fRCFD/Z2SUexoeH3B0KfulKQt5DtY9NeD2Yp3VEBz6/k/xWSbGPUi6NV2A==',
  'linux-arm64': 'sha512-FUVVH3aQbLEChjv5wQLdFbpBC7bclVIdVYO5hDzJthDyf2OQtdubIP5QqLPgEScQb3CVIAFg2IPJ5nihJa8Ndw==',
  'linux-x64-musl': 'sha512-H1tn//6H1EOlkC87CYYs1iwz5rvMjGiyUpIR+8Pu0dRwA+DLAkQXgJGb0yRc+O8IWSZOhgWjarRIbPsS1cK2eg==',
  'linux-arm64-musl': 'sha512-bZRgaooI/08JmS9d0lLfv9s7N6aO8Ykd0u2U6dmRsBQ1Tq1VFY5ZOi6hfoJBOwS4+1OR3xaUGYRS10i7dZBn9g==',
  'darwin-x64': 'sha512-fockeRy3+Yrr3PxRtGW2XRPWcShjRxIhUJDWi9Xi4svB8h+JUDn7JijHzy1vgUILOE5uIvgfMadN2siEFlt/Ug==',
  'darwin-arm64': 'sha512-EBKlipLmKY+ZEY+yNft2NegA6Uz34ZMjkzYxUaLF37qitojBJbIcF71F6JwFRlpIPXmiWchftLa9XONg3KBaxQ==',
  'win32-x64': 'sha512-g/fa2hqcU/+Qd3NMaY/8i+AoX6HQt3zBcj+V/Ot9icr5TN4PmOmuy6YhVNFLHb2IniLIrBA+gZFqonUe0aYLxg==',
  'win32-arm64': 'sha512-+yn6RI0BeeiG+xbX8OkxSgRAiKIJZhO1foPNG8wUfjIPYaaxYsm8GL3TV7KyuBgGrjPYR1+pFzXaHY2bLsF37g==',
};

/** Downloads the pinned Claude CLI build for this platform, once per run, and returns its binary. */
async function installClaudeCli(): Promise<string> {
  // A musl system, such as an Alpine container, reports no glibc version and needs the musl build.
  const musl = process.platform === 'linux' && !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
  const platform = `${process.platform}-${process.arch}${musl ? '-musl' : ''}`;
  const integrity = CLAUDE_CLI_BUILDS[platform];
  if (!integrity) throw new Error(`no pinned Claude CLI build for ${platform}`);
  const name = `claude-code-${platform}`;
  const dir = await installPinned({ url: `https://registry.npmjs.org/@anthropic-ai/${name}/-/${name}-${CLAUDE_CLI_VERSION}.tgz`, integrity });
  return join(dir, 'package', process.platform === 'win32' ? 'claude.exe' : 'claude');
}

export function buildAnthropicAuth(oauthToken: string, apiKey: string): AnthropicAuth {
  if (oauthToken) return { kind: 'oauth', token: oauthToken };
  if (apiKey) return { kind: 'apiKey', key: apiKey };
  throw new Error('Either claude_code_oauth_token or anthropic_api_key must be provided');
}

/**
 * Parse a single JSON-stream line emitted by Claude CLI. Returns the text
 * delta (if any) plus the full parsed event when it is a terminal `result`
 * event, so callers can both stream text and capture the exit reason
 * (`is_error`, `subtype`, error text) for diagnostics on failure.
 * `--include-partial-messages` wraps each API stream event in a `stream_event` line.
 * `assistantRefusal` is set on every assistant message: the refusal reason, or null when it did not end on `stop_reason: "refusal"`.
 */
function processJsonLine(line: string): {
  text: string; replace: boolean; resultEvent: unknown; assistantRefusal?: string | null; toolUses?: { id: string; tool: string; file?: string }[]; toolResults?: string[];
  limits?: LimitUsage[];
} {
  try {
    const event = JSON.parse(line);
    const streamed = event.type === 'stream_event' ? event.event : event;
    if (streamed?.type === 'content_block_delta' && streamed.delta?.type === 'text_delta' && streamed.delta.text) {
      return { text: streamed.delta.text, replace: false, resultEvent: null };
    }
    const blocks: { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown }[] = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'assistant') {
      const refused = event.message?.stop_reason === 'refusal';
      const toolUses = blocks.filter(b => b.type === 'tool_use').map(b => {
        const file = fileReadBy(String(b.name), b.input);
        return { id: String(b.id), tool: String(b.name), ...(file && { file }) };
      });
      return { text: '', replace: false, resultEvent: null, assistantRefusal: refused ? refusalReason(event.message.stop_details) : null, toolUses };
    }
    if (event.type === 'user') {
      return { text: '', replace: false, resultEvent: null, toolResults: blocks.filter(b => b.type === 'tool_result').map(b => String(b.tool_use_id)) };
    }
    if (event.type === 'rate_limit_event') {
      return { text: '', replace: false, resultEvent: null, limits: readClaudeLimits(event.rate_limit_info) };
    }
    if (event.type === 'result') {
      const text = typeof event.result === 'string' ? event.result : '';
      return { text, replace: text.length > 0, resultEvent: event };
    }
  } catch {
    // Non-JSON line (e.g. verbose debug output) — skip silently
  }
  return { text: '', replace: false, resultEvent: null };
}

/** Returns the file a `Read` or `read_file` call reads, as the call names it. A file in a related repo gets `owner/name:` in front. */
function fileReadBy(tool: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { file_path: filePath, path, repo } = input as Record<string, unknown>;
  if (tool === 'Read' && typeof filePath === 'string') return filePath;
  if (tool === 'mcp__manki__read_file' && typeof path === 'string') return typeof repo === 'string' && repo ? `${repo}:${path}` : path;
  return undefined;
}

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
};

/**
 * Reads the windows of a `rate_limit_event`'s `rate_limit_info`. `unifiedWindows` holds every window the account has,
 * each with a `utilization` from 0 to 1. Without it, only the top-level window is read, and only when it has a `utilization`.
 */
export function readClaudeLimits(info: unknown): LimitUsage[] {
  if (!info || typeof info !== 'object') return [];
  const { unifiedWindows, rateLimitType, utilization, resetsAt } = info as Record<string, unknown>;
  const windows: [string, unknown][] = unifiedWindows && typeof unifiedWindows === 'object'
    ? Object.entries(unifiedWindows)
    : typeof rateLimitType === 'string' ? [[rateLimitType, { utilization, resetsAt }]] : [];
  return windows.flatMap(([name, w]) => {
    const used = (w as { utilization?: unknown } | null)?.utilization;
    if (typeof used !== 'number' || !Number.isFinite(used)) return [];
    const resets = (w as { resetsAt?: unknown }).resetsAt;
    return [{
      account: 'Claude subscription',
      window: CLAUDE_WINDOWS[name] ?? name.replace(/_/g, ' '),
      usedPercent: Math.round(used * 100),
      ...(typeof resets === 'number' && Number.isFinite(resets) && { resetsAt: resets }),
    }];
  });
}

/** Names a refusal by its `stop_details.category`, which is `null` when no named policy area applies. */
function refusalReason(stopDetails: unknown): string {
  const category = (stopDetails as { category?: unknown } | null | undefined)?.category;
  return typeof category === 'string' && category ? `refusal (${category})` : 'refusal';
}



/**
 * Lift the `usage` block from a Claude CLI `result` event into the canonical
 * `LLMUsage` shape. Returns `ZERO_USAGE` when the event is missing or
 * malformed so callers can always rely on numeric counters.
 */
export function extractAnthropicCLIUsage(resultEvent: unknown): LLMUsage {
  if (!resultEvent || typeof resultEvent !== 'object') return { ...ZERO_USAGE };
  const usage = (resultEvent as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return { ...ZERO_USAGE };
  return readAnthropicUsage(usage as Record<string, unknown>);
}

/** Maps an Anthropic `usage` block to `LLMUsage`. Input counts cache writes and reads, which `input_tokens` leaves out. */
function readAnthropicUsage(u: Record<string, unknown>): LLMUsage {
  const cacheReadTokens = readCount(u.cache_read_input_tokens);
  const cacheWriteTokens = readCount(u.cache_creation_input_tokens);
  return {
    inputTokens: readCount(u.input_tokens) + cacheWriteTokens + cacheReadTokens,
    outputTokens: readCount(u.output_tokens),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: 0,
  };
}

// The 4.5 generation rejects adaptive thinking and needs `budget_tokens`. Every later model rejects `budget_tokens`.
const BUDGET_THINKING_MODELS = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
// `xhigh` arrived with Opus 4.7, so the 4.5 and 4.6 generations reject it.
const NO_XHIGH_MODELS = [...BUDGET_THINKING_MODELS, 'claude-opus-4-6', 'claude-sonnet-4-6'];

function isModelOf(model: string, ids: readonly string[]): boolean {
  return ids.some((id) => model === id || model.startsWith(`${id}-`));
}

function usesBudgetThinking(model: string): boolean {
  return isModelOf(model, BUDGET_THINKING_MODELS);
}

/** Returns `effort` as `model` takes it. A model without `xhigh` gets `high`, so the call never costs more than asked. */
function claudeEffort(model: string, effort: NonNullable<SendMessageOptions['effort']>): NonNullable<SendMessageOptions['effort']> {
  return effort === 'xhigh' && isModelOf(model, NO_XHIGH_MODELS) ? 'high' : effort;
}

const MAX_TOKENS = 16384;
const THINKING_MAX_TOKENS = 32768;

const OAUTH_ERROR_HINT =
  'Check the claude_code_oauth_token secret (create a new token with `claude setup-token`) or use anthropic_api_key instead.';

// Error texts that point at the credential rather than at the request, such as a revoked token or an organization that disabled subscription access.
const AUTH_ERROR_PATTERN = /\b(authenticat\w*|log ?in|credentials?|token|subscription|organization|unauthori[sz]ed|forbidden|401|403)\b/i;

function readResultError(resultEvent: unknown): string | null {
  if (!resultEvent || typeof resultEvent !== 'object') return null;
  const event = resultEvent as { is_error?: unknown; result?: unknown };
  return event.is_error === true && typeof event.result === 'string' && event.result ? event.result : null;
}

/** Maps an SDK error for a used-up rate limit (429, `rate_limit_error`) or an overload (529, `overloaded_error`) to a `QuotaError`. */
function anthropicQuotaError(error: unknown): QuotaError | undefined {
  const { status, type, message } = (error ?? {}) as { status?: unknown; type?: unknown; message?: unknown };
  const text = `Anthropic API error: ${sanitizeLogOutput(String(message ?? '')).slice(0, 500)}`;
  if (status === 429 || type === 'rate_limit_error') return new QuotaError(text, 'Anthropic API rate limit reached', undefined, 'key');
  if (status === 529 || type === 'overloaded_error') return new QuotaError(text, 'Anthropic API is overloaded');
  return undefined;
}

// The names Claude Code gives the tools of Manki's tool server.
const MANKI_TOOLS = ['mcp__manki__git_history', 'mcp__manki__ast_grep', 'mcp__manki__repo_info', 'mcp__manki__read_file', 'mcp__manki__grep', 'mcp__manki__glob'];

/**
 * Writes the MCP config that starts Manki's tool server into `dir` and returns its path. The server gets the CLI's
 * environment without the Claude credential, which it does not need, and the GitHub API URL `repo_info` reads.
 */
export function writeToolServerConfig(dir: string, { command, args }: MankiCommand): string {
  const path = join(dir, 'mcp.json');
  const apiUrl = process.env.GITHUB_API_URL;
  const config = { mcpServers: { manki: { type: 'stdio', command, args, env: { CLAUDE_CODE_OAUTH_TOKEN: '', ...(apiUrl && { GITHUB_API_URL: apiUrl }) } } } };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

// Turns past the step budget, so the model can still answer after the hook refuses a call.
const EXTRA_TURNS = 5;

/** The Manki parts a call with repository tools starts: the tool server from its MCP config, and the step hook. */
export interface ClaudeToolSetup {
  mcpConfigPath: string;
  stepHook: MankiCommand;
}

function shellCommand({ command, args }: MankiCommand): string {
  return [command, ...args].map(arg => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * Returns the Claude CLI arguments for one call. Without `repoTools` the CLI gets no tools at all. With them it gets
 * Read, Grep and Glob confined to `repoTools.root`, Manki's tool server, the hook that counts the tool steps, and no
 * other tool.
 */
export function claudeCliArgs(model: string, systemPromptPath: string, { effort, repoTools }: SendMessageOptions = {}, tools?: ClaudeToolSetup): string[] {
  // -p enables pipe mode — reads prompt from stdin when no argument follows
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    // No MCP servers and no settings files beyond `--mcp-config` and `--settings`: only the environment configures the CLI.
    '--strict-mcp-config',
    '--setting-sources', '',
    // Replaces Claude Code's own agentic system prompt, which otherwise frames every stage.
    '--system-prompt-file', systemPromptPath,
    `--model=${model}`,
  ];
  if (repoTools && tools) {
    const hooks = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: shellCommand(tools.stepHook) }] }] };
    args.push(
      // `--restricted` confines the file tools to the working directories, which are an empty directory and `--add-dir`,
      // whatever the permission rules say. `dontAsk` refuses every call nothing allowed.
      '--restricted',
      '--permission-mode', 'dontAsk',
      '--tools', 'Read,Grep,Glob',
      '--add-dir', repoTools.root,
      '--mcp-config', tools.mcpConfigPath,
      '--allowedTools', MANKI_TOOLS.join(','),
      '--settings', JSON.stringify({ hooks }),
      '--max-turns', String(repoTools.steps + EXTRA_TURNS),
    );
  } else {
    // Without tools the reply is a single turn. With them, the CLI's `result` keeps only the last message.
    args.push('--tools', '');
  }
  if (effort) args.push('--effort', claudeEffort(model, effort));
  return args;
}

export interface AnthropicClientOptions {
  auth: AnthropicAuth;
  model: string;
}

export class AnthropicClient implements LLMClient {
  private readonly auth: AnthropicAuth;
  private anthropic?: Anthropic;
  private readonly model: string;
  private cachedCLIPath?: string;

  constructor(options: AnthropicClientOptions) {
    this.auth = options.auth;
    this.model = options.model;

    if (this.auth.kind === 'apiKey') {
      this.anthropic = new Anthropic({ apiKey: this.auth.key });
    }
  }

  async sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (this.auth.kind === 'oauth') {
      return this.sendViaOAuth(systemPrompt, userMessage, options);
    }
    return this.sendViaAPI(systemPrompt, userMessage, options);
  }

  get repoTools(): boolean {
    return this.auth.kind === 'oauth';
  }

  sentEffort(effort: NonNullable<SendMessageOptions['effort']>): NonNullable<SendMessageOptions['effort']> {
    // Over the API, a budget thinking model gets a thinking budget of its own for every tier.
    return this.auth.kind === 'apiKey' && usesBudgetThinking(this.model) ? effort : claudeEffort(this.model, effort);
  }

  async warmupCLI(): Promise<void> {
    if (this.auth.kind !== 'oauth') return;
    await this.ensureCLI();
  }

  private async ensureCLI(): Promise<string> {
    if (this.cachedCLIPath) {
      return this.cachedCLIPath;
    }

    try {
      const { stdout } = await execFileAsync('which', ['claude']);
      this.cachedCLIPath = stdout.trim();
      return this.cachedCLIPath;
    } catch {
      core.info(`Claude CLI not found, installing version ${CLAUDE_CLI_VERSION}...`);
      const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);
      try {
        // One slow or dropped download must not cost the call, so the install is tried once more.
        this.cachedCLIPath = await installClaudeCli().catch((error: unknown) => {
          core.info(`Claude CLI install failed (${reasonOf(error)}), trying again`);
          return installClaudeCli();
        });
      } catch (error) {
        throw new Error(`Failed to install Claude CLI: ${reasonOf(error)}`);
      }
      return this.cachedCLIPath;
    }
  }

  private async sendViaOAuth(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    const cliPath = await this.ensureCLI();
    // A file keeps a long system prompt clear of the per-argument size limit.
    return withPromptDir(async (promptDir) => {
      const systemPromptPath = join(promptDir, 'system.md');
      const repoTools = options?.repoTools;
      const fullPrompt = repoTools ? `${systemPrompt}\n\n${repoToolsPrompt(repoTools, 'Read, Grep and Glob')}` : systemPrompt;
      writeFileSync(systemPromptPath, fullPrompt, { mode: 0o600 });
      let tools: ClaudeToolSetup | undefined;
      if (repoTools) {
        const stepsDir = join(promptDir, 'steps');
        mkdirSync(stepsDir);
        const readsFile = relatedReadsFile(promptDir);
        tools = { mcpConfigPath: writeToolServerConfig(promptDir, toolServerCommand(repoTools.root, { related: repoTools.related, readsFile })), stepHook: stepHookCommand(stepsDir, repoTools.steps) };
      }
      const args = claudeCliArgs(this.model, systemPromptPath, options, tools);
      const reads = () => (repoTools?.related ? readRelatedReads(relatedReadsFile(promptDir)) : undefined);
      const response = await this.runOAuthCli(cliPath, args, fullPrompt.length + userMessage.length, userMessage, options)
        .catch((error: unknown) => { throw carryReadings(error, { relatedReads: reads() }); });
      const relatedReads = reads();
      return relatedReads ? { ...response, relatedReads } : response;
    });
  }

  private async runOAuthCli(cliPath: string, args: string[], promptChars: number, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    const oauthToken = this.auth.kind === 'oauth' ? this.auth.token : undefined;
    const startTime = Date.now();
    const model = this.model;

    let output = '';
    let replyTail = '';
    let jsonBuffer = '';
    let lastResultEvent: unknown = null;
    let refusal: string | undefined;
    const toolSteps: ToolStep[] = [];
    const toolStarts = new Map<string, { tool: string; start: number }>();
    const filesRead = new Set<string>();
    const root = options?.repoTools?.root;
    // The CLI reports the limits after each request, so a later reading of a window replaces an earlier one.
    const limits = new Map<string, LimitUsage>();
    // A failed run keeps the readings too, since a used-up limit is when they matter most.
    const readings = () => ({ ...(limits.size > 0 && { limits: [...limits.values()] }), ...(filesRead.size > 0 && { filesRead: [...filesRead] }) });
    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      const delta = processJsonLine(line);
      for (const limit of delta.limits ?? []) limits.set(limit.window, limit);
      for (const { id, tool, file } of delta.toolUses ?? []) {
        toolStarts.set(id, { tool, start: Date.now() });
        if (file) filesRead.add(root && isAbsolute(file) ? relative(root, file) : file);
      }
      for (const id of delta.toolResults ?? []) {
        const started = toolStarts.get(id);
        if (started) toolSteps.push({ tool: started.tool, durationMs: Date.now() - started.start });
      }
      if (delta.resultEvent !== null) lastResultEvent = delta.resultEvent;
      if (!delta.replace) replyTail = appendReplyTail(replyTail, delta.text);
      if (delta.assistantRefusal !== undefined) refusal = delta.assistantRefusal ?? undefined;
      output = delta.replace ? delta.text : output + delta.text;
    };

    const { code, signal, stderr, lastStdoutChunk } = await runCli({
      label: 'Claude',
      cliPath,
      args,
      env: cliEnv('claude', {
        ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
        // The CLI defaults to the model's own limit, which lets a runaway reply run for many minutes.
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(THINKING_MAX_TOKENS),
      }, 'CLAUDE_CODE_OAUTH_TOKEN'),
      input: userMessage,
      hardTimeoutMs: options?.timeoutMs,
      signal: options?.signal,
      onStdout: (chunk) => {
        jsonBuffer += chunk;
        const lines = jsonBuffer.split('\n');
        jsonBuffer = lines.pop() ?? '';
        lines.forEach(consumeLine);
      },
    }).catch((error: unknown) => {
      warnReplyTail('Claude CLI', replyTail);
      throw carryReadings(error, readings());
    });
    consumeLine(jsonBuffer);
    const resultEvent = lastResultEvent as { stop_reason?: unknown; api_error?: unknown } | null;
    // A reply that reaches `CLAUDE_CODE_MAX_OUTPUT_TOKENS` fails the CLI run with `api_error: "max_output_tokens"`.
    const truncated = resultEvent?.stop_reason === 'max_tokens' || resultEvent?.api_error === 'max_output_tokens';
    const cliError = readResultError(lastResultEvent);
    // Only the last assistant message counts, and only on a failed run: the CLI can recover from a refused attempt.
    if (code === 0 && !cliError) refusal = undefined;
    if (resultEvent?.stop_reason === 'refusal') refusal ??= 'refusal';

    // The CLI can report a used-up subscription limit on a run that exits 0.
    const limitText = cliError ?? (code !== 0 ? stderr : '');
    const quota = matchQuotaText(limitText);
    if (quota) {
      const limit = quota.overloaded ? 'Claude is overloaded' : 'Claude subscription limit reached';
      const message = `${limit}: ${sanitizeLogOutput(limitText.slice(-500)).trim()}`;
      core.warning(message);
      throw carryReadings(new QuotaError(message, limit, quota.resetsAt, quota.overloaded ? undefined : 'token'), readings());
    }
    if ((lastResultEvent as { subtype?: unknown } | null)?.subtype === 'error_max_turns') {
      const message = 'Claude CLI used all its turns before it answered';
      core.warning(message);
      throw carryReadings(new Error(message), readings());
    }
    if ((code !== 0 && !truncated) || refusal) {
      const msg = buildExitDiagnostics({
        exitCode: code,
        signal,
        stderr,
        lastStdoutChunk,
        model,
        effort: options?.effort,
        promptChars,
        elapsedMs: Date.now() - startTime,
        resultEvent: lastResultEvent,
      });
      const hint = cliError && AUTH_ERROR_PATTERN.test(cliError) ? ` ${OAUTH_ERROR_HINT}` : '';
      const lead = cliError ? `Claude CLI error: ${sanitizeLogOutput(cliError)}.${hint} ` : '';
      core.warning(`${lead}Claude CLI failed (${msg})`);
      warnReplyTail('Claude CLI', replyTail);
      const message = `${lead}Claude CLI invocation failed (${msg})`;
      throw carryReadings(refusal ? new RefusalError(message, refusal) : new Error(message), readings());
    }
    if (truncated) {
      core.warning(`Claude CLI reply reached the ${THINKING_MAX_TOKENS}-token output limit (exit ${code})`);
      warnReplyTail('Claude CLI', replyTail);
    }
    const content = code === 0 ? output.trim() : '';
    core.debug(sanitizeLogOutput(content.slice(0, 200)));
    return {
      content,
      usage: extractAnthropicCLIUsage(lastResultEvent),
      latencyMs: Date.now() - startTime,
      model: this.model,
      truncated,
      ...(toolSteps.length > 0 && { toolSteps }),
      ...readings(),
    };
  }

  private async sendViaAPI(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (!this.anthropic) throw new Error('Anthropic client not initialized');

    const effort = options?.effort;
    const budgetThinking = usesBudgetThinking(this.model);
    const useThinking = effort !== undefined && !(budgetThinking && effort === 'low');
    const budgetMap: Record<string, number> = { medium: 5000, high: 10000, xhigh: 13000, max: 16000 };

    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: useThinking ? THINKING_MAX_TOKENS : MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    };

    if (useThinking && budgetThinking) {
      params.thinking = { type: 'enabled', budget_tokens: budgetMap[effort!] };
    } else if (useThinking) {
      params.thinking = { type: 'adaptive' };
      params.output_config = { effort: claudeEffort(this.model, effort!) };
    }

    const startTime = Date.now();
    // The SDK refuses non-streaming requests whose `max_tokens` could run past its 10 minute timeout.
    const anthropic = this.anthropic;
    let replyTail = '';
    const response = await callWithTimeout('Anthropic API', options, (signal) => {
      const stream = anthropic.messages.stream(params, signal ? { signal } : undefined);
      stream.on('text', (text) => { replyTail = appendReplyTail(replyTail, text); });
      return stream.finalMessage();
    }).catch((error: unknown) => {
      warnReplyTail('Anthropic API', replyTail);
      throw anthropicQuotaError(error) ?? error;
    });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const content = textBlocks.map((b) => 'text' in b ? b.text : '').join('\n');
    core.debug(sanitizeLogOutput(content.slice(0, 200)));
    if (response.stop_reason === 'max_tokens' || response.stop_reason === 'refusal') {
      core.warning(`Anthropic API reply ended on stop_reason ${response.stop_reason}`);
      warnReplyTail('Anthropic API', content);
    }
    if (response.stop_reason === 'refusal') {
      const reason = refusalReason(response.stop_details);
      const explanation = response.stop_details?.explanation;
      throw new RefusalError(`Claude API declined the request: ${reason}${explanation ? `. ${sanitizeLogOutput(explanation)}` : ''}`, reason);
    }

    const sdkUsage = (response as unknown as { usage?: Record<string, unknown> }).usage;
    const usage: LLMUsage = sdkUsage ? readAnthropicUsage(sdkUsage) : { ...ZERO_USAGE };

    return { content, usage, latencyMs: Date.now() - startTime, model: this.model, truncated: response.stop_reason === 'max_tokens' };
  }
}
