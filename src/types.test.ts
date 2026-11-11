import { isBlockingSeverity, migrateLegacySeverity, migrateStoredSeverities, RoundContext, roundContextToFlatAliases } from './types';

describe('migrateLegacySeverity', () => {
  it('maps `required` to `blocker`', () => {
    expect(migrateLegacySeverity('required')).toBe('blocker');
  });

  it.each(['suggestion', 'nitpick', 'nit'])('maps `%s` to `note`', severity => {
    expect(migrateLegacySeverity(severity)).toBe('note');
  });

  it.each(['blocker', 'warning', 'note', 'ignore'])(
    'passes through current severity `%s` unchanged',
    severity => {
      expect(migrateLegacySeverity(severity)).toBe(severity);
    },
  );

  it('passes through unknown values unchanged', () => {
    expect(migrateLegacySeverity('unknown-severity')).toBe('unknown-severity');
  });

  it('passes through the empty string unchanged', () => {
    expect(migrateLegacySeverity('')).toBe('');
  });
});

describe('migrateStoredSeverities', () => {
  it('rewrites every stored severity of an older record, at any depth, adds up the counts of merged levels, drops a grade step between merged levels, and keeps a stored config and a field that only shares a name', () => {
    const record = {
      meta: { round: 2, to: 5 },
      config: { severity: 'suggestion' },
      variants: [{ name: 'base', overrides: { review: { from: 'suggestion', severity: 'nitpick' } } }],
      recap: { reclassified: [{ threadId: 'T1', from: 'suggestion', to: 'nit', grade: 'nitpick' }] },
      findings: {
        severityCounts: { blocker: 1, warning: 0, suggestion: 2, nitpick: 3 },
        entries: [
          { title: 'A suggestion to rename', severity: 'suggestion', reviewerSeverity: 'nitpick', originalSeverity: 'required', gradeIfConfirmed: 'blocker', gradePath: [{ from: 'nit', to: 'suggestion', by: 'judge' }] },
          { severity: 'warning', cell: { row: 'style', column: 'normal' } },
          // A step between two levels that are now one is no grade change, and the steps around it still join up.
          { severity: 'ignore', gradePath: [{ from: 'warning', to: 'suggestion', by: 'judge' }, { from: 'suggestion', to: 'nitpick', by: 'ratchet', reason: 'r' }, { from: 'nitpick', to: 'ignore', by: 'in_pr_suppression' }] },
        ],
        unposted: [{ severity: 'nitpick', unpostedReason: 'note_cap' }],
      },
      threads: [{ threadId: 'T1', severity: 'nit', recordedGrade: 'suggestion', peakGrade: 'required' }],
      judge: { threadEvaluations: [{ threadId: 'T1', status: 'partly_addressed', grade: 'nitpick', cell: { row: 'style', column: 'normal' } }] },
      staticSignals: [{ severity: 'note', tool: 'suggestion' }],
    };
    expect(migrateStoredSeverities(record)).toBe(record);
    expect(record).toEqual({
      meta: { round: 2, to: 5 },
      config: { severity: 'suggestion' },
      variants: [{ name: 'base', overrides: { review: { from: 'suggestion', severity: 'nitpick' } } }],
      recap: { reclassified: [{ threadId: 'T1', from: 'suggestion', to: 'nit', grade: 'nitpick' }] },
      findings: {
        severityCounts: { blocker: 1, warning: 0, note: 5 },
        entries: [
          { title: 'A suggestion to rename', severity: 'note', reviewerSeverity: 'note', originalSeverity: 'blocker', gradeIfConfirmed: 'blocker' },
          { severity: 'warning', cell: { row: 'style', column: 'normal' } },
          { severity: 'ignore', gradePath: [{ from: 'warning', to: 'note', by: 'judge' }, { from: 'note', to: 'ignore', by: 'in_pr_suppression' }] },
        ],
        unposted: [{ severity: 'note', unpostedReason: 'note_cap' }],
      },
      threads: [{ threadId: 'T1', severity: 'note', recordedGrade: 'note', peakGrade: 'blocker' }],
      judge: { threadEvaluations: [{ threadId: 'T1', status: 'partly_addressed', grade: 'note', cell: { row: 'style', column: 'normal' } }] },
      staticSignals: [{ severity: 'note', tool: 'suggestion' }],
    });
    // A record of the current version, and a value that is no record, come back as they are.
    const current = { findings: { severityCounts: { blocker: 0, warning: 1, note: 2 }, entries: [{ severity: 'note', gradePath: [{ from: 'warning', to: 'note', by: 'judge' }] }] } };
    expect(migrateStoredSeverities(structuredClone(current))).toEqual(current);
    for (const value of [null, undefined, 'suggestion', 3]) expect(migrateStoredSeverities(value)).toBe(value);
  });
});

