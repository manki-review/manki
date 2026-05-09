import { parseArgs, readProviderInputsFromEnv } from './smoke';

describe('parseArgs', () => {
  describe('--model', () => {
    it('parses a model flag', () => {
      expect(parseArgs(['--model', 'claude-haiku-4-5'])).toMatchObject({ model: 'claude-haiku-4-5' });
    });

    it('throws when --model is missing a value', () => {
      expect(() => parseArgs(['--model'])).toThrow('--model requires a value.');
    });

    it('throws when --model is an empty string', () => {
      expect(() => parseArgs(['--model', ''])).toThrow('--model requires a value.');
    });

    it('throws when --model is omitted entirely', () => {
      expect(() => parseArgs([])).toThrow('--model is required');
    });
  });

  describe('--effort', () => {
    it.each(['low', 'medium', 'high', 'max'] as const)('accepts effort=%s', (effort) => {
      expect(parseArgs(['--model', 'm', '--effort', effort])).toMatchObject({ effort });
    });

    it('throws on invalid effort value', () => {
      expect(() => parseArgs(['--model', 'm', '--effort', 'turbo'])).toThrow('Invalid --effort');
    });

    it('throws when --effort is missing a value', () => {
      expect(() => parseArgs(['--model', 'm', '--effort'])).toThrow('--effort requires a value.');
    });

    it('omits effort from result when flag is absent', () => {
      const result = parseArgs(['--model', 'm']);
      expect(result.effort).toBeUndefined();
    });
  });

  describe('--prompt', () => {
    it('parses a custom prompt', () => {
      expect(parseArgs(['--model', 'm', '--prompt', 'hello'])).toMatchObject({ prompt: 'hello' });
    });

    it('uses the default prompt when --prompt is omitted', () => {
      const result = parseArgs(['--model', 'm']);
      expect(result.prompt).toBe('Reply with the single word: OK');
    });

    it('throws when --prompt is missing a value', () => {
      expect(() => parseArgs(['--model', 'm', '--prompt'])).toThrow('--prompt requires a non-empty value.');
    });

    it('throws when --prompt is an empty string', () => {
      expect(() => parseArgs(['--model', 'm', '--prompt', ''])).toThrow('--prompt requires a non-empty value.');
    });
  });

  describe('unknown arguments', () => {
    it('throws on unrecognised flags', () => {
      expect(() => parseArgs(['--model', 'm', '--unknown'])).toThrow('Unknown argument: --unknown');
    });
  });
});

describe('readProviderInputsFromEnv', () => {
  const origEnv = process.env;

  afterEach(() => {
    process.env = origEnv;
  });

  it('maps each env var to the correct ProviderInputs field', () => {
    process.env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'a',
      ANTHROPIC_API_KEY: 'b',
      OPENAI_OAUTH_TOKEN: 'c',
      OPENAI_API_KEY: 'd',
      GEMINI_OAUTH_TOKEN: 'e',
      GEMINI_API_KEY: 'f',
    };
    expect(readProviderInputsFromEnv()).toEqual({
      anthropicOauthToken: 'a',
      anthropicApiKey: 'b',
      openaiOauthToken: 'c',
      openaiApiKey: 'd',
      geminiOauthToken: 'e',
      geminiApiKey: 'f',
    });
  });

  it('returns empty strings when env vars are absent', () => {
    process.env = {};
    expect(readProviderInputsFromEnv()).toEqual({
      anthropicOauthToken: '',
      anthropicApiKey: '',
      openaiOauthToken: '',
      openaiApiKey: '',
      geminiOauthToken: '',
      geminiApiKey: '',
    });
  });
});
