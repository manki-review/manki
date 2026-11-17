import { execFile } from 'child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import * as core from '@actions/core';

import { registerSecret } from '../utils';
import { buildExitDiagnostics, callWithTimeout, carryReadings, CliExit, cliEnv, extractCliErrorSnippet, HARD_TIMEOUT_MS, lastLine, MankiCommand, matchQuotaText, pause, readRelatedReads, registerAuthFileSecrets, relatedReadsFile, repoToolsPrompt, runCli, sanitizeLogOutput, seedAuthFile, STALE_TIMEOUT_MS, toolServerCommand, warnReplyTail, withPromptDir } from './cli-utils';
import { LimitUsage, LLMClient, LLMResponse, LLMUsage, OpenAIAuth, QuotaError, readCount, RefusalError, SendMessageOptions, TimeoutError, ZERO_USAGE } from './types';

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

/** Names a Codex window by its length: `5-hour`, `weekly`, or its hours or days. */
function codexWindowName(minutes: number): string {
  if (minutes === 7 * 24 * 60) return 'weekly';
  return minutes % (24 * 60) === 0 ? `${minutes / (24 * 60)}-day` : `${Math.round(minutes / 60)}-hour`;
}

/** Lists the `.jsonl` files under `dir` and its subfolders with their modification times, skipping what cannot be read. */
function listSessionFiles(dir: string): { path: string; mtimeMs: number }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listSessionFiles(path);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return [];
      try {
        return [{ path, mtimeMs: statSync(path).mtimeMs }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Returns the `sessions/YYYY/MM/DD` folders under `codexHome` that can hold a session started since `since`, so the scan
 * never walks the whole history. Codex names them by its own local date, and its time zone can differ from Manki's, so
 * the folders span every zone from UTC-12 to UTC+14.
 */
function sessionFolders(codexHome: string, since: number): string[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const folders = new Set<string>();
  const end = Date.now() + 14 * HOUR_MS;
  for (let time = since - 12 * HOUR_MS; ; time = Math.min(time + DAY_MS, end)) {
    const date = new Date(time);
    folders.add(join(codexHome, 'sessions', String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())));
    if (time >= end) break;
  }
  return [...folders];
}

/**
 * Reads the usage limits Codex recorded as `rate_limits` under `codexHome` since `since`, in milliseconds, from the newest
 * session file that has any. Calls run in parallel, so the newest file can be another call's with none yet. Every file
 * reads the same account. Returns none when nothing was recorded.
 */
export function readCodexLimits(codexHome: string, since: number): LimitUsage[] {
  const files = sessionFolders(codexHome, since).flatMap(dir => listSessionFiles(dir))
    .filter(f => f.mtimeMs >= since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files) {
    const limits = readSessionLimits(file.path);
    if (limits.length > 0) return limits;
  }
  return [];
}

/** Reads the usage limits last recorded in the Codex session file at `path`, or none. */
function readSessionLimits(path: string): LimitUsage[] {
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return [];
  }
  for (const line of lines.reverse()) {
    if (!line.includes('"rate_limits"')) continue;
    let rateLimits: unknown;
    try {
      rateLimits = (JSON.parse(line) as { payload?: { rate_limits?: unknown } }).payload?.rate_limits;
    } catch {
      continue;
    }
    if (!rateLimits || typeof rateLimits !== 'object') continue;
    const { primary, secondary } = rateLimits as { primary?: unknown; secondary?: unknown };
    return [primary, secondary].flatMap(w => {
      const { used_percent: used, window_minutes: minutes, resets_at: resets } = (w ?? {}) as Record<string, unknown>;
      if (typeof used !== 'number' || !Number.isFinite(used) || typeof minutes !== 'number' || minutes <= 0) return [];
      return [{
        account: 'ChatGPT subscription',
        window: codexWindowName(minutes),
        usedPercent: Math.round(used),
        ...(typeof resets === 'number' && Number.isFinite(resets) && { resetsAt: resets }),
      }];
    });
  }
  return [];
}

const OPENAI_OAUTH_BOOTSTRAP_HINT =
  'Bootstrap with `codex login` then `cat ~/.codex/auth.json | base64 | gh secret set OPENAI_OAUTH_TOKEN`. Codex rotates the tokens when it refreshes them, so the stored copy goes stale: re-run the bootstrap when Codex fails to authenticate, or use openai_api_key instead.';

