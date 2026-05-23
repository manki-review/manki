import { execFile, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { promisify } from 'util';

import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';

import { sanitizeLogOutput, STALE_TIMEOUT_MS, buildTimeoutDiagnostics, buildExitDiagnostics } from './cli-utils';
import { AnthropicAuth, LLMClient, LLMResponse, LLMUsage, readCount, SendMessageOptions, ZERO_USAGE } from './types';

// Re-export for backward compatibility with existing test imports.
export { sanitizeLogOutput, STALE_TIMEOUT_MS };

const execFileAsync = promisify(execFile);

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

let cliInstallPromise: Promise<string> | null = null;

export function resetCLIInstallPromise(): void {
  cliInstallPromise = null;
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
          await execFileAsync('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
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

    return new Promise((resolve, reject) => {
      // -p enables pipe mode — reads prompt from stdin when no argument follows
      const args = [
        '-p',
        '--verbose',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--model', this.model,
      ];

      if (options?.effort) {
        args.push('--effort', options.effort);
      }

      const child = spawn(cliPath, args, {
        env: {
          // process.env is spread intentionally — Claude CLI requires PATH, HOME, and other system vars.
          // CLAUDE_CODE_OAUTH_TOKEN is added conditionally. Secrets should be managed via GitHub Actions secret masking.
          ...process.env,
          ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let jsonBuffer = '';
      let stderr = '';
      let timedOut = false;
      let stale = false;
      let outputExceeded = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let staleKillTimer: NodeJS.Timeout | undefined;
      let outputKillTimer: NodeJS.Timeout | undefined;
      // Only set in the catch block below; clearTimeout(undefined) is a no-op on the normal path
      let stdinKillTimer: NodeJS.Timeout | undefined;
      let lastStdoutChunk = '';
      let lastResultEvent: unknown = null;
      let rawBytes = 0;

      const clearAllTimers = (): void => {
        clearTimeout(timer);
        clearTimeout(staleTimer);
        if (killTimer) clearTimeout(killTimer);
        if (staleKillTimer) clearTimeout(staleKillTimer);
        if (outputKillTimer) clearTimeout(outputKillTimer);
        if (stdinKillTimer) clearTimeout(stdinKillTimer);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        clearTimeout(staleTimer);
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
        killTimer.unref();
      }, 1200000);
      timer.unref();

      const handleStale = (): void => {
        if (outputExceeded || timedOut) return;
        stale = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        staleKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
        staleKillTimer.unref();
      };
      let staleTimer = setTimeout(handleStale, STALE_TIMEOUT_MS);
      staleTimer.unref();

      const MAX_OUTPUT = 50 * 1024 * 1024; // 50 MB
      const killOnOutputExceeded = (): void => {
        if (outputExceeded) return;
        outputExceeded = true;
        clearTimeout(timer);
        clearTimeout(staleTimer);
        child.kill('SIGTERM');
        outputKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
        outputKillTimer.unref();
      };
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', (data: Buffer) => {
        if (outputExceeded || settled || stale) return;
        clearTimeout(staleTimer);
        staleTimer = setTimeout(handleStale, STALE_TIMEOUT_MS);
        staleTimer.unref();

        rawBytes += data.length;
        if (rawBytes + stderr.length > MAX_OUTPUT) { killOnOutputExceeded(); return; }

        // Decode once — avoids double decoding and multi-byte corruption at chunk boundaries
        const chunk = stdoutDecoder.write(data);
        if (chunk.length >= 500) {
          lastStdoutChunk = chunk.slice(-500);
        } else {
          lastStdoutChunk = (lastStdoutChunk + chunk).slice(-500);
        }
        jsonBuffer += chunk;
        const lines = jsonBuffer.split('\n');
        jsonBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const delta = processJsonLine(line);
          if (delta.resultEvent !== null) lastResultEvent = delta.resultEvent;
          if (delta.replace) {
            output = delta.text;
          } else {
            output += delta.text;
          }
        }
      });
      child.stderr.on('data', (data: Buffer) => {
        if (outputExceeded || settled) return;
        stderr += stderrDecoder.write(data);
        if (rawBytes + stderr.length > MAX_OUTPUT) killOnOutputExceeded();
      });

      child.on('close', (code, signal) => {
        clearAllTimers();
        if (settled) return;
        settled = true;
        // Flush any remaining bytes from the decoders
        const remaining = stdoutDecoder.end();
        if (remaining) {
          jsonBuffer += remaining;
          if (jsonBuffer.trim()) {
            const delta = processJsonLine(jsonBuffer);
            if (delta.resultEvent !== null) lastResultEvent = delta.resultEvent;
            if (delta.replace) {
              output = delta.text;
            } else {
              output += delta.text;
            }
          }
        }
        stderr += stderrDecoder.end();
        if (stale) {
          const details = buildTimeoutDiagnostics(lastStdoutChunk, stderr);
          const msg = `Claude CLI stale — no output for ${STALE_TIMEOUT_MS / 1000}s${details ? `. ${details}` : ''}`;
          core.warning(msg);
          reject(new Error(msg));
          return;
        }
        if (timedOut) {
          const details = buildTimeoutDiagnostics(lastStdoutChunk, stderr);
          const msg = `Claude CLI timed out after 1200s${details ? `. ${details}` : ''}`;
          core.warning(msg);
          reject(new Error(msg));
          return;
        }
        if (outputExceeded) {
          reject(new Error('Claude CLI output exceeded 50MB limit'));
          return;
        }
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
          core.warning(`Claude CLI failed (${msg})`);
          reject(new Error(`Claude CLI invocation failed (${msg})`));
          return;
        }
        const content = output.trim();
        core.debug(sanitizeLogOutput(content.slice(0, 200)));
        resolve({
          content,
          usage: extractAnthropicCLIUsage(lastResultEvent),
          latencyMs: Date.now() - startTime,
        });
      });

      child.on('error', (error) => {
        clearAllTimers();
        if (settled) return;
        settled = true;
        reject(new Error(`Claude CLI spawn failed: ${error.message}`));
      });

      child.stdin.on('error', (err) => {
        core.warning(`stdin write error: ${err.message}`);
      });

      // Node.js stream.write() buffers data internally — it never does partial writes.
      // When write() returns false, the data is still fully queued; it just means the
      // internal buffer exceeded highWaterMark. We wait for 'drain' before calling end()
      // to avoid unnecessary buffering pressure.
      try {
        const canWrite = child.stdin.write(fullPrompt);
        if (!canWrite) {
          // The drain handler stays registered until fired or GC. The `settled` guard
          // ensures it won't call end() after the process has already exited.
          child.stdin.once('drain', () => {
            if (!settled) {
              try { child.stdin.end(); } catch { /* stream already destroyed */ }
            }
          });
        } else {
          try { child.stdin.end(); } catch { /* stream may be destroyed */ }
        }
      } catch (err) {
        core.warning(`stdin write failed: ${(err as Error).message}`);
        if (!settled) {
          settled = true;
          clearAllTimers();
          reject(new Error(`stdin write failed: ${(err as Error).message}`));
        }
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        // Assigned after clearAllTimers — the close handler's clearAllTimers will clear this new timer
        stdinKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
        stdinKillTimer.unref();
      }
    });
  }

  private async sendViaAPI(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (!this.anthropic) throw new Error('Anthropic client not initialized');

    const useThinking = options?.effort && options.effort !== 'low';
    const budgetMap: Record<string, number> = { medium: 5000, high: 10000, max: 16000 };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {
      model: this.model,
      max_tokens: useThinking ? 32768 : 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    };

    if (useThinking) {
      params.thinking = { type: 'enabled', budget_tokens: budgetMap[options!.effort!] };
    }

    const startTime = Date.now();
    const response = await this.anthropic.messages.create(params);

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

    return { content, usage, latencyMs: Date.now() - startTime };
  }
}
