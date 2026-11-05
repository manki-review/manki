import { ProviderName } from './types';

export interface ModelSpec {
  provider: ProviderName;
  model: string;
}

const KNOWN_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>(['anthropic', 'openai', 'gemini']);

const KNOWN_PREFIXES: ReadonlyArray<readonly [RegExp, ProviderName]> = [
  [/^claude-/, 'anthropic'],
  [/^gpt-/, 'openai'],
  [/^o\d/, 'openai'],
  [/^gemini-/, 'gemini'],
];

export function parseModelSpec(input: string): ModelSpec {
  input = input.trim();
  if (!input) {
    throw new Error('Unknown model "". Use a known prefix (e.g., "claude-...", "gpt-...", "o3...", "gemini-...") or "provider/model" syntax.');
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

  throw new Error(`Unknown model "${input}". Use a known prefix (e.g., "claude-...", "gpt-...", "o3...", "gemini-...") or "provider/model" syntax.`);
}

const FAMILY_NAMES: ReadonlyMap<string, string> = new Map([['claude', 'Claude'], ['gpt', 'GPT'], ['gemini', 'Gemini']]);

/**
 * Returns a model's display name, such as "Claude Sonnet 5.5" for `claude-sonnet-5-5` or "GPT 5.5" for `gpt-5.5`.
 * Dash-separated version numbers join with a dot and a trailing date stamp is dropped. Any other id is returned as given.
 */
export function modelDisplayName(id: string): string {
  const bare = id.trim().replace(/^(anthropic|openai|gemini)\//, '');
  const [family, ...rest] = bare.split('-');
  const name = FAMILY_NAMES.get(family);
  if (/^\d{8}$/.test(rest[rest.length - 1])) rest.pop();
  if (!name || rest.length === 0 || rest.some(part => !/^[a-z0-9.]+$/i.test(part))) return id;
  const words = [name];
  for (const part of rest) {
    const last = words[words.length - 1];
    if (/^\d{1,2}$/.test(part) && /\d$/.test(last)) words[words.length - 1] = `${last}.${part}`;
    else words.push(part[0].toUpperCase() + part.slice(1));
  }
  return words.join(' ');
}
