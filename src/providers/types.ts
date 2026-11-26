import type { RelatedRepoTools } from '../types';

export type ProviderName = 'anthropic' | 'openai' | 'gemini';

/** Token counts of one or more calls. `inputTokens` includes the cache reads and writes, `outputTokens` the reasoning. */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** The part of `cacheWriteTokens` cached for an hour rather than five minutes. Unset when no call reported the split. */
  cacheWrite1hTokens?: number;
  /** The input tokens of the call's largest request, cache reads and writes included. Unset when only the sum over its requests is known. */
  largestRequestInputTokens?: number;
  /** The largest request the client saw when it did not see them all, so the largest is at least this. Unset when `largestRequestInputTokens` is known. */
  largestSeenRequestInputTokens?: number;
}

export interface LLMResponse {
  content: string;
  usage?: LLMUsage;
  latencyMs?: number;
  /** Model that answered. */
  model?: string;
  /** Whether the provider reports that the output stopped at its token limit. Unset when the provider does not expose a stop reason. */
  truncated?: boolean;
  /**
   * The tools the model called while it answered, in order. Empty when the call had repository tools and the model
   * called none. Unset when the call had no tools, or when the client does not report the steps of a call.
   */
  toolSteps?: ToolStep[];
  /** Tool calls that read each related repo, by `owner/name`. Unset when none did. */
  relatedReads?: Record<string, number>;
  /** Tool calls Manki's tool server refused because they named a path the repository's `closed_paths` closes. Unset when none did. */
  closedCalls?: number;
  /** The files the model's tool calls read, each once, relative to the repository root. Unset when it read none. */
  filesRead?: string[];
  /** The subscription usage limits the CLI reported for its account. Unset when it reported none. */
  limits?: LimitUsage[];
  /** Set when the last message of the reply went on from messages cut at the output limit. */
  cut?: CutReply;
}

/** The messages of a reply that the output limit cut right before its last message. */
export interface CutReply {
  /** How many messages in a row were cut before the last one. */
  messages: number;
  /** Whether the cut text and the last message made one answer, so the reply joined them. */
  joined: boolean;
}

/** How much of one subscription usage window an account has used. */
export interface LimitUsage {
  /** The account, named by its subscription, such as `Claude subscription`. */
  account: string;
  /** The window, such as `5-hour` or `weekly`. */
  window: string;
  /** Share of the window used, from 0 to 100. */
  usedPercent: number;
  /** When the window resets, in Unix seconds. */
  resetsAt?: number;
}

/**
 * Coerce a candidate JSON value to a non-negative integer. Accepts both
 * number and string shapes — some CLI providers serialise token counts as
 * strings on edge code paths. Clamps anything non-numeric to zero.
 */
export function readCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return 0;
}

export const ZERO_USAGE: LLMUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

/**
 * Returns `usage` with `largestRequestInputTokens` set from `requestInputs`, the input tokens of each request of the call.
 * When they do not add up to `usage.inputTokens`, a request the client did not see could be the largest, so it sets
 * `largestSeenRequestInputTokens` instead.
 */
export function withLargestRequest(usage: LLMUsage, requestInputs: readonly number[]): LLMUsage {
  const sum = requestInputs.reduce((total, tokens) => total + tokens, 0);
  if (sum <= 0) return usage;
  const largest = Math.max(...requestInputs);
  return sum === usage.inputTokens ? { ...usage, largestRequestInputTokens: largest } : { ...usage, largestSeenRequestInputTokens: largest };
}

/** Returns `usage` of a call that made one request, which is then its largest. */
export function oneRequest(usage: LLMUsage): LLMUsage {
  return withLargestRequest(usage, [usage.inputTokens]);
}

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  const reported = a.cacheWrite1hTokens !== undefined || b.cacheWrite1hTokens !== undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    ...(reported && { cacheWrite1hTokens: (a.cacheWrite1hTokens ?? 0) + (b.cacheWrite1hTokens ?? 0) }),
  };
}

