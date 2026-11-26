import type { LLMCall } from './providers';
import { calibrate, FixRateHistory } from './fix-rate';
import { isEmptyInterRoundDiff, MAX_INTER_ROUND_DIFF_CHARS } from './judge';
import { collectResolvedThreadIds, fingerprintFinding, PreviousFinding, RecapState, securityOverridesIn } from './recap';
import { MANKI_VERSION, RepoContext } from './github';
import type { MemorySkip } from './memory';
import { latestLimits, parseModelSpec, summarizeCalls } from './providers';
import { routingDigest } from './routing';
import { DISPROVED_TAG, FOLLOW_UP_TAG, FullReviewOptions, MemoryLoadStatus, OpenThread, OWN_PROPOSAL_TAG, ParsedDiff, PromptVersions, RATCHET_SUPPRESSED_TAG, ReclassifiedPrior, RESOLVED_THREAD_SUPPRESSED_TAG, ReviewConfig, ReviewModels, ReviewResult, RoundCap, RoundContext, RoundDiffExcludedFile, RoundDiffPerFile, RoundJudgeDrop, RoundRawFinding, RoundRecap, RoundRelatedRepo, RoundRouting, RoundRunner, RoundStaticAnalysis, RoundTrigger, RoundUsage, RoundUsageStage, SECURITY_TAG, SecurityOverride, SEVERITY_ORDER, ThreadResolutionOverrides, TokenServiceCall, PRE_EXISTING_TAG, Finding, FindingFingerprintEntry } from './types';

const ALLOWED_FINGERPRINT_TAGS = new Set<string>([
  OWN_PROPOSAL_TAG,
  RATCHET_SUPPRESSED_TAG,
  RESOLVED_THREAD_SUPPRESSED_TAG,
  FOLLOW_UP_TAG,
  SECURITY_TAG,
  PRE_EXISTING_TAG,
  DISPROVED_TAG,
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
  recap: RecapState;
  priorRoundCount: number;
  maxAutoRounds: number;
  diff: ParsedDiff;
  /** `changeDigest` of the PR's full diff, excluded files included and closed files left out. */
  changeDigest: string;
  excludedFiles: RoundDiffExcludedFile[];
  openThreads: OpenThread[];
  interRoundDiff?: string;
  memoryLoadStatus: MemoryLoadStatus;
  memoryLoadError?: string;
  /** Why the run may not use memory, when `memoryLoadStatus` is `skipped`. */
  memorySkip?: MemorySkip;
  /** The repo's fix-rate history, read from memory at the start of the round. */
  fixRates?: FixRateHistory;
  staticAnalysis?: RoundStaticAnalysis;
  /** The token service calls the run made before the round posts. */
  tokenServiceCalls?: TokenServiceCall[];
  runner?: RoundRunner;
  /** The instruction files the round read, and the one that was cut. */
  instructions?: Pick<RepoContext, 'files' | 'cut'>;
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
  const securityOverrides: SecurityOverride[] = securityOverridesIn(recap.previousFindings ?? []).map(({ thread, login, via, role }) => ({ thread, login, via, role }));
  return {
    priorRoundCount: recap.priorRounds.length,
    reclassifiedPriorCount: count,
    ...(entries.length > 0 && { reclassifiedPriors: entries }),
    ...(securityOverrides.length > 0 && { securityOverrides }),
  };
}

/** Returns the commit `MANKI_BUILD_COMMIT` names, when it is a full commit SHA. */
function mankiCommit(): string | undefined {
  const commit = process.env.MANKI_BUILD_COMMIT;
  return commit && /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
}

/**
 * Totals `calls`, per stage and per model, and keeps the calls. Only the newest reading of each usage limit is kept.
 * Counts the tool calls refused for a closed path when any was.
 */
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
  const closedCalls = calls.reduce((sum, call) => sum + (call.closedCalls ?? 0), 0);
  return {
    ...summarizeCalls(calls),
    ...(calls.length > 0 && { perStage: groups(c => c.stage), perModel: groups(c => c.model), llmCalls: calls.map(({ limits: _limits, ...call }) => call) }),
    ...(limits.length > 0 && { limits }),
    ...(closedCalls > 0 && { closedCalls }),
  };
}

/** Returns how many findings the judge merged into another one: the findings sent to its calls, less the ones they returned. */
export function mergedDuplicateCount(result: Pick<ReviewResult, 'rawFindingCount' | 'toolAlertCount' | 'staticDedupCount' | 'llmDedupCount' | 'allJudgedFindings'>): number {
  const judged = result.allJudgedFindings?.length ?? 0;
  if (judged === 0) return 0;
  return (result.rawFindingCount ?? 0) + (result.toolAlertCount ?? 0) - (result.staticDedupCount ?? 0) - (result.llmDedupCount ?? 0) - judged;
}

