import { createHash } from 'crypto';

import * as core from '@actions/core';

import { wrapUpNoted } from '../tool-steps';
import { assumesShortRequests, estimateCostUsd } from './model-registry';
import { addUsage, LimitUsage, LLMCall, LLMClient, LLMUsage, QuotaError, RefusalError, SendMessageOptions, TimeoutError, UsageSummary, ZERO_USAGE } from './types';
import { readingsOf, sanitizeLogOutput } from './cli-utils';

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
 * A refused request with a `timeoutMs` gets only the time the refused call left of it on `fallback`,
 * and fails with a `TimeoutError` when none is left.
 *
 * A request that fails with a `QuotaError`, an `UnreachableError` included, is sent to `fallback` once too, with the time the failed call left.
 * Later requests go to `fallback` only after it answered one. The `QuotaError` is thrown unchanged when `fallback`
 * fails as well, when no time is left, or when `movesOnLimit` returns undefined. `movesOnLimit` takes `fallback` for
 * the stage and returns the function that gives it back. That function runs once, when every fallback call the stage
 * started after a limit failed and the stage has not moved. A request with no time left takes nothing.
 *
 * A request made with repository tools (`repoTools` in its options) never goes to a `fallback` without them. It is sent to
 * `client` and fails with its own error, also after the stage moved, since such a `fallback` would answer as if it had read the code.
 *
 * `onFallback` is called once, when the stage moves: at the first refusal, or when `fallback` first answers after a limit.
 * `onNoTime` is called for each request that is not sent to `fallback` because the failed call left no time.
 */
export function withModelFallback(
  client: LLMClient,
  fallback: LLMClient | undefined,
  onFallback: (error: RefusalError | QuotaError) => void,
  movesOnLimit: () => (() => void) | undefined = () => () => {},
  onNoTime: () => void = () => {},
): LLMClient {
  if (!fallback) return client;
  let moved = false;
  let giveBack: (() => void) | undefined;
  let trying = 0;
  const needsMissingTools = (opts: SendMessageOptions | undefined): boolean => !!opts?.repoTools && !fallback.repoTools;
  return {
    sendMessage: async (sys, user, opts) => {
      if (needsMissingTools(opts)) return client.sendMessage(sys, user, opts);
      if (moved) return fallback.sendMessage(sys, user, opts);
      const start = Date.now();
      try {
        return await client.sendMessage(sys, user, opts);
      } catch (error) {
        const limit = error instanceof QuotaError;
        if (!limit && !(error instanceof RefusalError)) throw error;
        const timeoutMs = opts?.timeoutMs || undefined;
        const usedMs = Date.now() - start;
        const outOfTime = timeoutMs !== undefined && usedMs >= timeoutMs;
        const resend = () => fallback.sendMessage(sys, user, timeoutMs === undefined ? opts : { ...opts, timeoutMs: timeoutMs - usedMs });
        if (outOfTime) onNoTime();
        if (limit) {
          if (outOfTime) throw error;
          giveBack ??= movesOnLimit();
          if (!giveBack) throw error;
          trying += 1;
          try {
            const response = await resend();
            if (!moved) onFallback(error);
            moved = true;
            return response;
          } catch (failure) {
            // The limit of the configured model stays the stage's error, whatever stops the fallback.
            core.warning(`The fallback model failed too, so the call fails with "${error.limit}": ${sanitizeLogOutput(String((failure as Error)?.message ?? failure)).slice(0, 300)}`);
            throw error;
          } finally {
            trying -= 1;
            // Another fallback call of the stage can still answer, and a stage that moved keeps the fallback.
            if (trying === 0 && !moved) {
              const release = giveBack;
              giveBack = undefined;
              release?.();
            }
          }
        }
        // Parallel calls can all be refused before the first one returns, and the stage moves only once.
        if (!moved) onFallback(error);
        moved = true;
        if (outOfTime) throw new TimeoutError(`The refused call used up its ${timeoutMs / 1000}s, so it is not sent to the fallback model`, { cause: error });
        return resend();
      }
    },
    ...(client.warmupCLI ? { warmupCLI: client.warmupCLI.bind(client) } : {}),
    ...(client.repoTools ? { repoTools: true } : {}),
  };
}

/**
 * Sends every request to `client` with `signal`, so its abort stops the call in flight. With `deadline`, a time in ms since
 * the epoch, a request gets no more time than is left until then, and one made at or after it is not sent and fails with a
 * `TimeoutError`. Without either, returns `client`.
 */
