import { minimatch } from 'minimatch';

import { DiffFile, ReviewerAgent } from './types';

/**
 * Default test-path globs used by the per-agent lens. Kept in sync with
 * `DEFAULT_CONFIG.convergence.test_path_patterns` (see `config.ts`). Defined
 * here so the lens stays valid even when `config.convergence` is unset.
 */
const DEFAULT_TEST_PATH_PATTERNS: readonly string[] = Object.freeze([
  '**/*.test.*',
  '**/*.spec.*',
  '**/tests/**',
  '**/__tests__/**',
]);

// Standard reviewer pool used for teamSize >= 3. TRIVIAL_VERIFIER_AGENT is
// intentionally excluded — it is only active for the teamSize=1 path and does
// not participate in scoring, focusAreas validation, or planner prompts.
//
// Per-agent `lens` is conservative on purpose: false-negatives (missed
// findings) are far more costly than the cycles saved by skipping. Only two
// agents declare a lens today:
//
//   - `Testing & Coverage` runs only when the diff touches a test file.
//   - `Architecture & Design` runs unless every changed file is a test file
//     (purely test-only diffs do not change public API or module structure).
//
// All other agents have no lens and always run.
export const AGENT_POOL: readonly ReviewerAgent[] = Object.freeze([
  {
    name: 'Security & Safety',
    focus: 'Vulnerabilities, injection, auth, data leaks, memory safety, crypto correctness, key exposure, timing side-channels',
  },
  {
    name: 'Architecture & Design',
    focus: 'Design patterns, coupling, abstractions, API design, module boundaries, separation of concerns, SOLID principles',
    lens: {
      mode: 'exclude-only',
      filePatterns: [...DEFAULT_TEST_PATH_PATTERNS],
    },
  },
  {
    name: 'Correctness & Logic',
    focus: 'Edge cases, off-by-one errors, null/undefined handling, race conditions, data integrity, type safety, error propagation',
  },
  {
    name: 'Testing & Coverage',
    focus: 'Missing tests, test quality, edge case coverage, assertion strength, mock appropriateness, test maintainability',
    lens: {
      mode: 'include',
      filePatterns: [...DEFAULT_TEST_PATH_PATTERNS],
    },
  },
  {
    name: 'Performance & Efficiency',
    focus: 'Unnecessary allocations, N+1 queries, hot path optimization, caching opportunities, async/concurrency patterns, memory usage',
  },
  {
    name: 'Maintainability & Readability',
    focus: 'Naming clarity, code complexity, dead code, DRY violations, documentation gaps, cognitive load',
  },
  {
    name: 'Dependencies & Integration',
    focus: 'API contracts, breaking changes, dependency versions, compatibility, external service integration, error handling at boundaries',
  },
]);

export const TRIVIAL_VERIFIER_AGENT: ReviewerAgent = Object.freeze({
  name: 'Trivial Change Verifier',
  focus: 'Review this trivial change on two fronts: (1) check the actual content for issues appropriate to the change type — typos, stale references, broken markdown/links, incomplete renames; (2) verify the change is actually trivial as classified and flag any hidden behavior change, security implication, broken invariant, or missing test that would contradict that assessment.',
});

export function buildAgentPool(customReviewers?: ReviewerAgent[]): ReviewerAgent[] {
  const pool = [...AGENT_POOL];
  for (const custom of (customReviewers ?? [])) {
    if (!pool.some(p => p.name === custom.name)) pool.push(custom);
  }
  return pool;
}

/**
 * Decide whether `agent` can be safely skipped for the given diff. Returns
 * `null` when the agent should run, otherwise a short skip-reason tag.
 *
 * The check is conservative: agents without a lens always run, and an empty
 * file list always runs (so the agent can confirm there is nothing to flag).
 */
export function checkAgentLens(
  agent: ReviewerAgent,
  files: readonly DiffFile[],
): 'lens-no-match' | null {
  const lens = agent.lens;
  if (!lens || lens.filePatterns.length === 0) return null;
  if (files.length === 0) return null;

  const matchOpts = { matchBase: true, dot: true };
  const matchesAny = (path: string): boolean =>
    lens.filePatterns.some(p => minimatch(path, p, matchOpts));

  if (lens.mode === 'include') {
    return files.some(f => matchesAny(f.path)) ? null : 'lens-no-match';
  }
  return files.every(f => matchesAny(f.path)) ? 'lens-no-match' : null;
}
