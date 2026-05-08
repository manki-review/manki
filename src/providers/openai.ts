import { execFile, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { promisify } from 'util';

import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import * as core from '@actions/core';

import { LLMClient, LLMResponse, OpenAIAuth, SendMessageOptions } from './types';

const execFileAsync = promisify(execFile);

export const STALE_TIMEOUT_MS = 90_000;

export function buildOpenAIAuth(oauthToken: string, apiKey: string): OpenAIAuth {
  if (oauthToken) return { kind: 'oauth', token: oauthToken };
  if (apiKey) return { kind: 'apiKey', key: apiKey };
  throw new Error('Either openai_oauth_token or openai_api_key must be provided');
}

/** Strip GitHub Actions workflow commands to prevent injection when logging CLI output. */
export function sanitizeLogOutput(text: string): string {
  return text.replace(/^::[a-z].*$/gim, '[redacted-workflow-cmd]');
}

/**
 * o-series reasoning models (o1, o3, o4, ...) accept the `reasoning_effort`
 * parameter on the chat completions API; GPT-family models (gpt-4o, gpt-4.1,
 * gpt-5, ...) do not and will reject the field.
 */
export function isReasoningModel(model: string): boolean {
  return /^o\d/i.test(model);
}

/**
 * Map manki's effort tiers (`low|medium|high|max`) to the values the OpenAI
 * stack accepts. Both the chat completions API and the Codex CLI cap reasoning
 * effort at `'high'`, so manki's `'max'` collapses to `'high'` on both paths.
 */
export function resolveCLIEffort(effort: string): 'low' | 'medium' | 'high' {
  const map: Record<string, 'low' | 'medium' | 'high'> = {
    low: 'low', medium: 'medium', high: 'high', max: 'high',
  };
  return map[effort] ?? 'high';
}

/** Build diagnostic snippets for timeout/stale error messages. */
function buildTimeoutDiagnostics(lastStdoutChunk: string, stderrText: string): string {
  const stdoutSnippet = sanitizeLogOutput(lastStdoutChunk.slice(-500));
  const stderrSnippet = sanitizeLogOutput(stderrText.slice(0, 500));
  const parts: string[] = [];
  if (stdoutSnippet) parts.push(`Last stdout: ${stdoutSnippet}`);
  if (stderrSnippet) parts.push(`stderr: ${stderrSnippet}`);
  return parts.join('. ');
}

let cliInstallPromise: Promise<string> | null = null;

export function resetCLIInstallPromise(): void {
  cliInstallPromise = null;
}

export interface OpenAIClientOptions {
  auth: OpenAIAuth;
  model: string;
}

export class OpenAIClient implements LLMClient {
  private readonly auth: OpenAIAuth;
  private openai?: OpenAI;
  private readonly model: string;
  private cachedCLIPath?: string;

  constructor(options: OpenAIClientOptions) {
    this.auth = options.auth;
    this.model = options.model;

    if (this.auth.kind === 'apiKey') {
      // Explicit timeout makes the bound visible and consistent with the OAuth/CLI path's
      // 1200s hard deadline. The SDK default (600s) leaves the action hanging on slow calls.
      this.openai = new OpenAI({ apiKey: this.auth.key, timeout: 300_000 });
    }
  }

  async sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (this.auth.kind === 'oauth') {
      return this.sendViaOAuth(systemPrompt, userMessage, options);
    }
    return this.sendViaAPI(systemPrompt, userMessage, options);
  }

  private async ensureCLI(): Promise<string> {
    if (this.cachedCLIPath) {
      return this.cachedCLIPath;
    }

    try {
      const { stdout } = await execFileAsync('which', ['codex']);
      this.cachedCLIPath = stdout.trim();
      return this.cachedCLIPath;
    } catch {
      if (!cliInstallPromise) {
        cliInstallPromise = (async () => {
          core.info('Codex CLI not found, installing via npm...');
          let npmOutput = '';
          try {
            const { stdout: npmStdout, stderr: npmStderr } = await execFileAsync(
              'npm',
              ['install', '-g', '@openai/codex'],
              { timeout: 120000 },
            );
            npmOutput = [npmStdout, npmStderr].filter(Boolean).join(' | ').trim();
          } catch (npmErr) {
            const message = (npmErr as Error).message;
            throw new Error(`Failed to install Codex CLI via npm: ${message}`);
          }
          try {
            const { stdout } = await execFileAsync('which', ['codex']);
            return stdout.trim();
          } catch {
            const suffix = npmOutput ? ` (npm output: ${sanitizeLogOutput(npmOutput).slice(0, 500)})` : '';
            throw new Error(`Failed to locate Codex CLI on PATH after npm install${suffix}`);
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

    return new Promise((resolve, reject) => {
      // `codex exec` runs a non-interactive completion, reading the prompt from stdin
      // when invoked with `-` as the prompt argument. `--model` selects the model.
      const args = ['exec', '--model', this.model];

      if (options?.effort && isReasoningModel(this.model)) {
        // Codex CLI's `-c` accepts bare `key=value` overrides; embedded double-quotes
        // here would be passed as literal characters because `spawn` bypasses the shell.
        args.push('-c', `model_reasoning_effort=${resolveCLIEffort(options.effort)}`);
      } else if (options?.effort) {
        core.warning(`Ignoring effort=${options.effort} — model "${this.model}" is not a reasoning model`);
      }

      // Read prompt from stdin
      args.push('-');

      const child = spawn(cliPath, args, {
        env: {
          // process.env spread intentionally — Codex CLI requires PATH, HOME, and other system vars.
          // The OAuth token is passed via CODEX_OAUTH_TOKEN (mirroring the CLAUDE_CODE_OAUTH_TOKEN
          // convention) and OPENAI_OAUTH_TOKEN as a fallback for CLI versions that read it. Aliasing
          // an OAuth subscription token as OPENAI_API_KEY would be a credential type confusion.
          ...process.env,
          ...(oauthToken ? { CODEX_OAUTH_TOKEN: oauthToken, OPENAI_OAUTH_TOKEN: oauthToken } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let stderr = '';
      let timedOut = false;
      let stale = false;
      let outputExceeded = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let staleKillTimer: NodeJS.Timeout | undefined;
      let outputKillTimer: NodeJS.Timeout | undefined;
      let stdinKillTimer: NodeJS.Timeout | undefined;
      let lastStdoutChunk = '';
      let rawStdoutBytes = 0;
      let rawStderrBytes = 0;

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

        rawStdoutBytes += data.length;
        if (rawStdoutBytes + rawStderrBytes > MAX_OUTPUT) { killOnOutputExceeded(); return; }

        const chunk = stdoutDecoder.write(data);
        if (chunk.length >= 500) {
          lastStdoutChunk = chunk.slice(-500);
        } else {
          lastStdoutChunk = (lastStdoutChunk + chunk).slice(-500);
        }
        output += chunk;
      });
      child.stderr.on('data', (data: Buffer) => {
        if (outputExceeded || settled) return;
        rawStderrBytes += data.length;
        stderr += stderrDecoder.write(data);
        if (rawStdoutBytes + rawStderrBytes > MAX_OUTPUT) killOnOutputExceeded();
      });

      child.on('close', (code, signal) => {
        clearAllTimers();
        if (settled) return;
        settled = true;
        const remaining = stdoutDecoder.end();
        if (remaining) output += remaining;
        stderr += stderrDecoder.end();
        if (stale) {
          const details = buildTimeoutDiagnostics(lastStdoutChunk, stderr);
          const msg = `Codex CLI stale — no output for ${STALE_TIMEOUT_MS / 1000}s${details ? `. ${details}` : ''}`;
          core.warning(msg);
          reject(new Error(msg));
          return;
        }
        if (timedOut) {
          const details = buildTimeoutDiagnostics(lastStdoutChunk, stderr);
          const msg = `Codex CLI timed out after 1200s${details ? `. ${details}` : ''}`;
          core.warning(msg);
          reject(new Error(msg));
          return;
        }
        if (outputExceeded) {
          reject(new Error('Codex CLI output exceeded 50MB limit'));
          return;
        }
        if (code !== 0) {
          const sanitizedStderr = sanitizeLogOutput(stderr.slice(0, 500));
          const msg = `exit ${code}${signal ? `, signal ${signal}` : ''}: ${sanitizedStderr}`;
          core.warning(`Codex CLI failed (${msg})`);
          reject(new Error(`Codex CLI invocation failed (${msg})`));
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
        reject(new Error(`Codex CLI spawn failed: ${error.message}`));
      });

      child.stdin.on('error', (err) => {
        core.warning(`stdin write error: ${err.message}`);
      });

      try {
        const canWrite = child.stdin.write(fullPrompt);
        if (!canWrite) {
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
        stdinKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
        stdinKillTimer.unref();
      }
    });
  }

  private async sendViaAPI(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (!this.openai) throw new Error('OpenAI client not initialized');

    const reasoning = isReasoningModel(this.model);
    if (options?.effort && !reasoning) {
      core.warning(`Ignoring effort=${options.effort} — model "${this.model}" is not a reasoning model`);
    }

    // `reasoning_effort` is only valid on o-series chat completions and the SDK's
    // non-streaming union doesn't always surface it on every model branch. Intersecting
    // with a narrow `{ reasoning_effort?: ... }` keeps the rest of the call site fully
    // typed while letting us assign the field with compile-time checking.
    type ParamsWithReasoningEffort = ChatCompletionCreateParamsNonStreaming & {
      reasoning_effort?: 'low' | 'medium' | 'high';
    };
    const params: ParamsWithReasoningEffort = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    };

    if (reasoning && options?.effort) {
      params.reasoning_effort = resolveCLIEffort(options.effort);
    }

    const response = await this.openai.chat.completions.create(params);
    const content = response.choices?.[0]?.message?.content ?? '';
    core.debug(sanitizeLogOutput(content.slice(0, 200)));

    return { content };
  }
}
