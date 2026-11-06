import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { LLMClient, SendMessageOptions } from './providers';
import { refuteBlockers } from './refute';
import { Finding, RoundContext } from './types';

jest.mock('@actions/core');

const finding = (title: string, overrides: Partial<Finding> = {}): Finding => ({
  severity: 'blocker', title, file: 'src/math.ts', line: 2, description: 'Large inputs overflow.', reviewers: ['R'],
  evidence: { checks: [], proof: ['src/math.ts:2'] }, ...overrides,
});

/** A client with tools that answers each finding, picked by its title in the user message, with a canned reply. */
function fakeClient(replies: Record<string, unknown>): LLMClient & { calls: [string, SendMessageOptions | undefined][] } {
  const calls: [string, SendMessageOptions | undefined][] = [];
  return {
    repoTools: true,
    calls,
    async sendMessage(_system, user, options) {
      const title = Object.keys(replies).find(t => user.includes(`: ${t}\n`))!;
      calls.push([title, options]);
      const reply = replies[title];
      if (reply instanceof Error) throw reply;
      return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) };
    },
  };
}

describe('refuteBlockers', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'manki-refute-'));
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    writeFileSync(join(workspace, 'src', 'api.ts'), `${'// handler\n'.repeat(8)}if (a > 1000 || b > 1000) throw new Error();\n`);
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('checks each blocker and open lead with 15 tool steps, and grades it by the outcome', async () => {
    const lead = { checked: 'read src/math.ts:2', left: 'find the callers' };
    const client = fakeClient({
      'Disproved': { outcome: 'disproved', reason: 'Both inputs are checked at src/api.ts:9.', proof: ['src/api.ts:9'] },
      'Confirmed': { outcome: 'confirmed', reason: 'Any caller can pass a huge number.', proof: ['src/math.ts:2', 'src/api.ts:4'] },
      'Confirmed without proof': { outcome: 'confirmed', reason: 'Trust me.' },
      'Unsettled': { outcome: 'unsettled', reason: 'The callers are generated.' },
      'Lead confirmed': { outcome: 'confirmed', reason: 'It overflows.', proof: ['src/math.ts:2'] },
      'Unproven lead confirmed': { outcome: 'confirmed', reason: 'It overflows.', proof: ['src/math.ts:2'] },
      'Unproven and contradicted': { outcome: 'confirmed', reason: 'It overflows.', proof: ['src/math.ts:2'] },
      'Disproved without proof': { outcome: 'disproved', reason: 'Probably fine.' },
      'Disproved on made-up lines': { outcome: 'disproved', reason: 'Checked elsewhere.', proof: ['src/gone.ts:1', 'src/api.ts:99'] },
      'Security disproved': { outcome: 'disproved', reason: 'A comment says it is intended.', proof: ['src/api.ts:9'] },
      'Lead unsettled': { outcome: 'unsettled', reason: 'Could not tell.' },
      'Failing': new Error('CLI crashed'),
    });
    const findings = [
      finding('Disproved'),
      finding('Confirmed'),
      finding('Confirmed without proof'),
      finding('Unsettled'),
      finding('Lead confirmed', { severity: 'warning', notChecked: true, lead }),
      finding('Unproven lead confirmed', { severity: 'warning', notChecked: true, lead, tags: ['unproven-blocker'] }),
      finding('Unproven and contradicted', { severity: 'nitpick', notChecked: true, lead, tags: ['unproven-blocker', 'contradicts-prior-round'] }),
      finding('Disproved without proof'),
      finding('Disproved on made-up lines'),
      finding('Security disproved', { tags: ['security'] }),
      finding('Lead unsettled', { notChecked: true, lead }),
      finding('Failing'),
      finding('A warning', { severity: 'warning' }),
      finding('Elsewhere', { file: 'src/missing.ts' }),
      finding('Dropped lead', { severity: 'ignore', notChecked: true, lead }),
    ];

    const result = await refuteBlockers(client, findings, { workspace, effort: 'high' });

    expect(result.map(f => [f.title, f.severity, f.refutation?.outcome])).toEqual([
      ['Disproved', 'ignore', 'disproved'],
      ['Confirmed', 'blocker', 'confirmed'],
      ['Confirmed without proof', 'warning', 'unsettled'],
      ['Unsettled', 'warning', 'unsettled'],
      // A confirmation keeps the grade the judge gave a lead, and lifts only the cap on an unproven blocker.
      ['Lead confirmed', 'warning', 'confirmed'],
      ['Unproven lead confirmed', 'blocker', 'confirmed'],
      // A cross-round contradiction lowered it after the cap, so the proving lines do not lift it.
      ['Unproven and contradicted', 'nitpick', 'confirmed'],
      ['Disproved without proof', 'warning', 'unsettled'],
      // A citation of a file the workspace lacks, or of a line past its end, settles nothing.
      ['Disproved on made-up lines', 'warning', 'unsettled'],
      // PR content the refuter reads could steer it, so only a confirmation changes a security finding.
      ['Security disproved', 'blocker', 'disproved'],
      ['Lead unsettled', 'ignore', 'unsettled'],
      ['Failing', 'blocker', undefined],
      ['A warning', 'warning', undefined],
      // Its file is not in the workspace, so there is no code to check.
      ['Elsewhere', 'blocker', undefined],
      // The judge or a suppression dropped it, so it is never checked or brought back.
      ['Dropped lead', 'ignore', undefined],
    ]);
    expect(result[0].judgeNotes).toBe('Refutation disproved: Both inputs are checked at src/api.ts:9.');
    expect(result[1].evidence?.proof).toEqual(['src/math.ts:2', 'src/api.ts:4']);
    expect([result[4].lead, result[4].notChecked]).toEqual([undefined, undefined]);
    expect(result[5].tags).toEqual([]);
    // Every blocker and lead was asked once, and the warning never.
    expect(client.calls.map(([title]) => title).sort()).toEqual(['Confirmed', 'Confirmed without proof', 'Disproved', 'Disproved on made-up lines', 'Disproved without proof', 'Failing', 'Lead confirmed', 'Lead unsettled', 'Security disproved', 'Unproven and contradicted', 'Unproven lead confirmed', 'Unsettled']);
    expect(client.calls[0][1]).toEqual({ effort: 'high', repoTools: { root: workspace, steps: 15 }, timeoutMs: 600_000 });
  });

  it('reuses the outcome an earlier round stored for the same finding while every file it rests on is unchanged', async () => {
    writeFileSync(join(workspace, 'src', 'api.ts'), 'if (a > 1000) throw new Error();\n');
    const client = fakeClient({ 'Sum overflows': { outcome: 'disproved', reason: 'Checked at src/api.ts:1.', proof: ['src/api.ts:1'] } });
    const [first] = await refuteBlockers(client, [finding('Sum overflows')], { workspace });
    const priorRounds = [{ findings: { entries: [] }, judge: { dropped: [{ title: 'Sum overflows', file: 'src/math.ts', line: 2, reviewers: ['R'], refutation: first.refutation }] } }] as unknown as RoundContext[];
    const calls = async () => {
      await refuteBlockers(client, [finding('Sum overflows', { line: 3 })], { workspace, priorRounds });
      return client.calls.length;
    };

    expect(first.refutation?.files).toEqual(['src/api.ts', 'src/math.ts']);
    const [again] = await refuteBlockers(client, [finding('Sum overflows', { line: 3 })], { workspace, priorRounds });
    expect([client.calls.length, again.severity, again.refutation]).toEqual([1, 'ignore', first.refutation]);

    // A change to the file that holds the check the outcome cites forces a new check, like a change to the finding's file.
    writeFileSync(join(workspace, 'src', 'api.ts'), '// the check is gone\n');
    expect(await calls()).toBe(2);
  });

  it('reuses an outcome only for a finding near the same line whose cited files it covers', async () => {
    const client = fakeClient({ 'Sum overflows': { outcome: 'disproved', reason: 'Checked at src/api.ts:9.', proof: ['src/api.ts:9'] } });
    const [first] = await refuteBlockers(client, [finding('Sum overflows')], { workspace });
    const priorRounds = [{ findings: { entries: [] }, judge: { dropped: [{ title: 'Sum overflows', file: 'src/math.ts', line: 2, reviewers: ['R'], refutation: first.refutation }] } }] as unknown as RoundContext[];
    writeFileSync(join(workspace, 'src', 'other.ts'), 'export const x = 1;\n');

    await refuteBlockers(client, [finding('Sum overflows', { line: 40 })], { workspace, priorRounds });
    await refuteBlockers(client, [finding('Sum overflows', { evidence: { checks: [], proof: ['src/math.ts:2', 'src/other.ts:1'] } })], { workspace, priorRounds });

    expect(client.calls).toHaveLength(3);
  });
});
