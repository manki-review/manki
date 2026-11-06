import { estimateCostUsd } from './model-registry';
import { addUsage, LLMCall, LLMClient, LLMUsage, RefusalError, UsageSummary, ZERO_USAGE } from './types';
import { sanitizeLogOutput } from './cli-utils';

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
    ...(client.repoTools ? { repoTools: true } : {}),
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
          // Parallel calls can all be refused before the first one returns, and the stage moves only once.
          if (!refused) onFallback(error);
          refused = true;
        }
      }
      return fallback.sendMessage(sys, user, opts);
    },
    ...(client.warmupCLI ? { warmupCLI: client.warmupCLI.bind(client) } : {}),
    ...(client.repoTools ? { repoTools: true } : {}),
  };
}

/** Sends every request to `client` with `signal`, so its abort stops the call in flight. Without `signal`, returns `client`. */
export function withSignal(client: LLMClient, signal: AbortSignal | undefined): LLMClient {
  if (!signal) return client;
  return {
    sendMessage: (sys, user, opts) => client.sendMessage(sys, user, { ...opts, signal }),
    ...(client.warmupCLI ? { warmupCLI: client.warmupCLI.bind(client) } : {}),
    ...(client.repoTools ? { repoTools: true } : {}),
  };
}

/** Appends one `LLMCall` to `calls` for every request sent through the returned client, failed ones included. */
export function recordCalls(client: LLMClient, label: { stage: string; agent?: string; fallback?: true }, calls: LLMCall[]): LLMClient {
  return {
    sendMessage: async (...args) => {
      const opts = args[2];
      const attempt = calls.filter(c => c.stage === label.stage && c.agent === label.agent).length + 1;
      const base = { ...label, ...(opts?.effort && { effort: opts.effort }), attempt };
      const start = Date.now();
      try {
        const response = await client.sendMessage(...args);
        const usage = response.usage ?? ZERO_USAGE;
        calls.push({
          ...base,
          ...(response.model && { model: response.model }),
          durationMs: response.latencyMs ?? Date.now() - start,
          ...usage,
          // Some paths report zeros when the provider sent no counts, and no real call uses no tokens.
          costUsd: response.model && (usage.inputTokens > 0 || usage.outputTokens > 0) ? estimateCostUsd(response.model, usage) : null,
        });
        return response;
      } catch (error) {
        calls.push({
          ...base,
          failed: true,
          error: sanitizeLogOutput(String((error as Error)?.message ?? error)).slice(0, 300),
          durationMs: Date.now() - start,
          ...ZERO_USAGE,
          costUsd: null,
        });
        throw error;
      }
    },
    ...(client.warmupCLI ? { warmupCLI: client.warmupCLI.bind(client) } : {}),
  };
}

/** Sums `calls` into one `UsageSummary`. */
export function summarizeCalls(calls: readonly LLMCall[]): UsageSummary {
  const usage = calls.reduce<LLMUsage>((sum, c) => addUsage(sum, c), { ...ZERO_USAGE });
  const priced = calls.filter(c => c.costUsd !== null);
  return {
    calls: calls.length,
    failedCalls: calls.filter(c => c.failed).length,
    ...usage,
    totalTokens: usage.inputTokens + usage.outputTokens,
    durationMs: calls.reduce((sum, c) => sum + c.durationMs, 0),
    estimatedCostUsd: priced.reduce((sum, c) => sum + c.costUsd!, 0),
    unpricedCalls: calls.length - priced.length - calls.filter(c => c.failed).length,
  };
}