describe('isBlockingSeverity', () => {
  it.each([
    ['blocker', true],
    ['warning', true],
    ['note', false],
    ['ignore', false],
  ] as const)('treats `%s` as blocking: %s', (severity, blocking) => {
    expect(isBlockingSeverity(severity)).toBe(blocking);
  });
});

function fullyPopulatedContext(): RoundContext {
  return {
    meta: {
      prNumber: 42,
      commitSha: 'abc123',
      round: 2,
      timestamp: '2026-01-01T00:00:00.000Z',
      mankiVersion: '4.7.0',
      promptVersions: { judge: ['j1'], reviewer: ['r1'], planner: ['p1'] },
    },
    config: {
      reviewLevel: 'medium',
      memoryEnabled: true,
      reviewPasses: 1,
    },
    diff: {
      lines: 120,
      additions: 90,
      deletions: 30,
      filesReviewed: 4,
      fileTypes: { '.ts': 3, '.md': 1 },
    },
    models: {
      planner: 'claude-haiku-4-5',
      reviewer: 'claude-sonnet-4-6',
      judge: 'claude-opus-4-6',
      dedup: 'claude-haiku-4-5',
    },
    planner: {
      source: 'planner',
      used: true,
      teamSize: 3,
      judgeEffort: 'high',
      prType: 'feat',
      durationMs: 1200,
    },
    reviewers: {
      agents: ['typescript', 'security', 'tests'],
      agentMetrics: [
        {
          name: 'typescript',
          findingsRaw: 5,
          findingsKept: 3,
          durationMs: 8000,
          status: 'success',
          responseLength: 4200,
          warnings: [],
          inputTokens: 1500,
          outputTokens: 900,
        },
      ],
    },
    judge: {
      summary: 'Three issues kept, two demoted to nits.',
      severityChanges: 1,
      mergedDuplicates: 2,
      durationMs: 4500,
      verdictReason: 'required_present',
      inPrSuppressedCount: 1,
      crossRoundSuppressed: 0,
      crossRoundDemoted: 1,
    },
    dedup: { staticDropped: 1, llmDropped: 0, durationMs: 200 },
    memory: { suppressionsApplied: 1 },
    findings: {
      count: 3,
      severityCounts: { blocker: 0, warning: 1, note: 2 },
      entries: [
        {
          fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'missing-null-check' },
          threadId: 'PRRT_kw1',
          severity: 'warning',
          authorReplyClass: 'none',
        },
        {
          fingerprint: { file: 'src/bar.ts', lineStart: 20, lineEnd: 25, slug: 'rename-helper' },
          severity: 'note',
        },
        {
          fingerprint: { file: 'src/baz.ts', lineStart: 5, lineEnd: 5, slug: 'trailing-space' },
          severity: 'note',
          authorReplyClass: 'agree',
        },
      ],
    },
    usage: {
      inputTokens: 12000,
      outputTokens: 3000,
      totalTokens: 15000,
      estimatedCostUsd: 0.0825,
      perStage: {
        planner: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
        reviewer: { inputTokens: 9000, outputTokens: 2400, totalTokens: 11400 },
        judge: { inputTokens: 2300, outputTokens: 480, totalTokens: 2780 },
        dedup: { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
      },
    },
    verdict: 'COMMENT',
  };
}

