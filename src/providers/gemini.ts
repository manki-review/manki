import { execFile } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';

import { FinishReason, GoogleGenAI, ThinkingConfig, ThinkingLevel } from '@google/genai';
import * as core from '@actions/core';

import { buildExitDiagnostics, callWithTimeout, cliEnv, matchQuotaText, registerAuthFileSecrets, runCli, sanitizeLogOutput, seedAuthFile, warnReplyTail } from './cli-utils';
import { GeminiAuth, LLMClient, LLMResponse, LLMUsage, QuotaError, readCount, RefusalError, SendMessageOptions, ZERO_USAGE } from './types';

const execFileAsync = promisify(execFile);

export function resolveGeminiCredsDir(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('Cannot seed Gemini OAuth credentials: $HOME is not set in the environment.');
  }
  return join(home, '.gemini');
}

const GEMINI_OAUTH_BOOTSTRAP_HINT =
  'Bootstrap with `gemini` (sign in with Google using a Gemini Code Assist Standard or Enterprise account) then `cat ~/.gemini/oauth_creds.json | base64 | gh secret set GEMINI_OAUTH_TOKEN`. Re-run the bootstrap when the refresh_token expires. Personal accounts can no longer sign in, so use gemini_api_key instead.';

export function buildGeminiAuth(oauthToken: string, apiKey: string): GeminiAuth {
  if (oauthToken) return { kind: 'oauth', token: oauthToken };
  if (apiKey) return { kind: 'apiKey', key: apiKey };
  throw new Error('Either gemini_oauth_token or gemini_api_key must be provided');
}

function geminiMajorMinor(model: string): [number, number] | undefined {
  const match = /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/i.exec(model);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : undefined;
}

/**
 * Maps an effort tier to the model's thinking config, or `undefined` to keep the model default.
 * Gemini 3 onwards takes `thinkingLevel` and rejects `thinkingBudget`. Gemini 2.5 takes only
 * `thinkingBudget`, where `low` leaves thinking off. Older models reject any thinking config.
 */
export function geminiThinkingConfig(model: string, effort: SendMessageOptions['effort']): ThinkingConfig | undefined {
  const version = geminiMajorMinor(model);
  if (!effort || !version) return undefined;
  const [major, minor] = version;
  if (major >= 3) {
    const levels = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH, max: ThinkingLevel.HIGH };
    return { thinkingLevel: levels[effort] };
  }
  if (major < 2 || minor < 5 || effort === 'low') return undefined;
  return { thinkingBudget: effort === 'medium' ? 5000 : 10000 };
}

// Pinned like the Codex CLI and installed without lifecycle scripts. The package has none, and only
// its optional keychain dependency has one, which the seeded `oauth_creds.json` file does not need.
// Keep this in sync with the install step in `.github/workflows/manki-dispatch.yml`.
export const GEMINI_CLI_VERSION = '0.66.0';

// `finishReason` and `promptFeedback.blockReason` values that mean a safety or policy filter declined the request.
const POLICY_BLOCK_REASONS: ReadonlySet<string> = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MODEL_ARMOR']);

