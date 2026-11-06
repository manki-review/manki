import type { LLMUsage } from './providers';
import { changeDigest } from './diff';
import { isEmptyInterRoundDiff, MAX_INTER_ROUND_DIFF_CHARS } from './judge';
import { collectResolvedThreadIds, fingerprintFinding, PreviousFinding, RecapState, securityOverridesIn } from './recap';
import { MANKI_VERSION } from './github';
import { parseModelSpec } from './providers';
import { routingDigest } from './routing';
import { CONTRADICTION_TAG, DEFENSIVE_HARDENING_TAG, FOLLOW_UP_TAG, FullReviewOptions, MemoryLoadStatus, OpenThread, OWN_PROPOSAL_TAG, ParsedDiff, RATCHET_SUPPRESSED_TAG, ReclassifiedPrior, RESOLVED_THREAD_SUPPRESSED_TAG, ReviewConfig, ReviewModels, ReviewResult, RoundCap, RoundContext, RoundDiffExcludedFile, RoundDiffPerFile, RoundRecap, RoundRouting, RoundStaticAnalysis, RoundTrigger, RoundUsage, RoundUsageStage, SECURITY_TAG, SecurityOverride, SEVERITY_ORDER, ThreadResolutionOverrides } from './types';

const ALLOWED_FINGERPRINT_TAGS = new Set<string>([
  DEFENSIVE_HARDENING_TAG,
  OWN_PROPOSAL_TAG,
  CONTRADICTION_TAG,
  RATCHET_SUPPRESSED_TAG,
  RESOLVED_THREAD_SUPPRESSED_TAG,
  FOLLOW_UP_TAG,
  SECURITY_TAG,
]);

/** What `buildRoundContext` records about the round besides the review result. */
export interface RoundRecordInput {
  prNumber: number;
  commitSha: string;
  trigger: RoundTrigger;
  options: FullReviewOptions;
  config: ReviewConfig;
  /** Where the round's `review` block came from. */
  reviewSource: RoundRouting['configSource'];
  models: ReviewModels;
  plannerEnabled: boolean;
  recap: RecapState;
  priorRoundCount: number;
  maxAutoRounds: number;
  diff: ParsedDiff;
  excludedFiles: RoundDiffExcludedFile[];
  openThreads: OpenThread[];
  interRoundDiff?: string;
  memoryLoadStatus: MemoryLoadStatus;
  memoryLoadError?: string;
  staticAnalysis?: RoundStaticAnalysis;
}

/** Durations `buildRoundContext` records that only the review stage measures. */
export interface RoundDurations {
  plannerDurationMs?: number;
  judgeDurationMs: number;
}

export function buildRoundRecap(recap: {
  priorRounds: unknown[];
  reclassifiedPriorCount?: number;
  reclassifiedPriors?: ReclassifiedPrior[];
  previousFindings?: PreviousFinding[];
}): RoundRecap {
  const count = recap.reclassifiedPriorCount ?? 0;
  const entries = recap.reclassifiedPriors ?? [];
  const securityOverrides: SecurityOverride[] = securityOverridesIn(recap.previousFindings ?? []).map(({ thread, login, via }) => ({ thread, login, via }));
  return {
    priorRoundCount: recap.priorRounds.length,
    reclassifiedPriorCount: count,
    ...(entries.length > 0 && { reclassifiedPriors: entries }),
    ...(securityOverrides.length > 0 && { securityOverrides }),
  };
}