describe('RoundContext', () => {
  it('instantiates with every field populated', () => {
    const ctx = fullyPopulatedContext();
    expect(ctx.meta.mankiVersion).toBe('4.7.0');
    expect(ctx.findings.entries).toHaveLength(3);
    expect(ctx.judge.summary).toMatch(/Three issues/);
    expect(ctx.reviewers.agents).toEqual(['typescript', 'security', 'tests']);
  });

  it('carries split judge counters and inter-round override on `RoundJudge`', () => {
    const ctx: RoundContext = {
      ...fullyPopulatedContext(),
      judge: {
        summary: 'split counters',
        ownProposalDemotedCount: 2,
        contradictionDemotedCount: 1,
        ratchetSuppressedCount: 3,
        resolvedThreadSuppressedCount: 1,
        interRoundDiffEmptyOverride: { applied: true, affectedThreadCount: 4 },
        threadEvaluations: [
          { threadId: 'PRRT_a', status: 'not_addressed', reason: 'No code changes since prior review' },
        ],
      },
    };
    expect(ctx.judge.ownProposalDemotedCount).toBe(2);
    expect(ctx.judge.contradictionDemotedCount).toBe(1);
    expect(ctx.judge.ratchetSuppressedCount).toBe(3);
    expect(ctx.judge.resolvedThreadSuppressedCount).toBe(1);
    expect(ctx.judge.interRoundDiffEmptyOverride).toEqual({ applied: true, affectedThreadCount: 4 });
    expect(ctx.judge.threadEvaluations).toHaveLength(1);
  });

  it('carries judge per-finding state on `FindingFingerprintEntry`', () => {
    const entry: RoundContext['findings']['entries'][number] = {
      fingerprint: { file: 'src/a.ts', lineStart: 1, lineEnd: 1, slug: 'race-condition' },
      severity: 'note',
      judgeNotes: 'Reachable only under shutdown',
      checkStatus: 'confirmed',
      tags: ['own-proposal-followup'],
      originalSeverity: 'warning',
    };
    expect(entry.judgeNotes).toMatch(/shutdown/);
    expect(entry.checkStatus).toBe('confirmed');
    expect(entry.tags).toEqual(['own-proposal-followup']);
    expect(entry.originalSeverity).toBe('warning');
  });

  it('omits all new optional fields gracefully on minimal entry', () => {
    const entry: RoundContext['findings']['entries'][number] = {
      fingerprint: { file: 'x', lineStart: 1, lineEnd: 1, slug: 's' },
      severity: 'note',
    };
    expect(entry.judgeNotes).toBeUndefined();
    expect(entry.checkStatus).toBeUndefined();
    expect(entry.tags).toBeUndefined();
    expect(entry.originalSeverity).toBeUndefined();
  });

  it('carries verdict trace, thread-state, and inter-round diff fields on `RoundJudge`', () => {
    const ctx: RoundContext = {
      ...fullyPopulatedContext(),
      judge: {
        summary: 'prior unaddressed',
        verdictReason: 'prior_unaddressed',
        verdictTrace: {
          survivingBlockers: [],
          unresolvedPriors: [
            { file: 'src/a.ts', title: 'Race condition', fingerprint: 'src/a.ts:10:10:race-condition', threadId: 'PRRT_a', round: 3 },
          ],
        },
        openThreadsState: 'fetched',
        openThreadCount: 1,
        resolvedThreadIdCount: 0,
        interRoundDiffState: 'changed',
        interRoundDiffBytes: 24_000,
        interRoundDiffTruncated: true,
        threadResolutionOverrides: { addressedDropped: 1, notAddressedOverridden: 0, uncertainCount: 2 },
      },
    };
    expect(ctx.judge.verdictTrace?.unresolvedPriors).toHaveLength(1);
    expect(ctx.judge.verdictTrace?.unresolvedPriors[0].round).toBe(3);
    expect(ctx.judge.openThreadsState).toBe('fetched');
    expect(ctx.judge.openThreadCount).toBe(1);
    expect(ctx.judge.resolvedThreadIdCount).toBe(0);
    expect(ctx.judge.interRoundDiffState).toBe('changed');
    expect(ctx.judge.interRoundDiffBytes).toBe(24_000);
    expect(ctx.judge.interRoundDiffTruncated).toBe(true);
    expect(ctx.judge.threadResolutionOverrides).toEqual({ addressedDropped: 1, notAddressedOverridden: 0, uncertainCount: 2 });
  });

  it('carries `cap` and `trigger` provenance on `RoundMeta`', () => {
    const ctx: RoundContext = {
      ...fullyPopulatedContext(),
      meta: {
        ...fullyPopulatedContext().meta,
        cap: {
          priorRoundCount: 5,
          maxAutoRounds: 5,
          skipCap: true,
          forceReview: false,
          bypassReason: 'skip_cap',
        },
        trigger: { event: 'issue_comment:edited:settings:again', sender: 'alice' },
      },
    };
    expect(ctx.meta.cap?.priorRoundCount).toBe(5);
    expect(ctx.meta.cap?.maxAutoRounds).toBe(5);
    expect(ctx.meta.cap?.bypassReason).toBe('skip_cap');
    expect(ctx.meta.trigger?.event).toBe('issue_comment:edited:settings:again');
    expect(ctx.meta.trigger?.sender).toBe('alice');
  });

  it('leaves `cap` and `trigger` undefined on a minimal meta', () => {
    const ctx: RoundContext = {
      ...fullyPopulatedContext(),
      meta: { prNumber: 1, commitSha: 'sha', round: 1, timestamp: 'ts', mankiVersion: '5.0.0' },
    };
    expect(ctx.meta.cap).toBeUndefined();
    expect(ctx.meta.trigger).toBeUndefined();
  });

  it('omits all new `RoundJudge` trace and state fields gracefully on minimal judge', () => {
    const ctx: RoundContext = {
      ...fullyPopulatedContext(),
      judge: { summary: 'minimal' },
    };
    expect(ctx.judge.verdictTrace).toBeUndefined();
    expect(ctx.judge.openThreadsState).toBeUndefined();
    expect(ctx.judge.openThreadCount).toBeUndefined();
    expect(ctx.judge.resolvedThreadIdCount).toBeUndefined();
    expect(ctx.judge.interRoundDiffState).toBeUndefined();
    expect(ctx.judge.interRoundDiffBytes).toBeUndefined();
    expect(ctx.judge.interRoundDiffTruncated).toBeUndefined();
    expect(ctx.judge.threadResolutionOverrides).toBeUndefined();
  });
});

