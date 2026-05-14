import { AuthorReplyClass, FindingFingerprint, FindingFingerprintEntry, FindingSeverity, RoundContext } from './types';
import { titleToSlug } from './github';

/**
 * Build a `RoundContext` test fixture. Required-but-uninteresting fields are
 * filled with neutral defaults so each test only declares the slice it cares
 * about. `meta.round` always reflects the explicit `round` argument, even when
 * `overrides.meta` is provided.
 *
 * Shared across `judge.test.ts`, `review.test.ts`, and `index.test.ts` so all
 * call sites read off the same baseline shape.
 */
export function makeRoundContext(round: number, overrides: Partial<RoundContext> = {}): RoundContext {
  const base: RoundContext = {
    meta: {
      prNumber: 1,
      commitSha: `sha${round}`,
      round,
      timestamp: `2025-01-0${round}T00:00:00Z`,
      mankiVersion: '5.0.0-test',
    },
    config: { reviewLevel: 'medium', nitHandling: 'issues', memoryEnabled: false },
    diff: { lines: 0, additions: 0, deletions: 0, filesReviewed: 0, fileTypes: {} },
    models: { reviewer: 'r', judge: 'j' },
    planner: { used: false },
    reviewers: { agents: [] },
    judge: { summary: '' },
    dedup: {},
    memory: {},
    findings: { count: 0, severityCounts: {}, entries: [] },
    usage: {},
    verdict: 'COMMENT',
  };
  return {
    ...base,
    ...overrides,
    meta: { ...base.meta, ...(overrides.meta ?? {}), round },
  };
}

/**
 * Build a `FindingFingerprintEntry` test fixture. Defaults mirror what the
 * pre-migration `HandoverFinding` literals carried, so tests can declare just
 * the slice they care about.
 */
export function makeFindingFingerprintEntry(
  overrides: Partial<FindingFingerprintEntry> & { title?: string; file?: string; lineStart?: number; lineEnd?: number } = {},
): FindingFingerprintEntry {
  const title = overrides.title ?? 'Sample finding';
  const file = overrides.file ?? 'src/a.ts';
  const lineStart = overrides.lineStart ?? 10;
  const lineEnd = overrides.lineEnd ?? lineStart;
  const fingerprint = overrides.fingerprint ?? {
    file,
    lineStart,
    lineEnd,
    slug: titleToSlug(title),
  };
  return {
    fingerprint,
    severity: overrides.severity ?? 'warning',
    authorReplyClass: overrides.authorReplyClass ?? 'none',
    ...(overrides.threadId !== undefined && { threadId: overrides.threadId }),
    ...(overrides.specialist !== undefined && { specialist: overrides.specialist }),
    ...(overrides.suggestedFix !== undefined && { suggestedFix: overrides.suggestedFix }),
    title,
  };
}

/**
 * Shape accepted by `roundContextFromLegacy` mirroring the pre-migration
 * `HandoverRound` fixture shape. Lets tests written against the old
 * `priorRounds: HandoverRound[]` payload keep their literal structure while
 * feeding `RoundContext[]` consumers.
 */
export interface LegacyHandoverRoundFixture {
  round: number;
  commitSha: string;
  timestamp: string;
  findings: LegacyHandoverFindingFixture[];
  agents?: string[];
  judgeSummary?: string;
}

export interface LegacyHandoverFindingFixture {
  fingerprint: FindingFingerprint;
  severity: FindingSeverity | 'unknown';
  title: string;
  authorReply: AuthorReplyClass;
  threadId?: string;
  specialist?: string;
  suggestedFix?: string;
}

/**
 * Project a legacy `HandoverRound`-shaped fixture into a `RoundContext`.
 * `authorReply` becomes `authorReplyClass`; per-round metadata maps onto
 * `meta` / `judge` / `reviewers`.
 */
/**
 * Project a list of legacy `HandoverRound`-shaped fixtures into a `RoundContext[]`.
 * Variadic so call sites read `legacyRounds({ round: 1, ... }, { round: 2, ... })`.
 */
export function legacyRounds(...inputs: LegacyHandoverRoundFixture[]): RoundContext[] {
  return inputs.map(roundContextFromLegacy);
}

export function roundContextFromLegacy(input: LegacyHandoverRoundFixture): RoundContext {
  return makeRoundContext(input.round, {
    meta: {
      prNumber: 1,
      commitSha: input.commitSha,
      round: input.round,
      timestamp: input.timestamp,
      mankiVersion: '5.0.0-test',
    },
    reviewers: { agents: input.agents ?? [] },
    judge: { summary: input.judgeSummary ?? '' },
    findings: {
      count: input.findings.length,
      severityCounts: {},
      entries: input.findings.map(legacyFindingToFingerprintEntry),
    },
  });
}

/** Project a list of legacy finding fixtures into `FindingFingerprintEntry[]`. */
export function fingerprintEntriesFromLegacy(findings: LegacyHandoverFindingFixture[]): FindingFingerprintEntry[] {
  return findings.map(legacyFindingToFingerprintEntry);
}

function legacyFindingToFingerprintEntry(f: LegacyHandoverFindingFixture): FindingFingerprintEntry {
  return {
    fingerprint: f.fingerprint,
    severity: f.severity,
    authorReplyClass: f.authorReply,
    ...(f.threadId !== undefined && { threadId: f.threadId }),
    ...(f.specialist !== undefined && { specialist: f.specialist }),
    ...(f.suggestedFix !== undefined && { suggestedFix: f.suggestedFix }),
    title: f.title,
  };
}
