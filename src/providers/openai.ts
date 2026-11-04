import { execFile } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';

import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import * as core from '@actions/core';

import { buildExitDiagnostics, runCli, seedAuthFile, STALE_TIMEOUT_MS } from './cli-utils';
import { LLMClient, LLMResponse, LLMUsage, OpenAIAuth, readCount, SendMessageOptions, ZERO_USAGE } from './types';

const execFileAsync = promisify(execFile);

// Re-export for existing test imports.
export { STALE_TIMEOUT_MS };

export function resolveCodexHome(): string {
  const explicit = process.env.CODEX_HOME;
  if (explicit) return explicit;
  const home = process.env.HOME;
  if (!home) {
    throw new Error(
      'Cannot resolve CODEX_HOME: neither $CODEX_HOME nor $HOME is set in the environment.',
    );
  }
  return join(home, '.codex');
}

const OPENAI_OAUTH_BOOTSTRAP_HINT =
  'Bootstrap with `codex login` then `cat ~/.codex/auth.json | base64 | gh secret set OPENAI_OAUTH_TOKEN`. Re-run the bootstrap when the refresh_token expires.';

// Pin Codex CLI to a known-good version and disable lifecycle scripts on install
// to mitigate supply-chain risk if a compromised release is published. Keep this
// in sync with the explicit install step in `.github/workflows/manki.yml`.
export const CODEX_CLI_VERSION = '0.129.0';

const CODEX_BLOCKED_BARE = new Set([
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'GEMINI_API_KEY', 'GEMINI_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_OAUTH_TOKEN', 'CODEX_OAUTH_TOKEN',
  'GITHUB_TOKEN', 'GITHUB_APP_PRIVATE_KEY',
  'REVIEW_MEMORY_TOKEN',
  'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RESULTS_URL',
]);

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
export function resolveEffortTier(effort: 'low' | 'medium' | 'high' | 'max'): 'low' | 'medium' | 'high' {
  if (effort === 'max') return 'high';
  return effort;
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
              ['install', '-g', '--ignore-scripts', `@openai/codex@${CODEX_CLI_VERSION}`],
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
    const codexHome = resolveCodexHome();
    const oauthToken = this.auth.kind === 'oauth' ? this.auth.token : undefined;
    const model = this.model;
    if (oauthToken) {
      seedAuthFile({
        secret: oauthToken,
        inputName: 'openai_oauth_token',
        targetPath: join(codexHome, 'auth.json'),
        requiredFields: ['tokens.access_token', 'tokens.refresh_token'],
        bootstrapHint: OPENAI_OAUTH_BOOTSTRAP_HINT,
      });
    }
    const cliPath = await this.ensureCLI();
    const startTime = Date.now();

    // `codex exec` runs a non-interactive completion, reading the prompt from stdin
    // when invoked with `-` as the prompt argument. `--model` selects the model.
    const args = ['exec', '--model', this.model];

    if (options?.effort && isReasoningModel(this.model)) {
      // Codex CLI's `-c` accepts bare `key=value` overrides; embedded double-quotes
      // here would be passed as literal characters because `spawn` bypasses the shell.
      args.push('-c', `model_reasoning_effort=${resolveEffortTier(options.effort)}`);
    } else if (options?.effort) {
      core.warning(`Ignoring effort=${options.effort} for model "${this.model}" — not a reasoning model. The Codex CLI will apply its own default effort instead.`);
    }

    // Read prompt from stdin
    args.push('-');

    const safeCodexEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !CODEX_BLOCKED_BARE.has(k) && !k.startsWith('INPUT_'),
      ),
    ) as NodeJS.ProcessEnv;

    let output = '';
    const { code, signal, stderr, lastStdoutChunk } = await runCli({
      label: 'Codex',
      cliPath,
      args,
      env: { ...safeCodexEnv, CODEX_HOME: codexHome },
      input: fullPrompt,
      onStdout: (chunk) => { output += chunk; },
      stderrResetsStale: true,
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
      core.warning(`Codex CLI failed (${msg})`);
      throw new Error(`Codex CLI invocation failed (${msg})`);
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
    if (!this.openai) throw new Error('OpenAI client not initialized');

    const reasoning = isReasoningModel(this.model);
    if (options?.effort && !reasoning) {
      core.warning(`Ignoring effort=${options.effort} for model "${this.model}" — not a reasoning model. Effort has no effect via the OpenAI API for GPT-family models.`);
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
      params.reasoning_effort = resolveEffortTier(options.effort);
    }

    const startTime = Date.now();
    const response = await this.openai.chat.completions.create(params);
    const choice = response.choices?.[0];
    const content = choice?.message?.content ?? '';
    core.debug(sanitizeLogOutput(content.slice(0, 200)));

    const sdkUsage = response.usage as undefined | {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
    const usage: LLMUsage = sdkUsage
      ? {
          inputTokens: readCount(sdkUsage.prompt_tokens),
          outputTokens: readCount(sdkUsage.completion_tokens),
          cachedTokens: readCount(sdkUsage.prompt_tokens_details?.cached_tokens),
          reasoningTokens: readCount(sdkUsage.completion_tokens_details?.reasoning_tokens),
        }
      : { ...ZERO_USAGE };

    return { content, usage, latencyMs: Date.now() - startTime, truncated: choice?.finish_reason === 'length' };
  }
}
