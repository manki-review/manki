import { modelDisplayName, parseModelSpec } from './model-registry';

describe('parseModelSpec', () => {
  it('parses bare model with known prefix', () => {
    expect(parseModelSpec('claude-opus-4-6')).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6' });
  });

  it('parses provider/model syntax', () => {
    expect(parseModelSpec('anthropic/claude-opus-4-6')).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6' });
  });

  it('preserves further slashes in the model id', () => {
    expect(parseModelSpec('anthropic/claude-opus-4-6/v1')).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6/v1' });
  });

  it('parses gpt- prefix as openai', () => {
    expect(parseModelSpec('gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(parseModelSpec('gpt-4.1')).toEqual({ provider: 'openai', model: 'gpt-4.1' });
    expect(parseModelSpec('gpt-4o-mini')).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('parses o-series (o3/o4) prefix as openai', () => {
    expect(parseModelSpec('o3')).toEqual({ provider: 'openai', model: 'o3' });
    expect(parseModelSpec('o3-mini')).toEqual({ provider: 'openai', model: 'o3-mini' });
    expect(parseModelSpec('o4-mini')).toEqual({ provider: 'openai', model: 'o4-mini' });
  });

  it('parses openai/model syntax', () => {
    expect(parseModelSpec('openai/gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(parseModelSpec('openai/o3')).toEqual({ provider: 'openai', model: 'o3' });
  });

  it('parses bare gemini model with known prefix', () => {
    expect(parseModelSpec('gemini-2.5-flash')).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
  });

  it('parses gemini provider/model syntax', () => {
    expect(parseModelSpec('gemini/gemini-2.5-pro')).toEqual({ provider: 'gemini', model: 'gemini-2.5-pro' });
  });

  it('throws on bare model with unknown prefix', () => {
    expect(() => parseModelSpec('mistral-large')).toThrow(/Unknown model "mistral-large"/);
  });

  it('throws on explicit unknown provider', () => {
    expect(() => parseModelSpec('mistral/mistral-large')).toThrow(/Unknown provider "mistral"/);
  });

  it('throws on empty model after slash', () => {
    expect(() => parseModelSpec('anthropic/')).toThrow(/Empty model/);
  });

  it('throws on empty string', () => {
    expect(() => parseModelSpec('')).toThrow(/Unknown model/);
  });

  it('throws on slash-only input', () => {
    expect(() => parseModelSpec('/')).toThrow(/Unknown provider/);
  });

  it('throws on whitespace-only input', () => {
    expect(() => parseModelSpec('   ')).toThrow(/Unknown model/);
  });
});

describe('modelDisplayName', () => {
  it.each([
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
    ['anthropic/claude-opus-4-6', 'Claude Opus 4.6'],
    ['gpt-5.5', 'GPT 5.5'],
    ['gpt-4o-mini', 'GPT 4o Mini'],
    ['openai/gpt-5.5', 'GPT 5.5'],
    ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
    ['gemini-3-pro', 'Gemini 3 Pro'],
  ])('names %s as %s', (id, name) => {
    expect(modelDisplayName(id)).toBe(name);
  });

  it.each(['o3', 'my-model', 'claude', 'claude-20241022', 'claude-opus-4-6/v1', 'constructor-1', 'openai/ft:gpt-4o:org'])('returns the unknown id %s as given', id => {
    expect(modelDisplayName(id)).toBe(id);
  });
});
