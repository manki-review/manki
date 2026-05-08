import { ProviderName } from './types';

export interface ModelSpec {
  provider: ProviderName;
  model: string;
}

const KNOWN_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>(['anthropic', 'openai']);

const KNOWN_PREFIXES: ReadonlyArray<readonly [RegExp, ProviderName]> = [
  [/^claude-/, 'anthropic'],
  [/^gpt-/, 'openai'],
  [/^o\d/, 'openai'],
];

export function parseModelSpec(input: string): ModelSpec {
  input = input.trim();
  if (!input) {
    throw new Error('Unknown model "". Use a known prefix (e.g., "claude-...", "gpt-...", "o3...") or "provider/model" syntax.');
  }
  const slash = input.indexOf('/');
  if (slash !== -1) {
    const provider = input.slice(0, slash);
    const model = input.slice(slash + 1);
    if (!KNOWN_PROVIDERS.has(provider as ProviderName)) {
      throw new Error(`Unknown provider "${provider}" in model spec "${input}".`);
    }
    if (!model) {
      throw new Error(`Empty model in spec "${input}".`);
    }
    return { provider: provider as ProviderName, model };
  }

  for (const [regex, provider] of KNOWN_PREFIXES) {
    if (regex.test(input)) {
      return { provider, model: input };
    }
  }

  throw new Error(`Unknown model "${input}". Use a known prefix (e.g., "claude-...", "gpt-...", "o3...") or "provider/model" syntax.`);
}
