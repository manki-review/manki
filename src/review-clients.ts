import * as core from '@actions/core';

import { resolveFallbackModel, resolveModel } from './config';
import { buildAuthForProvider, createLLMClient, parseModelSpec, sanitizeLogOutput } from './providers';
import type { LLMClient, ProviderInputs } from './providers';
import { ReviewClients, teamModels } from './review';
import { modelIdentity } from './routing';
import type { ReviewConfig, ReviewModels } from './types';

/** Builds the client for `model` with the credentials its provider takes. Throws when they are missing. */
export function buildLLMClient(model: string, providerInputs: ProviderInputs): LLMClient {
  const spec = parseModelSpec(model);
  return createLLMClient(spec.provider, spec.model, buildAuthForProvider(spec.provider, providerInputs));
}

/** Builds one LLM client per stage, plus each stage's refusal fallback. Throws on a model spec or credentials that do not resolve. */
export function buildReviewClients(config: ReviewConfig, providerInputs: ProviderInputs): { clients: ReviewClients; models: ReviewModels } {
  const finderModels = teamModels(config);
  const models: ReviewModels = {
    planner: resolveModel(config, 'planner'),
    judge: resolveModel(config, 'judge'),
    ...(config.models?.second_refuter && { refuterPair: config.models.second_refuter }),
    dedup: resolveModel(config, 'dedup'),
  };
  core.info(`Models — planner: ${models.planner}, reviewers: ${finderModels.join(', ')}, judge: ${models.judge}, second refuter: ${models.refuterPair ?? 'off'}, dedup: ${models.dedup}`);

  const buildClient = (model: string) => buildLLMClient(model, providerInputs);
  const reviewerByModel = new Map(finderModels.map(model => [modelIdentity(model), buildClient(model)]));
  const reviewer = reviewerByModel.get(modelIdentity(finderModels[0]))!;
  const judge = buildClient(models.judge);
  const refuterPair = models.refuterPair ? buildClient(models.refuterPair) : undefined;
  const planner = config.planner?.enabled !== false ? buildClient(models.planner) : undefined;
  const dedup = buildClient(models.dedup);
  const fallbackClients = new Map<string, LLMClient>([...reviewerByModel, [modelIdentity(models.judge), judge]]);
  const fallbackFor = (stageModel: string) => {
    const model = resolveFallbackModel(config, stageModel);
    if (!model) return undefined;
    const key = modelIdentity(model);
    if (!fallbackClients.has(key)) fallbackClients.set(key, buildClient(model));
    return { model, client: fallbackClients.get(key)! };
  };
  const fallbacks: NonNullable<ReviewClients['fallbacks']> = {
    ...(planner && { planner: fallbackFor(models.planner) }),
    reviewerByModel: new Map(finderModels.flatMap((model) => {
      const fallback = fallbackFor(model);
      return fallback ? [[modelIdentity(model), fallback] as const] : [];
    })),
    judge: fallbackFor(models.judge),
    dedup: fallbackFor(models.dedup),
  };
  return { clients: { reviewer, reviewerByModel, judge, ...(refuterPair && { refuterPair }), planner, dedup, fallbacks }, models };
}

function fallbackClientsOf({ fallbacks }: ReviewClients): LLMClient[] {
  if (!fallbacks) return [];
  return [fallbacks.planner, ...(fallbacks.reviewerByModel?.values() ?? []), fallbacks.judge, fallbacks.dedup].flatMap(f => f ? [f.client] : []);
}

/**
 * Eagerly install any provider CLI before the planner timer starts. The
 * fallback `npm install -g` inside `ensureCLI` takes around 30s on a
 * cold runner and would otherwise race the planner's own 30s timeout.
 * Warming up once here pays the cost before any per-call deadline runs.
 * Deduplicate by client instance so roles that share a client don't
 * serialize redundant install retries on failure.
 */
export async function warmUpClients(clients: ReviewClients): Promise<void> {
  const warmupTargets = new Set<LLMClient>(
    [clients.planner, ...(clients.reviewerByModel?.values() ?? []), clients.judge, clients.refuterPair, clients.dedup, ...fallbackClientsOf(clients)].filter(
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