describe('roundContextToFlatAliases', () => {
  it('derives every legacy alias from a `RoundContext`', () => {
    const ctx = fullyPopulatedContext();
    const aliases = roundContextToFlatAliases(ctx);
    expect(aliases).toEqual({
      prNumber: 42,
      commitSha: 'abc123',
      verdict: 'COMMENT',
      diffLines: 120,
      diffAdditions: 90,
      diffDeletions: 30,
      filesReviewed: 4,
      agents: ['typescript', 'security', 'tests'],
      // 3 kept + 1 staticDropped + 0 llmDropped + 2 mergedDuplicates
      findingsRaw: 6,
      findingsKept: 3,
      findingsDropped: 3,
      severity: { blocker: 0, warning: 1, note: 2 },
      model: 'claude-sonnet-4-6',
      reviewerModel: 'claude-sonnet-4-6',
      judgeModel: 'claude-opus-4-6',
    });
  });

  it('treats missing dedup and judge merge counts as zero', () => {
    const ctx = fullyPopulatedContext();
    ctx.dedup = {};
    ctx.judge.mergedDuplicates = undefined;
    const aliases = roundContextToFlatAliases(ctx);
    expect(aliases.findingsRaw).toBe(ctx.findings.count);
    expect(aliases.findingsDropped).toBe(0);
  });

  it('uses findings.count, not entries.length, for findingsKept', () => {
    const ctx = fullyPopulatedContext();
    ctx.findings.count = 5;
    const aliases = roundContextToFlatAliases(ctx);
    expect(aliases.findingsKept).toBe(5);
  });

  it('handles minimal context with no optional fields', () => {
    const ctx: RoundContext = {
      meta: { prNumber: 1, commitSha: 'sha', round: 1, timestamp: 'ts', mankiVersion: '5.0.0' },
      config: { reviewLevel: 'small', memoryEnabled: false },
      diff: { lines: 10, additions: 10, deletions: 0, filesReviewed: 1, fileTypes: {} },
      models: { reviewer: 'model-a', judge: 'model-b' },
      planner: { source: 'disabled', used: false },
      reviewers: { agents: [] },
      judge: { summary: '' },
      dedup: {},
      memory: {},
      findings: { count: 0, severityCounts: {}, entries: [] },
      usage: {},
      verdict: 'APPROVE',
    };
    const aliases = roundContextToFlatAliases(ctx);
    expect(aliases).toEqual({
      prNumber: 1,
      commitSha: 'sha',
      verdict: 'APPROVE',
      diffLines: 10,
      diffAdditions: 10,
      diffDeletions: 0,
      filesReviewed: 1,
      agents: [],
      findingsRaw: 0,
      findingsKept: 0,
      findingsDropped: 0,
      severity: {},
      model: 'model-a',
      reviewerModel: 'model-a',
      judgeModel: 'model-b',
    });
  });
});