/** Maps an SDK 429 or `RESOURCE_EXHAUSTED` error, which a used-up quota or rate limit returns, to a `QuotaError`. */
function geminiQuotaError(error: unknown): QuotaError | undefined {
  const { status, message } = (error ?? {}) as { status?: unknown; message?: unknown };
  const text = sanitizeLogOutput(String(message ?? '')).slice(0, 1000);
  if (status !== 429 && !/\bRESOURCE_EXHAUSTED\b/.test(text)) return undefined;
  return new QuotaError(`Gemini API quota exhausted: ${text.slice(0, 500)}`, 'Gemini API quota exhausted', matchQuotaText(text)?.resetsAt, 'key');
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
  private genAI?: GoogleGenAI;
  private readonly model: string;
  private cachedCLIPath?: string;

  constructor(options: GeminiClientOptions) {
    this.auth = options.auth;
    this.model = options.model;

    if (this.auth.kind === 'apiKey') {
      this.genAI = new GoogleGenAI({ apiKey: this.auth.key });
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
          await execFileAsync('npm', ['install', '-g', '--ignore-scripts', `@google/gemini-cli@${GEMINI_CLI_VERSION}`], {
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
    // The Gemini CLI does not currently expose a thinking flag, so any
    // requested effort beyond `low` is silently unsupported on this path. Surface
    // it as a warning instead of dropping the option without a trace.
    if (options?.effort && options.effort !== 'low') {
      core.warning(
        `Gemini CLI (OAuth) path does not support effort=${options.effort}; thinking config is not applied. Use API key auth for thinking control.`,
      );
    }
    // Use a structural delimiter that is harder to spoof from inside diff content
    // than a bare `---` markdown rule, and explicitly mark the user content as untrusted.
    const fullPrompt = `${systemPrompt}\n\n=== USER CONTENT (untrusted) ===\n\n${userMessage}\n\n=== END USER CONTENT ===`;
    const geminiCredsDir = resolveGeminiCredsDir();
    const cliPath = await this.ensureCLI();
    const oauthToken = this.auth.kind === 'oauth' ? this.auth.token : undefined;
    const startTime = Date.now();
    const model = this.model;
    if (oauthToken) {
      seedAuthFile({
        secret: oauthToken,
        inputName: 'gemini_oauth_token',
        targetPath: join(geminiCredsDir, 'oauth_creds.json'),
        requiredFields: ['access_token', 'refresh_token'],
        bootstrapHint: GEMINI_OAUTH_BOOTSTRAP_HINT,
      });
    }

    // Prompt is written to stdin; the CLI reads until EOF and responds on stdout.
    // We pass the full prompt on stdin to avoid argv length limits.
    const args = [
      // Headless runs refuse an untrusted directory. `runCli` runs the CLI in an empty one.
      '--skip-trust',
      '--model', this.model,
    ];

    let output = '';
    const { code, signal, stderr, lastStdoutChunk } = await runCli({
      label: 'Gemini',
      cliPath,
      args,
      env: cliEnv('gemini', {
        // GOOGLE_GENAI_USE_GCA=true selects the LOGIN_WITH_GOOGLE auth type in
        // non-interactive mode. The CLI then loads its credentials from the
        // `oauth_creds.json` file seeded above (which carries a refresh_token,
        // unlike the GOOGLE_CLOUD_ACCESS_TOKEN env-var path that only sets a
        // short-lived access_token).
        ...(oauthToken ? { GOOGLE_GENAI_USE_GCA: 'true' } : {}),
      }),
      input: fullPrompt,
      hardTimeoutMs: options?.timeoutMs,
      signal: options?.signal,
      onStdout: (chunk) => { output += chunk; },
    }).catch((error: unknown) => {
      warnReplyTail('Gemini CLI', output);
      throw error;
    }).finally(() => registerAuthFileSecrets(join(geminiCredsDir, 'oauth_creds.json')));

    if (code !== 0) {
      // The CLI logs 429 retries it recovered from, so only its final error line counts. Stack frames are skipped.
      const finalLine = stderr.split(/\r?\n/).filter(line => line.trim() && !/^\s+at\s/.test(line)).pop() ?? '';
      const quota = matchQuotaText(finalLine);
      if (quota && !quota.overloaded) {
        const message = `Gemini quota exhausted: ${sanitizeLogOutput(finalLine).trim()}`;
        core.warning(message);
        throw new QuotaError(message, 'Gemini quota exhausted', quota.resetsAt, 'token');
      }
      const msg = buildExitDiagnostics({
        exitCode: code,
        signal,
        stderr,
        lastStdoutChunk,
        model,
        effort: options?.effort,
        promptChars: fullPrompt.length,
        elapsedMs: Date.now() - startTime,
      });
      core.warning(`Gemini CLI failed (${msg})`);
      warnReplyTail('Gemini CLI', output);
      throw new Error(`Gemini CLI invocation failed (${msg})`);
    }
    const content = output.trim();
    core.debug(sanitizeLogOutput(content.slice(0, 200)));
    return {
      content,
      usage: { ...ZERO_USAGE },
      latencyMs: Date.now() - startTime,
      model: this.model,
    };
  }

  private async sendViaAPI(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (!this.genAI) throw new Error('Gemini client not initialized');

    const thinkingConfig = geminiThinkingConfig(this.model, options?.effort);
    // Gemini 3 onwards always thinks, so its thoughts need room even without an effort tier.
    const thinks = thinkingConfig !== undefined || (geminiMajorMinor(this.model)?.[0] ?? 0) >= 3;

    const startTime = Date.now();
    const genAI = this.genAI;
    const response = await callWithTimeout('Gemini API', options, (abortSignal) => genAI.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: thinks ? 32768 : 16384,
        ...(thinkingConfig && { thinkingConfig }),
        ...(abortSignal && { abortSignal }),
      },
    })).catch((error: unknown) => { throw geminiQuotaError(error) ?? error; });

    const finishReason = response.candidates?.[0]?.finishReason;
    const content = response.text ?? '';
    if (finishReason && finishReason !== FinishReason.STOP) {
      core.warning(`Gemini API reply ended on finishReason ${finishReason}`);
      warnReplyTail('Gemini API', content);
    }
    const blockReason = response.promptFeedback?.blockReason;
    const policyBlock = [blockReason, finishReason].find(r => r !== undefined && POLICY_BLOCK_REASONS.has(r));
    if (policyBlock) {
      throw new RefusalError(`Gemini API declined the request: ${policyBlock}`, policyBlock);
    }
    const truncated = finishReason === FinishReason.MAX_TOKENS;
    if (!content && !truncated) {
      const reason = blockReason ?? finishReason ?? 'no candidates';
      throw new Error(`Gemini API returned no usable content: ${reason}`);
    }
    core.debug(sanitizeLogOutput(content.slice(0, 200)));

    const usageMetadata = response.usageMetadata;
    const usage: LLMUsage = usageMetadata
      ? {
          inputTokens: readCount(usageMetadata.promptTokenCount),
          outputTokens: readCount(usageMetadata.candidatesTokenCount),
          cacheReadTokens: readCount(usageMetadata.cachedContentTokenCount),
          cacheWriteTokens: 0,
          reasoningTokens: readCount(usageMetadata.thoughtsTokenCount),
        }
      : { ...ZERO_USAGE };

    return { content, usage, latencyMs: Date.now() - startTime, model: this.model, truncated };
  }
}
