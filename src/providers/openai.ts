import { execFile } from 'child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import * as core from '@actions/core';

import { registerSecret, safeJsonParse } from '../utils';
import { advisedWaitMs, buildExitDiagnostics, callWithTimeout, carryReadings, CliExit, cliEnv, cliHome, fileReadBy, HARD_TIMEOUT_MS, MankiCommand, matchQuotaText, pause, readRelatedReads, registerAuthFileSecrets, relatedReadsFile, repoToolsPrompt, resultChars, runCli, sanitizeLogOutput, seedAuthFile, STALE_TIMEOUT_MS, toolServerCommand, warnReplyTail, withPromptDir } from './cli-utils';
import { LimitUsage, LLMClient, LLMResponse, LLMUsage, OpenAIAuth, oneRequest, QuotaError, readCount, RefusalError, SendMessageOptions, TimeoutError, ToolStep, withLargestRequest, ZERO_USAGE } from './types';
import { checkLoginFilePath, withLoginFile } from './codex-login-file';

const execFileAsync = promisify(execFile);

// Re-export for existing test imports.
export { STALE_TIMEOUT_MS };

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

/**
 * Returns the input tokens of each request of the Codex session `session` under `codexHome`, from the `token_count` events
 * of its session file, or none when they do not add up. Each request adds its `last_token_usage` to `total_token_usage`,
 * and an event that adds nothing repeats the last request.
 */
function readCodexRequestInputs(codexHome: string, session: string, since: number): number[] {
  const file = sessionFolders(codexHome, since).flatMap(dir => listSessionFiles(dir)).find(f => f.path.endsWith(`-${session}.jsonl`));
  let lines: string[];
  try {
    lines = file ? readFileSync(file.path, 'utf8').split('\n') : [];
  } catch {
    return [];
  }
  const inputs: number[] = [];
  let total = 0;
  for (const line of lines) {
    if (!line.includes('"token_count"')) continue;
    const payload = (safeJsonParse(line) as { payload?: { type?: unknown; info?: unknown } } | null)?.payload;
    if (payload?.type !== 'token_count' || !payload.info || typeof payload.info !== 'object') continue;
    const info = payload.info as { total_token_usage?: { input_tokens?: unknown }; last_token_usage?: { input_tokens?: unknown } };
    const next = readCount(info.total_token_usage?.input_tokens);
    if (next === total) continue;
    const request = readCount(info.last_token_usage?.input_tokens);
    if (next !== total + request) return [];
    inputs.push(request);
    total = next;
  }
  return inputs;
}

const OPENAI_OAUTH_BOOTSTRAP_HINT =
  'Bootstrap with `codex login` then `cat ~/.codex/auth.json | base64 | gh secret set OPENAI_OAUTH_TOKEN`. Codex rotates the tokens when it refreshes them, so the stored copy goes stale: re-run the bootstrap when Codex fails to authenticate, or use openai_api_key instead.';

