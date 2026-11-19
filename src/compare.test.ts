import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runComparisons, runPatternChecks, runRelatedChecks } from './compare';
import { CLAIMS_MISSING_RULE, PRE_EXISTING_RULE, RELATED_REPO_TRUST_RULE, UNTRUSTED_CONTENT_RULE, VERIFY_CLAIMS_RULE } from './writing-rules';
import { repoToolsPrompt } from './providers/cli-utils';
import { AddedPiece, RelatedQuestion, SiblingFieldQuestion, SiblingImplementationQuestion } from './symbol-uses';
import { fakeClient, gitWorkspace, HANG } from './test-utils';

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
      { kind: 'field', reviewer: 'Sibling field: idle vs retired', at: ['src/claim.py:2'], status: 'answered', findings: 1, inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { kind: 'implementations', reviewer: 'Sibling code: FromWire::from_wire', at: ['src/text.rs:2', 'src/image.rs:8'], status: 'answered', findings: 1, inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);

    const plain = fakeClient(() => '[]', false);
    await runComparisons(() => plain, { fields: [fieldQuestion('retired')], implementations: [implementationQuestion('size')] });
    expect(plain.calls[0].options).toEqual({ timeoutMs: 600_000 });
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

    // A retry asks only the question whose call failed, and keeps each answer whose question it would send unchanged.
    const raised = { severity: 'warning' as const, title: 'Kept', file: 'src/claim.py', line: 2, description: 'd', reviewers: ['Sibling field: idle vs a'] };
    const confirm = jest.fn(async () => true);
    const earlier = { answers: new Map(result.comparisons.map(c => [c.reviewer, { record: c, findings: c.reviewer === raised.reviewers[0] ? [raised] : [] }])), confirm };
    const again = fakeClient(() => '[]');
    const retried = await runComparisons(() => again, { fields, implementations }, { earlier });
    expect(again.calls.map(c => c.user.includes('`b` instead'))).toEqual([true]);
    expect(retried.comparisons.map(c => `${c.reviewer}: ${c.status}${c.reused ? ', kept' : ''}`)).toEqual([
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(s => `Sibling field: idle vs ${s}: answered${s === 'b' ? '' : ', kept'}`),
      ...Array.from({ length: 6 }, (_, i) => `Sibling code: check_${i}: answered, kept`),
      'Sibling field: idle vs g: cut',
      'Sibling field: idle vs h: cut',
      'Sibling code: check_0 #2: cut',
    ]);
    expect(retried.findings).toEqual([raised]);
    // A question sent anything else, here at another effort, is asked again.
    const other = fakeClient(() => '[]');
    confirm.mockClear();
    await runComparisons(() => other, { fields, implementations }, { earlier, effort: 'high' });
    expect(other.calls).toHaveLength(12);
    // Nothing could be kept, so nothing asked whether it may be.
    expect(confirm).not.toHaveBeenCalled();
    // A question whose answer may not be kept is asked again.
    const refused = fakeClient(() => '[]');
    await runComparisons(() => refused, { fields, implementations }, { earlier: { ...earlier, confirm: async () => false } });
    expect(refused.calls).toHaveLength(12);
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

describe('runRelatedChecks', () => {
  const question = (kind: RelatedQuestion['kind'], name: string, extra: Partial<RelatedQuestion> = {}): RelatedQuestion => ({
    kind, name, lines: ['acme/node:src/net.cpp:2'], quoted: ['acme/node:src/net.cpp:2: if (nVersion < MIN_PEER_VERSION) return false;'], changed: 1,
    hunks: ['diff --git a/src/peer.rs b/src/peer.rs\n@@ -1,1 +1,2 @@\n+const MIN_PEER_VERSION: u32 = 70016;'], ...extra,
  });

  it('checks each counterpart in a call of its own, and keeps a finding only with a line on both sides that exists', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'manki-related-check-'));
    const checkout = mkdtempSync(join(tmpdir(), 'manki-related-checkout-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'manki-related-state-'));
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src/peer.rs'), 'fn accept() {}\nconst MIN_PEER_VERSION: u32 = 70016;\n');
    mkdirSync(join(checkout, 'src'));
    writeFileSync(join(checkout, 'src/net.cpp'), 'bool Accept() {\n    if (nVersion < MIN_PEER_VERSION) return false;\n}\n');
    writeFileSync(join(stateDir, `${encodeURIComponent('acme/node')}.done`), checkout);
    const related = { repos: [{ repo: 'acme/node', kind: 'reference' as const }], cacheDir: '/cache', stateDir };
    const finding = (title: string, proof: string[]) => ({
      severity: 'warning', title, file: 'src/peer.rs', line: 2, description: 'The reference rejects an older peer.', evidence: ['acme/node:src/net.cpp:2 rejects it with `nVersion < MIN_PEER_VERSION`'], proof,
    });
    const client = fakeClient(user => user.includes('`MIN_PEER_VERSION`, and the lines below are where the reference')
      ? [
        finding('Both sides', ['src/peer.rs:2', 'acme/node:src/net.cpp:2']),
        finding('Only the PR', ['src/peer.rs:2']),
        finding('Only the reference', ['acme/node:src/net.cpp:2']),
        finding('A line the reference does not hold', ['src/peer.rs:2', 'acme/node:src/net.cpp:40']),
      ]
      : []);
    let result;
    try {
      result = await runRelatedChecks(() => client, [
        question('reference', 'MIN_PEER_VERSION', { as: ['nMinPeerVersion'], notShown: 3 }),
        question('consumer', 'PeerInfo', { hunks: [] }),
        question('dependency', 'read_varint'),
      ], { effort: 'high', workspace, related });
    } finally {
      for (const dir of [workspace, checkout, stateDir]) rmSync(dir, { recursive: true, force: true });
    }

    const [reference, consumer, dependency] = client.calls;
    expect(reference.options).toEqual({ effort: 'high', repoTools: { root: workspace, steps: 12, related }, timeoutMs: 600_000 });
    expect(reference.system).toContain('You check a pull request\'s change against one counterpart in a related repository');
    expect(reference.system).toContain('- Every defect cites a line on both sides in `proof`: at least one `file:line` of the PR\'s head commit and one `owner/name:path:line` of the related repo, each a line you read. A defect without both is dropped.');
    expect(reference.system).toContain('- When the answer is no, when the code on both sides agrees, or when you could not open the counterpart, respond with [].');
    expect(reference.system).toContain(`- ${RELATED_REPO_TRUST_RULE}\n- ${UNTRUSTED_CONTENT_RULE}\n- ${VERIFY_CLAIMS_RULE}`);
    expect(reference.user).toContain('The change touches `MIN_PEER_VERSION`, and the lines below are where the reference repo holds it. Compare what the change does with what the reference does, in both directions');
    expect(reference.user).toContain('Open the counterpart\'s file with your tools before you answer. Some lines were found by a guess at what that repo calls the name');
    expect(reference.user).toContain(`## In the Reference Repo\n\nEach line starts with \`owner/name:path:line\` and is quoted from the related repo's fetched commit. ${RELATED_REPO_TRUST_RULE}\n\n\`\`\`\nacme/node:src/net.cpp:2: if (nVersion < MIN_PEER_VERSION) return false;\n\`\`\`\n\n3 more lines not shown.\n\n## Changed Hunks\n\n\`\`\`diff\ndiff --git a/src/peer.rs`);
    expect(consumer.user).toContain('The change touches `PeerInfo`, and the consumer repo uses it on the lines below. Check that each use still works with the change');
    expect(consumer.user).not.toContain('## Changed Hunks');
    expect(consumer.user).not.toContain('found by a guess');
    expect(dependency.user).toContain('The change calls or reads `read_varint`, and the dependency repo holds it on the lines below. Check each assumption the change makes about it against that code');
    // Every line of a repo and every path sits inside a fence: outside the fences only Manki's own text and the searched names remain.
    for (const { user } of client.calls) expect(user.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gm, '')).not.toMatch(/acme\/|src\//);

    expect(result.findings).toEqual([expect.objectContaining({
      title: 'Both sides', reviewers: ['Reference check: MIN_PEER_VERSION'],
      evidence: { checks: ['acme/node:src/net.cpp:2 rejects it with `nVersion < MIN_PEER_VERSION`'], proof: ['src/peer.rs:2'], relatedProof: ['acme/node:src/net.cpp:2'] },
    })]);
    expect(result.comparisons).toEqual([
      { kind: 'reference', reviewer: 'Reference check: MIN_PEER_VERSION', at: ['acme/node:src/net.cpp:2'], status: 'answered', findings: 1, dropped: 3, inputDigest: expect.any(String) },
      { kind: 'consumer', reviewer: 'Consumer check: PeerInfo', at: ['acme/node:src/net.cpp:2'], status: 'answered', findings: 0, inputDigest: expect.any(String) },
      { kind: 'dependency', reviewer: 'Dependency check: read_varint', at: ['acme/node:src/net.cpp:2'], status: 'answered', findings: 0, inputDigest: expect.any(String) },
    ]);
  });

  it('asks at most eight counterparts in their order and records the rest as cut, and asks none without repository tools', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `name_${i}`);
    const client = fakeClient(() => '[]');
    const progress = { started: jest.fn(), ended: jest.fn() };
    const result = await runRelatedChecks(() => client, [...names.map(name => question('consumer', name)), question('consumer', 'name_0')], { workspace: '/repo', progress });
    expect(client.calls.map(c => c.user.match(/`(name_\d)`/)![1])).toEqual(names.slice(0, 8));
    // The progress counts the questions asked, not those cut, and hears the findings of each answer.
    expect(progress.started.mock.calls).toEqual([[8]]);
    expect(progress.ended.mock.calls).toEqual(Array.from({ length: 8 }, () => [0]));
    expect(result.comparisons.map(c => `${c.reviewer}: ${c.status}`)).toEqual([
      ...names.slice(0, 8).map(name => `Consumer check: ${name}: answered`),
      'Consumer check: name_8: cut', 'Consumer check: name_9: cut', 'Consumer check: name_0 #2: cut',
    ]);

    // A call that could not open the counterpart would report nothing, so none is made.
    const plain = fakeClient(() => '[]', false);
    for (const workspace of ['/repo', undefined]) {
      const skippedProgress = { started: jest.fn(), ended: jest.fn() };
      const skipped = await runRelatedChecks(() => plain, [question('reference', 'MIN_PEER_VERSION')], { workspace, progress: skippedProgress });
      expect(skippedProgress.ended.mock.calls).toEqual([[undefined]]);
      expect(skipped).toEqual({ findings: [], comparisons: [{ kind: 'reference', reviewer: 'Reference check: MIN_PEER_VERSION', at: ['acme/node:src/net.cpp:2'], status: 'skipped' }] });
    }
    expect(plain.calls).toEqual([]);
  });
});

