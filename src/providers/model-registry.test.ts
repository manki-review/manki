import { parseModelSpec } from './model-registry';

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

  it('throws on bare model with unknown prefix', () => {
    expect(() => parseModelSpec('gpt-4o')).toThrow(/Unknown model "gpt-4o"/);
  });

  it('throws on explicit unknown provider', () => {
    expect(() => parseModelSpec('openai/gpt-4o')).toThrow(/Unknown provider "openai"/);
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
