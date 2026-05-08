import { AnthropicClient } from './anthropic';
import { createLLMClient } from './factory';
import { ProviderName } from './types';

jest.mock('@anthropic-ai/sdk');

describe('createLLMClient', () => {
  it('returns an AnthropicClient for the anthropic provider', () => {
    const client = createLLMClient('anthropic', 'claude-opus-4-6', { kind: 'apiKey', key: 'sk-test' });
    expect(client).toBeInstanceOf(AnthropicClient);
  });

  it('accepts oauth auth for anthropic', () => {
    const client = createLLMClient('anthropic', 'claude-opus-4-6', { kind: 'oauth', token: 'tok' });
    expect(client).toBeInstanceOf(AnthropicClient);
  });

  it('throws on unknown provider', () => {
    const bogus = 'openai' as unknown as ProviderName;
    expect(() => createLLMClient(bogus, 'gpt-4o', { kind: 'apiKey', key: 'sk' })).toThrow(/Unsupported provider/);
  });
});
