export type ProviderName = 'anthropic' | 'openai' | 'gemini';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface LLMResponse {
  content: string;
  usage: LLMUsage;
  latencyMs: number;
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
  cachedTokens: 0,
  reasoningTokens: 0,
});

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export interface SendMessageOptions {
  effort?: 'low' | 'medium' | 'high' | 'max';
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