// Pin Codex CLI to a known-good version and disable lifecycle scripts on install
// to mitigate supply-chain risk if a compromised release is published. Keep this
// in sync with the explicit install step in `.github/workflows/manki.yml`. The `Codex tools` workflow checks the
// tools this version offers a model against `scripts/fixtures/codex-tools.json`.
export const CODEX_CLI_VERSION = '0.166.0';

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function buildOpenAIAuth(oauthToken: string, apiKey: string, baseUrl: string, oauthFile = ''): OpenAIAuth {
  if (oauthToken && oauthFile) throw new Error('openai_oauth_token and openai_oauth_file are both set. Set only one of them: the file on a self-hosted runner, the token anywhere else.');
  if (baseUrl) {
    for (const [name, value] of [['openai_oauth_token', oauthToken], ['openai_oauth_file', oauthFile]]) {
      if (value) throw new Error(`openai_base_url cannot be used with ${name}: a ChatGPT login works only on the servers of OpenAI. Remove ${name} and set openai_api_key to the key of that endpoint.`);
    }
    if (!apiKey) throw new Error('openai_base_url is set but openai_api_key is missing. Set openai_api_key to the key of that endpoint.');
    // A URL can carry a password, so the message leaves the value out.
    if (!isHttpUrl(baseUrl)) throw new Error('openai_base_url must be an http or https URL, such as https://host/v1');
    return { kind: 'endpoint', key: apiKey, baseUrl };
  }
  if (oauthToken) return { kind: 'oauth', token: oauthToken };
  if (oauthFile) {
    checkLoginFilePath(oauthFile);
    return { kind: 'oauthFile', path: oauthFile };
  }
  if (apiKey) return { kind: 'apiKey', key: apiKey };
  throw new Error('Either openai_oauth_token, openai_oauth_file or openai_api_key must be provided');
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

// Codex's own error when the provider reports an overload.
const CAPACITY_ERROR = 'Selected model is at capacity. Please try a different model.';
// Codex's own words once every try of one request met a 429. The endpoint named no wait with it.
const THROTTLED_ERROR = /^exceeded retry limit, last status: 429\b/;

// The events `codex exec --json` prints on stdout, one JSON object per line, in the runs measured with Codex 0.166.0.
const CODEX_EVENTS = new Set(['thread.started', 'turn.started', 'item.started', 'item.completed', 'error', 'turn.completed', 'turn.failed']);
// The note of an `error` event while Codex waits before it sends a failed request again.
const RETRY_NOTE = /^Reconnecting\.\.\. \d+\/\d+ /;
// A session goes on the command line of a resumed run, so only an id in the form Codex gives it counts.
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// The longest error of Codex's own that a message quotes.
const MAX_ERROR_CHARS = 16_384;

type CodexEvent = { type: string } & Record<string, unknown>;

/** What a `codex exec --json` run printed on stdout. */
interface CodexRunEvents {
  /** The session of the run, from `thread.started`. */
  session?: string;
  /** The text of the last `agent_message` of a turn that ended with `turn.completed`. */
  answer?: string;
  /** The token counts of the `turn.completed` that gave `answer`. Unset when it carried none. */
  usage?: LLMUsage;
  /** Codex's own error, from the `turn.failed` that ended the turn. */
  failure?: string;
  /** The text of the last `agent_message`, also of a turn that failed or did not end. */
  reply?: string;
}

/** Reads `line` as an event of `CODEX_EVENTS`, or `undefined` when it is anything else. */
function parseCodexEvent(line: string): CodexEvent | undefined {
  const event = safeJsonParse(line) as { type?: unknown } | null;
  return typeof event?.type === 'string' && CODEX_EVENTS.has(event.type) ? event as CodexEvent : undefined;
}

const textOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const agentMessage = (event: CodexEvent): string | undefined => {
  const item = event.item as { type?: unknown; text?: unknown } | undefined;
  return event.type === 'item.completed' && item?.type === 'agent_message' ? textOf(item.text) : undefined;
};

/** A call of Manki's tool server that a Codex event starts or ends. */
interface CodexToolCall {
  id: string;
  /** The tool, named as the Claude CLI names a tool of the same server. */
  tool: string;
  arguments: unknown;
  /** The characters of text the result gave the model, on the event that ends the call. */
  resultChars?: number;
}

/** Returns the call of Manki's tool server that `event` starts or ends, or `undefined` when it is none. */
function toolCall(event: CodexEvent | undefined): CodexToolCall | undefined {
  const item = event?.item as { type?: unknown; id?: unknown; server?: unknown; tool?: unknown; arguments?: unknown; result?: { content?: unknown } | null; error?: { message?: unknown } | null } | undefined;
  const id = textOf(item?.id);
  if ((event?.type !== 'item.started' && event?.type !== 'item.completed') || item?.type !== 'mcp_tool_call' || id === undefined) return undefined;
  return {
    id,
    tool: `mcp__${textOf(item.server) ?? ''}__${textOf(item.tool) ?? ''}`,
    arguments: item.arguments,
    ...(event.type === 'item.completed' && { resultChars: resultChars(item.result ? item.result.content : item.error?.message) }),
  };
}

/** Reads the token counts of a `turn.completed` event's `usage`, or `undefined` when it has none. */
function codexUsage(value: unknown): LLMUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: readCount(usage.input_tokens),
    outputTokens: readCount(usage.output_tokens),
    cacheReadTokens: readCount(usage.cached_input_tokens),
    cacheWriteTokens: 0,
    reasoningTokens: readCount(usage.reasoning_output_tokens),
  };
}

