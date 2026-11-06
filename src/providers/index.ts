export { buildAuthForProvider, hasAnyProviderCredentials } from './auth';
export type { ProviderInputs } from './auth';
export { sanitizeLogOutput } from './cli-utils';
export { createLLMClient } from './factory';
export { recordCalls, summarizeCalls, withRefusalFallback, withSignal, wrapClientForUsage } from './instrumentation';
export { estimateCostUsd, modelDisplayName, parseModelSpec } from './model-registry';
export type { ModelSpec } from './model-registry';
export type {
  AnthropicAuth,
  GeminiAuth,
  LLMCall,
  LLMClient,
  LLMResponse,
  LLMUsage,
  OpenAIAuth,
  ProviderAuth,
  ProviderName,
  SendMessageOptions,
  UsageSummary,
} from './types';
export { addUsage, QuotaError, RefusalError, TurnLimitError, ZERO_USAGE } from './types';
