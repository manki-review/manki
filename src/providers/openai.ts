import { execFile } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import * as core from '@actions/core';

import { buildExitDiagnostics, callWithTimeout, cliEnv, extractCliErrorSnippet, MankiCommand, matchQuotaText, readRelatedReads, registerAuthFileSecrets, relatedReadsFile, repoToolsPrompt, runCli, seedAuthFile, STALE_TIMEOUT_MS, toolServerCommand, warnReplyTail, withPromptDir } from './cli-utils';
import { LLMClient, LLMResponse, LLMUsage, OpenAIAuth, QuotaError, readCount, RefusalError, SendMessageOptions, ZERO_USAGE } from './types';

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
  'Bootstrap with `codex login` then `cat ~/.codex/auth.json | base64 | gh secret set OPENAI_OAUTH_TOKEN`. Codex rotates the tokens when it refreshes them, so the stored copy goes stale: re-run the bootstrap when Codex fails to authenticate, or use openai_api_key instead.';

// Pin Codex CLI to a known-good version and disable lifecycle scripts on install
// to mitigate supply-chain risk if a compromised release is published. Keep this
// in sync with the explicit install step in `.github/workflows/manki.yml`.
export const CODEX_CLI_VERSION = '0.166.0';

export function buildOpenAIAuth(oauthToken: string, apiKey: string): OpenAIAuth {
  if (oauthToken) return { kind: 'oauth', token: oauthToken };
  if (apiKey) return { kind: 'apiKey', key: apiKey };
  throw new Error('Either openai_oauth_token or openai_api_key must be provided');
}

/** Strip GitHub Actions workflow commands to prevent injection when logging CLI output. */
export function sanitizeLogOutput(text: string): string {
  return text.replace(/^::[a-z].*$/gim, '[redacted-workflow-cmd]');
}

type OpenAIReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Returns the highest `reasoning_effort` the model accepts, or `undefined` if it rejects the
 * parameter. Per OpenAI's model pages: `high` for o-series, `gpt-5` and `gpt-5.1`, `xhigh` for
 * `gpt-5.2` to `gpt-5.5`, `max` from `gpt-5.6`. GPT-4, `-chat` and `-pro` models take none.
 */
function maxReasoningEffort(model: string): OpenAIReasoningEffort | undefined {
  const name = model.toLowerCase();
  if (/-(chat|pro)(-|$)/.test(name)) return undefined;
  if (/^o\d/.test(name)) return 'high';
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(name);
  if (!gpt) return undefined;
  const major = Number(gpt[1]);
  const minor = Number(gpt[2] ?? 0);
  if (major < 5) return undefined;
  if (major > 5 || minor >= 6) return 'max';
  return minor >= 2 ? 'xhigh' : 'high';
}

/**
 * Maps manki's effort tier to the `reasoning_effort` value for `model`, or `undefined`
 * when the model rejects the parameter. `max` becomes the model's highest value.
 * The chat completions API and the Codex CLI accept the same values.
 */
export function resolveReasoningEffort(
  model: string,
  effort: 'low' | 'medium' | 'high' | 'max',
): OpenAIReasoningEffort | undefined {
  const ceiling = maxReasoningEffort(model);
  if (!ceiling) return undefined;
  return effort === 'max' ? ceiling : effort;
}

