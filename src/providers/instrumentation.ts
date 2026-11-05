import { addUsage, LLMClient, LLMUsage, RefusalError, ZERO_USAGE } from './types';

export interface UsageTotals {
  usage: LLMUsage;
  latencyMs: number;
  calls: number;
  failures: number;
}

export function wrapClientForUsage(client: LLMClient): {
  client: LLMClient;
  getTotals(): Readonly<UsageTotals>;
} {
  const totals: UsageTotals = { usage: { ...ZERO_USAGE }, latencyMs: 0, calls: 0, failures: 0 };
  const wrapped: LLMClient = {
    sendMessage: async (sys, user, opts) => {
      try {
        const response = await client.sendMessage(sys, user, opts);
        totals.usage = addUsage(totals.usage, response.usage ?? ZERO_USAGE);
        totals.latencyMs += response.latencyMs ?? 0;
        totals.calls += 1;
        return response;
      } catch (err) {
        totals.failures += 1;
        throw err;
      }
    },
    ...(client.warmupCLI ? { warmupCLI: client.warmupCLI.bind(client) } : {}),
  };
  return { client: wrapped, getTotals: () => Object.freeze({ ...totals, usage: Object.freeze({ ...totals.usage }) }) };
}

/**
 * Sends each request to `client`, and once a safety filter refuses one, sends it and every later
 * request to `fallback`. A refusal on `fallback` and any other error are thrown unchanged.
 */
export function withRefusalFallback(
  client: LLMClient,
  fallback: LLMClient | undefined,
  onFallback: (error: RefusalError) => void,
): LLMClient {
  if (!fallback) return client;
  let refused = false;
  return {
    sendMessage: async (sys, user, opts) => {
      if (!refused) {
        try {
          return await client.sendMessage(sys, user, opts);
        } catch (error) {
          if (!(error instanceof RefusalError)) throw error;
          refused = true;
          onFallback(error);
        }
      }
      return fallback.sendMessage(sys, user, opts);
    },
    ...(client.warmupCLI ? { warmupCLI: client.warmupCLI.bind(client) } : {}),
  };
}
