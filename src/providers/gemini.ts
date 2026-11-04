import { execFile } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';

import { FinishReason, GoogleGenAI, ThinkingConfig, ThinkingLevel } from '@google/genai';
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
  'Bootstrap with `gemini` (sign in with Google using a Gemini Code Assist Standard or Enterprise account) then `cat ~/.gemini/oauth_creds.json | base64 | gh secret set GEMINI_OAUTH_TOKEN`. Re-run the bootstrap when the refresh_token expires. Personal accounts can no longer sign in, so use gemini_api_key instead.';

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
// Keep this in sync with the install step in `.github/workflows/manki.yml`.
export const GEMINI_CLI_VERSION = '0.66.0';

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

    const thinkingConfig = geminiThinkingConfig(this.model, options?.effort);
    // Gemini 3 onwards always thinks, so its thoughts need room even without an effort tier.
    const thinks = thinkingConfig !== undefined || (geminiMajorMinor(this.model)?.[0] ?? 0) >= 3;

    const startTime = Date.now();
    const response = await this.genAI.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: thinks ? 32768 : 16384,
        ...(thinkingConfig && { thinkingConfig }),
      },
    });

    const finishReason = response.candidates?.[0]?.finishReason;
    const truncated = finishReason === FinishReason.MAX_TOKENS;
    const content = response.text ?? '';
    if (!content && !truncated) {
      const reason = response.promptFeedback?.blockReason ?? finishReason ?? 'no candidates';
      throw new Error(`Gemini API returned no usable content: ${reason}`);
    }
    core.debug(sanitizeLogOutput(content.slice(0, 200)));

    const usageMetadata = response.usageMetadata;
    const usage: LLMUsage = usageMetadata
      ? {
          inputTokens: readCount(usageMetadata.promptTokenCount),
          outputTokens: readCount(usageMetadata.candidatesTokenCount),
          cachedTokens: readCount(usageMetadata.cachedContentTokenCount),
          reasoningTokens: readCount(usageMetadata.thoughtsTokenCount),
        }
      : { ...ZERO_USAGE };

    return { content, usage, latencyMs: Date.now() - startTime, truncated };
  }
}
