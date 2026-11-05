import { ReviewerAgent } from './types';

export const TRIVIAL_VERIFIER_AGENT: ReviewerAgent = Object.freeze({
  name: 'Trivial Change Verifier',
  focus: 'Review this trivial change on two fronts: (1) check the actual content for issues appropriate to the change type — typos, stale references, broken markdown/links, incomplete renames; (2) verify the change is actually trivial as classified and flag any hidden behavior change, security implication, broken invariant, or missing test that would contradict that assessment.',
});

const FINDER_FOCUS = `defects in the change. Check, in this order:
1. Correctness: wrong results, missed edge cases, null or undefined handling, races, broken invariants.
2. Security: injection, authentication or permission bypass, secret or token exposure, unsafe handling of untrusted input. A security defect always blocks the merge, so report every one you find.
3. Error paths: a failure that is swallowed, loses its cause, or leaves state half changed.
4. Tests that cannot fail: assertions that pass whatever the code does, or mocks that replace the code under test.
5. Contract breaks: changed behavior of an API, config key, file or wire format, or stored data that existing callers rely on.`;

/** Returns the finder every non-trivial round runs. Each custom reviewer becomes one more line to check. */
export function buildFinderAgent(customReviewers: readonly ReviewerAgent[]): ReviewerAgent {
  const extra = customReviewers.map(r => `\n- ${r.name}: ${r.focus}`).join('');
  return {
    name: 'Finder',
    focus: extra ? `${FINDER_FOCUS}\n\nThis repository also asks you to check:${extra}` : FINDER_FOCUS,
  };
}
