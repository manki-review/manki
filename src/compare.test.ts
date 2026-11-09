import { runComparisons } from './compare';
import { CLAIMS_MISSING_RULE, PRE_EXISTING_RULE } from './review';
import { LLMClient, SendMessageOptions } from './providers';
import { SiblingFieldQuestion, SiblingImplementationQuestion } from './symbol-uses';

jest.mock('@actions/core');

const fieldQuestion = (sibling: string, field = 'utxos'): SiblingFieldQuestion => ({
  struct: 'Account', field, sibling, item: 'outpoint',
  lookups: [
    { file: 'src/settle.rs', line: 2, text: 'if account.utxos.contains_key(&outpoint) {' },
    { file: 'src/settle.rs', line: 5, text: 'let held = account.utxos.remove(&outpoint);' },
  ],
  definition: { file: 'src/account.rs', line: 3, code: '3:  pub struct Account {\n4:      pub utxos: BTreeMap<OutPoint, Utxo>,\n5:      spent_before_funded: BTreeMap<OutPoint, Utxo>,\n6:  }' },
  hunks: ['diff --git a/src/settle.rs b/src/settle.rs\n@@ -1,4 +1,9 @@\n+    if account.utxos.contains_key(&outpoint) {'],
});

const implementationQuestion = (name: string, trait?: string): SiblingImplementationQuestion => ({
  name, ...(trait && { trait }),
  members: [
    { owner: 'ServicePayload', file: 'src/service.rs', line: 2, changed: true, code: '2:  fn consensus_decode() {\n3:+     if version > 3 { return Err(e) }\n4:  }' },
    { owner: 'RegistrarPayload', file: 'src/registrar.rs', line: 8, changed: false, code: '8:  fn consensus_decode() {\n9:      Ok(p)\n10:  }' },
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
  severity: 'blocker', title: 'An output held in `spent_before_funded` is counted twice', file: 'src/settle.rs', line: 2,
  description: 'The lookup only checks `utxos`.', evidence: ['src/account.rs:5 declares `spent_before_funded`'], proof: ['src/settle.rs:2'],
}]);

const GAP = JSON.stringify([{
  severity: 'warning', title: 'The registrar decoder accepts any version', file: 'src/registrar.rs', line: 9, description: 'Only the service decoder checks it.',
  evidence: ['src/service.rs:3 rejects versions above 3'], claimsMissing: true, emptySearch: 'grep `version >` in src/registrar.rs: no match',
  preExisting: true, preExistingReason: 'The registrar decoder never checked the version.',
}]);

describe('runComparisons', () => {
  it('asks one small call per question with the code it compares, and names its findings after the question', async () => {
    const client = fakeClient(user => user.includes('spent_before_funded') ? FINDING : GAP);
    const names: string[] = [];
    const result = await runComparisons(name => {
      names.push(name);
      return client;
    }, { fields: [fieldQuestion('spent_before_funded')], implementations: [implementationQuestion('consensus_decode', 'Decodable')] }, { effort: 'high', workspace: '/repo' });

    expect(names).toEqual(['Sibling field: utxos vs spent_before_funded', 'Sibling code: Decodable::consensus_decode']);
    const [field, implementation] = client.calls;
    expect(field.options).toEqual({ effort: 'high', repoTools: { root: '/repo', steps: 12 }, timeoutMs: 600_000 });
    expect(field.system).toContain('You can read the repository with read-only tools.');
    expect(field.system).toContain(`- ${CLAIMS_MISSING_RULE}\n- ${PRE_EXISTING_RULE}`);
    expect(field.user).toContain('The change looks up `outpoint` in `utxos` of `Account`, on the first line below. Can `outpoint` be held in `spent_before_funded` instead? If so, does the change handle it? Read where `spent_before_funded` is written before you answer.');
    expect(field.user).toContain('The changed lines that use `utxos`:\n\n```\nsrc/settle.rs:2: if account.utxos.contains_key(&outpoint) {\nsrc/settle.rs:5: let held = account.utxos.remove(&outpoint);\n```');
    expect(field.user).toContain('## `Account`\n\n');
    expect(field.user).toContain('```rs\nsrc/account.rs\n3:  pub struct Account {');
    expect(field.user).toContain('## Changed Hunks\n\n```diff\ndiff --git a/src/settle.rs b/src/settle.rs');
    expect(implementation.user).toContain('These functions implement `Decodable::consensus_decode` on sibling types. List every check, guard, version test, bound, error or event one has and another lacks.');
    expect(implementation.user).toContain('### `ServicePayload` (changed by the PR)\n\n```rs\nsrc/service.rs\n2:  fn consensus_decode() {');
    expect(implementation.user).toContain('### `RegistrarPayload`\n\n```rs\nsrc/registrar.rs\n8:');
    // Every path the PR controls sits inside a fence: outside the fences only Manki's own text and checked names remain.
    for (const user of [field.user, implementation.user]) {
      expect(user.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gm, '')).not.toMatch(/src\//);
    }

    expect(result.findings).toEqual([expect.objectContaining({
      severity: 'blocker', file: 'src/settle.rs', line: 2, reviewers: ['Sibling field: utxos vs spent_before_funded'],
      evidence: { checks: ['src/account.rs:5 declares `spent_before_funded`'], proof: ['src/settle.rs:2'] },
    }), expect.objectContaining({
      file: 'src/registrar.rs', reviewers: ['Sibling code: Decodable::consensus_decode'], preExisting: 'The registrar decoder never checked the version.',
      evidence: { checks: ['src/service.rs:3 rejects versions above 3'], proof: [], emptySearch: 'grep `version >` in src/registrar.rs: no match' },
    })]);
    expect(result.comparisons).toEqual([
      { kind: 'field', reviewer: 'Sibling field: utxos vs spent_before_funded', at: ['src/settle.rs:2'], status: 'answered', findings: 1 },
      { kind: 'implementations', reviewer: 'Sibling code: Decodable::consensus_decode', at: ['src/service.rs:2', 'src/registrar.rs:8'], status: 'answered', findings: 1 },
    ]);

    const plain = fakeClient(() => '[]', false);
    await runComparisons(() => plain, { fields: [fieldQuestion('spent_before_funded')], implementations: [implementationQuestion('size')] });
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
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(s => `Sibling field: utxos vs ${s}: ${s === 'b' ? 'failed' : 'answered'}`),
      ...Array.from({ length: 6 }, (_, i) => `Sibling code: check_${i}: answered`),
      'Sibling field: utxos vs g: cut',
      'Sibling field: utxos vs h: cut',
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

    expect(result.comparisons.map(c => `${c.reviewer}: ${c.status}`)).toEqual(['Sibling field: utxos vs quick: answered', 'Sibling field: utxos vs slow: timed_out']);
    expect(client.calls.every(c => c.options?.signal === deadline.signal)).toBe(true);

    const late = fakeClient(() => '[]');
    const skipped = await runComparisons(() => late, { fields: [fieldQuestion('quick')], implementations: [] }, { signal: deadline.signal });
    expect(late.calls).toEqual([]);
    expect(skipped.comparisons).toEqual([{ kind: 'field', reviewer: 'Sibling field: utxos vs quick', at: ['src/settle.rs:2'], status: 'timed_out' }]);
  });
});
