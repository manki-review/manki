import { AnthropicClient } from './anthropic';
import { OpenAIClient } from './openai';
import { GeminiClient } from './gemini';
import { LLMClient, ProviderAuth, ProviderName } from './types';

export function createLLMClient(provider: ProviderName, model: string, auth: ProviderAuth): LLMClient {
  if (provider === 'openai') return new OpenAIClient({ auth, model });
  // Only `OpenAIAuth` has the `endpoint` and `oauthFile` kinds.
  if (auth.kind === 'endpoint' || auth.kind === 'oauthFile') throw new Error(`The ${provider} provider cannot use the OpenAI endpoint`);
  switch (provider) {
    case 'anthropic':
      return new AnthropicClient({ auth, model });
    case 'gemini':
      return new GeminiClient({ auth, model });
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${exhaustive as string}`);
    }
  }
}
