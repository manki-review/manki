import { addUsage, LLMClient, LLMUsage, ZERO_USAGE } from './types';

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
  return { client: wrapped, getTotals: () => Object.freeze({ ...totals }) };
}
