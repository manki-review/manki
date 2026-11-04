import { execFile } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';

import { FinishReason, GoogleGenerativeAI } from '@google/generative-ai';
import * as core from '@actions/core';

import { buildExitDiagnostics, runCli, sanitizeLogOutput, seedAuthFile } from './cli-utils';
import { GeminiAuth, LLMClient, LLMResponse, LLMUsage, readCount, SendMessageOptions, ZERO_USAGE } from './types';

const execFileAsync = promisify(execFile);

export function resolveGeminiCredsDir(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('Cannot seed Gemini OAuth credentials: $HOME is not set in the environment.');
  }
  return join(home, '.gemini');
}

const GEMINI_OAUTH_BOOTSTRAP_HINT =
  'Bootstrap with `gemini` (sign in with Google) then `cat ~/.gemini/oauth_creds.json | base64 | gh secret set GEMINI_OAUTH_TOKEN`. Re-run the bootstrap when the refresh_token expires.';

const GEMINI_BLOCKED_BARE = new Set([
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'REVIEW_MEMORY_TOKEN', 'GITHUB_TOKEN',
  'GEMINI_API_KEY', 'GEMINI_OAUTH_TOKEN', 'GITHUB_APP_PRIVATE_KEY',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_OAUTH_TOKEN', 'CODEX_OAUTH_TOKEN',
  'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RESULTS_URL',
]);

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
      '--model', this.model,
    ];

    // Strip other providers' secrets and all INPUT_* vars (GitHub Actions delivers
    // every action input as INPUT_<NAME>, which would otherwise bypass bare-name
    // stripping) from the forwarded env. PATH/HOME etc. flow through `safeEnv`.
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !GEMINI_BLOCKED_BARE.has(k) && !/^INPUT_/i.test(k),
      ),
    ) as NodeJS.ProcessEnv;

    let output = '';
    const { code, signal, stderr, lastStdoutChunk } = await runCli({
      label: 'Gemini',
      cliPath,
      args,
      env: {
        ...safeEnv,
        // GOOGLE_GENAI_USE_GCA=true selects the LOGIN_WITH_GOOGLE auth type in
        // non-interactive mode. The CLI then loads its credentials from the
        // `oauth_creds.json` file seeded above (which carries a refresh_token,
        // unlike the GOOGLE_CLOUD_ACCESS_TOKEN env-var path that only sets a
        // short-lived access_token).
        ...(oauthToken ? { GOOGLE_GENAI_USE_GCA: 'true' } : {}),
      },
      input: fullPrompt,
      onStdout: (chunk) => { output += chunk; },
    });

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
      });
      core.warning(`Gemini CLI failed (${msg})`);
      throw new Error(`Gemini CLI invocation failed (${msg})`);
    }
    const content = output.trim();
    core.debug(sanitizeLogOutput(content.slice(0, 200)));
    return {
      content,
      usage: { ...ZERO_USAGE },
      latencyMs: Date.now() - startTime,
    };
  }

  private async sendViaAPI(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (!this.genAI) throw new Error('Gemini client not initialized');

    const thinkingBudget = geminiThinkingBudget(options?.effort);

    // The SDK type for GenerationConfig predates Gemini 2.5 thinking config.
    // The underlying REST API accepts `thinkingConfig.thinkingBudget` — pass it
    // through with a cast so we don't have to wait for the SDK types to catch up.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generationConfig: any = {
      maxOutputTokens: thinkingBudget !== undefined ? 32768 : 16384,
    };
    if (thinkingBudget !== undefined) {
      generationConfig.thinkingConfig = { thinkingBudget };
    }

    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: systemPrompt,
    });

    const startTime = Date.now();
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

    const usageMetadata = (response.response as unknown as {
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    }).usageMetadata;
    const usage: LLMUsage = usageMetadata
      ? {
          inputTokens: readCount(usageMetadata.promptTokenCount),
          outputTokens: readCount(usageMetadata.candidatesTokenCount),
          cachedTokens: readCount(usageMetadata.cachedContentTokenCount),
          reasoningTokens: readCount(usageMetadata.thoughtsTokenCount),
        }
      : { ...ZERO_USAGE };

    const truncated = response.response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS;
    return { content, usage, latencyMs: Date.now() - startTime, truncated };
  }
}
