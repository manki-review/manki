export { buildAuthForProvider, hasAnyProviderCredentials, readProviderInputsFromEnv } from './auth';
export type { ProviderInputs } from './auth';
export { removeSeededAuthFiles, sanitizeLogOutput } from './cli-utils';
export { createLLMClient } from './factory';
export { latestLimits, recordCalls, summarizeCalls, withRefusalFallback, withSignal, wrapClientForUsage } from './instrumentation';
export { estimateCostUsd, modelDisplayName, parseModelSpec } from './model-registry';
export type { ModelSpec } from './model-registry';
export type {
  AnthropicAuth,
  GeminiAuth,
  LLMCall,
  LLMClient,
  LLMResponse,
  LimitUsage,
  LLMUsage,
  OpenAIAuth,
  ProviderAuth,
  ProviderName,
  SendMessageOptions,
  UsageSummary,
} from './types';
export { addUsage, QuotaError, RefusalError, ZERO_USAGE } from './types';