/** Builds the `RoundContext` a review posts, which later rounds read back as their history. */
export function buildRoundContext(input: RoundRecordInput, result: ReviewResult, durations: RoundDurations): RoundContext {
  const {
    prNumber, commitSha, trigger, options, config, models, recap,
    priorRoundCount, maxAutoRounds, diff, excludedFiles, openThreads, interRoundDiff, memoryLoadStatus, memoryLoadError, memorySkip, staticAnalysis,
    tokenServiceCalls, fixRates,
  } = input;
  const { skipCap, forceReview, bypassHint } = options;
  const { plannerDurationMs, judgeDurationMs, wallClockMs } = durations;
  const filteredFiles = diff.files;
  const severityMap: Record<string, number> = { blocker: 0, warning: 0, note: 0 };
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
        const warnings = result.agentWarnings?.get(name);
        const model = agentModels.get(name);
        const effort = result.agentEffortMap?.get(name);
        const inputDigest = result.agentInputDigests?.get(name);
        const findingsReturned = result.agentFindingsReturned?.get(name);
        return {
          name,
          findingsRaw: rawFindings.filter(f => f.reviewers.includes(name)).length,
          findingsKept: result.findings.filter(f => f.reviewers.includes(name)).length,
          keptOnly: keptFinders.filter(finders => finders.size === 1 && finders.has(name)).length,
          keptShared: keptFinders.filter(finders => finders.size > 1 && finders.has(name)).length,
          ...(durationMs != null && { durationMs }),
          status: failureReason ? 'failed' as const : 'success' as const,
          responseLength: result.agentResponseLengths?.get(name),
          ...(warnings && { warnings }),
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          retryCount: retryCount ?? 0,
          ...(result.agentsAskedAgain?.includes(name) && { askedAgain: true as const }),
          ...(result.agentUnitLines?.has(name) && { units: result.agentUnitLines.get(name) }),
          ...(failureReason && { failureReason }),
          model,
          ...(effort && { effort }),
          ...(inputDigest && { inputDigest }),
          ...(findingsReturned !== undefined && { findingsReturned }),
          ...(result.reused?.finders.includes(name) && { reused: true as const }),
        };
      })
    : undefined;

  // Judge calibration metrics
  const severityChanges = allJudged.filter(f => f.judgeNotes).length;
  const regrades = { up: 0, down: 0 };
  for (const f of allJudged) {
    // A later step can move the finding again, so the judge's grade is where its own step ends.
    const judgeGrade = f.gradePath?.find(step => step.by === 'judge')?.to ?? f.originalSeverity ?? f.severity;
    // A merged duplicate can be filed at the judge's grade, which is no regrade.
    if (!f.reviewerSeverity || f.reviewerSeverity === judgeGrade) continue;
    regrades[SEVERITY_ORDER.indexOf(judgeGrade) < SEVERITY_ORDER.indexOf(f.reviewerSeverity) ? 'up' : 'down']++;
  }
  const mergedDuplicates = mergedDuplicateCount(result);
  const ownProposalDemotedCount = allJudged.filter(f => f.tags?.includes(OWN_PROPOSAL_TAG)).length;
  const ratchetSuppressedCount = allJudged.filter(f => f.tags?.includes(RATCHET_SUPPRESSED_TAG)).length;
  const resolvedThreadSuppressedCount = allJudged.filter(f => f.tags?.includes(RESOLVED_THREAD_SUPPRESSED_TAG)).length;
  const crossRoundSuppressed = result.crossRoundSuppressed;
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
    ...(f.preExisting && { preExisting: f.preExisting }),
    ...(f.rule && { rule: f.rule }),
  }));
  const judgeDrops: RoundJudgeDrop[] = allJudged.filter(f => f.severity === 'ignore').map(f => ({
    title: f.title,
    file: f.file,
    line: f.line,
    reviewers: f.reviewers,
    ...(f.reviewerSeverity && { reviewerSeverity: f.reviewerSeverity }),
    ...(f.lowestReviewerSeverity && { lowestReviewerSeverity: f.lowestReviewerSeverity }),
    ...(f.judgeNotes && { judgeNotes: f.judgeNotes }),
    ...(f.refutation && { refutation: f.refutation }),
    ...(f.pairRefutation && { pairRefutation: f.pairRefutation }),
    ...(f.gradePath && { gradePath: f.gradePath }),
    ...(f.gradeIfConfirmed && { gradeIfConfirmed: f.gradeIfConfirmed }),
    ...(f.judgeIfConfirmed && { judgeIfConfirmed: f.judgeIfConfirmed }),
    ...(f.doubts && { doubts: f.doubts }),
    ...(f.cell && { cell: f.cell }),
    ...(f.rule && { rule: f.rule }),
  }));
  const toEntry = (f: Finding): FindingFingerprintEntry => ({
    fingerprint: fingerprintFinding(f.title, f.file ?? '', f.line || 0),
    ...((f.threadId ?? f.answeredIn?.threadId) && { threadId: f.threadId ?? f.answeredIn?.threadId }),
    severity: f.severity,
    ...(f.reviewers.length > 0 && { reviewers: f.reviewers }),
    ...(f.suggestedFix && { suggestedFix: f.suggestedFix.slice(0, 300) }),
    ...(f.title && { title: f.title.slice(0, 200) }),
    ...(f.judgeNotes && { judgeNotes: f.judgeNotes }),
    ...(f.checkStatus && { checkStatus: f.checkStatus }),
    ...(f.tags && f.tags.length > 0 && { tags: f.tags.filter(t => ALLOWED_FINGERPRINT_TAGS.has(t)) }),
    ...(f.originalSeverity && { originalSeverity: f.originalSeverity }),
    ...(f.reviewerSeverity && { reviewerSeverity: f.reviewerSeverity }),
    ...(f.lowestReviewerSeverity && { lowestReviewerSeverity: f.lowestReviewerSeverity }),
    ...(f.toolEvidence && { toolEvidence: f.toolEvidence.status }),
    ...(f.toolSource && { toolSource: f.toolSource }),
    ...(f.origin && { origin: f.origin }),
    ...(f.raisedIn && { raisedIn: f.raisedIn }),
    ...(f.sameAs && { sameAs: f.sameAs }),
    ...(f.relisted && { relisted: true }),
    ...(f.category && { category: f.category }),
    ...(f.revertGap && { revertGap: f.revertGap }),
    ...(f.effort && { effort: f.effort }),
    ...(f.evidence && { evidence: f.evidence }),
    ...(f.notChecked && { notChecked: true }),
    ...(f.refutation && { refutation: f.refutation }),
    ...(f.pairRefutation && { pairRefutation: f.pairRefutation }),
    ...(f.originCheck && { originCheck: f.originCheck }),
    ...(f.otherFinderVote && { otherFinderVote: f.otherFinderVote }),
    ...(f.importance && { importance: f.importance }),
    ...(f.gradeIfConfirmed && { gradeIfConfirmed: f.gradeIfConfirmed }),
    ...(f.judgeIfConfirmed && { judgeIfConfirmed: f.judgeIfConfirmed }),
    ...(f.doubts && { doubts: f.doubts }),
    ...(f.trigger && { trigger: f.trigger }),
    ...(f.cell && { cell: f.cell }),
    ...(f.judgeCell && { judgeCell: f.judgeCell }),
    ...(f.gradePath && { gradePath: f.gradePath }),
    ...(f.preExisting && f.preExistingCheck && { preExisting: { reason: f.preExisting.slice(0, 200), check: f.preExistingCheck } }),
    ...(f.rule && { rule: f.rule }),
    ...(f.unpostedReason && { unpostedReason: f.unpostedReason }),
  });
  const unposted = [...(result.unpostedPreExisting ?? []), ...(result.unposted ?? [])].map((f): FindingFingerprintEntry => ({ ...toEntry(f), posted: 'record' }));
  const calibrations = fixRates ? result.findings.map(f => calibrate(fixRates, f)) : [];
  return {
    meta: {
      prNumber,
      commitSha,
      round,
      timestamp: new Date().toISOString(),
      mankiVersion: MANKI_VERSION,
      ...(mankiCommit() && { mankiCommit: mankiCommit() }),
      cap,
      trigger,
      ...(result.outcome && { outcome: result.outcome }),
      ...(result.needsHuman && { needsHuman: result.needsHuman }),
      ...(llmCalls.length > 0 && { promptVersions: promptVersions(llmCalls) }),
      ...(options.draft && { draft: true }),
      ...(!result.reviewComplete && { incomplete: true as const }),
      ...(result.retryAfter && { retryAfter: result.retryAfter }),
      ...(result.reused && { reusedFrom: result.reused.from }),
      ...(fixRates && { calibrationLowered: calibrations.filter(c => c?.wouldLower).length }),
    },
    config: {
      memoryEnabled: config.memory?.enabled ?? false,
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
      planner: models.planner,
      ...(agentModels.size > 0 && { reviewer: [...agentModels.values()][0] }),
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
      ...(result.judgeSkipped && { skipped: 'nothing_to_judge' as const }),
      ...(result.judgeEffort && { effort: result.judgeEffort }),
      ...(judgeDrops.length > 0 && { dropped: judgeDrops }),
      severityChanges,
      ...((regrades.up > 0 || regrades.down > 0) && { regrades }),
      mergedDuplicates,
      ...(result.toolAlertCount && { toolAlertCount: result.toolAlertCount }),
      // The stage's time also covers the verdict reader, so a round without a judge call records none.
      ...(!result.judgeSkipped && { durationMs: judgeDurationMs }),
      retryCount: result.judgeRetryCount ?? 0,
      ...(result.verdictReason && { verdictReason: result.verdictReason }),
      ...(ownProposalDemotedCount > 0 && { ownProposalDemotedCount }),
      ...(ratchetSuppressedCount > 0 && { ratchetSuppressedCount }),
      ...(resolvedThreadSuppressedCount > 0 && { resolvedThreadSuppressedCount }),
      ...(inPrSuppressedCount > 0 && { inPrSuppressedCount }),
      ...(crossRoundSuppressed != null && crossRoundSuppressed > 0 && { crossRoundSuppressed }),
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
      entries: result.findings.map((f, i) => ({ ...toEntry(f), ...(calibrations[i] && { calibration: calibrations[i] }) })),
      ...(unposted.length > 0 && { unposted }),
      ...(result.carried && { carried: result.carried }),
      ...(result.carriedEnded && { carriedEnded: result.carriedEnded }),
      ...(result.originsWithoutPrior && { originsWithoutPrior: true }),
    },
    usage,
    verdict: result.verdict,
    recap: buildRoundRecap(recap),
    ...(staticAnalysis && { staticAnalysis }),
    ...(tokenServiceCalls && tokenServiceCalls.length > 0 && { tokenService: tokenServiceCalls }),
    ...(input.runner && { runner: input.runner }),
    ...(result.slicing && { slicing: result.slicing }),
    ...(result.leads && result.leads.length > 0 && { leads: result.leads }),
    ...(result.notStarted && result.notStarted.length > 0 && { notStarted: result.notStarted }),
    ...(input.instructions && { instructions: { files: input.instructions.files.map(f => f.path), ...(input.instructions.cut && { cut: input.instructions.cut }) } }),
    ...(result.relatedRepos && { relatedRepos: result.relatedRepos.map(r => withReads(r, llmCalls)) }),
    ...(result.dependencySources && { dependencySources: result.dependencySources.map(d => ({ ...d, ...readsOf(d.package, llmCalls) })) }),
    ...(result.usesOutsideDiff && { usesOutsideDiff: result.usesOutsideDiff }),
    ...(result.units && { units: result.units }),
    ...(result.relatedWork && {
      relatedWork: {
        candidates: result.relatedWork.items.map(({ kind, number, sharedFiles, relation, reason }) => ({ kind, number, sharedFiles, relation, reason })),
        ...(result.relatedWork.skipped && { skipped: result.relatedWork.skipped }),
      },
    }),
    ...(result.comparisons?.length && { comparisons: result.comparisons }),
    ...(result.sweeps?.length && { sweeps: result.sweeps }),
    ...(result.secondReads && { secondReads: result.secondReads }),
    ...(result.prClaims && { prClaims: result.prClaims }),
    ...(result.fixes && { fixes: result.fixes }),
    ...(result.scope && { scope: result.scope }),
  };
}

