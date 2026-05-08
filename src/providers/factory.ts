import { AnthropicClient } from './anthropic';
import { LLMClient, ProviderAuth, ProviderName } from './types';

export function createLLMClient(provider: ProviderName, model: string, auth: ProviderAuth): LLMClient {
  switch (provider) {
    case 'anthropic':
      return new AnthropicClient({ auth, model });
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${exhaustive as string}`);
    }
  }
}