/** Builds the `RoundContext` a review posts, which later rounds read back as their history. */
export function buildRoundContext(input: RoundRecordInput, result: ReviewResult, durations: RoundDurations): RoundContext {
  const {
    prNumber, commitSha, trigger, options, config, models, plannerEnabled, recap,
    priorRoundCount, maxAutoRounds, diff, excludedFiles, openThreads, interRoundDiff, memoryLoadStatus, memoryLoadError, staticAnalysis,
  } = input;
  const { skipCap, forceReview, bypassHint } = options;
  const { plannerDurationMs, judgeDurationMs } = durations;
  const filteredFiles = diff.files;
  const severityMap: Record<string, number> = { blocker: 0, warning: 0, suggestion: 0, nitpick: 0 };
  for (const f of result.findings) {
    if (f.severity in severityMap) severityMap[f.severity]++;
  }

  // Per-agent metrics: count raw and kept findings per agent
  const agentNames = result.agentNames;
  const allJudged = result.allJudgedFindings ?? [];
  const rawFindings = result.rawFindings ?? allJudged;
  const agentModels = result.agentModels ?? new Map<string, string>();
  const reviewerEffort = result.agentEffortMap?.values().next().value;
  const agentMetrics = agentNames.length > 0
    ? agentNames.map(name => {
        const usage = result.agentUsage?.get(name);
        const durationMs = result.agentDurationMs?.get(name);
        const retryCount = result.agentRetryCount?.get(name);
        const failureReason = result.agentFailureReasons?.[name];
        const model = agentModels.get(name);
        const effort = result.agentEffortMap?.get(name);
        const multiPassConsistency = result.agentMultiPassConsistency?.get(name);
        return {
          name,
          findingsRaw: rawFindings.filter(f => f.reviewers.includes(name)).length,
          findingsKept: result.findings.filter(f => f.reviewers.includes(name)).length,
          ...(durationMs != null && { durationMs }),
          status: failureReason ? 'failed' as const : 'success' as const,
          responseLength: result.agentResponseLengths?.get(name),
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          retryCount: retryCount ?? 0,
          ...(failureReason && { failureReason }),
          model,
          ...(effort && { effort }),
          ...(multiPassConsistency && { multiPassConsistency }),
        };
      })
    : undefined;
  const keptOnlyBy: Record<string, number> = {};
  let keptByMany = 0;
  for (const f of result.findings) {
    const finders = [...new Set(f.reviewers.filter(r => agentModels.has(r)))];
    if (finders.length === 1) keptOnlyBy[finders[0]] = (keptOnlyBy[finders[0]] ?? 0) + 1;
    else if (finders.length > 1) keptByMany++;
  }
  const pairName = result.pairAgentName;
  const keptPairOnly = pairName ? keptOnlyBy[pairName] ?? 0 : 0;
  // The two-finder fields stay for rounds with exactly two finders, so earlier rounds compare.
  const corroboration = {
    keptOnlyBy,
    keptByMany,
    ...(agentModels.size === 2 && pairName && {
      keptPrimaryOnly: Object.values(keptOnlyBy).reduce((sum, n) => sum + n, 0) - keptPairOnly,
      keptPairOnly,
      keptBoth: keptByMany,
    }),
  };

  // Judge calibration metrics
  const confidenceDistribution = { high: 0, medium: 0, low: 0 };
  for (const f of allJudged) {
    if (f.judgeConfidence) confidenceDistribution[f.judgeConfidence]++;
  }
  const severityChanges = allJudged.filter(f => f.judgeNotes).length;
  const regrades = { up: 0, down: 0 };
  for (const f of allJudged) {
    if (!f.reviewerSeverity) continue;
    const judgeGrade = f.originalSeverity ?? f.severity;
    regrades[SEVERITY_ORDER.indexOf(judgeGrade) < SEVERITY_ORDER.indexOf(f.reviewerSeverity) ? 'up' : 'down']++;
  }
  const mergedDuplicates = allJudged.length > 0
    ? (result.rawFindingCount ?? 0)
      + (result.toolAlertCount ?? 0)
      - (result.suppressionCount ?? 0)
      - (result.staticDedupCount ?? 0)
      - (result.llmDedupCount ?? 0)
      - allJudged.length
    : 0;
  const defensiveHardeningCount = allJudged.filter(f => f.tags?.includes(DEFENSIVE_HARDENING_TAG)).length;
  const ownProposalDemotedCount = allJudged.filter(f => f.tags?.includes(OWN_PROPOSAL_TAG)).length;
  const contradictionDemotedCount = allJudged.filter(f => f.tags?.includes(CONTRADICTION_TAG)).length;
  const ratchetSuppressedCount = allJudged.filter(f => f.tags?.includes(RATCHET_SUPPRESSED_TAG)).length;
  const resolvedThreadSuppressedCount = allJudged.filter(f => f.tags?.includes(RESOLVED_THREAD_SUPPRESSED_TAG)).length;
  const crossRoundSuppressed = result.crossRoundSuppressed;
  const crossRoundDemoted = result.crossRoundDemoted;
  const interRoundDiffEmptyOverride = result.interRoundDiffEmptyOverride;
  const inPrSuppressedCount = result.inPrSuppressedCount ?? 0;
  const openThreadCount = openThreads.length;
  const resolvedThreadIdCount = collectResolvedThreadIds(recap.previousFindings).size;
  const hasPriorRoundsForJudge = recap.priorRounds.length > 0;
  const interRoundDiffState: 'unknown' | 'empty' | 'changed' = !hasPriorRoundsForJudge || interRoundDiff === undefined
    ? 'unknown'
    : interRoundDiff.trim().length === 0
      ? 'empty'
      : 'changed';
  const interRoundDiffBytes = interRoundDiff !== undefined ? interRoundDiff.length : undefined;
  const interRoundDiffTruncated = interRoundDiff !== undefined && interRoundDiff.length > MAX_INTER_ROUND_DIFF_CHARS;
  const interRoundDiffKnownEmptyForCounts = hasPriorRoundsForJudge && isEmptyInterRoundDiff(interRoundDiff);
  const knownThreadIdSet = new Set(openThreads.map(t => t.threadId));
  let addressedDropped = 0;
  let uncertainCount = 0;
  for (const ev of result.threadEvaluations ?? []) {
    if (ev.status === 'uncertain') uncertainCount++;
    if (ev.status === 'addressed' && (!knownThreadIdSet.has(ev.threadId) || interRoundDiffKnownEmptyForCounts)) {
      addressedDropped++;
    }
  }
  const notAddressedOverridden = interRoundDiffEmptyOverride?.applied ? interRoundDiffEmptyOverride.affectedThreadCount : 0;
  const threadResolutionOverrides: ThreadResolutionOverrides | undefined =
    (addressedDropped > 0 || notAddressedOverridden > 0 || uncertainCount > 0)
      ? { addressedDropped, notAddressedOverridden, uncertainCount }
      : undefined;
  // File analysis metrics
  const fileTypes: Record<string, number> = {};
  for (const file of filteredFiles) {
    const dotIdx = file.path.lastIndexOf('.');
    const ext = dotIdx !== -1 ? file.path.slice(dotIdx) : '(none)';
    fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
  }

  const round = priorRoundCount + 1;
  const cap: RoundCap = {
    priorRoundCount,
    maxAutoRounds,
    skipCap: !!skipCap,
    forceReview: !!forceReview,
    bypassReason: bypassHint ?? (forceReview ? 'force_review' : skipCap ? 'skip_cap' : 'within_cap'),
  };

  const buildStage = (usage: LLMUsage | undefined): RoundUsageStage => {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  };
  const reviewerUsage: LLMUsage | undefined = result.agentUsage && result.agentUsage.size > 0
    ? Array.from(result.agentUsage.values()).reduce(
        (acc, u) => ({
          inputTokens: acc.inputTokens + u.inputTokens,
          outputTokens: acc.outputTokens + u.outputTokens,
          cachedTokens: acc.cachedTokens + u.cachedTokens,
          reasoningTokens: acc.reasoningTokens + u.reasoningTokens,
        }),
        { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
      )
    : undefined;
  const stageUsages: Array<['planner' | 'reviewer' | 'judge' | 'dedup' | 'verdict', LLMUsage | undefined]> = [
    ['planner', result.plannerUsage],
    ['reviewer', reviewerUsage],
    ['judge', result.judgeUsage],
    ['dedup', result.dedupUsage],
    ['verdict', result.verdictUsage],
  ];
  const perStage: NonNullable<RoundUsage['perStage']> = {};
  let totalInput = 0;
  let totalOutput = 0;
  for (const [name, u] of stageUsages) {
    if (!u) continue;
    const stage = buildStage(u);
    perStage[name] = stage;
    totalInput += stage.inputTokens ?? 0;
    totalOutput += stage.outputTokens ?? 0;
  }
  const usage: RoundUsage = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    totalTokens: totalInput + totalOutput,
    ...(Object.keys(perStage).length > 0 && { perStage }),
  };
  const findingEntries = result.findings.map(f => ({
    fingerprint: fingerprintFinding(f.title, f.file ?? '', f.line || 0),
    ...(f.threadId && { threadId: f.threadId }),
    severity: f.severity,
    ...(f.reviewers.length > 0 && { reviewers: f.reviewers }),
    ...(f.suggestedFix && { suggestedFix: f.suggestedFix.slice(0, 300) }),
    ...(f.title && { title: f.title.slice(0, 200) }),
    ...(f.judgeNotes && { judgeNotes: f.judgeNotes.slice(0, 500) }),
    ...(f.judgeConfidence && { judgeConfidence: f.judgeConfidence }),
    ...(f.reachability && { reachability: f.reachability }),
    ...(f.reachabilityReasoning && { reachabilityReasoning: f.reachabilityReasoning.slice(0, 500) }),
    ...(f.tags && f.tags.length > 0 && { tags: f.tags.filter(t => ALLOWED_FINGERPRINT_TAGS.has(t)) }),
    ...(f.originalSeverity && { originalSeverity: f.originalSeverity }),
    ...(f.reviewerSeverity && { reviewerSeverity: f.reviewerSeverity }),
    ...(f.toolEvidence && { toolEvidence: f.toolEvidence.status }),
    ...(f.toolSource && { toolSource: f.toolSource }),
  }));
  return {
    meta: {
      prNumber,
      commitSha,
      round,
      timestamp: new Date().toISOString(),
      mankiVersion: MANKI_VERSION,
      cap,
      trigger,
      ...(result.outcome && { outcome: result.outcome }),
    },
    config: {
      memoryEnabled: config.memory?.enabled ?? false,
      ...(config.review_passes != null && { reviewPasses: config.review_passes }),
    },
    diff: {
      changeDigest: changeDigest(diff, config.exclude_paths),
      lines: diff.totalAdditions + diff.totalDeletions,
      additions: diff.totalAdditions,
      deletions: diff.totalDeletions,
      filesReviewed: filteredFiles.length,
      fileTypes,
      ...(excludedFiles.length > 0 && { excludedFiles: excludedFiles.slice(0, 100) as RoundDiffExcludedFile[] }),
      ...(diff.binarySkipped && diff.binarySkipped.length > 0 && { binarySkipped: diff.binarySkipped.slice(0, 100) }),
      oversizedHandled: false,
      perFile: filteredFiles.slice(0, 200).map((f): RoundDiffPerFile => ({
        path: f.path,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        changeType: f.changeType,
      })),
    },
    models: {
      ...(plannerEnabled && { planner: models.planner }),
      reviewer: models.reviewer,
      ...(result.pairAgentName && { reviewerPair: models.reviewerPair }),
      judge: models.judge,
      dedup: models.dedup,
      ...(result.modelFallbacks && { fallbacks: result.modelFallbacks }),
    },
    planner: (() => {
      const source = result.plannerSource ?? (result.plannerResult ? 'planner' : 'disabled');
      const used = source === 'planner';
      const base = {
        source,
        used,
        ...(result.plannerFallbackReason && { fallbackReason: result.plannerFallbackReason }),
        ...result.triage,
        ...(result.sensitivePaths != null && { sensitivePaths: result.sensitivePaths }),
        ...(result.ciOrDependencyPaths != null && { ciOrDependencyPaths: result.ciOrDependencyPaths }),
        ...(result.trivialOverridden && { trivialOverridden: true }),
        teamSize: result.agentNames.length,
        ...(reviewerEffort && { reviewerEffort }),
      };
      if (!result.plannerResult) return base;
      return {
        ...base,
        ...(result.plannerResult.defaultedFields && { defaultedFields: result.plannerResult.defaultedFields }),
        judgeEffort: result.plannerResult.judgeEffort,
        prType: result.plannerResult.prType,
        ...(plannerDurationMs != null && { durationMs: plannerDurationMs }),
        ...(result.plannerResult.language && { language: result.plannerResult.language }),
        ...(result.plannerResult.context && { context: result.plannerResult.context }),
      };
    })(),
    reviewers: {
      agents: result.agentNames,
      ...(agentMetrics && { agentMetrics }),
      ...corroboration,
    },
    ...(result.routing && {
      routing: {
        ...result.routing,
        configSource: input.reviewSource,
        configDigest: routingDigest(input.config.review),
        reviewers: [...agentModels].map(([name, model]) => {
          const effort = result.agentEffortMap?.get(name);
          return { name, model, provider: parseModelSpec(model).provider, ...(effort && { effort }) };
        }),
      },
    }),
    judge: {
      summary: result.summary,
      confidenceDistribution,
      severityChanges,
      ...((regrades.up > 0 || regrades.down > 0) && { regrades }),
      mergedDuplicates,
      ...(result.toolAlertCount && { toolAlertCount: result.toolAlertCount }),
      durationMs: judgeDurationMs,
      retryCount: result.judgeRetryCount ?? 0,
      ...(result.verdictReason && { verdictReason: result.verdictReason }),
      ...(defensiveHardeningCount > 0 && { defensiveHardeningCount }),
      ...(ownProposalDemotedCount > 0 && { ownProposalDemotedCount }),
      ...(contradictionDemotedCount > 0 && { contradictionDemotedCount }),
      ...(ratchetSuppressedCount > 0 && { ratchetSuppressedCount }),
      ...(resolvedThreadSuppressedCount > 0 && { resolvedThreadSuppressedCount }),
      ...(inPrSuppressedCount > 0 && { inPrSuppressedCount }),
      ...(crossRoundSuppressed != null && crossRoundSuppressed > 0 && { crossRoundSuppressed }),
      ...(crossRoundDemoted != null && crossRoundDemoted > 0 && { crossRoundDemoted }),
      ...(interRoundDiffEmptyOverride && { interRoundDiffEmptyOverride }),
      ...(result.threadEvaluations && result.threadEvaluations.length > 0 && { threadEvaluations: result.threadEvaluations }),
      ...(result.verdictTrace && { verdictTrace: result.verdictTrace }),
      openThreadsState: recap.openThreadsState,
      openThreadCount,
      resolvedThreadIdCount,
      interRoundDiffState,
      ...(interRoundDiffBytes != null && { interRoundDiffBytes }),
      interRoundDiffTruncated,
      ...(threadResolutionOverrides && { threadResolutionOverrides }),
    },
    dedup: {
      ...(result.staticDedupCount != null && { staticDropped: result.staticDedupCount }),
      ...(result.llmDedupCount != null && { llmDropped: result.llmDedupCount }),
      ...(mergedDuplicates > 0 && { sameRoundLlmDropped: mergedDuplicates }),
      ...(result.duplicateMatches && result.duplicateMatches.length > 0 && { duplicateMatches: result.duplicateMatches.slice(0, 50) }),
      ...(result.testNitSuppressedCount != null && result.testNitSuppressedCount > 0 && { testNitSuppressedCount: result.testNitSuppressedCount }),
      ...(result.staticSignalMatches && result.staticSignalMatches.length > 0 && { staticSignalMatches: result.staticSignalMatches.slice(0, 50) }),
      ...(result.dedupDurationMs != null && { durationMs: result.dedupDurationMs }),
    },
    memory: {
      ...(result.suppressionCount != null && result.suppressionCount > 0 && { suppressionsApplied: result.suppressionCount }),
      loadStatus: memoryLoadStatus,
      ...(memoryLoadError && { loadError: memoryLoadError }),
    },
    findings: {
      count: result.findings.length,
      severityCounts: severityMap,
      entries: findingEntries,
    },
    usage,
    verdict: result.verdict,
    recap: buildRoundRecap(recap),
    ...(staticAnalysis && { staticAnalysis }),
  };
}