/**
 * Reads the events a `codex exec --json` run that exited with `code` printed on `stdout`. The model's text arrives inside
 * a JSON string, so no text of the model can pass for an event. A run gives an answer or Codex's own error only in the
 * sequence measured: every line is an event, `thread.started` comes first, one turn starts and one event ends it, and
 * that event comes last. Codex exits with 0 after `turn.completed` and with 1 after `turn.failed`. Any other run has neither.
 */
function readCodexEvents(stdout: string, { code, signal }: Pick<CliExit, 'code' | 'signal'> = { code: null, signal: null }): CodexRunEvents {
  const lines = stdout.split('\n');
  // The text after the last line break is a line that a killed run did not end.
  const cut = lines.pop() !== '';
  const parsed = lines.map(parseCodexEvent);
  const events = parsed.filter((event): event is CodexEvent => event !== undefined);
  const id = events[0]?.type === 'thread.started' ? textOf(events[0].thread_id) : undefined;
  const session = id && SESSION_ID.test(id) ? id : undefined;
  const turns = events.filter(event => event.type === 'turn.started');
  const ends = events.filter(event => event.type === 'turn.completed' || event.type === 'turn.failed');
  const last = events.at(-1);
  const measured = !cut && !signal && events.length === parsed.length && session !== undefined && turns.length === 1 && ends.length === 1 && last === ends[0];
  const messages = (from: CodexEvent[]) => from.map(agentMessage).filter((text): text is string => text !== undefined);
  const answer = measured && code === 0 && last.type === 'turn.completed' ? messages(events.slice(events.indexOf(turns[0]))).at(-1) ?? '' : undefined;
  const usage = answer !== undefined ? codexUsage(last?.usage) : undefined;
  const failure = measured && code === 1 && last.type === 'turn.failed' ? textOf((last.error as { message?: unknown } | undefined)?.message) : undefined;
  const reply = messages(events).at(-1);
  return {
    ...(session && { session }),
    ...(answer !== undefined && { answer }),
    ...(usage && { usage }),
    ...(failure && { failure: sanitizeLogOutput(failure).slice(0, MAX_ERROR_CHARS) }),
    ...(reply !== undefined && { reply }),
  };
}

/** Returns the event on the last line of `stdout`, or `undefined` when that line is no event or has not ended. */
function lastEvent(stdout: string): CodexEvent | undefined {
  if (!stdout.endsWith('\n')) return undefined;
  return parseCodexEvent(stdout.slice(stdout.lastIndexOf('\n', stdout.length - 2) + 1, -1));
}