/**
 * Thrown when a provider's safety or usage-policy filter declines the request. Another model can
 * often serve the same request, so callers may retry it there. `reason` names the provider's signal.
 */
export class RefusalError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'RefusalError';
  }
}

/**
 * Thrown when a provider refuses a request because a quota, rate limit or capacity limit is used up.
 * Sending it again to the same model before `resetsAt` fails the same way, so callers never retry it there.
 * A stage with a fallback model sends it there once (`withModelFallback`).
 * `limit` says which limit, such as "Claude subscription limit reached".
 * `credential` names what the user can swap to get past it, and is unset when no other one helps.
 */
export class QuotaError extends Error {
  constructor(message: string, readonly limit: string, readonly resetsAt?: string, readonly credential?: 'token' | 'key') {
    super(message);
    this.name = 'QuotaError';
  }
}

/**
 * Thrown when a CLI's output proves that no request of the call reached the model, because the provider could not be
 * reached at all. The same provider fails the same way again soon, so it counts as a limit: it is not retried there,
 * and a stage with a fallback model sends it there under the rules of a limit.
 */
export class UnreachableError extends QuotaError {
  constructor(message: string, limit: string) {
    super(message, limit);
    this.name = 'UnreachableError';
  }
}

/** Thrown when a model call ran past its time limit. */
export class TimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown in place of a model call the round has too little time left to start. Its message is the summary of the
 * incomplete round. A stage that catches errors passes it on, so the call shows only in the round's `notStarted`.
 */
export class NotStartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotStartedError';
  }
}

/** A tool step an LLM call took. A tool of Manki's tool server is named `mcp__manki__<tool>` on every client. */
export interface ToolStep {
  tool: string;
  durationMs?: number;
  /** The file the step read, as `filesRead` names it. Unset on a step that read no file. */
  file?: string;
  /** The characters of text the tool's result gave the model. */
  resultChars?: number;
}

/** One LLM call, as the round and reply records keep it. Token counts follow `LLMUsage`. */
export interface LLMCall extends LLMUsage {
  /** Pipeline stage that made the call: `planner`, `reviewer`, `compare`, `judge`, `dedup`, `verdict`, `related` or `reply`. */
  stage: string;
  /** Finder that made the call, on the `reviewer` stage, or the comparison, on the `compare` stage. */
  agent?: string;
  /** Model that answered. Unknown for a call that failed. */
  model?: string;
  /** Effort tier the provider was sent. */
  effort?: SendMessageOptions['effort'];
  /** Set on a call to the stage's fallback model, after a safety filter refused the stage's own model or that model reached a limit. */
  fallback?: boolean;
  /** Set on a refuter's call for a finding a sweep raised. The dedup and judge calls on what the sweeps reported have the agent `sweep`. */
  sweep?: true;
  /** Position among the calls of the same stage and agent, so above 1 means a retry or another pass. */
  attempt: number;
  failed?: boolean;
  error?: string;
  durationMs: number;
  /** Estimate at public API prices, `null` when the model has no known price or the provider reported no usage. */
  costUsd: number | null;
  /**
   * Set when `costUsd` takes the standard price although the model charges more for a long request and the call's input
   * passes that limit, because only the sum over the call's requests is known.
   */
  costAssumesShortRequests?: true;
  /** Tool steps the call took. Empty when it had repository tools and called none. Unset when it had no tools or its client reports no steps. */
  toolSteps?: ToolStep[];
  /** Tool calls that read each related repo, by `owner/name`. Unset when none did. */
  relatedReads?: Record<string, number>;
  /** Tool calls Manki's tool server refused because they named a path the repository's `closed_paths` closes. Unset when none did. */
  closedCalls?: number;
  /** The files the call's tool calls read, each once, relative to the repository root. Unset when it read none. */
  filesRead?: string[];
  /**
   * The first 12 hex digits of the SHA-256 of the call's system prompt with its digits replaced, so calls before and
   * after a prompt change compare, and the counts a prompt quotes do not split one version.
   */
  promptDigest?: string;
  /** The tool steps the call was given, when it had tools. */
  stepBudget?: number;
  /** Set when the call used enough steps that Manki told the model to wrap up. Only a client that reports `toolSteps` sets it. */
  wrapUpNoted?: true;
  /** The subscription usage limits the call's CLI reported. The round record keeps only the newest per window, in `RoundUsage.limits`. */
  limits?: LimitUsage[];
  /** Mirrors `LLMResponse.cut`. */
  cut?: CutReply;
}

