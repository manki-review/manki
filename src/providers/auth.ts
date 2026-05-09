import { buildAnthropicAuth } from './anthropic';
import { buildGeminiAuth } from './gemini';
import { buildOpenAIAuth } from './openai';
import { ProviderAuth, ProviderName } from './types';

export interface ProviderInputs {
  anthropicOauthToken: string;
  anthropicApiKey: string;
  openaiOauthToken: string;
  openaiApiKey: string;
  geminiOauthToken: string;
  geminiApiKey: string;
}

export function buildAuthForProvider(provider: ProviderName, inputs: ProviderInputs): ProviderAuth {
  switch (provider) {
    case 'anthropic':
      return buildAnthropicAuth(inputs.anthropicOauthToken, inputs.anthropicApiKey);
    case 'openai':
      return buildOpenAIAuth(inputs.openaiOauthToken, inputs.openaiApiKey);
    case 'gemini':
      return buildGeminiAuth(inputs.geminiOauthToken, inputs.geminiApiKey);
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${exhaustive as string}`);
    }
  }
}

export function hasAnyProviderCredentials(inputs: ProviderInputs): boolean {
  return !!(
    inputs.anthropicOauthToken ||
    inputs.anthropicApiKey ||
    inputs.openaiOauthToken ||
    inputs.openaiApiKey ||
    inputs.geminiOauthToken ||
    inputs.geminiApiKey
  );
}
