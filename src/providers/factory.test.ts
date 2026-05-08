import * as AnthropicModule from './anthropic';
import { AnthropicClient } from './anthropic';
import { OpenAIClient } from './openai';
import { createLLMClient } from './factory';
import { ProviderName } from './types';

jest.mock('@anthropic-ai/sdk');
jest.mock('openai');

describe('createLLMClient', () => {
  it('returns an AnthropicClient for the anthropic provider', () => {
    const client = createLLMClient('anthropic', 'claude-opus-4-6', { kind: 'apiKey', key: 'sk-test' });
    expect(client).toBeInstanceOf(AnthropicClient);
  });

  it('forwards model and apiKey auth to AnthropicClient constructor', () => {
    const auth = { kind: 'apiKey' as const, key: 'sk-test' };
    const RealAnthropicClient = AnthropicModule.AnthropicClient;
    // jest.spyOn works here because Jest compiles TypeScript to CJS and factory.ts
    // accesses AnthropicClient via the module namespace object (anthropic_1.AnthropicClient),
    // so replacing the property on the namespace object intercepts the call.
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

  it('returns an OpenAIClient for the openai provider with apiKey auth', () => {
    const client = createLLMClient('openai', 'gpt-4o', { kind: 'apiKey', key: 'sk-test' });
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('returns an OpenAIClient for the openai provider with oauth auth', () => {
    const client = createLLMClient('openai', 'o3', { kind: 'oauth', token: 'tok' });
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('throws on unknown provider', () => {
    const bogus = 'mistral' as unknown as ProviderName;
    expect(() => createLLMClient(bogus, 'mistral-large', { kind: 'apiKey', key: 'sk' })).toThrow(/Unsupported provider/);
  });
});