/** Totals over a set of `LLMCall`s. */
export interface UsageSummary extends LLMUsage {
  calls: number;
  failedCalls: number;
  totalTokens: number;
  durationMs: number;
  /** Estimate at public API prices, over the calls whose model has a known price. */
  estimatedCostUsd: number;
  /** Successful calls left out of `estimatedCostUsd`: their model has no known price, or their provider reported no usage. */
  unpricedCalls: number;
}

/** Read-only tools on a checked-out repository, for a call to use while it answers. */
export interface RepoTools {
  /** The repository the tools read. Nothing outside it is readable. */
  root: string;
  /** How many tool calls the model may make. Once they are used up, every further call is refused. */
  steps: number;
  /** Related repos the tools may also read, each named by a `repo` argument. Every call states them, so no stage leaves them out unnoticed. */
  related: RelatedRepoTools | undefined;
  /** Set on a call that checks one finding or statement. Its prompt then names a related repo only for the code that check rests on, with no rules for grading. */
  checking?: true;
  /** Set on a finder's call whose message lists uses outside the diff or lines of the related repos and tells it to open files. Its prompt then says so too. */
  listed?: true;
}

export interface SendMessageOptions {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Wall-clock limit for the call. Unset keeps the provider's default limit. */
  timeoutMs?: number;
  /** Stops the call once it aborts. The call then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Gives the call read-only tools on a repository. A client without `repoTools` ignores it. */
  repoTools?: RepoTools;
  /**
   * The call's prompt template, rendered with fixed values for what changes each round. The recorded `promptDigest`
   * hashes it in place of the system prompt, so the digest changes only when the template does. No provider sends it.
   */
  promptTemplate?: string;
  /** Marks a call that runs for a finding a sweep raised, so the call's record shows it. No provider sends it. */
  sweep?: true;
  /** Called as the model starts each tool call. Only a CLI client that streams its tool calls calls it. */
  onToolStep?: () => void;
}

export interface LLMClient {
  sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse>;
  /**
   * Eagerly prepare any out-of-process resources (e.g. installing the Claude
   * CLI on PATH) so the first `sendMessage` call doesn't race a 30s install
   * against an upstream timeout. Optional; providers that don't shell out
   * leave it undefined.
   */
  warmupCLI?(): Promise<void>;
  /** Whether `sendMessage` gives the model the tools `SendMessageOptions.repoTools` asks for. */
  readonly repoTools?: boolean;
  /**
   * Returns the effort tier `sendMessage` sends for `effort`, which is lower when the model's scale stops below it, or
   * `undefined` when it sends none. Unset when every tier is sent as asked.
   */
  sentEffort?(effort: NonNullable<SendMessageOptions['effort']>): SendMessageOptions['effort'];
}

export type AnthropicAuth =
  | { kind: 'oauth'; token: string }
  | { kind: 'apiKey'; key: string };

export type OpenAIAuth =
  | { kind: 'oauth'; token: string }
  /** A ChatGPT login kept in a file on a self-hosted runner, which Manki writes back to when Codex renews it. */
  | { kind: 'oauthFile'; path: string }
  | { kind: 'apiKey'; key: string }
  /** An OpenAI-compatible endpoint other than OpenAI's own servers, with the key it takes. */
  | { kind: 'endpoint'; key: string; baseUrl: string };

export type GeminiAuth =
  | { kind: 'oauth'; token: string }
  | { kind: 'apiKey'; key: string };

export type ProviderAuth = AnthropicAuth | OpenAIAuth | GeminiAuth;
