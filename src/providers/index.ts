export { buildAuthForProvider, hasAnyProviderCredentials } from './auth';
export type { ProviderInputs } from './auth';
export { sanitizeLogOutput } from './cli-utils';
export { createLLMClient } from './factory';
export { wrapClientForUsage } from './instrumentation';
export { parseModelSpec } from './model-registry';
export type { ModelSpec } from './model-registry';
export type {
  AnthropicAuth,
  GeminiAuth,
  LLMClient,
  LLMResponse,
  LLMUsage,
  OpenAIAuth,
  ProviderAuth,
  ProviderName,
  SendMessageOptions,
} from './types';
export { addUsage, readCount, ZERO_USAGE } from './types';
