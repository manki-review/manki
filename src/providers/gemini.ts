import { execFile, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { promisify } from 'util';

import { GoogleGenerativeAI } from '@google/generative-ai';
import * as core from '@actions/core';

import { sanitizeLogOutput, STALE_TIMEOUT_MS, buildTimeoutDiagnostics } from './cli-utils';
import { GeminiAuth, LLMClient, LLMResponse, SendMessageOptions } from './types';

const execFileAsync = promisify(execFile);

export function buildGeminiAuth(oauthToken: string, apiKey: string): GeminiAuth {
  if (oauthToken) return { kind: 'oauth', token: oauthToken };
  if (apiKey) return { kind: 'apiKey', key: apiKey };
  throw new Error('Either gemini_oauth_token or gemini_api_key must be provided');
}

/** Map effort level to Gemini thinking budget. `low` disables thinking entirely. */
export function geminiThinkingBudget(effort: SendMessageOptions['effort']): number | undefined {
  if (!effort || effort === 'low') return undefined;
  if (effort === 'medium') return 5000;
  // 'high' and 'max' both map to the maximum thinking budget supported across
  // Gemini 2.5/3.x families.
  return 10000;
}

let cliInstallPromise: Promise<string> | null = null;

export function resetGeminiCLIInstallPromise(): void {
  cliInstallPromise = null;
}

export interface GeminiClientOptions {
  auth: GeminiAuth;
  model: string;
}

export class GeminiClient implements LLMClient {
  private readonly auth: GeminiAuth;
  private genAI?: GoogleGenerativeAI;
  private readonly model: string;
  private cachedCLIPath?: string;

  constructor(options: GeminiClientOptions) {
    this.auth = options.auth;
    this.model = options.model;

    if (this.auth.kind === 'apiKey') {
      this.genAI = new GoogleGenerativeAI(this.auth.key);
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
      const { stdout } = await execFileAsync('which', ['gemini']);
      this.cachedCLIPath = stdout.trim();
      return this.cachedCLIPath;
    } catch {
      if (!cliInstallPromise) {
        cliInstallPromise = (async () => {
          core.info('Gemini CLI not found, installing via npm...');
          await execFileAsync('npm', ['install', '-g', '@google/gemini-cli'], {
            timeout: 120000,
          });
          try {
            const { stdout } = await execFileAsync('which', ['gemini']);
            return stdout.trim();
          } catch {
            throw new Error('Failed to install Gemini CLI');
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
    // The Gemini CLI does not currently expose a thinking-budget flag, so any
    // requested effort beyond `low` is silently unsupported on this path. Surface
    // it as a warning instead of dropping the option without a trace.
    if (options?.effort && options.effort !== 'low') {
      core.warning(
        `Gemini CLI (OAuth) path does not support effort=${options.effort}; thinking budget is not applied. Use API key auth for thinking-budget control.`,
      );
    }
    // Use a structural delimiter that is harder to spoof from inside diff content
    // than a bare `---` markdown rule, and explicitly mark the user content as untrusted.
    const fullPrompt = `${systemPrompt}\n\n=== USER CONTENT (untrusted) ===\n\n${userMessage}\n\n=== END USER CONTENT ===`;
    const cliPath = await this.ensureCLI();
    const oauthToken = this.auth.kind === 'oauth' ? this.auth.token : undefined;

    return new Promise((resolve, reject) => {
      // Prompt is written to stdin; the CLI reads until EOF and responds on stdout.
      // We pass the full prompt on stdin to avoid argv length limits.
      const args = [
        '--model', this.model,
      ];

      // Strip other providers' secrets from the forwarded env so a compromised
      // Gemini CLI cannot exfiltrate them. PATH/HOME etc. flow through `safeEnv`.
      const {
        ANTHROPIC_API_KEY: _anthropicApiKey,
        CLAUDE_CODE_OAUTH_TOKEN: _claudeOauthToken,
        REVIEW_MEMORY_TOKEN: _memoryToken,
        GITHUB_TOKEN: _githubToken,
        ...safeEnv
      } = process.env;
      void _anthropicApiKey; void _claudeOauthToken; void _memoryToken; void _githubToken;

      const child = spawn(cliPath, args, {
        env: {
          ...safeEnv,
          // The Gemini CLI reads GOOGLE_CLOUD_ACCESS_TOKEN when GOOGLE_GENAI_USE_GCA
          // is set to authenticate with an existing OAuth access token, per
          // @google/gemini-cli bundle/chunk-6DSAZLFF.js.
          ...(oauthToken ? { GOOGLE_GENAI_USE_GCA: 'true', GOOGLE_CLOUD_ACCESS_TOKEN: oauthToken } : {}),
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
      let rawBytes = 0;
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

        rawBytes += data.length;
        if (rawBytes + rawStderrBytes > MAX_OUTPUT) { killOnOutputExceeded(); return; }

        const chunk = stdoutDecoder.write(data);
        if (chunk.length >= 500) {
          lastStdoutChunk = chunk.slice(-500);
        } else {
          lastStdoutChunk = (lastStdoutChunk + chunk).slice(-500);
        }
        // Gemini CLI emits plain text on stdout — concatenate verbatim.
        output += chunk;
      });
      child.stderr.on('data', (data: Buffer) => {
        if (outputExceeded || settled) return;
        rawStderrBytes += data.length;
        stderr += stderrDecoder.write(data);
        if (rawBytes + rawStderrBytes > MAX_OUTPUT) killOnOutputExceeded();
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
          const msg = `Gemini CLI stale — no output for ${STALE_TIMEOUT_MS / 1000}s${details ? `. ${details}` : ''}`;
          core.warning(msg);
          reject(new Error(msg));
          return;
        }
        if (timedOut) {
          const details = buildTimeoutDiagnostics(lastStdoutChunk, stderr);
          const msg = `Gemini CLI timed out after 1200s${details ? `. ${details}` : ''}`;
          core.warning(msg);
          reject(new Error(msg));
          return;
        }
        if (outputExceeded) {
          reject(new Error('Gemini CLI output exceeded 50MB limit'));
          return;
        }
        if (code !== 0) {
          const stderrSnippet = sanitizeLogOutput(stderr.slice(0, 500));
          const msg = `exit ${code}${signal ? `, signal ${signal}` : ''}: ${stderrSnippet}`;
          core.warning(`Gemini CLI failed (${msg})`);
          reject(new Error(`Gemini CLI invocation failed (${msg})`));
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
        reject(new Error(`Gemini CLI spawn failed: ${error.message}`));
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
    if (!this.genAI) throw new Error('Gemini client not initialized');

    const thinkingBudget = geminiThinkingBudget(options?.effort);

    // The SDK type for GenerationConfig predates Gemini 2.5 thinking config.
    // The underlying REST API accepts `thinkingConfig.thinkingBudget` — pass it
    // through with a cast so we don't have to wait for the SDK types to catch up.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generationConfig: any = {};
    if (thinkingBudget !== undefined) {
      generationConfig.thinkingConfig = { thinkingBudget };
    }

    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: systemPrompt,
    });

    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig,
    });

    let content: string;
    try {
      content = response.response.text();
    } catch (err) {
      throw new Error(`Gemini API returned no usable content: ${(err as Error).message}`);
    }
    core.debug(sanitizeLogOutput(content.slice(0, 200)));

    return { content };
  }
}