describe('runPatternChecks', () => {
  const HANDLER = (name: string) => `export function ${name}(req: Request) {\n  return withAuth(req, () => ok());\n}\n`;
  const piece = (name: string, extra: Partial<AddedPiece> = {}): AddedPiece => ({
    kind: 'function', name, file: 'src/refund.ts', start: 1, end: 3, size: 3, code: '1:+ export function refund(req: Request) {\n2:+   return ok();\n3:+ }', ...extra,
  });
  const finding = (title: string, proof: string[], extra: Record<string, unknown> = {}) => ({
    severity: 'warning', title, file: 'src/refund.ts', line: 2, description: 'The new handler skips `withAuth`.', cost: 'A caller can refund without a session.',
    evidence: ['src/charge.ts:2 wraps the handler in `withAuth`'], proof, ...extra,
  });

  it('asks one call per piece with its added lines, and keeps a finding of a difference only with two existing places or a rule, on a line the PR adds', async () => {
    const { root, diff } = gitWorkspace(
      { 'src/charge.ts': HANDLER('charge'), 'src/cancel.ts': HANDLER('cancel'), 'src/void.ts': HANDLER('voidOrder'), 'AGENTS.md': '# Rules\n' },
      { 'src/void.ts': 'export function voidOrder(req: Request) {\n  return ok();\n}\n', 'src/refund.ts': 'export function refund(req: Request) {\n  return ok();\n}\n', 'gen/handlers.ts': HANDLER('generated'), 'src/link.ts': HANDLER('linked') },
    );
    // `exclude_paths` leaves the generated file out of the reviewed diff, but the PR still adds its lines.
    const reviewed = { ...diff, files: diff.files.filter(f => !f.path.startsWith('gen/')) };
    const instructionFiles = [{ path: 'AGENTS.md', text: '# Rules\n\nEvery handler must check the session with `withAuth`.' }];
    const client = fakeClient(user => {
      if (user.includes('`Refund`')) return { answer: 'follows', places: ['src/charge.ts:1'], findings: [finding('Ignored without a difference', ['src/charge.ts:2', 'src/cancel.ts:2'])] };
      if (user.includes('`refunds`') && !user.includes('could not be used')) return { answer: 'maybe' };
      if (user.includes('`Refunds`')) return { answer: 'differs', places: ['src/charge.ts:1', 'src/cancel.ts:1'], findings: [{ proof: ['src/charge.ts:2'], cost: 'Some cost.' }] };
      if (user.includes('`refunds`')) return { answer: 'no_comparable' };
      return {
        answer: 'differs', places: ['src/charge.ts:1', './src/charge.ts:1', 'src/cancel.ts:1-3', 'src/cancel.ts:2', 'src/void.ts:2', 'src/refund.ts:1', 'src/missing.ts:1'],
        findings: [
          finding('Two places', ['src/charge.ts:2', './src/cancel.ts:2', 'src/cancel.ts:40', 'src/refund.ts:2']),
          finding('One place', ['src/charge.ts:2', 'src/refund.ts:2']),
          finding('A line an excluded file adds', ['src/charge.ts:2', 'gen/handlers.ts:2', 'src/refund.ts:2']),
          finding('One place spelled three ways', ['src/charge.ts:2', 'src/charge.ts:2-3', './src/charge.ts:1-2']),
          // `lib` links to `src`, so its `charge.ts` is the same place.
          finding('One place and a link to it', ['src/charge.ts:2', 'lib/charge.ts:2', 'src/refund.ts:2']),
          finding('A line the PR adds, spelled another way', ['src/charge.ts:2', './src/refund.ts:2']),
          finding('A place the PR changes', ['src/charge.ts:2', 'src/void.ts:2', 'src/refund.ts:2']),
          finding('A place that is not there', ['src/charge.ts:2', 'src/cancel.ts:40', 'src/refund.ts:2']),
          finding('A rule', ['src/refund.ts:2'], { rule: 'Every handler must check the session with `withAuth`.', ruleFile: 'AGENTS.md', file: './src/refund.ts' }),
          finding('A made-up rule', ['src/refund.ts:2'], { rule: 'Every handler must log the request first.', ruleFile: 'AGENTS.md' }),
          finding('No cost', ['src/charge.ts:2', 'src/cancel.ts:2'], { cost: ' ' }),
          finding('Off the new code', ['src/charge.ts:2', 'src/cancel.ts:2'], { file: 'src/charge.ts' }),
          // A finder with tools can name the checkout by its absolute path, in the file and in the proof.
          finding('Absolute paths', [`${root}/src/charge.ts:2`, `${root}/src/cancel.ts:2`], { file: `${root}/src/refund.ts`, evidence: [`${root}/src/charge.ts:2 wraps the handler in \`withAuth\``] }),
          finding('Filed through a link', ['src/charge.ts:2', 'src/cancel.ts:2'], { file: 'lib/refund.ts' }),
          // The PR adds `src/link.ts` as a symlink, so a finding on it stays on the file the diff names.
          finding('On a symlink the PR adds', ['src/charge.ts:2', 'src/cancel.ts:2'], { file: 'src/link.ts' }),
        ],
      };
    });
    const pieces = [piece('refund', { kind: 'file', name: 'src/refund.ts' }), piece('Refund', { kind: 'type' }), piece('refunds', { kind: 'key' }), piece('Refunds', { kind: 'type' })];
    let result: Awaited<ReturnType<typeof runPatternChecks>>;
    let retried: Awaited<ReturnType<typeof runPatternChecks>>;
    const again = fakeClient(() => ({ answer: 'follows' }));
    try {
      symlinkSync(join(root, 'src'), join(root, 'lib'));
      rmSync(join(root, 'src/link.ts'));
      symlinkSync('charge.ts', join(root, 'src/link.ts'));
      result = await runPatternChecks(() => client, pieces, { effort: 'high', workspace: root, diff: reviewed, fullDiff: diff, instructionFiles });
      // A retry of the round keeps each answer whose question is unchanged, with its findings, and asks nothing again.
      const answers = new Map(result.comparisons.map(c => [c.reviewer, { record: c, findings: result.findings.filter(f => f.reviewers.includes(c.reviewer)) }]));
      retried = await runPatternChecks(() => again, pieces, { effort: 'high', workspace: root, diff: reviewed, fullDiff: diff, instructionFiles, earlier: { answers, confirm: async () => true } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const [file, type] = client.calls;
    expect(file.options).toEqual({ effort: 'high', repoTools: { root, steps: 12 }, timeoutMs: 600_000 });
    expect(file.system).toContain('You check one piece of structure a pull request adds');
    expect(file.system).toContain('- **no_comparable**: you found fewer than two existing places that do the same kind of thing. One existing example is not a pattern.');
    expect(file.system).toContain('Manki drops a finding that cites fewer than two existing places and quotes no rule, or that is not on a line the PR adds.');
    expect(file.system).toContain(`- ${CLAIMS_MISSING_RULE}\n- ${UNTRUSTED_CONTENT_RULE}\n- ${VERIFY_CLAIMS_RULE}`);
    expect(file.user).toContain('The change adds a new file. Find the existing places in the repository that do the same kind of thing');
    expect(file.user).toContain('```ts\nsrc/refund.ts\n1:+ export function refund(req: Request) {');
    expect(file.user).toContain("## Instruction Files\n\nThe repository's instruction files, as the base branch holds them.");
    expect(type.user).toContain('The change adds the type `Refund`.');
    expect(client.calls.filter(c => c.user.includes('`refunds`')).map(c => c.user.includes('Reply with only the JSON object'))).toEqual([false, true]);
    // Every path the PR controls sits inside a fence: outside the fences only Manki's own text and checked names remain.
    for (const { user } of client.calls) expect(user.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gm, '')).not.toMatch(/src\/|AGENTS/);

    expect(result.findings.map(f => `${f.title}: ${f.severity}`)).toEqual(['Two places: warning', 'A rule: warning', 'No cost: note', 'Absolute paths: warning', 'Filed through a link: warning', 'On a symlink the PR adds: warning']);
    expect(result.findings[0]).toEqual(expect.objectContaining({
      reviewers: ['Pattern check: refund.ts'], description: 'The new handler skips `withAuth`. A caller can refund without a session.',
      evidence: { checks: ['src/charge.ts:2 wraps the handler in `withAuth`'], proof: ['src/charge.ts:2', 'src/cancel.ts:2', 'src/refund.ts:2'] },
    }));
    // A place is compared by its path from the root and its lines, a made-up line is left out, and the finding's own line closes the proof.
    expect(result.findings[1]).toEqual(expect.objectContaining({ file: 'src/refund.ts', evidence: expect.objectContaining({ proof: ['src/refund.ts:2'] }) }));
    expect(result.findings[3]).toEqual(expect.objectContaining({
      file: 'src/refund.ts', evidence: { checks: ['src/charge.ts:2 wraps the handler in `withAuth`'], proof: ['src/charge.ts:2', 'src/cancel.ts:2', 'src/refund.ts:2'] },
    }));
    // A finding filed through the link sits on the diff's file, and its own line closes the proof there.
    expect(result.findings[4]).toEqual(expect.objectContaining({ file: 'src/refund.ts', evidence: expect.objectContaining({ proof: ['src/charge.ts:2', 'src/cancel.ts:2', 'src/refund.ts:2'] }) }));
    expect(result.findings[5]).toEqual(expect.objectContaining({ file: 'src/link.ts', evidence: expect.objectContaining({ proof: ['src/charge.ts:2', 'src/cancel.ts:2', 'src/link.ts:2'] }) }));
    expect(result.comparisons).toEqual([
      { kind: 'pattern', reviewer: 'Pattern check: refund.ts', at: ['src/refund.ts:1'], status: 'answered', answer: 'differs', places: ['src/charge.ts:1', 'src/cancel.ts:1-3'], findings: 6, dropped: 9, inputDigest: expect.any(String) },
      { kind: 'pattern', reviewer: 'Pattern check: Refund', at: ['src/refund.ts:1'], status: 'answered', answer: 'follows', places: ['src/charge.ts:1'], findings: 0, inputDigest: expect.any(String) },
      { kind: 'pattern', reviewer: 'Pattern check: refunds', at: ['src/refund.ts:1'], status: 'answered', answer: 'no_comparable', findings: 0, inputDigest: expect.any(String) },
      // A difference whose findings are all unusable keeps its answer and places.
      { kind: 'pattern', reviewer: 'Pattern check: Refunds', at: ['src/refund.ts:1'], status: 'answered', answer: 'differs', places: ['src/charge.ts:1', 'src/cancel.ts:1'], findings: 0, dropped: 1, inputDigest: expect.any(String) },
    ]);
    expect(again.calls).toEqual([]);
    expect(retried.findings).toEqual(result.findings);
    expect(retried.comparisons).toEqual(result.comparisons.map(c => ({ ...c, reused: true })));
  });

  it('asks at most four pieces in their order and records the rest as cut, names a file of no plain name by its kind, and asks none without repository tools', async () => {
    const names = Array.from({ length: 5 }, (_, i) => `piece_${i}`);
    const client = fakeClient(() => ({ answer: 'follows' }));
    const result = await runPatternChecks(() => client, [...names.map(name => piece(name)), piece('src/a b.ts', { kind: 'file' })], {
      workspace: '/repo', diff: { files: [], totalAdditions: 0, totalDeletions: 0 },
    });
    expect(client.calls.map(c => c.user.match(/`(piece_\d)`/)![1])).toEqual(names.slice(0, 4));
    expect(result.comparisons.map(c => `${c.reviewer}: ${c.status}`)).toEqual([
      ...names.slice(0, 4).map(name => `Pattern check: ${name}: answered`), 'Pattern check: piece_4: cut', 'Pattern check: new file: cut',
    ]);

    const plain = fakeClient(() => ({ answer: 'follows' }), false);
    for (const workspace of ['/repo', undefined]) {
      const skipped = await runPatternChecks(() => plain, [piece('refund')], { workspace, diff: { files: [], totalAdditions: 0, totalDeletions: 0 } });
      expect(skipped).toEqual({ findings: [], comparisons: [{ kind: 'pattern', reviewer: 'Pattern check: refund', at: ['src/refund.ts:1'], status: 'skipped' }] });
    }
    expect(plain.calls).toEqual([]);
  });
});