/** Maps an SDK 429, a used-up quota (`insufficient_quota`) or a rate limit, to a `QuotaError`. */
function openAIQuotaError(error: unknown): QuotaError | undefined {
  const { status, code, message } = (error ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  if (status !== 429 && code !== 'insufficient_quota' && code !== 'rate_limit_exceeded') return undefined;
  const text = sanitizeLogOutput(String(message ?? '')).slice(0, 500);
  const limit = code === 'insufficient_quota' ? 'OpenAI API quota exhausted' : 'OpenAI API rate limit reached';
  return new QuotaError(`${limit}: ${text}`, limit, matchQuotaText(text)?.resetsAt, 'key');
}

/**
 * Returns the `-c` overrides that give Codex Manki's tool server. Its tools are read-only, so they run without
 * approval. Codex starts the server with a few default variables only, so `env_vars` names the rest of the CLI's own
 * environment, such as the runner temp folder, the proxy settings and the GitHub API URL `repo_info` needs. Codex reads
 * their values from its own environment, so none of them, such as a proxy password, lands on the command line.
 */
function codexToolServerArgs({ command, args }: MankiCommand, env: NodeJS.ProcessEnv): string[] {
  return [
    '-c', `mcp_servers.manki.command=${JSON.stringify(command)}`,
    '-c', `mcp_servers.manki.args=${JSON.stringify(args)}`,
    '-c', 'mcp_servers.manki.default_tools_approval_mode="approve"',
    '-c', `mcp_servers.manki.env_vars=${JSON.stringify(Object.keys(env).filter(name => name !== 'CODEX_HOME'))}`,
  ];
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

  get repoTools(): boolean {
    return this.auth.kind === 'oauth';
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
    const repoTools = options?.repoTools;
    const toolsPrompt = repoTools ? `\n\n${repoToolsPrompt(repoTools, '`read_file`, `grep` and `glob`')}` : '';
    const instructions = `${systemPrompt}${toolsPrompt}`;
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
    // `runCli` runs it in an empty directory, which is not a git repository.
    // The read-only sandbox still lets tools read every file, such as the auth files, so every built-in tool
    // that reads files or reaches the network or an account is off, and only Manki's tool server is left.
    const args = [
      'exec', '--skip-git-repo-check', `--model=${this.model}`, '--sandbox', 'read-only', '-c', 'approval_policy=never',
      '-c', 'features.shell_tool=false', '-c', 'features.view_image=false', '-c', 'web_search=disabled', '-c', 'features.apps=false',
      '-c', 'features.plugins=false', '-c', 'features.multi_agent=false', '-c', 'features.image_generation=false',
    ];

    const reasoningEffort = options?.effort && resolveReasoningEffort(this.model, options.effort);
    if (reasoningEffort) {
      // Codex CLI's `-c` accepts bare `key=value` overrides; embedded double-quotes
      // here would be passed as literal characters because `spawn` bypasses the shell.
      args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
    } else if (options?.effort) {
      core.warning(`Ignoring effort=${options.effort} for model "${this.model}": it does not accept reasoning effort. The Codex CLI will apply its own default effort instead.`);
    }

    // The GitHub API URL is for the tool server's `repo_info`, which Codex starts with names from this environment.
    const apiUrl = process.env.GITHUB_API_URL;
    const env = cliEnv('codex', { CODEX_HOME: codexHome, ...(repoTools && apiUrl && { GITHUB_API_URL: apiUrl }) });

    let output = '';
    const { code, signal, stderr, lastStdoutChunk, relatedReads } = await withPromptDir(async (promptDir) => {
      // Manki's instructions replace Codex's own, so stdin carries only the untrusted content.
      const instructionsPath = join(promptDir, 'instructions.md');
      writeFileSync(instructionsPath, instructions, { mode: 0o600 });
      const readsFile = relatedReadsFile(promptDir);
      const toolArgs = repoTools
        ? codexToolServerArgs(toolServerCommand(repoTools.root, { fileTools: true, steps: repoTools.steps, related: repoTools.related, readsFile }), env)
        : [];
      const exit = await runCli({
        label: 'Codex',
        cliPath,
        args: [...args, ...toolArgs, '-c', `model_instructions_file=${JSON.stringify(instructionsPath)}`, '-'],
        env,
        input: userMessage,
        hardTimeoutMs: options?.timeoutMs,
        signal: options?.signal,
        onStdout: (chunk) => { output += chunk; },
        stderrResetsStale: true,
      });
      return { ...exit, relatedReads: repoTools?.related && readRelatedReads(readsFile) };
    }).catch((error: unknown) => {
      warnReplyTail('Codex CLI', output);
      throw error;
    }).finally(() => registerAuthFileSecrets(join(codexHome, 'auth.json')));

    if (code !== 0) {
      // Codex echoes the prompt to stderr, so only its `ERROR:` line is read for a limit.
      const errorLine = extractCliErrorSnippet(stderr);
      const quota = matchQuotaText(errorLine);
      if (quota && !quota.overloaded) {
        const message = `ChatGPT subscription limit reached: ${errorLine}`;
        core.warning(message);
        throw new QuotaError(message, 'ChatGPT subscription limit reached', quota.resetsAt, 'token');
      }
      const msg = buildExitDiagnostics({
        exitCode: code,
        signal,
        stderr,
        lastStdoutChunk,
        model,
        effort: options?.effort,
        promptChars: instructions.length + userMessage.length,
        elapsedMs: Date.now() - startTime,
      });
      core.warning(`Codex CLI failed (${msg})`);
      warnReplyTail('Codex CLI', output);
      throw new Error(`Codex CLI invocation failed (${msg})`);
    }
    const content = output.trim();
    core.debug(sanitizeLogOutput(content.slice(0, 200)));
    return {
      content,
      latencyMs: Date.now() - startTime,
      model: this.model,
      ...(relatedReads && { relatedReads }),
    };
  }

  private async sendViaAPI(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (!this.openai) throw new Error('OpenAI client not initialized');

    const reasoningEffort = options?.effort && resolveReasoningEffort(this.model, options.effort);
    if (options?.effort && !reasoningEffort) {
      core.warning(`Ignoring effort=${options.effort} for model "${this.model}": it does not accept reasoning effort. Effort has no effect via the OpenAI API for this model.`);
    }

    // The SDK's `reasoning_effort` union lacks `max`, which `gpt-5.6` onwards accept.
    type ParamsWithReasoningEffort = Omit<ChatCompletionCreateParamsNonStreaming, 'reasoning_effort'> & {
      reasoning_effort?: OpenAIReasoningEffort;
    };
    const params: ParamsWithReasoningEffort = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    };

    if (reasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }

    const startTime = Date.now();
    const openai = this.openai;
    const response = await callWithTimeout('OpenAI API', options, (signal) =>
      openai.chat.completions.create(params as ChatCompletionCreateParamsNonStreaming, signal ? { signal } : undefined))
      .catch((error: unknown) => { throw openAIQuotaError(error) ?? error; });
    const choice = response.choices?.[0];
    const content = choice?.message?.content ?? '';
    core.debug(sanitizeLogOutput(content.slice(0, 200)));
    if (choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter') {
      core.warning(`OpenAI API reply ended on finish_reason ${choice.finish_reason}`);
      warnReplyTail('OpenAI API', content);
    }
    const refusal = choice?.message?.refusal;
    if (choice?.finish_reason === 'content_filter' || refusal) {
      const reason = refusal ? 'refusal' : 'content_filter';
      throw new RefusalError(`OpenAI API declined the request: ${reason}${refusal ? `. ${sanitizeLogOutput(refusal).slice(0, 300)}` : ''}`, reason);
    }

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
          cacheReadTokens: readCount(sdkUsage.prompt_tokens_details?.cached_tokens),
          cacheWriteTokens: 0,
          reasoningTokens: readCount(sdkUsage.completion_tokens_details?.reasoning_tokens),
        }
      : { ...ZERO_USAGE };

    return { content, usage, latencyMs: Date.now() - startTime, model: this.model, truncated: choice?.finish_reason === 'length' };
  }
}
