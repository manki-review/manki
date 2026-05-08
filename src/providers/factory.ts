import { AnthropicClient } from './anthropic';
import { OpenAIClient } from './openai';
import { LLMClient, ProviderAuth, ProviderName } from './types';

export function createLLMClient(provider: ProviderName, model: string, auth: ProviderAuth): LLMClient {
  switch (provider) {
    case 'anthropic':
      return new AnthropicClient({ auth, model });
    case 'openai':
      return new OpenAIClient({ auth, model });
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${exhaustive as string}`);
    }
  }
}
