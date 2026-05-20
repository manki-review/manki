export type ProviderName = 'anthropic' | 'openai' | 'gemini';

export interface LLMResponse {
  content: string;
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
