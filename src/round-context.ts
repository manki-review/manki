import type { LLMCall } from './providers';
import { isEmptyInterRoundDiff, MAX_INTER_ROUND_DIFF_CHARS } from './judge';
import { collectResolvedThreadIds, fingerprintFinding, PreviousFinding, RecapState, securityOverridesIn } from './recap';
import { MANKI_VERSION } from './github';
import type { MemorySkip } from './memory';
import { latestLimits, parseModelSpec, summarizeCalls } from './providers';
import { routingDigest } from './routing';
import { CONTRADICTION_TAG, FOLLOW_UP_TAG, FullReviewOptions, MemoryLoadStatus, OpenThread, OWN_PROPOSAL_TAG, ParsedDiff, PromptVersions, RATCHET_SUPPRESSED_TAG, ReclassifiedPrior, RESOLVED_THREAD_SUPPRESSED_TAG, ReviewConfig, ReviewModels, ReviewResult, RoundCap, RoundContext, RoundDiffExcludedFile, RoundDiffPerFile, RoundJudgeDrop, RoundRawFinding, RoundRecap, RoundRelatedRepo, RoundRouting, RoundStaticAnalysis, RoundTrigger, RoundUsage, RoundUsageStage, SECURITY_TAG, SecurityOverride, SEVERITY_ORDER, ThreadResolutionOverrides, TokenServiceCall, PRE_EXISTING_TAG, Finding, FindingFingerprintEntry } from './types';

