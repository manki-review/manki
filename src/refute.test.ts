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
      'Lead unsettled': { outcome: 'unsettled', reason: 'Could not tell.' },
      'Failing': new Error('CLI crashed'),
    });
    const findings = [
      finding('Disproved'),
      finding('Confirmed'),
      finding('Confirmed without proof'),
      finding('Unsettled'),
      finding('Lead confirmed', { severity: 'warning', notChecked: true, lead }),
      finding('Lead unsettled', { notChecked: true, lead }),
      finding('Failing'),
      finding('A warning', { severity: 'warning' }),
      finding('Elsewhere', { file: 'src/missing.ts' }),
    ];

    const result = await refuteBlockers(client, findings, { workspace, effort: 'high' });

    expect(result.map(f => [f.title, f.severity, f.refutation?.outcome])).toEqual([
      ['Disproved', 'ignore', 'disproved'],
      ['Confirmed', 'blocker', 'confirmed'],
      ['Confirmed without proof', 'warning', 'unsettled'],
      ['Unsettled', 'warning', 'unsettled'],
      ['Lead confirmed', 'blocker', 'confirmed'],
      ['Lead unsettled', 'ignore', 'unsettled'],
      ['Failing', 'blocker', undefined],
      ['A warning', 'warning', undefined],
      // Its file is not in the workspace, so there is no code to check.
      ['Elsewhere', 'blocker', undefined],
    ]);
    expect(result[0].judgeNotes).toBe('Refutation disproved: Both inputs are checked at src/api.ts:9.');
    expect(result[1].evidence?.proof).toEqual(['src/math.ts:2', 'src/api.ts:4']);
    expect([result[4].lead, result[4].notChecked]).toEqual([undefined, undefined]);
    // Every blocker and lead was asked once, and the warning never.
    expect(client.calls.map(([title]) => title).sort()).toEqual(['Confirmed', 'Confirmed without proof', 'Disproved', 'Failing', 'Lead confirmed', 'Lead unsettled', 'Unsettled']);
    expect(client.calls[0][1]).toEqual({ effort: 'high', repoTools: { root: workspace, steps: 15 }, timeoutMs: 600_000 });
  });

  it('reuses the outcome an earlier round stored for the same finding while its file is unchanged', async () => {
    const client = fakeClient({ 'Sum overflows': { outcome: 'disproved', reason: 'Checked at src/api.ts:9.', proof: ['src/api.ts:9'] } });
    const [first] = await refuteBlockers(client, [finding('Sum overflows')], { workspace });
    const priorRounds = [{ findings: { entries: [] }, judge: { dropped: [{ title: 'Sum overflows', file: 'src/math.ts', line: 2, reviewers: ['R'], refutation: first.refutation }] } }] as unknown as RoundContext[];

    const [again] = await refuteBlockers(client, [finding('Sum overflows', { line: 3 })], { workspace, priorRounds });

    expect(client.calls).toHaveLength(1);
    expect([again.severity, again.refutation]).toEqual(['ignore', first.refutation]);

    writeFileSync(join(workspace, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    await refuteBlockers(client, [finding('Sum overflows')], { workspace, priorRounds });

    expect(client.calls).toHaveLength(2);
  });
});
