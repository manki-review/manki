import { runComparisons } from './compare';
import { CLAIMS_MISSING_RULE, PRE_EXISTING_RULE } from './review';
import { RELATED_REPO_TRUST_RULE, UNTRUSTED_CONTENT_RULE, VERIFY_CLAIMS_RULE } from './writing-rules';
import { LLMClient, SendMessageOptions } from './providers';
import { repoToolsPrompt } from './providers/cli-utils';
import { SiblingFieldQuestion, SiblingImplementationQuestion } from './symbol-uses';

jest.mock('@actions/core');

const fieldQuestion = (sibling: string, field = 'idle'): SiblingFieldQuestion => ({
  struct: 'WorkerPool', field, sibling, item: 'worker_id',
  lookups: [
    { file: 'src/claim.py', line: 2, text: 'if worker_id in pool.idle:' },
    { file: 'src/claim.py', line: 5, text: 'pool.idle.discard(worker_id)' },
  ],
  definition: { file: 'src/pool.py', line: 3, code: '3:  class WorkerPool:\n4:      idle: set[str] = set()\n5:      retired: set[str] = set()' },
  hunks: ['diff --git a/src/claim.py b/src/claim.py\n@@ -1,4 +1,9 @@\n+    if worker_id in pool.idle:'],
});

const implementationQuestion = (name: string, trait?: string): SiblingImplementationQuestion => ({
  name, ...(trait && { trait }),
  members: [
    { owner: 'TextPart', file: 'src/text.rs', line: 2, changed: true, code: '2:  fn from_wire() {\n3:+     if version > 3 { return Err(e) }\n4:  }' },
    { owner: 'ImagePart', file: 'src/image.rs', line: 8, changed: false, code: '8:  fn from_wire() {\n9:      Ok(p)\n10:  }' },
  ],
});

const HANG = 'hang until aborted';

/** A client that answers each call with the reply `reply` picks for its user message, and keeps every call. `HANG` waits for the call's signal. */
function fakeClient(reply: (user: string) => string | Error, repoTools = true): LLMClient & { calls: Array<{ system: string; user: string; options?: SendMessageOptions }> } {
  const calls: Array<{ system: string; user: string; options?: SendMessageOptions }> = [];
  return {
    repoTools,
    calls,
    async sendMessage(system, user, options) {
      calls.push({ system, user, options });
      const answer = reply(user);
      if (answer instanceof Error) throw answer;
      if (answer === HANG) return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      return { content: answer };
    },
  };
}

const FINDING = JSON.stringify([{
  severity: 'blocker', title: 'A worker held in `retired` is claimed again', file: 'src/claim.py', line: 2,
  description: 'The lookup only checks `idle`.', evidence: ['src/pool.py:5 declares `retired`'], proof: ['src/claim.py:2'],
}]);

const GAP = JSON.stringify([{
  severity: 'warning', title: 'The image decoder accepts any version', file: 'src/image.rs', line: 9, description: 'Only the text decoder checks it.',
  evidence: ['src/text.rs:3 rejects versions above 3'], claimsMissing: true, emptySearch: 'grep `version >` in src/image.rs: no match',
  preExisting: true, preExistingReason: 'The image decoder never checked the version.',
}]);