/** Returns the tool calls of `calls` that read the repo or package `name`, in all and by stage, or nothing when none did. */
export function readsOf(name: string, calls: LLMCall[]): { reads?: number; readsByStage?: Record<string, number> } {
  const readsByStage: Record<string, number> = {};
  for (const call of calls) {
    const reads = call.relatedReads?.[name] ?? 0;
    // A refuter is recorded as a judge call with its own agent name.
    const stage = call.stage === 'judge' && call.agent?.startsWith('refute') ? call.agent : call.stage;
    if (reads > 0) readsByStage[stage] = (readsByStage[stage] ?? 0) + reads;
  }
  const reads = Object.values(readsByStage).reduce((sum, n) => sum + n, 0);
  return reads > 0 ? { reads, readsByStage } : {};
}

/** Adds to `repo` the tool calls of `calls` that read it, in all and by stage, when any did. */
export function withReads(repo: RoundRelatedRepo, calls: LLMCall[]): RoundRelatedRepo {
  return { ...repo, ...readsOf(repo.repo, calls) };
}

/** Returns, per stage, the distinct prompt digests of `calls`, sorted. */
function promptVersions(calls: LLMCall[]): PromptVersions {
  const byStage = new Map<string, Set<string>>();
  for (const { stage, promptDigest } of calls) {
    if (promptDigest) byStage.set(stage, (byStage.get(stage) ?? new Set()).add(promptDigest));
  }
  return Object.fromEntries([...byStage].map(([stage, digests]) => [stage, [...digests].sort()]));
}