// Pin Codex CLI to a known-good version and disable lifecycle scripts on install
// to mitigate supply-chain risk if a compromised release is published. Keep this
// in sync with the explicit install step in `.github/workflows/manki.yml`.
export const CODEX_CLI_VERSION = '0.166.0';

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function buildOpenAIAuth(oauthToken: string, apiKey: string, baseUrl: string): OpenAIAuth {
  if (baseUrl) {
    if (oauthToken) {
      throw new Error('openai_base_url cannot be used with openai_oauth_token: a ChatGPT login works only on the servers of OpenAI. Remove openai_oauth_token and set openai_api_key to the key of that endpoint.');
    }
    if (!apiKey) throw new Error('openai_base_url is set but openai_api_key is missing. Set openai_api_key to the key of that endpoint.');
    // A URL can carry a password, so the message leaves the value out.
    if (!isHttpUrl(baseUrl)) throw new Error('openai_base_url must be an http or https URL, such as https://host/v1');
    return { kind: 'endpoint', key: apiKey, baseUrl };
  }
  if (oauthToken) return { kind: 'oauth', token: oauthToken };
  if (apiKey) return { kind: 'apiKey', key: apiKey };
  throw new Error('Either openai_oauth_token or openai_api_key must be provided');
}

type OpenAIReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const REASONING_ORDER: readonly OpenAIReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

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
 * when the model rejects the parameter. `max`, and a tier above the model's highest value, become that value.
 * The chat completions API and the Codex CLI accept the same values.
 */
export function resolveReasoningEffort(
  model: string,
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): OpenAIReasoningEffort | undefined {
  const ceiling = maxReasoningEffort(model);
  if (!ceiling) return undefined;
  return effort === 'max' || REASONING_ORDER.indexOf(effort) > REASONING_ORDER.indexOf(ceiling) ? ceiling : effort;
}

