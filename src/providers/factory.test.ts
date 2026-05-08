import { AnthropicClient } from './anthropic';
import { createLLMClient } from './factory';
import { ProviderName } from './types';

jest.mock('@anthropic-ai/sdk');

describe('createLLMClient', () => {
  it('returns an AnthropicClient for the anthropic provider', () => {
    const client = createLLMClient('anthropic', 'claude-opus-4-6', { kind: 'apiKey', key: 'sk-test' });
    expect(client).toBeInstanceOf(AnthropicClient);
  });

  it('forwards the model to the constructed client', () => {
    const client = createLLMClient('anthropic', 'claude-sonnet-4-20250514', { kind: 'apiKey', key: 'sk-test' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).model).toBe('claude-sonnet-4-20250514');
  });

  it('forwards apiKey auth to the constructed client', () => {
    const auth = { kind: 'apiKey' as const, key: 'sk-test' };
    const client = createLLMClient('anthropic', 'claude-opus-4-6', auth);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).auth).toEqual(auth);
  });

  it('forwards oauth auth to the constructed client', () => {
    const auth = { kind: 'oauth' as const, token: 'tok' };
    const client = createLLMClient('anthropic', 'claude-opus-4-6', auth);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).auth).toEqual(auth);
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
