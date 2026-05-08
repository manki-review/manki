import { GoogleGenerativeAI } from '@google/generative-ai';

import { buildGeminiAuth, GeminiClient, geminiThinkingBudget } from './gemini';
import { parseModelSpec } from './model-registry';

jest.mock('@google/generative-ai');

describe('GeminiClient', () => {
  it('accepts oauth auth', () => {
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-2.5-flash' });
    expect(client).toBeDefined();
  });

  it('accepts apiKey auth', () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'key' }, model: 'gemini-2.5-flash' });
    expect(client).toBeDefined();
  });
});

describe('geminiThinkingBudget', () => {
  it('returns undefined for low (no thinking)', () => {
    expect(geminiThinkingBudget('low')).toBeUndefined();
  });

  it('returns undefined when effort is omitted', () => {
    expect(geminiThinkingBudget(undefined)).toBeUndefined();
  });

  it('returns 5000 for medium', () => {
    expect(geminiThinkingBudget('medium')).toBe(5000);
  });

  it('returns 10000 for high', () => {
    expect(geminiThinkingBudget('high')).toBe(10000);
  });

  it('returns 10000 for max (clamped to high)', () => {
    expect(geminiThinkingBudget('max')).toBe(10000);
  });
});

describe('sendMessage effort option (API path)', () => {
  let mockGenerateContent: jest.Mock;
  let mockGetGenerativeModel: jest.Mock;

  beforeEach(() => {
    mockGenerateContent = jest.fn().mockResolvedValue({
      response: { text: () => 'response text' },
    });
    mockGetGenerativeModel = jest.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    });
    (GoogleGenerativeAI as unknown as jest.Mock).mockImplementation(() => ({
      getGenerativeModel: mockGetGenerativeModel,
    }));
  });

  it('passes model name and system instruction to getGenerativeModel', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-2.5-flash' });

    await client.sendMessage('system', 'user');

    expect(mockGetGenerativeModel).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      systemInstruction: 'system',
    });
  });

  it('passes user message as content with role user', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-2.5-flash' });

    await client.sendMessage('system', 'hello world');

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.contents).toEqual([{ role: 'user', parts: [{ text: 'hello world' }] }]);
  });

  it('includes thinkingConfig when effort is high', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-2.5-pro' });

    await client.sendMessage('system', 'user', { effort: 'high' });

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 10000 });
  });

  it('includes thinkingConfig when effort is medium', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-2.5-flash' });

    await client.sendMessage('system', 'user', { effort: 'medium' });

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 5000 });
  });

  it('omits thinkingConfig when effort is low', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-2.5-flash' });

    await client.sendMessage('system', 'user', { effort: 'low' });

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('omits thinkingConfig when no options provided', async () => {
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-2.5-flash' });

    await client.sendMessage('system', 'user');

    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('returns the response text', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'hello there' },
    });
    const client = new GeminiClient({ auth: { kind: 'apiKey', key: 'k' }, model: 'gemini-2.5-flash' });

    const result = await client.sendMessage('system', 'user');
    expect(result.content).toBe('hello there');
  });

  it('throws when SDK client is not initialized (oauth-only construction)', async () => {
    const client = new GeminiClient({ auth: { kind: 'oauth', token: 'tok' }, model: 'gemini-2.5-flash' });

    const sendViaAPI = (GeminiClient.prototype as unknown as Record<string, unknown>)['sendViaAPI'] as (
      systemPrompt: string,
      userMessage: string,
    ) => Promise<unknown>;

    await expect(sendViaAPI.call(client, 'sys', 'user')).rejects.toThrow('Gemini client not initialized');
  });
});

describe('buildGeminiAuth', () => {
  it('throws when neither token is present', () => {
    expect(() => buildGeminiAuth('', '')).toThrow(
      'Either gemini_oauth_token or gemini_api_key must be provided',
    );
  });

  it('returns oauth kind when only oauth token is present', () => {
    expect(buildGeminiAuth('oauth-tok', '')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });

  it('returns apiKey kind when only api key is present', () => {
    expect(buildGeminiAuth('', 'gem-key')).toEqual({ kind: 'apiKey', key: 'gem-key' });
  });

  it('oauth wins when both tokens are present', () => {
    expect(buildGeminiAuth('oauth-tok', 'gem-key')).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });
});

describe('parseModelSpec — gemini detection', () => {
  it('detects gemini-2.5-flash as gemini provider', () => {
    expect(parseModelSpec('gemini-2.5-flash')).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
  });

  it('detects gemini-2.5-pro as gemini provider', () => {
    expect(parseModelSpec('gemini-2.5-pro')).toEqual({ provider: 'gemini', model: 'gemini-2.5-pro' });
  });

  it('parses gemini/<model> explicit syntax', () => {
    expect(parseModelSpec('gemini/gemini-2.5-flash')).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
  });
});
