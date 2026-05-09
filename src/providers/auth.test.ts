import { buildAuthForProvider, hasAnyProviderCredentials, ProviderInputs } from './auth';

const empty: ProviderInputs = {
  anthropicOauthToken: '',
  anthropicApiKey: '',
  openaiOauthToken: '',
  openaiApiKey: '',
  geminiOauthToken: '',
  geminiApiKey: '',
};

describe('hasAnyProviderCredentials', () => {
  it('returns false when all six fields are empty', () => {
    expect(hasAnyProviderCredentials(empty)).toBe(false);
  });

  it('returns true when any single field is set', () => {
    for (const key of Object.keys(empty) as (keyof ProviderInputs)[]) {
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
