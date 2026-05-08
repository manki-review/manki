import * as AnthropicModule from './anthropic';
import { AnthropicClient } from './anthropic';
import { createLLMClient } from './factory';
import { ProviderName } from './types';

jest.mock('@anthropic-ai/sdk');

describe('createLLMClient', () => {
  it('returns an AnthropicClient for the anthropic provider', () => {
    const client = createLLMClient('anthropic', 'claude-opus-4-6', { kind: 'apiKey', key: 'sk-test' });
    expect(client).toBeInstanceOf(AnthropicClient);
  });

  it('forwards model and apiKey auth to AnthropicClient constructor', () => {
    const auth = { kind: 'apiKey' as const, key: 'sk-test' };
    const RealAnthropicClient = AnthropicModule.AnthropicClient;
    const spy = jest.spyOn(AnthropicModule, 'AnthropicClient').mockImplementation(
      (opts) => new RealAnthropicClient(opts),
    );
    createLLMClient('anthropic', 'claude-sonnet-4-20250514', auth);
    expect(spy).toHaveBeenCalledWith({ auth, model: 'claude-sonnet-4-20250514' });
    spy.mockRestore();
  });

  it('forwards oauth auth to AnthropicClient constructor', () => {
    const auth = { kind: 'oauth' as const, token: 'tok' };
    const RealAnthropicClient = AnthropicModule.AnthropicClient;
    const spy = jest.spyOn(AnthropicModule, 'AnthropicClient').mockImplementation(
      (opts) => new RealAnthropicClient(opts),
    );
    createLLMClient('anthropic', 'claude-opus-4-6', auth);
    expect(spy).toHaveBeenCalledWith({ auth, model: 'claude-opus-4-6' });
    spy.mockRestore();
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