describe('runComparisons', () => {
  it('asks one small call per question with the code it compares, and names its findings after the question', async () => {
    const client = fakeClient(user => user.includes('retired') ? FINDING : GAP);
    const names: string[] = [];
    const result = await runComparisons(name => {
      names.push(name);
      return client;
    }, { fields: [fieldQuestion('retired')], implementations: [implementationQuestion('from_wire', 'FromWire')] }, { effort: 'high', workspace: '/repo' });

    expect(names).toEqual(['Sibling field: idle vs retired', 'Sibling code: FromWire::from_wire']);
    const [field, implementation] = client.calls;
    expect(field.options).toEqual({ effort: 'high', repoTools: { root: '/repo', steps: 12 }, timeoutMs: 600_000 });
    // With related repos configured, the tools of a comparison read them too, under the rule that their content is untrusted.
    const related = { repos: [{ repo: 'acme/reports', kind: 'consumer' as const }], cacheDir: '/cache', stateDir: '/state' };
    await runComparisons(() => client, { fields: [fieldQuestion('retired')], implementations: [] }, { effort: 'high', workspace: '/repo', related });
    const withRelated = client.calls.at(-1)!.options!.repoTools!;
    expect(withRelated).toStrictEqual({ root: '/repo', steps: 12, related });
    expect(repoToolsPrompt(withRelated, 'Read, Grep and Glob')).toContain(RELATED_REPO_TRUST_RULE);
    expect(field.system).toContain('You can read the repository with read-only tools.');
    expect(field.system).toContain('- **warning**: a real case that fails, but not catastrophically. List its proving lines in `proof` too.');
    expect(field.system).toContain(`- ${CLAIMS_MISSING_RULE}\n- ${PRE_EXISTING_RULE}`);
    // A gap in sibling code is what these calls look for, so the defect a PR fixes in one path is never pre-existing in the other.
    expect(PRE_EXISTING_RULE).toContain('Never set it either on the defect this PR fixes in one path and leaves in a sibling path, such as an auth check added to `POST /items` while `PUT /items/:id` stays open: the fix is incomplete, so report it as part of the change and cite the line of the fix in `proof`.');
    expect(field.system).toContain(`- ${UNTRUSTED_CONTENT_RULE}\n- ${VERIFY_CLAIMS_RULE}`);
    expect(field.user).toContain('The change looks up `worker_id` in `idle` of `WorkerPool`, on the first line below. Can `worker_id` be held in `retired` instead? If so, does the change handle it? Read where `retired` is written before you answer.');
    expect(field.user).toContain('The changed lines that use `idle`:\n\n```\nsrc/claim.py:2: if worker_id in pool.idle:\nsrc/claim.py:5: pool.idle.discard(worker_id)\n```');
    expect(field.user).toContain('## `WorkerPool`\n\n');
    expect(field.user).toContain('```py\nsrc/pool.py\n3:  class WorkerPool:');
    expect(field.user).toContain('## Changed Hunks\n\n```diff\ndiff --git a/src/claim.py b/src/claim.py');
    expect(implementation.user).toContain('These functions implement `FromWire::from_wire` on sibling types. List every check, guard, version test, bound, error or event one has and another lacks.');
    expect(implementation.user).toContain('### `TextPart` (changed by the PR)\n\n```rs\nsrc/text.rs\n2:  fn from_wire() {');
    expect(implementation.user).toContain('### `ImagePart`\n\n```rs\nsrc/image.rs\n8:');
    // Every path the PR controls sits inside a fence: outside the fences only Manki's own text and checked names remain.
    for (const user of [field.user, implementation.user]) {
      expect(user.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gm, '')).not.toMatch(/src\//);
    }

    expect(result.findings).toEqual([expect.objectContaining({
      severity: 'blocker', file: 'src/claim.py', line: 2, reviewers: ['Sibling field: idle vs retired'],
      evidence: { checks: ['src/pool.py:5 declares `retired`'], proof: ['src/claim.py:2'] },
    }), expect.objectContaining({
      file: 'src/image.rs', reviewers: ['Sibling code: FromWire::from_wire'], preExisting: 'The image decoder never checked the version.',
      evidence: { checks: ['src/text.rs:3 rejects versions above 3'], proof: [], emptySearch: 'grep `version >` in src/image.rs: no match' },
    })]);
    expect(result.comparisons).toEqual([
      { kind: 'field', reviewer: 'Sibling field: idle vs retired', at: ['src/claim.py:2'], status: 'answered', findings: 1 },
      { kind: 'implementations', reviewer: 'Sibling code: FromWire::from_wire', at: ['src/text.rs:2', 'src/image.rs:8'], status: 'answered', findings: 1 },
    ]);

    const plain = fakeClient(() => '[]', false);
    await runComparisons(() => plain, { fields: [fieldQuestion('retired')], implementations: [implementationQuestion('size')] });
    expect(plain.calls[0].options).toEqual({});
    expect(plain.calls[0].system).not.toContain('read-only tools');
    expect(plain.calls[0].user).not.toContain('Read where');
    expect(plain.calls[1].user).toContain('Each of these sibling types has its own `size` function. List every check');
  });

  it('caps each kind at six questions, records the rest as cut, asks again once for a reply that does not parse, and records a failure', async () => {
    const fields = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(sibling => fieldQuestion(sibling));
    const implementations = [...Array.from({ length: 6 }, (_, i) => implementationQuestion(`check_${i}`)), implementationQuestion('check_0')];
    const client = fakeClient(user => {
      if (user.includes('`b` instead')) return new Error('provider down');
      if (user.includes('`c` instead') && !user.includes('could not be used')) return 'not json';
      return '[]';
    });
    const result = await runComparisons(() => client, { fields, implementations });

    expect(client.calls).toHaveLength(13);
    expect(client.calls.filter(c => c.user.includes('`c` instead')).map(c => c.user.includes('Reply with only the JSON array'))).toEqual([false, true]);
    expect(result.comparisons.map(c => `${c.reviewer}: ${c.status}`)).toEqual([
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(s => `Sibling field: idle vs ${s}: ${s === 'b' ? 'failed' : 'answered'}`),
      ...Array.from({ length: 6 }, (_, i) => `Sibling code: check_${i}: answered`),
      'Sibling field: idle vs g: cut',
      'Sibling field: idle vs h: cut',
      'Sibling code: check_0 #2: cut',
    ]);
  });

  it('records a question still running when the signal stops the round waiting as timed out, and asks none after it', async () => {
    const deadline = new AbortController();
    const client = fakeClient(user => {
      if (user.includes('`slow` instead')) {
        setImmediate(() => deadline.abort());
        return HANG;
      }
      return '[]';
    });
    const result = await runComparisons(() => client, { fields: [fieldQuestion('quick'), fieldQuestion('slow')], implementations: [] }, { signal: deadline.signal });

    expect(result.comparisons.map(c => `${c.reviewer}: ${c.status}`)).toEqual(['Sibling field: idle vs quick: answered', 'Sibling field: idle vs slow: timed_out']);
    expect(client.calls.every(c => c.options?.signal === deadline.signal)).toBe(true);

    const late = fakeClient(() => '[]');
    const skipped = await runComparisons(() => late, { fields: [fieldQuestion('quick')], implementations: [] }, { signal: deadline.signal });
    expect(late.calls).toEqual([]);
    expect(skipped.comparisons).toEqual([{ kind: 'field', reviewer: 'Sibling field: idle vs quick', at: ['src/claim.py:2'], status: 'timed_out' }]);
  });
});
