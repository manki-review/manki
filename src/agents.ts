import { ReviewerAgent } from './types';

export const TRIVIAL_VERIFIER_AGENT: ReviewerAgent = Object.freeze({
  name: 'Trivial Change Verifier',
  focus: 'Review this trivial change on two fronts: (1) check the actual content for issues appropriate to the change type — typos, stale references, broken markdown/links, incomplete renames; (2) verify the change is actually trivial as classified and flag any hidden behavior change, security implication, broken invariant, or missing test that would contradict that assessment.',
});

const CHECKS = [
  'Correctness: wrong results, missed edge cases, null or undefined handling, races, broken invariants.',
  'Security: injection, authentication or permission bypass, secret or token exposure, unsafe handling of untrusted input, resource exhaustion or denial of service from outside input (CWE-400, CWE-770), such as an allocation, a loop or recursion sized by the input, or a size limit removed or raised. For a library, outside input is anything a caller of its public API can pass, readers and byte streams included. A security defect always blocks the merge, so report every one you find.',
  'Reference claims: when the PR title, description or changed code says the change matches another implementation, a spec or a standard, open the code or text it names and compare it with the change line by line. Read it in a **reference** related repo when one is listed. Report each difference the PR does not call out, citing both sides.',
  'Reference behaviour: when the change touches protocol, consensus, network or serialization code that a **reference** related repo implements, open its counterpart there and compare the behaviour in both directions: what this code sends against what the reference accepts, and what this code accepts against what the reference sends. For a changed size or count limit, find what the reference actually sends, not only the limit it checks on receive. For a changed decoder or encoder, compare the field order, field types and version bounds with the reference\'s serializer. Cite the reference code.',
  'Error paths: a failure that is swallowed, loses its cause, or leaves state half changed.',
  'Dropped cases: for each pattern match, `select!` arm, `catch`, ignored result such as `let _ =`, or fallback such as `.ok()` or `unwrap_or_default` the change adds, name the variants and errors it leaves out and what happens to each.',
  'Tests: for each test the change adds or edits, name the changed line whose revert makes it fail. A test with no such line, one that sets private fields or internal state instead of calling the public API, or one whose mocks replace the code under test is a defect.',
  'Reuse: for each constant, helper, type or loop the change adds, search for an existing one that does the same, and cite its `file:line`.',
  'Repository rules: check each added line against the rules in the repository context, such as `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`, and quote the rule it breaks.',
  'Contract breaks: changed behavior of an API, config key, file or wire format, or stored data that existing code relies on.',
  'Readers: search the whole repository, other packages included, for each changed type, field, variant and function, and check that every reader still works, not only each caller.',
  'Sibling state: when the change checks, adds or removes an item in one collection, read the type that holds it and check every other collection, cache, size or fee estimate, serializer and persistence event that holds or reports the same item.',
  'Sibling symmetry: compare each changed function with its counterpart, such as encode and decode, the other enum arms or the same function for another type. A check, version guard, lock or event that one has and the other lacks is a defect.',
];

const FINDER_FOCUS = `defects in the change. Check, in this order:\n${CHECKS.map((check, i) => `${i + 1}. ${check}`).join('\n')}

A PR can hold several defects of different kinds. Look for all of them, not only the first or the worst. Report a reuse finding only with the existing code's \`file:line\`, and a rule finding only with the rule quoted.`;

/** Returns the finder every non-trivial round runs. Each custom reviewer becomes one more line to check. */
export function buildFinderAgent(customReviewers: readonly ReviewerAgent[]): ReviewerAgent {
  const extra = customReviewers.map(r => `\n- ${r.name}: ${r.focus}`).join('');
  return {
    name: 'Finder',
    focus: extra ? `${FINDER_FOCUS}\n\nThis repository also asks you to check:${extra}` : FINDER_FOCUS,
  };
}