/** Returns the message of the last event on `stdout`, when it is Codex's `error` event saying it retries a failed request. */
function retryNote(stdout: string): string | undefined {
  const last = lastEvent(stdout);
  const message = last?.type === 'error' ? textOf(last.message) : undefined;
  return message && RETRY_NOTE.test(message) ? message : undefined;
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
const DROPPED_TEXT = /^stream disconnected before completion: (?:stream closed before response\.completed|Transport error|idle timeout waiting for SSE)\b/;
// Codex's note when it cannot reach the provider at all, as when the connection is refused, the host does not resolve
// or TLS fails. It then tries again after a wait that grows to about a minute, and never gives up within the call.
const WAITING_NOTE = 'Reconnecting... waiting for network';
// The notes measured, all `(Connection failed: error sending request)`. Codex words them itself after a failed connect,
// while a failure the provider words starts with another prefix, so the cause after `Connection failed:` can vary.
const NO_NETWORK_NOTE = /^Reconnecting\.\.\. waiting for network \(Connection failed: [^\n]+\)$/;
// How long a run may report nothing but `WAITING_NOTE` before it ends. Codex tries five times within it.
const NO_NETWORK_LIMIT_MS = 120_000;
// The warning Codex gives before the turn for a model it has no metadata for, as for a model only an endpoint serves.
const NO_METADATA = /^Model metadata for `[^`\n]+` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.$/;

const messageOf = (event: CodexEvent): string => textOf(event.message) ?? '';
const isWaiting = (event: CodexEvent): boolean => event.type === 'error' && messageOf(event).startsWith(`${WAITING_NOTE} (`);
const isNoNetwork = (event: CodexEvent): boolean => event.type === 'error' && NO_NETWORK_NOTE.test(messageOf(event));
const isNoMetadata = (event: CodexEvent): boolean => {
  const item = event.item as { type?: unknown; message?: unknown } | undefined;
  return event.type === 'item.completed' && item?.type === 'error' && NO_METADATA.test(textOf(item.message) ?? '');
};

/** Returns where the `WAITING_NOTE` events that end `stdout` start, or `undefined` when it does not end on one. */
function waitingSince(stdout: string): number | undefined {
  let since: number | undefined;
  for (let end = stdout.length; stdout[end - 1] === '\n';) {
    const start = stdout.lastIndexOf('\n', end - 2) + 1;
    const event = parseCodexEvent(stdout.slice(start, end - 1));
    if (!event || !isWaiting(event)) break;
    since = end = start;
  }
  return since;
}

/**
 * Whether the events of a run prove that no request reached the model: every line is an event, `thread.started` comes
 * first, then at most the `NO_METADATA` warning, then `turn.started`, and after it only `NO_NETWORK_NOTE` events. Any
 * other event can follow a request the provider received. On a ChatGPT login Codex first retries over WebSocket, and
 * those retries read the same as a failure the provider words itself, so they prove nothing.
 */
function reachedNoModel(stdout: string): boolean {
  const lines = stdout.split('\n');
  if (lines.pop() !== '') return false;
  const parsed = lines.map(parseCodexEvent);
  if (!parsed.every(event => event !== undefined)) return false;
  const [started, ...rest] = parsed as CodexEvent[];
  const [turn, ...notes] = rest[0] && isNoMetadata(rest[0]) ? rest.slice(1) : rest;
  return started?.type === 'thread.started' && turn?.type === 'turn.started' && notes.length > 0 && notes.every(isNoNetwork);
}
const RESUME_PROMPT = 'The connection to the model failed. Continue the task where it stopped, and give your answer in the format the task asked for.';

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
  // The read-only sandbox still lets tools read every file, such as the auth files, so every built-in tool Codex can
  // switch off is off. `docs/security.md` lists the few Codex keeps for some models and what they can reach.
  return [
    'exec', '--json', '--skip-git-repo-check', `--model=${model}`, '--sandbox', 'read-only', '-c', 'approval_policy=never',
    '-c', 'features.shell_tool=false', '-c', 'features.view_image=false', '-c', 'web_search=disabled', '-c', 'features.apps=false',
    '-c', 'features.plugins=false', '-c', 'features.multi_agent=false', '-c', 'features.image_generation=false',
    '-c', 'agents.enabled=false', '-c', 'features.goals=false', '-c', 'features.sleep_tool=false',
    '-c', 'tools.experimental_request_user_input.enabled=false',
    // No analytics leave the machine, and Codex's built-in skills add no text to the prompt.
    '-c', 'analytics.enabled=false', '-c', 'skills.bundled.enabled=false',
    ...(baseUrl ? codexEndpointArgs(baseUrl) : []),
  ];
}

/**
 * Returns the `-c` overrides that give Codex Manki's tool server. Its tools are read-only, so they run without
 * approval. Codex starts the server with a few default variables only, so `env_vars` names the rest of the CLI's own
 * environment, such as the runner temp folder, the proxy settings and the GitHub API URL `repo_info` needs. Codex reads
 * their values from its own environment, so none of them, such as a proxy password, lands on the command line.
 * `ENDPOINT_KEY_ENV` is not named, so the server never gets an endpoint's key. Codex waits for a required server
 * before its first request, so a server that starts slowly still has its tools in it, and one that fails ends the run.
 */
export function codexToolServerArgs({ command, args }: MankiCommand, env: NodeJS.ProcessEnv): string[] {
  return [
    '-c', `mcp_servers.manki.command=${JSON.stringify(command)}`,
    '-c', `mcp_servers.manki.args=${JSON.stringify(args)}`,
    '-c', 'mcp_servers.manki.default_tools_approval_mode="approve"',
    '-c', 'mcp_servers.manki.required=true',
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
    const home = cliHome('codex');
    const oauthToken = this.auth.kind === 'oauth' ? this.auth.token : undefined;
    const endpoint = this.auth.kind === 'endpoint' ? this.auth : undefined;
    const model = this.model;
    if (oauthToken) {
      seedAuthFile({
        secret: oauthToken,
        inputName: 'openai_oauth_token',
        targetPath: join(home, 'auth.json'),
        requiredFields: ['tokens.access_token', 'tokens.refresh_token'],
        bootstrapHint: OPENAI_OAUTH_BOOTSTRAP_HINT,
      });
    }
    const cliPath = await this.ensureCLI();
    const startTime = Date.now();
    const limitMs = options?.timeoutMs ?? HARD_TIMEOUT_MS;
    // A failed run keeps the readings too, since a used-up limit is when they matter most.
    const limitReadings = () => {
      const limits = readCodexLimits(home, startTime);
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
      ...(repoTools && apiUrl && { GITHUB_API_URL: apiUrl }),
      ...(endpoint && { [ENDPOINT_KEY_ENV]: endpoint.key }),
    }, endpoint && ENDPOINT_KEY_ENV);

    // The stdout of the run that runs now, or ran last.
    let output = '';
    // The tool steps and files read of every run of the call, since a resumed run goes on with the same budget.
    const toolSteps: ToolStep[] = [];
    const filesRead = new Set<string>();
    const fileReadings = () => (filesRead.size > 0 ? { filesRead: [...filesRead] } : {});
    const unreachableLimit = endpoint ? 'OpenAI endpoint unreachable' : 'OpenAI unreachable';
    const call = () => withPromptDir(async (promptDir) => {
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
      const carry = (error: unknown): never => { throw carryReadings(error, { relatedReads: reads(), ...fileReadings(), ...limitReadings() }); };
      const run = async (runArgs: string[], input: string, usedMs?: number): Promise<CliExit & { events: CodexRunEvents }> => {
        output = '';
        // Where the lines of `output` not read for tool calls yet start, and when each call of this run was seen to
        // start. A call starts and ends once, but Codex can report only its end.
        let unread = 0;
        const starts = new Map<string, number | undefined>();
        const ended = new Set<string>();
        const readToolCalls = (): void => {
          for (let end = output.indexOf('\n', unread); end !== -1; end = output.indexOf('\n', unread)) {
            const call = toolCall(parseCodexEvent(output.slice(unread, end)));
            unread = end + 1;
            if (call === undefined || ended.has(call.id)) continue;
            if (!starts.has(call.id)) {
              starts.set(call.id, call.resultChars === undefined ? Date.now() : undefined);
              options?.onToolStep?.();
            }
            if (call.resultChars === undefined) continue;
            ended.add(call.id);
            const start = starts.get(call.id);
            const file = fileReadBy(call.tool, call.arguments, repoTools?.root);
            if (file) filesRead.add(file);
            toolSteps.push({ tool: call.tool, ...(start !== undefined && { durationMs: Date.now() - start }), ...(file && { file }), resultChars: call.resultChars });
          }
        };
        const exit = await runCli({
          label: 'Codex',
          cliPath,
          args: [...args, ...toolArgs, '-c', `model_instructions_file=${JSON.stringify(instructionsPath)}`, ...runArgs],
          env,
          input,
          hardTimeoutMs: limitMs,
          // Waiting for the lock of a login file counts against the limit too.
          usedMs: usedMs ?? Date.now() - startTime,
          signal: options?.signal,
          waiting: {
            since: () => waitingSince(output), note: WAITING_NOTE, limitMs: NO_NETWORK_LIMIT_MS, doing: 'waiting for the network',
            // A resumed run follows a run that reached the model.
            unreachable: () => usedMs === undefined && reachedNoModel(output) ? unreachableLimit : undefined,
          },
          retrying: () => retryNote(output),
          onStdout: (chunk) => {
            output += chunk;
            readToolCalls();
          },
        }).catch(carry);
        return { ...exit, events: readCodexEvents(output, exit) };
      };
      let exit = await run(['-'], userMessage);
      const session = endpoint && exit.events.session;
      for (let resume = 1; session && exit.events.answer === undefined && resume <= MAX_RESUMES; resume++) {
        const finalError = exit.events.failure;
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
    });
    const loginFile = this.auth.kind === 'oauthFile' ? this.auth.path : undefined;
    const { code, signal, stderr, lastStdoutChunk, events, relatedReads } = await (loginFile
      ? withLoginFile(loginFile, join(home, 'auth.json'), { limitMs, signal: options?.signal, runner: { cliPath, env } }, call)
      : call()
    ).catch((error: unknown) => {
      warnReplyTail('Codex CLI', readCodexEvents(output).reply ?? '');
      throw error;
    }).finally(() => registerAuthFileSecrets(join(home, 'auth.json')));

    const limits = limitReadings();
    if (events.answer === undefined) {
      const limitError = codexLimitError(events.failure, !!endpoint);
      if (limitError) {
        core.warning(limitError.message);
        throw carryReadings(limitError, { relatedReads, ...fileReadings(), ...limits });
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
        resultEvent: events.failure ? { error: { message: events.failure } } : null,
      });
      core.warning(`Codex CLI failed (${msg})`);
      warnReplyTail('Codex CLI', events.reply ?? '');
      throw carryReadings(new Error(`Codex CLI invocation failed (${msg})`), { relatedReads, ...fileReadings(), ...limits });
    }
    const content = events.answer.trim();
    core.debug(sanitizeLogOutput(content.slice(0, 200)));
    return {
      content,
      // Codex counts the whole session in `turn.completed`, so the last run's counts cover the runs it resumed.
      ...(events.usage && { usage: events.session ? withLargestRequest(events.usage, readCodexRequestInputs(home, events.session, startTime)) : events.usage }),
      latencyMs: Date.now() - startTime,
      model: this.model,
      ...((toolSteps.length > 0 || repoTools) && { toolSteps }),
      ...(relatedReads && { relatedReads }),
      ...fileReadings(),
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
      ? oneRequest({
          inputTokens: readCount(sdkUsage.prompt_tokens),
          outputTokens: readCount(sdkUsage.completion_tokens),
          cacheReadTokens: readCount(sdkUsage.prompt_tokens_details?.cached_tokens),
          cacheWriteTokens: 0,
          reasoningTokens: readCount(sdkUsage.completion_tokens_details?.reasoning_tokens),
        })
      : { ...ZERO_USAGE };

    return { content, usage, latencyMs: Date.now() - startTime, model: this.model, truncated: choice?.finish_reason === 'length' };
  }
}
