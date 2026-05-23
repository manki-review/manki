import { ReviewerAgent } from './types';

// Standard reviewer pool used for teamSize >= 3. TRIVIAL_VERIFIER_AGENT is
// intentionally excluded — it is only active for the teamSize=1 path and does
// not participate in scoring, focusAreas validation, or planner prompts.
export const AGENT_POOL: readonly ReviewerAgent[] = Object.freeze([
  {
    name: 'Security & Safety',
    focus: 'Vulnerabilities, injection, auth, data leaks, memory safety, crypto correctness, key exposure, timing side-channels',
  },
  {
    name: 'Architecture & Design',
    focus: 'Design patterns, coupling, abstractions, API design, module boundaries, separation of concerns, SOLID principles',
  },
  {
    name: 'Correctness & Logic',
    focus: 'Edge cases, off-by-one errors, null/undefined handling, race conditions, data integrity, type safety, error propagation',
  },
  {
    name: 'Testing & Coverage',
    focus: 'Missing tests, test quality, edge case coverage, assertion strength, mock appropriateness, test maintainability',
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
