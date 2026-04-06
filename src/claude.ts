import { execFile, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { promisify } from 'util';

import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';

const execFileAsync = promisify(execFile);

export const STALE_TIMEOUT_MS = 90_000;

/** Strip GitHub Actions workflow commands to prevent injection when logging CLI output. */
export function sanitizeLogOutput(text: string): string {
  // Matches any line segment starting with :: followed by a letter — covers all workflow commands
  // regardless of parameter format (e.g. ::error file=foo.ts,line=5::message)
  return text.replace(/::[a-z].*$/gim, '[redacted-workflow-cmd]');
}

/** Parse a single JSON-stream line emitted by Claude CLI and return a text delta or final result. */
function processJsonLine(line: string): { text: string; replace: boolean } {
  try {
    const event = JSON.parse(line);
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      return { text: event.delta.text, replace: false };
    }
    if (event.type === 'result' && typeof event.result === 'string') {
      return { text: event.result, replace: true };
    }
  } catch {
    // Non-JSON line (e.g. verbose debug output) — skip silently
  }
  return { text: '', replace: false };
}

/** Build diagnostic snippets for timeout/stale error messages. */
function buildTimeoutDiagnostics(lastStdoutChunk: string, stderrText: string): { details: string; stdoutSnippet: string; stderrSnippet: string } {
  const stdoutSnippet = sanitizeLogOutput(lastStdoutChunk.slice(-500));
  const stderrSnippet = sanitizeLogOutput(stderrText.slice(0, 500));
  const parts: string[] = [];
  if (stdoutSnippet) parts.push(`Last stdout: ${stdoutSnippet}`);
  if (stderrSnippet) parts.push(`stderr: ${stderrSnippet}`);
  return { details: parts.join('. '), stdoutSnippet, stderrSnippet };
}

let cliInstallPromise: Promise<string> | null = null;

export function resetCLIInstallPromise(): void {
  cliInstallPromise = null;
}

export interface ClaudeClientOptions {
  oauthToken?: string;
  apiKey?: string;
  model: string;
}

export interface ClaudeResponse {
  content: string;
}

export interface SendMessageOptions {
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export class ClaudeClient {
  private oauthToken?: string;
  private apiKey?: string;
  private anthropic?: Anthropic;
  private model: string;
  private cachedCLIPath?: string;

  constructor(options: ClaudeClientOptions) {
    this.oauthToken = options.oauthToken;
    this.apiKey = options.apiKey;
    this.model = options.model;

    if (!this.oauthToken && !this.apiKey) {
      throw new Error('Either claude_code_oauth_token or anthropic_api_key must be provided');
    }

    if (this.apiKey) {
      this.anthropic = new Anthropic({ apiKey: this.apiKey });
    }
  }

  async sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<ClaudeResponse> {
    if (this.oauthToken) {
      return this.sendViaOAuth(systemPrompt, userMessage, options);
    }
    return this.sendViaAPI(systemPrompt, userMessage, options);
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

  private async sendViaOAuth(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<ClaudeResponse> {
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
    const cliPath = await this.ensureCLI();

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
          ...(this.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: this.oauthToken } : {}),
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
      }, 600000);
      timer.unref();

      const handleStale = (): void => {
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
        child.kill('SIGTERM');
        outputKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
        outputKillTimer.unref();
      };
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', (data: Buffer) => {
        if (outputExceeded || settled) return;
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
            if (delta.replace) {
              output = delta.text;
            } else {
              output += delta.text;
            }
          }
        }
        stderr += stderrDecoder.end();
        if (stale) {
          const { details } = buildTimeoutDiagnostics(lastStdoutChunk, stderr);
          const msg = `Claude CLI stale — no output for ${STALE_TIMEOUT_MS / 1000}s${details ? `. ${details}` : ''}`;
          core.warning(msg);
          reject(new Error(msg));
          return;
        }
        if (timedOut) {
          const { details } = buildTimeoutDiagnostics(lastStdoutChunk, stderr);
          const msg = `Claude CLI timed out after 600s${details ? `. ${details}` : ''}`;
          core.warning(msg);
          reject(new Error(msg));
          return;
        }
        if (outputExceeded) {
          reject(new Error('Claude CLI output exceeded 50MB limit'));
          return;
        }
        if (code !== 0) {
          const msg = `exit ${code}${signal ? `, signal ${signal}` : ''}: ${stderr.slice(0, 500)}`;
          core.warning(`Claude CLI failed (${msg})`);
          reject(new Error(`Claude CLI invocation failed (${msg})`));
          return;
        }
        const content = output.trim();
        core.debug(sanitizeLogOutput(content.slice(0, 200)));
        resolve({ content });
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

  private async sendViaAPI(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<ClaudeResponse> {
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

    const response = await this.anthropic.messages.create(params);

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const content = textBlocks.map((b) => 'text' in b ? b.text : '').join('\n');
    core.debug(sanitizeLogOutput(content.slice(0, 200)));

    return { content };
  }
}
