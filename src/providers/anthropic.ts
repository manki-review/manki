import { execFile } from 'child_process';
import { promisify } from 'util';

import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';

import { sanitizeLogOutput, STALE_TIMEOUT_MS, buildExitDiagnostics, runCli } from './cli-utils';
import { AnthropicAuth, LLMClient, LLMResponse, LLMUsage, readCount, SendMessageOptions, ZERO_USAGE } from './types';

// Re-export for backward compatibility with existing test imports.
export { sanitizeLogOutput, STALE_TIMEOUT_MS };

const execFileAsync = promisify(execFile);

// Pinned because a future release makes `--bare` the default for `-p`, and bare mode never reads
// `CLAUDE_CODE_OAUTH_TOKEN`. Keep this in sync with the install step in `.github/workflows/manki.yml`.
export const CLAUDE_CLI_VERSION = '2.1.318';

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
 */
function processJsonLine(line: string): { text: string; replace: boolean; resultEvent: unknown } {
  try {
    const event = JSON.parse(line);
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      return { text: event.delta.text, replace: false, resultEvent: null };
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



/**
 * Lift the `usage` block from a Claude CLI `result` event into the canonical
 * `LLMUsage` shape. Returns `ZERO_USAGE` when the event is missing or
 * malformed so callers can always rely on numeric counters.
 */
export function extractAnthropicCLIUsage(resultEvent: unknown): LLMUsage {
  if (!resultEvent || typeof resultEvent !== 'object') return { ...ZERO_USAGE };
  const usage = (resultEvent as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return { ...ZERO_USAGE };
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: readCount(u.input_tokens),
    outputTokens: readCount(u.output_tokens),
    cachedTokens: readCount(u.cache_read_input_tokens),
    reasoningTokens: 0,
  };
}

// The 4.5 generation rejects adaptive thinking and needs `budget_tokens`. Every later model rejects `budget_tokens`.
const BUDGET_THINKING_MODELS = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];

function usesBudgetThinking(model: string): boolean {
  return BUDGET_THINKING_MODELS.some((id) => model === id || model.startsWith(`${id}-`));
}

let cliInstallPromise: Promise<string> | null = null;

export function resetCLIInstallPromise(): void {
  cliInstallPromise = null;
}

const OAUTH_ERROR_HINT =
  'Check the claude_code_oauth_token secret (create a new token with `claude setup-token`) or use anthropic_api_key instead.';

// Error texts that point at the credential rather than at the request, such as a revoked token or an organization that disabled subscription access.
const AUTH_ERROR_PATTERN = /\b(authenticat\w*|log ?in|credentials?|token|subscription|organization|unauthori[sz]ed|forbidden|401|403)\b/i;

function readResultError(resultEvent: unknown): string | null {
  if (!resultEvent || typeof resultEvent !== 'object') return null;
  const event = resultEvent as { is_error?: unknown; result?: unknown };
  return event.is_error === true && typeof event.result === 'string' && event.result ? event.result : null;
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
      if (!cliInstallPromise) {
        cliInstallPromise = (async () => {
          core.info('Claude CLI not found, installing via npm...');
          // No `--ignore-scripts`: the package's postinstall puts the native binary in place.
          await execFileAsync('npm', ['install', '-g', `@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}`], {
            timeout: 120000,
          });
          try {
            const { stdout } = await execFileAsync('which', ['claude']);
            return stdout.trim();
          } catch {
            throw new Error('Failed to install Claude CLI');
          }
        })();
      }
      try {
        this.cachedCLIPath = await cliInstallPromise;
        return this.cachedCLIPath;
      } catch (error) {
        cliInstallPromise = null;
        throw error;
      }
    }
  }

  private async sendViaOAuth(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
    const cliPath = await this.ensureCLI();
    const oauthToken = this.auth.kind === 'oauth' ? this.auth.token : undefined;
    const startTime = Date.now();
    const model = this.model;

    // -p enables pipe mode — reads prompt from stdin when no argument follows
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      // Without tools the reply is a single turn. With them, a reviewer could write its JSON in one turn and end on a prose summary, and the CLI's `result` keeps only that last message.
      '--tools', '',
      // No MCP servers and no settings files: only the environment configures the CLI.
      '--strict-mcp-config',
      '--setting-sources', '',
      '--model', this.model,
    ];

    if (options?.effort) {
      args.push('--effort', options.effort);
    }

    let output = '';
    let jsonBuffer = '';
    let lastResultEvent: unknown = null;
    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      const delta = processJsonLine(line);
      if (delta.resultEvent !== null) lastResultEvent = delta.resultEvent;
      output = delta.replace ? delta.text : output + delta.text;
    };

    const { code, signal, stderr, lastStdoutChunk } = await runCli({
      label: 'Claude',
      cliPath,
      args,
      env: {
        // process.env is spread intentionally — Claude CLI requires PATH, HOME, and other system vars.
        // CLAUDE_CODE_OAUTH_TOKEN is added conditionally. Secrets should be managed via GitHub Actions secret masking.
        ...process.env,
        ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
      },
      input: fullPrompt,
      onStdout: (chunk) => {
        jsonBuffer += chunk;
        const lines = jsonBuffer.split('\n');
        jsonBuffer = lines.pop() ?? '';
        lines.forEach(consumeLine);
      },
    });
    consumeLine(jsonBuffer);

    if (code !== 0) {
      const msg = buildExitDiagnostics({
        exitCode: code,
        signal,
        stderr,
        lastStdoutChunk,
        model,
        effort: options?.effort,
        promptChars: fullPrompt.length,
        elapsedMs: Date.now() - startTime,
        resultEvent: lastResultEvent,
      });
      const cliError = readResultError(lastResultEvent);
      const hint = cliError && AUTH_ERROR_PATTERN.test(cliError) ? ` ${OAUTH_ERROR_HINT}` : '';
      const lead = cliError ? `Claude CLI error: ${sanitizeLogOutput(cliError)}.${hint} ` : '';
      core.warning(`${lead}Claude CLI failed (${msg})`);
      throw new Error(`${lead}Claude CLI invocation failed (${msg})`);
    }
    const content = output.trim();
    core.debug(sanitizeLogOutput(content.slice(0, 200)));
    return {
      content,
      usage: extractAnthropicCLIUsage(lastResultEvent),
      latencyMs: Date.now() - startTime,
      truncated: (lastResultEvent as { stop_reason?: unknown } | null)?.stop_reason === 'max_tokens',
    };
  }

  private async sendViaAPI(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (!this.anthropic) throw new Error('Anthropic client not initialized');

    const effort = options?.effort;
    const budgetThinking = usesBudgetThinking(this.model);
    const useThinking = effort !== undefined && !(budgetThinking && effort === 'low');
    const budgetMap: Record<string, number> = { medium: 5000, high: 10000, max: 16000 };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {
      model: this.model,
      max_tokens: useThinking ? 32768 : 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    };

    if (useThinking && budgetThinking) {
      params.thinking = { type: 'enabled', budget_tokens: budgetMap[effort!] };
    } else if (useThinking) {
      params.thinking = { type: 'adaptive' };
      params.output_config = { effort };
    }

    const startTime = Date.now();
    // The SDK refuses non-streaming requests whose `max_tokens` could run past its 10 minute timeout.
    const response = await this.anthropic.messages.stream(params).finalMessage();

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const content = textBlocks.map((b) => 'text' in b ? b.text : '').join('\n');
    core.debug(sanitizeLogOutput(content.slice(0, 200)));

    const sdkUsage = (response as unknown as { usage?: Record<string, unknown> }).usage;
    const usage: LLMUsage = sdkUsage
      ? {
          inputTokens: readCount(sdkUsage.input_tokens),
          outputTokens: readCount(sdkUsage.output_tokens),
          cachedTokens: readCount(sdkUsage.cache_read_input_tokens),
          reasoningTokens: 0,
        }
      : { ...ZERO_USAGE };

    return { content, usage, latencyMs: Date.now() - startTime, truncated: response.stop_reason === 'max_tokens' };
  }
}
