export { buildAnthropicAuth } from './anthropic';
export { buildOpenAIAuth } from './openai';
export { createLLMClient } from './factory';
export { parseModelSpec } from './model-registry';
export type { ModelSpec } from './model-registry';
export type {
  AnthropicAuth,
  LLMClient,
  LLMResponse,
  OpenAIAuth,
  ProviderAuth,
  ProviderName,
  SendMessageOptions,
} from './types';
