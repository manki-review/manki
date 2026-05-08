export type ProviderName = 'anthropic' | 'openai' | 'gemini';

export interface LLMResponse {
  content: string;
}

export interface SendMessageOptions {
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface LLMClient {
  sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse>;
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