export function withSignal(client: LLMClient, signal: AbortSignal | undefined, deadline?: number): LLMClient {
  if (!signal && deadline === undefined) return client;
  return {
    sendMessage: async (sys, user, opts) => {
      const leftMs = deadline === undefined ? undefined : deadline - Date.now();
      if (leftMs !== undefined && leftMs <= 0) throw new TimeoutError('No time is left for the call, so it is not sent');
      return client.sendMessage(sys, user, {
        ...opts,
        ...(signal && { signal: opts?.signal ? AbortSignal.any([opts.signal, signal]) : signal }),
        ...(leftMs !== undefined && { timeoutMs: Math.min(opts?.timeoutMs || leftMs, leftMs) }),
      });
    },
    ...(client.warmupCLI ? { warmupCLI: client.warmupCLI.bind(client) } : {}),
    ...(client.repoTools ? { repoTools: true } : {}),
  };
}

/** Appends one `LLMCall` to `calls` for every request sent through the returned client, failed ones included. */
/**
 * Returns the first 12 hex digits of the SHA-256 of `systemPrompt`, with every run of digits replaced first. A prompt
 * quotes counts that change each round, such as open threads or tool steps, and those must not split one version.
 */
function promptDigest(systemPrompt: string): string {
  return createHash('sha256').update(systemPrompt.replace(/\d+/g, '#')).digest('hex').slice(0, 12);
}

export function recordCalls(client: LLMClient, label: { stage: string; agent?: string; fallback?: true }, calls: LLMCall[]): LLMClient {
  return {
    sendMessage: async (...args) => {
      const [systemPrompt, , opts] = args;
      const attempt = calls.filter(c => c.stage === label.stage && c.agent === label.agent).length + 1;
      const stepBudget = client.repoTools ? opts?.repoTools?.steps : undefined;
      const base = {
        ...label, ...(opts?.effort && { effort: client.sentEffort?.(opts.effort) ?? opts.effort }), attempt,
        promptDigest: promptDigest(opts?.promptTemplate ?? systemPrompt),
        ...(stepBudget !== undefined && { stepBudget }),
        ...(opts?.sweep && { sweep: true as const }),
      };
      const start = Date.now();
      try {
        const response = await client.sendMessage(...args);
        const usage = response.usage ?? ZERO_USAGE;
        const toolSteps = response.toolSteps;
        calls.push({
          ...base,
          ...(response.model && { model: response.model }),
          ...(toolSteps && { toolSteps }),
          ...(response.relatedReads && { relatedReads: response.relatedReads }),
          ...(response.closedCalls && { closedCalls: response.closedCalls }),
          ...(response.filesRead && { filesRead: response.filesRead }),
          ...(response.limits && { limits: response.limits }),
          ...(response.cut && { cut: response.cut }),
          // Only a client that reports its tool steps shows whether the model was told to wrap up.
          ...(stepBudget !== undefined && toolSteps && wrapUpNoted(toolSteps.length, stepBudget) && { wrapUpNoted: true as const }),
          durationMs: response.latencyMs ?? Date.now() - start,
          ...usage,
          // Some paths report zeros when the provider sent no counts, and no real call uses no tokens.
          costUsd: response.model && (usage.inputTokens > 0 || usage.outputTokens > 0) ? estimateCostUsd(response.model, usage) : null,
          ...(response.model && assumesShortRequests(response.model, usage) && { costAssumesShortRequests: true as const }),
        });
        return response;
      } catch (error) {
        calls.push({
          ...base,
          failed: true,
          error: sanitizeLogOutput(String((error as Error)?.message ?? error)).slice(0, 300),
          ...readingsOf(error),
          durationMs: Date.now() - start,
          ...ZERO_USAGE,
          costUsd: null,
        });
        throw error;
      }
    },
    ...(client.warmupCLI ? { warmupCLI: client.warmupCLI.bind(client) } : {}),
    ...(client.repoTools ? { repoTools: true } : {}),
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

/** The newest reading of each account's usage windows in `calls`, which run in the order they finished. */
export function latestLimits(calls: readonly LLMCall[]): LimitUsage[] {
  const latest = new Map<string, LimitUsage>();
  for (const limit of calls.flatMap(c => c.limits ?? [])) latest.set(JSON.stringify([limit.account, limit.window]), limit);
  return [...latest.values()];
}