const ALLOWED_FINGERPRINT_TAGS = new Set<string>([
  OWN_PROPOSAL_TAG,
  CONTRADICTION_TAG,
  RATCHET_SUPPRESSED_TAG,
  RESOLVED_THREAD_SUPPRESSED_TAG,
  FOLLOW_UP_TAG,
  SECURITY_TAG,
  PRE_EXISTING_TAG,
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
  /** `changeDigest` of the PR's full diff, excluded files included. */
  changeDigest: string;
  excludedFiles: RoundDiffExcludedFile[];
  openThreads: OpenThread[];
  interRoundDiff?: string;
  memoryLoadStatus: MemoryLoadStatus;
  memoryLoadError?: string;
  /** Why the run may not use memory, when `memoryLoadStatus` is `skipped`. */
  memorySkip?: MemorySkip;
  staticAnalysis?: RoundStaticAnalysis;
  /** The token service calls the run made before the round posts. */
  tokenServiceCalls?: TokenServiceCall[];
}

/** Durations `buildRoundContext` records that only the review stage measures. */
export interface RoundDurations {
  plannerDurationMs?: number;
  judgeDurationMs: number;
  /** Wall-clock time of the run up to the review it posts. */
  wallClockMs?: number;
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

/** Totals `calls`, per stage and per model, and keeps the calls. Only the newest reading of each usage limit is kept. */
export function buildRoundUsage(calls: LLMCall[]): RoundUsage {
  const groups = (key: (call: LLMCall) => string | undefined): Record<string, RoundUsageStage> => {
    const byKey = new Map<string, LLMCall[]>();
    for (const call of calls) {
      const k = key(call);
      if (k) byKey.set(k, [...(byKey.get(k) ?? []), call]);
    }
    return Object.fromEntries([...byKey].map(([k, group]) => [k, summarizeCalls(group)]));
  };
  const limits = latestLimits(calls);
  return {
    ...summarizeCalls(calls),
    ...(calls.length > 0 && { perStage: groups(c => c.stage), perModel: groups(c => c.model), llmCalls: calls.map(({ limits: _limits, ...call }) => call) }),
    ...(limits.length > 0 && { limits }),
  };
}

/** Builds the `RoundContext` a review posts, which later rounds read back as their history. */
export function buildRoundContext(input: RoundRecordInput, result: ReviewResult, durations: RoundDurations): RoundContext {
  const {
    prNumber, commitSha, trigger, options, config, models, plannerEnabled, recap,
    priorRoundCount, maxAutoRounds, diff, excludedFiles, openThreads, interRoundDiff, memoryLoadStatus, memoryLoadError, memorySkip, staticAnalysis,
    tokenServiceCalls,
  } = input;
  const { skipCap, forceReview, bypassHint } = options;
  const { plannerDurationMs, judgeDurationMs, wallClockMs } = durations;
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
  const llmCalls = result.llmCalls ?? [];
  const keptFinders = result.findings.map(f => new Set(f.reviewers.filter(r => agentNames.includes(r))));
  const agentMetrics = agentNames.length > 0
    ? agentNames.map(name => {
        const usage = summarizeCalls(llmCalls.filter(c => c.stage === 'reviewer' && c.agent === name));
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
          keptOnly: keptFinders.filter(finders => finders.size === 1 && finders.has(name)).length,
          keptShared: keptFinders.filter(finders => finders.size > 1 && finders.has(name)).length,
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

  // Judge calibration metrics
  const confidenceDistribution = { high: 0, medium: 0, low: 0 };
  for (const f of allJudged) {
    if (f.judgeConfidence) confidenceDistribution[f.judgeConfidence]++;
  }
  const severityChanges = allJudged.filter(f => f.judgeNotes).length;
  const regrades = { up: 0, down: 0 };
  for (const f of allJudged) {
    // A later step can move the finding again, so the judge's grade is where its own step ends.
    const judgeGrade = f.gradePath?.find(step => step.by === 'judge')?.to ?? f.originalSeverity ?? f.severity;
    // A merged duplicate can be filed at the judge's grade, which is no regrade.
    if (!f.reviewerSeverity || f.reviewerSeverity === judgeGrade) continue;
    regrades[SEVERITY_ORDER.indexOf(judgeGrade) < SEVERITY_ORDER.indexOf(f.reviewerSeverity) ? 'up' : 'down']++;
  }
  const mergedDuplicates = allJudged.length > 0
    ? (result.rawFindingCount ?? 0)
      + (result.toolAlertCount ?? 0)
      - (result.staticDedupCount ?? 0)
      - (result.llmDedupCount ?? 0)
      - allJudged.length
    : 0;
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

  const usage = { ...buildRoundUsage(llmCalls), ...(wallClockMs != null && { wallClockMs }) };
  const rawFindingRecords: RoundRawFinding[] = (result.rawFindings ?? []).map(f => ({
    title: f.title,
    file: f.file,
    line: f.line,
    severity: f.severity,
    reviewers: f.reviewers,
    description: f.description,
    ...(f.suggestedFix && { suggestedFix: f.suggestedFix }),
    ...(f.howToFix && { howToFix: f.howToFix }),
    ...(f.evidence && { evidence: f.evidence }),
    ...(f.notChecked && { notChecked: true }),
    ...(f.lead && { lead: f.lead }),
  }));
  const judgeDrops: RoundJudgeDrop[] = allJudged.filter(f => f.severity === 'ignore').map(f => ({
    title: f.title,
    file: f.file,
    line: f.line,
    reviewers: f.reviewers,
    ...(f.reviewerSeverity && { reviewerSeverity: f.reviewerSeverity }),
    ...(f.judgeConfidence && { judgeConfidence: f.judgeConfidence }),
    ...(f.judgeNotes && { judgeNotes: f.judgeNotes }),
    ...(f.refutation && { refutation: f.refutation }),
    ...(f.pairRefutation && { pairRefutation: f.pairRefutation }),
    ...(f.gradePath && { gradePath: f.gradePath }),
    ...(f.gradeIfConfirmed && { gradeIfConfirmed: f.gradeIfConfirmed }),
    ...(f.doubts && { doubts: f.doubts }),
    ...(f.cell && { cell: f.cell }),
  }));
  const toEntry = (f: Finding): FindingFingerprintEntry => ({
    fingerprint: fingerprintFinding(f.title, f.file ?? '', f.line || 0),
    ...((f.threadId ?? f.answeredIn?.threadId) && { threadId: f.threadId ?? f.answeredIn?.threadId }),
    severity: f.severity,
    ...(f.reviewers.length > 0 && { reviewers: f.reviewers }),
    ...(f.suggestedFix && { suggestedFix: f.suggestedFix.slice(0, 300) }),
    ...(f.title && { title: f.title.slice(0, 200) }),
    ...(f.judgeNotes && { judgeNotes: f.judgeNotes }),
    ...(f.judgeConfidence && { judgeConfidence: f.judgeConfidence }),
    ...(f.tags && f.tags.length > 0 && { tags: f.tags.filter(t => ALLOWED_FINGERPRINT_TAGS.has(t)) }),
    ...(f.originalSeverity && { originalSeverity: f.originalSeverity }),
    ...(f.reviewerSeverity && { reviewerSeverity: f.reviewerSeverity }),
    ...(f.toolEvidence && { toolEvidence: f.toolEvidence.status }),
    ...(f.toolSource && { toolSource: f.toolSource }),
    ...(f.origin && { origin: f.origin }),
    ...(f.raisedIn && { raisedIn: f.raisedIn }),
    ...(f.category && { category: f.category }),
    ...(f.effort && { effort: f.effort }),
    ...(f.evidence && { evidence: f.evidence }),
    ...(f.notChecked && { notChecked: true }),
    ...(f.refutation && { refutation: f.refutation }),
    ...(f.pairRefutation && { pairRefutation: f.pairRefutation }),
    ...(f.gradeIfConfirmed && { gradeIfConfirmed: f.gradeIfConfirmed }),
    ...(f.doubts && { doubts: f.doubts }),
    ...(f.cell && { cell: f.cell }),
    ...(f.judgeCell && { judgeCell: f.judgeCell }),
    ...(f.gradePath && { gradePath: f.gradePath }),
    ...(f.preExisting && f.preExistingCheck && { preExisting: { reason: f.preExisting.slice(0, 200), check: f.preExistingCheck } }),
    ...(f.unpostedReason && { unpostedReason: f.unpostedReason }),
  });
  const unposted = [...(result.unpostedPreExisting ?? []), ...(result.unpostedNotes ?? [])].map(toEntry);
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
      ...(result.needsHuman && { needsHuman: result.needsHuman }),
      ...(llmCalls.length > 0 && { promptVersions: promptVersions(llmCalls) }),
      ...(options.draft && { draft: true }),
      ...(!result.reviewComplete && { incomplete: true as const }),
    },
    config: {
      memoryEnabled: config.memory?.enabled ?? false,
      ...(config.review_passes != null && { reviewPasses: config.review_passes }),
    },
    diff: {
      changeDigest: input.changeDigest,
      ...(result.changedSinceLastRoundCount != null && { changedSinceLastRound: result.changedSinceLastRoundCount }),
      lines: diff.totalAdditions + diff.totalDeletions,
      additions: diff.totalAdditions,
      deletions: diff.totalDeletions,
      filesReviewed: filteredFiles.length,
      fileTypes,
      ...(excludedFiles.length > 0 && { excludedFiles }),
      ...(diff.binarySkipped && diff.binarySkipped.length > 0 && { binarySkipped: diff.binarySkipped.map(f => f.path) }),
      oversizedHandled: false,
      perFile: filteredFiles.map((f): RoundDiffPerFile => ({
        path: f.path,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        changeType: f.changeType,
      })),
    },
    models: {
      ...(plannerEnabled && { planner: models.planner }),
      reviewer: models.reviewer,
      judge: models.judge,
      ...(models.refuterPair && (result.llmCalls?.some(c => c.agent === 'refute_pair') || [...result.findings, ...allJudged].some(f => f.pairRefutation))
        && { refuterPair: models.refuterPair }),
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
      };
      if (!result.plannerResult) return base;
      return {
        ...base,
        ...(result.plannerResult.defaultedFields && { defaultedFields: result.plannerResult.defaultedFields }),
        judgeEffort: result.plannerResult.judgeEffort,
        prType: result.plannerResult.prType,
        ...(plannerDurationMs != null && { durationMs: plannerDurationMs }),
        ...(result.plannerResult.language && { language: result.plannerResult.language }),
      };
    })(),
    reviewers: {
      agents: result.agentNames,
      ...(agentMetrics && { agentMetrics }),
      ...(rawFindingRecords.length > 0 && { rawFindings: rawFindingRecords }),
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
      ...(result.judgeEffort && { effort: result.judgeEffort }),
      ...(judgeDrops.length > 0 && { dropped: judgeDrops }),
      confidenceDistribution,
      severityChanges,
      ...((regrades.up > 0 || regrades.down > 0) && { regrades }),
      mergedDuplicates,
      ...(result.toolAlertCount && { toolAlertCount: result.toolAlertCount }),
      durationMs: judgeDurationMs,
      retryCount: result.judgeRetryCount ?? 0,
      ...(result.verdictReason && { verdictReason: result.verdictReason }),
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
      ...(result.fixClaimedThreadIds && { fixClaimedThreads: result.fixClaimedThreadIds }),
      ...(threadResolutionOverrides && { threadResolutionOverrides }),
    },
    dedup: {
      ...(result.staticDedupCount != null && { staticDropped: result.staticDedupCount }),
      ...(result.llmDedupCount != null && { llmDropped: result.llmDedupCount }),
      ...(mergedDuplicates > 0 && { sameRoundLlmDropped: mergedDuplicates }),
      ...(result.duplicateMatches && result.duplicateMatches.length > 0 && { duplicateMatches: result.duplicateMatches }),
      ...(result.testNitSuppressedCount != null && result.testNitSuppressedCount > 0 && { testNitSuppressedCount: result.testNitSuppressedCount }),
      ...(result.staticSignalMatches && result.staticSignalMatches.length > 0 && { staticSignalMatches: result.staticSignalMatches }),
      ...(result.dedupDurationMs != null && { durationMs: result.dedupDurationMs }),
    },
    memory: {
      ...(result.suppressionCount != null && result.suppressionCount > 0 && { suppressionsApplied: result.suppressionCount }),
      ...(result.memoryLoaded && { loaded: result.memoryLoaded }),
      ...(result.memorySuppressed && result.memorySuppressed.length > 0 && {
        suppressed: result.memorySuppressed.map(f => ({
          title: f.title.slice(0, 200), file: f.file, line: f.line, severity: f.severity, suppressionId: f.suppressedBy ?? 'unknown',
        })),
      }),
      loadStatus: memoryLoadStatus,
      ...(memorySkip && { skipReason: memorySkip.reason }),
      ...(memoryLoadError && { loadError: memoryLoadError }),
    },
    findings: {
      count: result.findings.length,
      severityCounts: severityMap,
      entries: result.findings.map(toEntry),
      ...(unposted.length > 0 && { unposted }),
    },
    usage,
    verdict: result.verdict,
    recap: buildRoundRecap(recap),
    ...(staticAnalysis && { staticAnalysis }),
    ...(tokenServiceCalls && tokenServiceCalls.length > 0 && { tokenService: tokenServiceCalls }),
    ...(result.slicing && { slicing: result.slicing }),
    ...(result.leads && result.leads.length > 0 && { leads: result.leads }),
    ...(result.relatedRepos && { relatedRepos: result.relatedRepos.map(r => withReads(r, llmCalls)) }),
    ...(result.usesOutsideDiff && { usesOutsideDiff: result.usesOutsideDiff }),
    ...(result.relatedWork && {
      relatedWork: {
        candidates: result.relatedWork.items.map(({ kind, number, sharedFiles, relation, reason }) => ({ kind, number, sharedFiles, relation, reason })),
        ...(result.relatedWork.skipped && { skipped: result.relatedWork.skipped }),
      },
    }),
    ...(result.comparisons?.length && { comparisons: result.comparisons }),
    ...(result.sweeps?.length && { sweeps: result.sweeps }),
  };
}

/** Adds to `repo` the tool calls of `calls` that read it, when any did. */
function withReads(repo: RoundRelatedRepo, calls: LLMCall[]): RoundRelatedRepo {
  const reads = calls.reduce((sum, call) => sum + (call.relatedReads?.[repo.repo] ?? 0), 0);
  return reads > 0 ? { ...repo, reads } : repo;
}

/** Returns, per stage, the distinct prompt digests of `calls`, sorted. */
function promptVersions(calls: LLMCall[]): PromptVersions {
  const byStage = new Map<string, Set<string>>();
  for (const { stage, promptDigest } of calls) {
    if (promptDigest) byStage.set(stage, (byStage.get(stage) ?? new Set()).add(promptDigest));
  }
  return Object.fromEntries([...byStage].map(([stage, digests]) => [stage, [...digests].sort()]));
}