/** Maps an SDK 429, a used-up quota (`insufficient_quota`) or a rate limit, to a `QuotaError`. */
function openAIQuotaError(error: unknown): QuotaError | undefined {
  const { status, code, message } = (error ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  if (status !== 429 && code !== 'insufficient_quota' && code !== 'rate_limit_exceeded') return undefined;
  const text = sanitizeLogOutput(String(message ?? '')).slice(0, 500);
  const limit = code === 'insufficient_quota' ? 'OpenAI API quota exhausted' : 'OpenAI API rate limit reached';
  return new QuotaError(`${limit}: ${text}`, limit, matchQuotaText(text)?.resetsAt, 'key');
}

/** The SDK's limit for one API request of a call that sets no `timeoutMs`. The SDK tries a request that ran past it again. */
const API_REQUEST_TIMEOUT_MS = 300_000;

/** Maps the error the SDK throws once its last try of a request ran past `requestTimeoutMs` to a `TimeoutError`. */
function openAITimeoutError(error: unknown, requestTimeoutMs: number): TimeoutError | undefined {
  if (!(error instanceof OpenAI.APIConnectionTimeoutError)) return undefined;
  return new TimeoutError(`OpenAI API timed out after ${requestTimeoutMs / 1000}s per request`, { cause: error });
}

// The line Codex ends its stderr with when the provider reports an overload.
const CAPACITY_ERROR = 'ERROR: Selected model is at capacity. Please try a different model.';
// Codex's own words once every try of one request met a 429. The endpoint named no wait with it.
const THROTTLED_ERROR = /^ERROR: exceeded retry limit, last status: 429\b/;

// Once a request of the run has used tokens, Codex prints their count below its error, which it prints twice.
const ERROR_ABOVE_TOKENS = /\n(ERROR:[^\n]*)\r?\n\1\r?\ntokens used\r?\n\d[\d,]*\s*$/;

/**
 * Returns the `ERROR:` line Codex ended the run on, or `undefined` when the run did not end on an error of Codex's own.
 * Codex prints its own error last on stderr, above the token count when it prints one, then exits with a code and no
 * answer on stdout. It also writes the prompt and the model's text to stderr, so no earlier line counts. A run that a
 * signal ended, or that printed an answer, can end stderr on the model's text, so none of its lines counts.
 */
function codexFinalError({ signal, stderr }: Pick<CliExit, 'signal' | 'stderr'>, stdout: string): string | undefined {
  if (signal || stdout) return undefined;
  const line = ERROR_ABOVE_TOKENS.exec(stderr)?.[1] ?? lastLine(stderr);
  return /^ERROR:\s/.test(line) ? extractCliErrorSnippet(line) : undefined;
}

/** Returns the limit that `finalError`, Codex's final error, reports as a `QuotaError`, or `undefined` when it reports none. */
function codexLimitError(finalError: string | undefined, endpoint: boolean): QuotaError | undefined {
  const atCapacity = finalError === CAPACITY_ERROR;
  const quota = finalError ? matchQuotaText(finalError) : undefined;
  if (!atCapacity && (!quota || quota.overloaded)) return undefined;
  const ownLimit = endpoint ? 'OpenAI endpoint limit reached' : 'ChatGPT subscription limit reached';
  const limit = atCapacity ? 'OpenAI model at capacity' : ownLimit;
  // No other credential gets past a model at capacity.
  const credential = atCapacity ? undefined : endpoint ? 'key' : 'token';
  return new QuotaError(`${limit}: ${finalError}`, limit, quota?.resetsAt, credential);
}

// The variable Codex reads an endpoint's key from, and the id of the model provider Manki defines for the endpoint.
const ENDPOINT_KEY_ENV = 'OPENAI_API_KEY';
const ENDPOINT_PROVIDER = 'manki';

/**
 * Returns the `-c` overrides that send Codex to the OpenAI-compatible endpoint at `baseUrl` instead of OpenAI's own
 * servers. Codex reads the key from `ENDPOINT_KEY_ENV`, so the key is not on the command line and no login file is needed.
 * Codex retries no failed stream, since it would sit out any wait the endpoint names. `sendViaCLI` resumes the session.
 */
function codexEndpointArgs(baseUrl: string): string[] {
  const provider = `model_providers.${ENDPOINT_PROVIDER}`;
  return [
    '-c', `model_provider=${JSON.stringify(ENDPOINT_PROVIDER)}`,
    '-c', `${provider}.name="OpenAI-compatible endpoint"`,
    '-c', `${provider}.base_url=${JSON.stringify(baseUrl)}`,
    '-c', `${provider}.wire_api="responses"`,
    '-c', `${provider}.env_key=${JSON.stringify(ENDPOINT_KEY_ENV)}`,
    '-c', `${provider}.stream_max_retries=0`,
  ];
}

// How often one call resumes its Codex session, and the pause before each resume of a model at capacity or of an
// endpoint that answers 429 and names no wait. The last pause repeats.
const MAX_RESUMES = 8;
const CAPACITY_PAUSES_MS = [5_000, 15_000, 30_000, 60_000];
// The least time a resumed run is started with. Starting Codex again on its session takes about 2 s before the model
// writes anything, and the model then has to write the whole answer.
const MIN_RESUMED_RUN_MS = 30_000;
// Codex's own words for a connection that ended before the answer did. A failure the endpoint words follows the same
// prefix, and so does an answer a content filter cut. Neither is a dropped connection.
const DROPPED_TEXT = /^ERROR: stream disconnected before completion: (?:stream closed before response\.completed|Transport error|idle timeout waiting for SSE)\b/;
// Codex ends the header of its stderr with the session line, and echoes the prompt after it. The match never passes
// the header's end, so no line of the prompt is read as the session. The header is a few hundred characters long.
const HEADER_CHARS = 4000;
const SESSION_ID = /^(?:(?!--------\r?\nuser\r?\n).*\n)*?session id: ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\r?\n--------\r?\nuser\r?\n/;
const RESUME_PROMPT = 'The connection to the model failed. Continue the task where it stopped, and give your answer in the format the task asked for.';
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

/** Reads a wait worded as a duration, such as `in 3s`, `in 320ms` or `in 1m30s`, in milliseconds. Any other text has none. */
function advisedWaitMs(resetsAt = ''): number | undefined {
  if (!/^in (?:\d+(?:\.\d+)?(?:ms|[hms]))+$/.test(resetsAt)) return undefined;
  return Math.ceil([...resetsAt.matchAll(/(\d+(?:\.\d+)?)(ms|[hms])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * UNIT_MS[unit], 0));
}

/**
 * Returns why the stream of a Codex run failed and how long to pause before resume number `resume` of the call, or
 * `undefined` when `finalError` reports anything else, such as a bad key, a refusal or a used-up quota.
 */
function streamFailure(finalError: string | undefined, resume: number): { reason: string; pauseMs: number } | undefined {
  if (!finalError) return undefined;
  if (DROPPED_TEXT.test(finalError)) return { reason: 'connection dropped', pauseMs: 0 };
  const backoffMs = CAPACITY_PAUSES_MS[Math.min(resume, CAPACITY_PAUSES_MS.length) - 1];
  if (finalError === CAPACITY_ERROR) return { reason: 'model at capacity', pauseMs: backoffMs };
  if (THROTTLED_ERROR.test(finalError)) return { reason: 'rate limit', pauseMs: backoffMs };
  const quota = matchQuotaText(finalError);
  const pauseMs = quota && !quota.overloaded ? advisedWaitMs(quota.resetsAt) : undefined;
  return pauseMs === undefined ? undefined : { reason: 'rate limit', pauseMs };
}

/**
 * Returns the arguments of a `codex exec` run of `model`, before the tool server and the instructions, sent to the
 * endpoint at `baseUrl` when one is set. `codex exec` reads the prompt from stdin when `-` is the prompt argument.
 * `runCli` runs it in an empty directory, which is not a git repository.
 */
export function codexExecArgs(model: string, baseUrl?: string): string[] {
  // The read-only sandbox still lets tools read every file, such as the auth files, so every built-in tool
  // that reads files or reaches the network or an account is off, and only Manki's tool server is left.
  return [
    'exec', '--skip-git-repo-check', `--model=${model}`, '--sandbox', 'read-only', '-c', 'approval_policy=never',
    '-c', 'features.shell_tool=false', '-c', 'features.view_image=false', '-c', 'web_search=disabled', '-c', 'features.apps=false',
    '-c', 'features.plugins=false', '-c', 'features.multi_agent=false', '-c', 'features.image_generation=false',
    ...(baseUrl ? codexEndpointArgs(baseUrl) : []),
  ];
}

/**
 * Returns the `-c` overrides that give Codex Manki's tool server. Its tools are read-only, so they run without
 * approval. Codex starts the server with a few default variables only, so `env_vars` names the rest of the CLI's own
 * environment, such as the runner temp folder, the proxy settings and the GitHub API URL `repo_info` needs. Codex reads
 * their values from its own environment, so none of them, such as a proxy password, lands on the command line.
 * `ENDPOINT_KEY_ENV` is not named, so the server never gets an endpoint's key.
 */
export function codexToolServerArgs({ command, args }: MankiCommand, env: NodeJS.ProcessEnv): string[] {
  return [
    '-c', `mcp_servers.manki.command=${JSON.stringify(command)}`,
    '-c', `mcp_servers.manki.args=${JSON.stringify(args)}`,
    '-c', 'mcp_servers.manki.default_tools_approval_mode="approve"',
    '-c', `mcp_servers.manki.env_vars=${JSON.stringify(Object.keys(env).filter(name => name !== 'CODEX_HOME' && name !== ENDPOINT_KEY_ENV))}`,
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
      this.openai = new OpenAI({ apiKey: this.auth.key, timeout: API_REQUEST_TIMEOUT_MS });
    } else if (this.auth.kind === 'endpoint') {
      registerSecret(this.auth.key);
    }
  }

  get repoTools(): boolean {
    return this.auth.kind !== 'apiKey';
  }

  sentEffort(effort: OpenAIReasoningEffort): OpenAIReasoningEffort | undefined {
    return resolveReasoningEffort(this.model, effort);
  }

  async sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    if (this.auth.kind === 'apiKey') {
      return this.sendViaAPI(systemPrompt, userMessage, options);
    }
    return this.sendViaCLI(systemPrompt, userMessage, options);
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

  private async sendViaCLI(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse> {
    const repoTools = options?.repoTools;
    const toolsPrompt = repoTools ? `\n\n${repoToolsPrompt(repoTools, '`read_file`, `grep` and `glob`')}` : '';
    const instructions = `${systemPrompt}${toolsPrompt}`;
    const codexHome = resolveCodexHome();
    const oauthToken = this.auth.kind === 'oauth' ? this.auth.token : undefined;
    const endpoint = this.auth.kind === 'endpoint' ? this.auth : undefined;
    const model = this.model;
    if (oauthToken) {
      seedAuthFile({
        secret: oauthToken,
        inputName: 'openai_oauth_token',
        targetPath: join(codexHome, 'auth.json'),
        requiredFields: ['tokens.access_token', 'tokens.refresh_token'],
        bootstrapHint: OPENAI_OAUTH_BOOTSTRAP_HINT,
      });
    } else {
      // Codex exits when its home does not exist, and only the login path creates it, by writing `auth.json`.
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    }
    const cliPath = await this.ensureCLI();
    const startTime = Date.now();
    const limitMs = options?.timeoutMs ?? HARD_TIMEOUT_MS;
    // A failed run keeps the readings too, since a used-up limit is when they matter most.
    const limitReadings = () => {
      const limits = readCodexLimits(codexHome, startTime);
      return limits.length > 0 ? { limits } : {};
    };

    const args = codexExecArgs(this.model, endpoint?.baseUrl);

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
    const env = cliEnv('codex', {
      CODEX_HOME: codexHome,
      ...(repoTools && apiUrl && { GITHUB_API_URL: apiUrl }),
      ...(endpoint && { [ENDPOINT_KEY_ENV]: endpoint.key }),
    }, endpoint && ENDPOINT_KEY_ENV);

    let output = '';
    const { code, signal, stderr, lastStdoutChunk, relatedReads } = await withPromptDir(async (promptDir) => {
      // Manki's instructions replace Codex's own, so stdin carries only the untrusted content.
      const instructionsPath = join(promptDir, 'instructions.md');
      writeFileSync(instructionsPath, instructions, { mode: 0o600 });
      const readsFile = relatedReadsFile(promptDir);
      // A resumed run starts a new tool server, which counts on from the earlier ones in this folder.
      const stepsDir = endpoint && repoTools ? join(promptDir, 'steps') : undefined;
      if (stepsDir) mkdirSync(stepsDir);
      const toolArgs = repoTools
        ? codexToolServerArgs(toolServerCommand(repoTools.root, { fileTools: true, steps: repoTools.steps, stepsDir, related: repoTools.related, readsFile }), env)
        : [];
      const reads = () => (repoTools?.related ? readRelatedReads(readsFile) : undefined);
      const carry = (error: unknown): never => { throw carryReadings(error, { relatedReads: reads(), ...limitReadings() }); };
      const run = (runArgs: string[], input: string, usedMs?: number): Promise<CliExit> => runCli({
        label: 'Codex',
        cliPath,
        args: [...args, ...toolArgs, '-c', `model_instructions_file=${JSON.stringify(instructionsPath)}`, ...runArgs],
        env,
        input,
        hardTimeoutMs: limitMs,
        usedMs,
        signal: options?.signal,
        onStdout: (chunk) => { output += chunk; },
      }).catch(carry);
      let exit = await run(['-'], userMessage);
      const session = endpoint && SESSION_ID.exec(exit.stderr.slice(0, HEADER_CHARS))?.[1];
      for (let resume = 1; session && exit.code !== 0 && resume <= MAX_RESUMES; resume++) {
        const finalError = codexFinalError(exit, output);
        const failure = streamFailure(finalError, resume);
        // A resume whose pause leaves the resumed run too little of the call's time is not started, so the call fails
        // on this run's error.
        if (!failure || Date.now() - startTime + failure.pauseMs + MIN_RESUMED_RUN_MS > limitMs) break;
        core.info(`Codex stream failed (${failure.reason}). Resuming the session in ${failure.pauseMs / 1000}s, resume ${resume} of ${MAX_RESUMES}.`);
        if (failure.pauseMs > 0) await pause(failure.pauseMs, options?.signal).catch(carry);
        exit = await run(['resume', session, '-'], RESUME_PROMPT, Date.now() - startTime).catch((error: unknown) => {
          // A call that runs out of time after a limit fails as that limit, since a new call would meet it again.
          const limitError = error instanceof TimeoutError ? codexLimitError(finalError, !!endpoint) : undefined;
          if (!limitError) throw error;
          core.warning(limitError.message);
          return carry(Object.assign(limitError, { cause: error }));
        });
      }
      return { ...exit, relatedReads: reads() };
    }).catch((error: unknown) => {
      warnReplyTail('Codex CLI', output);
      throw error;
    }).finally(() => registerAuthFileSecrets(join(codexHome, 'auth.json')));

    const limits = limitReadings();
    if (code !== 0) {
      const limitError = codexLimitError(codexFinalError({ signal, stderr }, output), !!endpoint);
      if (limitError) {
        core.warning(limitError.message);
        throw carryReadings(limitError, { relatedReads, ...limits });
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
      throw carryReadings(new Error(`Codex CLI invocation failed (${msg})`), { relatedReads, ...limits });
    }
    const content = output.trim();
    core.debug(sanitizeLogOutput(content.slice(0, 200)));
    return {
      content,
      latencyMs: Date.now() - startTime,
      model: this.model,
      ...(relatedReads && { relatedReads }),
      ...limits,
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
    // The SDK's timer for a request starts after the signal of `callWithTimeout` and runs as long, so the signal ends
    // the request first. The SDK sends no request again once that signal has aborted.
    const requestTimeoutMs = options?.timeoutMs || API_REQUEST_TIMEOUT_MS;
    const response = await callWithTimeout('OpenAI API', options, (signal) =>
      openai.chat.completions.create(params as ChatCompletionCreateParamsNonStreaming, { timeout: requestTimeoutMs, ...(signal && { signal }) }))
      .catch((error: unknown) => { throw openAIQuotaError(error) ?? openAITimeoutError(error, requestTimeoutMs) ?? error; });
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
