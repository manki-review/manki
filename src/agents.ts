import { ReviewerAgent } from './types';

export const TRIVIAL_VERIFIER_AGENT: ReviewerAgent = Object.freeze({
  name: 'Trivial Change Verifier',
  focus: 'Review this trivial change on two fronts: (1) check the actual content for issues appropriate to the change type — typos, stale references, broken markdown/links, incomplete renames; (2) verify the change is actually trivial as classified and flag any hidden behavior change, security implication, broken invariant, or missing test that would contradict that assessment.',
});

const CHECKS = [
  'Correctness: wrong results, missed edge cases, null or undefined handling, races, broken invariants.',
  'Security: injection, authentication or permission bypass, secret or token exposure, unsafe handling of untrusted input, resource exhaustion or denial of service from outside input (CWE-400, CWE-770), such as an allocation, a loop or recursion sized by the input, or a size limit removed or raised. For a library, outside input is anything a caller of its public API can pass, readers and byte streams included. A security defect always blocks the merge, so report every one you find.',
  'Reference claims: when the PR title, description or changed code says the change matches another implementation, a spec or a standard, open the code or text it names and compare it with the change line by line. Read it in a **reference** related repo when one is listed. Report each difference the PR does not call out, citing both sides.',
  'Reference behaviour: when the code implements or mirrors a reference, such as a spec, another implementation or an API it talks to, compare both directions of each contract: what this code produces against what the reference accepts, and what the reference produces against what this code accepts. Compare limits, field order, field types and versions. Read the reference in a **reference** related repo when one is listed, and cite it.',
  'Error paths: a failure that is swallowed, loses its cause, or leaves state half changed.',
  'Dropped cases: for each pattern match, `switch`, error handler, ignored result or fallback the change adds, name the variants and errors it leaves out and what happens to each. Examples: Rust `let _ =`, `.ok()` or `unwrap_or_default()`, TypeScript `catch {}`, `?.` with a default or an unawaited promise, Python `except: pass` or a `dict.get` default, Go `_ =` on an error or an ignored `ok`.',
  'Tests: for each test the change adds or edits, name the changed line whose revert makes it fail. A test with no such line, one that sets private fields or internal state instead of calling the public API, or one whose mocks replace the code under test is a defect.',
  'Reuse: for each constant, helper, type or loop the change adds, search for an existing one that does the same, and cite its `file:line`.',
  'Repository rules: check each added line against the rules in the repository context, such as `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`, and quote the rule it breaks.',
  'Contract breaks: changed behavior of an API, config key, file or wire format, or stored data that existing code relies on.',
  'Readers: search the whole repository, other packages included, for each changed type, field, variant and function, and check that every reader still works, not only each caller.',
  'Sibling state: when the change checks, adds or removes an item in one collection, read the type that holds it and check everything else that holds the item or is computed from it: other collections, caches, indexes, derived values such as totals or counts, serializers and change notifications such as events or webhooks.',
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
