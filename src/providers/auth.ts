import { buildAnthropicAuth } from './anthropic';
import { buildGeminiAuth } from './gemini';
import { buildOpenAIAuth } from './openai';
import { ProviderAuth, ProviderName } from './types';

export interface ProviderInputs {
  anthropicOauthToken: string;
  anthropicApiKey: string;
  openaiOauthToken: string;
  /** A Codex login file on a self-hosted runner, used instead of `openaiOauthToken`. */
  openaiOauthFile: string;
  openaiApiKey: string;
  /** An OpenAI-compatible endpoint that takes `openaiApiKey`, or empty for OpenAI's own servers. */
  openaiBaseUrl: string;
  geminiOauthToken: string;
  geminiApiKey: string;
}

/** Reads the credentials and the OpenAI endpoint from the environment variables named after the action's inputs. */
export function readProviderInputsFromEnv(): ProviderInputs {
  return {
    anthropicOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    openaiOauthToken: process.env.OPENAI_OAUTH_TOKEN ?? '',
    openaiOauthFile: process.env.OPENAI_OAUTH_FILE ?? '',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? '',
    geminiOauthToken: process.env.GEMINI_OAUTH_TOKEN ?? '',
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  };
}

export function buildAuthForProvider(provider: ProviderName, inputs: ProviderInputs): ProviderAuth {
  switch (provider) {
    case 'anthropic':
      return buildAnthropicAuth(inputs.anthropicOauthToken, inputs.anthropicApiKey);
    case 'openai':
      return buildOpenAIAuth(inputs.openaiOauthToken, inputs.openaiApiKey, inputs.openaiBaseUrl, inputs.openaiOauthFile);
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
    inputs.openaiOauthFile ||
    inputs.openaiApiKey ||
    inputs.geminiOauthToken ||
    inputs.geminiApiKey
  );
}
