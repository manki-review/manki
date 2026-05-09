import { migrateLegacySeverity, RoundContext, roundContextToFlatAliases } from './types';

describe('migrateLegacySeverity', () => {
  it('maps `required` to `blocker`', () => {
    expect(migrateLegacySeverity('required')).toBe('blocker');
  });

  it('maps `nit` to `nitpick`', () => {
    expect(migrateLegacySeverity('nit')).toBe('nitpick');
  });

  it.each(['blocker', 'warning', 'suggestion', 'nitpick', 'ignore'])(
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

function fullyPopulatedContext(): RoundContext {
  return {
    meta: {
      prNumber: 42,
      commitSha: 'abc123',
      round: 2,
      timestamp: '2026-01-01T00:00:00.000Z',
      mankiVersion: '4.7.0',
      promptVersions: { judge: 'j1', reviewer: 'r1', planner: 'p1' },
    },
    config: {
      reviewLevel: 'medium',
      nitHandling: 'issues',
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
      used: true,
      teamSize: 3,
      reviewerEffort: 'medium',
      judgeEffort: 'high',
      prType: 'feature',
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
      confidenceDistribution: { high: 2, medium: 1, low: 0 },
      severityChanges: 1,
      mergedDuplicates: 2,
      durationMs: 4500,
      verdictReason: 'novel_suggestion',
      defensiveHardeningCount: 0,
      inPrSuppressedCount: 1,
      crossRoundSuppressed: 0,
      crossRoundDemoted: 1,
    },
    dedup: { staticDropped: 1, llmDropped: 0, durationMs: 200 },
    memory: { patternsApplied: 2, suppressionsApplied: 1, escalationsApplied: 0 },
    findings: {
      count: 3,
      severityCounts: { blocker: 0, warning: 1, suggestion: 1, nitpick: 1 },
      entries: [
        {
          fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'missing-null-check' },
          threadId: 'PRRT_kw1',
          severity: 'warning',
          authorReplyClass: 'none',
        },
        {
          fingerprint: { file: 'src/bar.ts', lineStart: 20, lineEnd: 25, slug: 'rename-helper' },
          severity: 'suggestion',
        },
        {
          fingerprint: { file: 'src/baz.ts', lineStart: 5, lineEnd: 5, slug: 'trailing-space' },
          severity: 'nitpick',
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
      severity: { blocker: 0, warning: 1, suggestion: 1, nitpick: 1 },
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
      config: { reviewLevel: 'small', nitHandling: 'comments', memoryEnabled: false },
      diff: { lines: 10, additions: 10, deletions: 0, filesReviewed: 1, fileTypes: {} },
      models: { reviewer: 'model-a', judge: 'model-b' },
      planner: { used: false },
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
