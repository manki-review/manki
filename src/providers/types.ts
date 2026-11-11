import type { RelatedRepoTools } from '../types';

export type ProviderName = 'anthropic' | 'openai' | 'gemini';

/** Token counts of one or more calls. `inputTokens` includes the cache reads and writes, `outputTokens` the reasoning. */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface LLMResponse {
  content: string;
  usage?: LLMUsage;
  latencyMs?: number;
  /** Model that answered. */
  model?: string;
  /** Whether the provider reports that the output stopped at its token limit. Unset when the provider does not expose a stop reason. */
  truncated?: boolean;
  /** The tools the model called while it answered, in order. Unset when it called none. */
  toolSteps?: ToolStep[];
  /** Tool calls that read each related repo, by `owner/name`. Unset when none did. */
  relatedReads?: Record<string, number>;
  /** The files the model's tool calls read, each once, relative to the repository root. Unset when it read none. */
  filesRead?: string[];
  /** The subscription usage limits the CLI reported for its account. Unset when it reported none. */
  limits?: LimitUsage[];
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

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
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
 * Sending it again before `resetsAt` fails the same way, so callers neither retry it nor move it to
 * another model. `limit` says which limit, such as "Claude subscription limit reached".
 * `credential` names what the user can swap to get past it, and is unset when no other one helps.
 */
export class QuotaError extends Error {
  constructor(message: string, readonly limit: string, readonly resetsAt?: string, readonly credential?: 'token' | 'key') {
    super(message);
    this.name = 'QuotaError';
  }
}

/** A tool step an LLM call took. */
export interface ToolStep {
  tool: string;
  durationMs?: number;
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
  /** Set when a fallback model answered after a safety filter refused the stage's own model. */
  fallback?: boolean;
  /** Position among the calls of the same stage and agent, so above 1 means a retry or another pass. */
  attempt: number;
  failed?: boolean;
  error?: string;
  durationMs: number;
  /** Estimate at public API prices, `null` when the model has no known price or the provider reported no usage. */
  costUsd: number | null;
  /** Tool steps the call took. Unset when it took none. */
  toolSteps?: ToolStep[];
  /** Tool calls that read each related repo, by `owner/name`. Unset when none did. */
  relatedReads?: Record<string, number>;
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
  /** Related repos the tools may also read, each named by a `repo` argument. */
  related?: RelatedRepoTools;
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
  /** Returns the effort tier `sendMessage` sends for `effort`, which is lower when the model's scale stops below it. Unset when every tier is sent as asked. */
  sentEffort?(effort: NonNullable<SendMessageOptions['effort']>): NonNullable<SendMessageOptions['effort']>;
}

export type AnthropicAuth =
  | { kind: 'oauth'; token: string }
  | { kind: 'apiKey'; key: string };

export type OpenAIAuth =
  | { kind: 'oauth'; token: string }
  | { kind: 'apiKey'; key: string };

export type GeminiAuth =
  | { kind: 'oauth'; token: string }
  | { kind: 'apiKey'; key: string };

export type ProviderAuth = AnthropicAuth | OpenAIAuth | GeminiAuth;
