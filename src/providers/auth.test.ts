import { buildAuthForProvider, hasAnyProviderCredentials, ProviderInputs, readProviderInputsFromEnv } from './auth';

const empty: ProviderInputs = {
  anthropicOauthToken: '',
  anthropicApiKey: '',
  openaiOauthToken: '',
  openaiOauthFile: '',
  openaiApiKey: '',
  openaiBaseUrl: '',
  geminiOauthToken: '',
  geminiApiKey: '',
};

describe('hasAnyProviderCredentials', () => {
  it('returns false when no credential is set, also with an OpenAI base URL', () => {
    expect(hasAnyProviderCredentials(empty)).toBe(false);
    expect(hasAnyProviderCredentials({ ...empty, openaiBaseUrl: 'https://llm.example/v1' })).toBe(false);
  });

  it('returns true when any single credential is set', () => {
    for (const key of (Object.keys(empty) as (keyof ProviderInputs)[]).filter(key => key !== 'openaiBaseUrl')) {
      const inputs = { ...empty, [key]: 'x' };
      expect(hasAnyProviderCredentials(inputs)).toBe(true);
    }
  });
});

describe('buildAuthForProvider', () => {
  it('routes anthropic to oauth when only the OAuth token is present', () => {
    const inputs = { ...empty, anthropicOauthToken: 'oauth-tok' };
    expect(buildAuthForProvider('anthropic', inputs)).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });

  it('routes anthropic to apiKey when only the API key is present', () => {
    const inputs = { ...empty, anthropicApiKey: 'sk-ant' };
    expect(buildAuthForProvider('anthropic', inputs)).toEqual({ kind: 'apiKey', key: 'sk-ant' });
  });

  it('routes openai to oauth when only the OAuth token is present', () => {
    const inputs = { ...empty, openaiOauthToken: 'codex-tok' };
    expect(buildAuthForProvider('openai', inputs)).toEqual({ kind: 'oauth', token: 'codex-tok' });
  });

  it('routes openai to apiKey when only the API key is present', () => {
    const inputs = { ...empty, openaiApiKey: 'sk-openai' };
    expect(buildAuthForProvider('openai', inputs)).toEqual({ kind: 'apiKey', key: 'sk-openai' });
  });

  it('routes openai to the endpoint when a base URL comes with the API key, and refuses it with the OAuth token', () => {
    const inputs = { ...empty, openaiApiKey: 'sk-endpoint', openaiBaseUrl: 'https://llm.example/v1' };
    expect(buildAuthForProvider('openai', inputs)).toEqual({ kind: 'endpoint', key: 'sk-endpoint', baseUrl: 'https://llm.example/v1' });
    expect(() => buildAuthForProvider('openai', { ...inputs, openaiOauthToken: 'codex-tok' })).toThrow('openai_base_url cannot be used with openai_oauth_token');
  });

  it('routes gemini to oauth when only the OAuth token is present', () => {
    const inputs = { ...empty, geminiOauthToken: 'gemini-tok' };
    expect(buildAuthForProvider('gemini', inputs)).toEqual({ kind: 'oauth', token: 'gemini-tok' });
  });

  it('routes gemini to apiKey when only the API key is present', () => {
    const inputs = { ...empty, geminiApiKey: 'gemini-key' };
    expect(buildAuthForProvider('gemini', inputs)).toEqual({ kind: 'apiKey', key: 'gemini-key' });
  });

  it('throws for each provider when no matching credential is present', () => {
    expect(() => buildAuthForProvider('anthropic', empty)).toThrow(/credential|api.?key|token/i);
    expect(() => buildAuthForProvider('openai', empty)).toThrow(/credential|api.?key|token/i);
    expect(() => buildAuthForProvider('gemini', empty)).toThrow(/credential|api.?key|token/i);
  });

  it('prefers OAuth token over API key when both are present for anthropic', () => {
    const inputs = { ...empty, anthropicOauthToken: 'oauth-tok', anthropicApiKey: 'sk-ant' };
    expect(buildAuthForProvider('anthropic', inputs)).toEqual({ kind: 'oauth', token: 'oauth-tok' });
  });

  it('prefers OAuth token over API key when both are present for openai', () => {
    const inputs = { ...empty, openaiOauthToken: 'codex-tok', openaiApiKey: 'sk-openai' };
    expect(buildAuthForProvider('openai', inputs)).toEqual({ kind: 'oauth', token: 'codex-tok' });
  });

  it('prefers OAuth token over API key when both are present for gemini', () => {
    const inputs = { ...empty, geminiOauthToken: 'gemini-tok', geminiApiKey: 'gemini-key' };
    expect(buildAuthForProvider('gemini', inputs)).toEqual({ kind: 'oauth', token: 'gemini-tok' });
  });

  it('throws for an unsupported/unknown provider', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => buildAuthForProvider('unknown' as any, empty)).toThrow('Unsupported provider: unknown');
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
      OPENAI_OAUTH_FILE: 'h',
      OPENAI_API_KEY: 'd',
      OPENAI_BASE_URL: 'g',
      GEMINI_OAUTH_TOKEN: 'e',
      GEMINI_API_KEY: 'f',
    };
    expect(readProviderInputsFromEnv()).toEqual({
      anthropicOauthToken: 'a',
      anthropicApiKey: 'b',
      openaiOauthToken: 'c',
      openaiOauthFile: 'h',
      openaiApiKey: 'd',
      openaiBaseUrl: 'g',
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
      openaiOauthFile: '',
      openaiApiKey: '',
      openaiBaseUrl: '',
      geminiOauthToken: '',
      geminiApiKey: '',
    });
  });
});
