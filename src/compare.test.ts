import { runComparisons } from './compare';
import { CLAIMS_MISSING_RULE, PRE_EXISTING_RULE } from './review';
import { UNTRUSTED_CONTENT_RULE, VERIFY_CLAIMS_RULE } from './writing-rules';
import { LLMClient, SendMessageOptions } from './providers';
import { LimitQuestion, SiblingFieldQuestion, SiblingImplementationQuestion } from './symbol-uses';
import { RelatedRepoTools } from './types';

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

const limitQuestion = (name: string, previous?: string): LimitQuestion => ({
  name, value: '4 << 20', ...(previous && { previous }), file: 'server/grpc.go', line: 12, text: `grpc.${name}(4 << 20),`,
  hunk: `diff --git a/server/grpc.go b/server/grpc.go\n@@ -12,1 +12,1 @@\n-\tgrpc.${name}(16 << 20),\n+\tgrpc.${name}(4 << 20),`,
});

const RELATED: RelatedRepoTools = { repos: [{ repo: 'example/client', kind: 'reference' }], cacheDir: '/cache', stateDir: '/state' };

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
    const client = fakeClient(user => user.includes('MaxRecvMsgSize') ? '[]' : user.includes('retired') ? FINDING : GAP);
    const names: string[] = [];
    const result = await runComparisons(name => {
      names.push(name);
      return client;
    }, {
      fields: [fieldQuestion('retired')], implementations: [implementationQuestion('from_wire', 'FromWire')], limits: [limitQuestion('MaxRecvMsgSize', '16 << 20')],
    }, { effort: 'high', workspace: '/repo', related: RELATED });

    // A limit question's client is asked for its tools first, and each question gets one client.
    expect(names).toEqual(['Limit producers: MaxRecvMsgSize', 'Sibling field: idle vs retired', 'Sibling code: FromWire::from_wire']);
    const [field, implementation, limit] = client.calls;
    expect(field.options).toEqual({ effort: 'high', repoTools: { root: '/repo', steps: 12 }, timeoutMs: 600_000 });
    // Only a limit question reads the related repos, where a reference may produce the values.
    expect(limit.options).toEqual({ effort: 'high', repoTools: { root: '/repo', steps: 12, related: RELATED }, timeoutMs: 600_000 });
    expect(limit.user).toContain('The change lowers the limit `MaxRecvMsgSize` from `16 << 20` to `4 << 20`, on the line below. Which code produces the values this limit checks, and how large can they get? Search this repository and the reference repositories for every producer');
    expect(limit.user).toContain('```\nserver/grpc.go:12: grpc.MaxRecvMsgSize(4 << 20),\n```\n\n## Changed Hunk\n\n```diff\ndiff --git a/server/grpc.go b/server/grpc.go');
    expect(field.system).toContain('You can read the repository with read-only tools.');
    expect(field.system).toContain(`- ${CLAIMS_MISSING_RULE}\n- ${PRE_EXISTING_RULE}`);
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
    for (const user of [field.user, implementation.user, limit.user]) {
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
      { kind: 'limit', reviewer: 'Limit producers: MaxRecvMsgSize', at: ['server/grpc.go:12'], status: 'answered', findings: 0 },
    ]);

    // Without tools only the code in the prompt is known, which never says who produces a limit's values.
    const plain = fakeClient(() => '[]', false);
    const untooled = await runComparisons(() => plain, { fields: [fieldQuestion('retired')], implementations: [implementationQuestion('size')], limits: [limitQuestion('MaxRecvMsgSize')] }, { workspace: '/repo' });
    expect(plain.calls).toHaveLength(2);
    expect(untooled.comparisons.map(c => c.kind)).toEqual(['field', 'implementations']);
    expect(plain.calls[0].options).toEqual({});
    expect(plain.calls[0].system).not.toContain('read-only tools');
    expect(plain.calls[0].user).not.toContain('Read where');
    expect(plain.calls[1].user).toContain('Each of these sibling types has its own `size` function. List every check');
  });

  it('caps the sibling kinds at six questions and limits at four, records the rest as cut, asks again once for a reply that does not parse, and records a failure', async () => {
    const fields = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(sibling => fieldQuestion(sibling));
    const implementations = [...Array.from({ length: 6 }, (_, i) => implementationQuestion(`check_${i}`)), implementationQuestion('check_0')];
    const limits = Array.from({ length: 5 }, (_, i) => limitQuestion(`MAX_PART_${i}`));
    const client = fakeClient(user => {
      if (user.includes('`b` instead')) return new Error('provider down');
      if (user.includes('`c` instead') && !user.includes('could not be used')) return 'not json';
      return '[]';
    });
    const result = await runComparisons(() => client, { fields, implementations, limits }, { workspace: '/repo' });

    expect(client.calls).toHaveLength(17);
    expect(client.calls.find(c => c.user.includes('MAX_PART_0'))?.user).toContain('The change adds the limit `MAX_PART_0` at `4 << 20`, on the line below. Which code produces the values this limit checks, and how large can they get? Search this repository for every producer');
    expect(client.calls.filter(c => c.user.includes('`c` instead')).map(c => c.user.includes('Reply with only the JSON array'))).toEqual([false, true]);
    expect(result.comparisons.map(c => `${c.reviewer}: ${c.status}`)).toEqual([
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(s => `Sibling field: idle vs ${s}: ${s === 'b' ? 'failed' : 'answered'}`),
      ...Array.from({ length: 6 }, (_, i) => `Sibling code: check_${i}: answered`),
      ...Array.from({ length: 4 }, (_, i) => `Limit producers: MAX_PART_${i}: answered`),
      'Sibling field: idle vs g: cut',
      'Sibling field: idle vs h: cut',
      'Sibling code: check_0 #2: cut',
      'Limit producers: MAX_PART_4: cut',
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
    const result = await runComparisons(() => client, { fields: [fieldQuestion('quick'), fieldQuestion('slow')], implementations: [], limits: [] }, { signal: deadline.signal });

    expect(result.comparisons.map(c => `${c.reviewer}: ${c.status}`)).toEqual(['Sibling field: idle vs quick: answered', 'Sibling field: idle vs slow: timed_out']);
    expect(client.calls.every(c => c.options?.signal === deadline.signal)).toBe(true);

    const late = fakeClient(() => '[]');
    const skipped = await runComparisons(() => late, { fields: [fieldQuestion('quick')], implementations: [], limits: [] }, { signal: deadline.signal });
    expect(late.calls).toEqual([]);
    expect(skipped.comparisons).toEqual([{ kind: 'field', reviewer: 'Sibling field: idle vs quick', at: ['src/claim.py:2'], status: 'timed_out' }]);
  });
});
