import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, Readable } from 'stream';

import { claimStep, runStepHook, stepCheck, stepHookOutput } from './tool-steps';

describe('tool steps', () => {
  it('lets the calls of the budget run, adds the wrap-up note 3 steps before its end, and refuses every later call', () => {
    const checks = [1, 2, 4, 5, 8, 9, 12].map(step => stepCheck(step, 8));
    expect(checks.map(c => [!!c.note, !!c.refusal])).toEqual([[false, false], [false, false], [false, false], [true, false], [false, false], [false, true], [false, true]]);

    expect(stepHookOutput({})).toBe('');
    expect(JSON.parse(stepHookOutput(stepCheck(5, 8)))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('only 3 tool steps are left') } });
    // A refused call is denied, never allowed: an allow would skip the CLI's own permission checks.
    expect(JSON.parse(stepHookOutput(stepCheck(9, 8)))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('all 8 tool steps are used') },
    });
  });

  it('runs as a hook: reads the input, then answers for the next step of the call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manki-steps-'));
    const hook = async (steps: string) => {
      const output = new PassThrough();
      await runStepHook(dir, steps, Readable.from(['{"tool_name":"Read"}']), output);
      return String(output.read() ?? '');
    };
    try {
      expect([await hook('4'), await hook('4'), await hook('4'), await hook('4')].map(o => o && JSON.parse(o).hookSpecificOutput))
        .toEqual([{ hookEventName: 'PreToolUse', additionalContext: expect.any(String) }, '', '', '']);
      expect(JSON.parse(await hook('4')).hookSpecificOutput.permissionDecision).toBe('deny');
      await expect(hook('none')).rejects.toThrow('Manki step hook needs a directory and a step budget');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('numbers the steps of each call from 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manki-steps-'));
    const other = mkdtempSync(join(tmpdir(), 'manki-steps-'));
    try {
      expect([claimStep(dir), claimStep(dir), claimStep(other), claimStep(dir)]).toEqual([1, 2, 1, 3]);
      expect(() => claimStep(join(dir, 'missing'))).toThrow('ENOENT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
