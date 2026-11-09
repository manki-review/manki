import * as core from '@actions/core';

import { resolveFallbackModel, resolveModel, resolvePairModel } from './config';
import { buildAuthForProvider, createLLMClient, parseModelSpec, sanitizeLogOutput } from './providers';
import type { LLMClient, ProviderInputs } from './providers';
import { ReviewClients, teamModels } from './review';
import type { ReviewConfig, ReviewModels } from './types';

/** Builds the client for `model` with the credentials its provider takes. Throws when they are missing. */
export function buildLLMClient(model: string, providerInputs: ProviderInputs): LLMClient {
  const spec = parseModelSpec(model);
  return createLLMClient(spec.provider, spec.model, buildAuthForProvider(spec.provider, providerInputs));
}

export function buildReviewClients(config: ReviewConfig, providerInputs: ProviderInputs): { clients: ReviewClients; models: ReviewModels } {
  const models: ReviewModels = {
    planner: resolveModel(config, 'planner'),
    reviewer: resolveModel(config, 'reviewer'),
    reviewerPair: resolvePairModel(config),
    judge: resolveModel(config, 'judge'),
    dedup: resolveModel(config, 'dedup'),
  };
  core.info(`Models — planner: ${models.planner}, reviewer: ${models.reviewer}, reviewer pair: ${models.reviewerPair}, judge: ${models.judge}, dedup: ${models.dedup}`);

  const buildClient = (model: string) => buildLLMClient(model, providerInputs);
  const reviewer = buildClient(models.reviewer);
  const reviewerByModel = new Map<string, LLMClient>([[models.reviewer, reviewer]]);
  for (const model of teamModels(config)) {
    if (!reviewerByModel.has(model)) reviewerByModel.set(model, buildClient(model));
  }
  const judge = buildClient(models.judge);
  const planner = config.planner?.enabled !== false ? buildClient(models.planner) : undefined;
  const dedup = buildClient(models.dedup);
  const fallbackClients = new Map<string, LLMClient>([...reviewerByModel, [models.judge, judge]]);
  const fallbackFor = (stageModel: string) => {
    const model = resolveFallbackModel(config, stageModel);
    if (!model) return undefined;
    if (!fallbackClients.has(model)) fallbackClients.set(model, buildClient(model));
    return { model, client: fallbackClients.get(model)! };
  };
  const fallbacks: NonNullable<ReviewClients['fallbacks']> = {
    ...(planner && { planner: fallbackFor(models.planner) }),
    reviewerByModel: new Map([...reviewerByModel.keys()].flatMap((model) => {
      const fallback = fallbackFor(model);
      return fallback ? [[model, fallback] as const] : [];
    })),
    judge: fallbackFor(models.judge),
    dedup: fallbackFor(models.dedup),
  };
  return { clients: { reviewer, reviewerByModel, judge, planner, dedup, fallbacks }, models };
}

/**
 * Eagerly install any provider CLI before the planner timer starts. The
 * fallback `npm install -g` inside `ensureCLI` takes around 30s on a
 * cold runner and would otherwise race the planner's own 30s timeout.
 * Warming up once here pays the cost before any per-call deadline runs.
 * Deduplicate by client instance so roles that share a client don't
 * serialize redundant install retries on failure.
 */
function fallbackClientsOf({ fallbacks }: ReviewClients): LLMClient[] {
  if (!fallbacks) return [];
  return [fallbacks.planner, ...(fallbacks.reviewerByModel?.values() ?? []), fallbacks.judge, fallbacks.dedup].flatMap(f => f ? [f.client] : []);
}

export async function warmUpClients(clients: ReviewClients): Promise<void> {
  const warmupTargets = new Set<LLMClient>(
    [clients.planner, ...(clients.reviewerByModel?.values() ?? []), clients.judge, clients.dedup, ...fallbackClientsOf(clients)].filter(
      (c): c is LLMClient => !!c,
    ),
  );
  await Promise.allSettled(
    [...warmupTargets].map((c) =>
      c.warmupCLI
        ? c.warmupCLI().catch((error) =>
            core.warning(
              sanitizeLogOutput(
                `Provider CLI warmup failed (${c.constructor.name}): ${error instanceof Error ? error.message : error}`,
              ),
            ),
          )
        : Promise.resolve(),
    ),
  );
}
