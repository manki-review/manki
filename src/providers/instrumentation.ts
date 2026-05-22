import { addUsage, LLMClient, LLMUsage, ZERO_USAGE } from './types';

export function wrapClientForUsage(client: LLMClient): {
  client: LLMClient;
  totals: { usage: LLMUsage; latencyMs: number; calls: number };
} {
  const totals = { usage: { ...ZERO_USAGE }, latencyMs: 0, calls: 0 };
  const wrapped: LLMClient = {
    sendMessage: async (sys, user, opts) => {
      const response = await client.sendMessage(sys, user, opts);
      totals.usage = addUsage(totals.usage, response.usage ?? ZERO_USAGE);
      totals.latencyMs += response.latencyMs ?? 0;
      totals.calls += 1;
      return response;
    },
    ...(client.warmupCLI ? { warmupCLI: client.warmupCLI.bind(client) } : {}),
  };
  return { client: wrapped, totals };
}
