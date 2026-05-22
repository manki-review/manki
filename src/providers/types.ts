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

export const ZERO_USAGE: LLMUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
});

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
