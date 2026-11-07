import { LLMUsage, ProviderName } from './types';

export interface ModelSpec {
  provider: ProviderName;
  model: string;
}

const KNOWN_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>(['anthropic', 'openai', 'gemini']);

// A model id reaches a CLI's argv, so it may not start with `-` or hold spaces or shell characters.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

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
  const model = input.slice(slash + 1);
  if (model && !MODEL_ID.test(model)) {
    throw new Error(`Invalid model id "${model}" in "${input}". A model id starts with a letter or digit and holds only letters, digits and \`._:@/-\`.`);
  }
  if (slash !== -1) {
    const provider = input.slice(0, slash);
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
  const bare = id.trim()
    .replace(/^(anthropic|openai|gemini)\//, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '')
    .replace(/(-preview)-\d{2}-\d{2}$/, '$1');
  const [family, ...rest] = bare.split('-');
  const name = FAMILY_NAMES.get(family);
  if (!name || rest.length === 0 || rest.some(part => !/^[a-z0-9.]+$/i.test(part))) return id;
  const words = [name];
  for (const part of rest) {
    const last = words[words.length - 1];
    if (/^\d{1,2}$/.test(part) && /\d$/.test(last)) words[words.length - 1] = `${last}.${part}`;
    else words.push(part[0].toUpperCase() + part.slice(1));
  }
  return words.join(' ');
}

interface ModelPrice {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** Five-minute cache writes. Only Anthropic reports them. */
  cacheWrite: number;
  /** Prices for a prompt over `aboveTokens`, where the model charges more for one. */
  longPrompt?: { aboveTokens: number; input: number; output: number; cacheRead?: number };
}

/**
 * Public standard-tier API prices as of 2026-11, for cost estimates. Update the table when a provider
 * changes its prices: Gemini 3.8 Flash doubles its prices on 2027-01-01. A missing model's cost is unknown.
 */
const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longPrompt: { aboveTokens: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0, longPrompt: { aboveTokens: 272_000, input: 4, output: 15, cacheRead: 0.2 } },
  'gpt-6.1-terra': { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0, longPrompt: { aboveTokens: 272_000, input: 2, output: 7.5, cacheRead: 0.1 } },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0, longPrompt: { aboveTokens: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02 } },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0, longPrompt: { aboveTokens: 272_000, input: 4, output: 18, cacheRead: 0.4 } },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, longPrompt: { aboveTokens: 272_000, input: 10, output: 45, cacheRead: 1 } },
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
};

/**
 * Returns an estimate of a call's cost in USD at public API prices, or `null` for a model without a
 * known price. Subscription use is not billed per token, so this is what the same calls would cost on the API.
 */
export function estimateCostUsd(model: string, usage: LLMUsage): number | null {
  const price = MODEL_PRICES[model] ?? MODEL_PRICES[model.replace(/-\d{8}$/, '')];
  if (!price) return null;
  const long = price.longPrompt && usage.inputTokens > price.longPrompt.aboveTokens ? price.longPrompt : undefined;
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const cost = uncached * (long?.input ?? price.input)
    + usage.cacheReadTokens * (long?.cacheRead ?? price.cacheRead)
    + usage.cacheWriteTokens * price.cacheWrite
    + usage.outputTokens * (long?.output ?? price.output);
  return cost / 1_000_000;
}
