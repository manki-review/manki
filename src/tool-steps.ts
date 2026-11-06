import { once } from 'events';
import { closeSync, openSync } from 'fs';
import { join } from 'path';

/** The argument of `dist/index.js` that runs the Claude CLI hook which counts tool steps, instead of a review. */
export const STEP_HOOK_COMMAND = 'step-hook';

/** How many tool steps before the end of its budget a model is told to wrap up. */
export const WRAP_UP_STEPS = 3;

/** What happens to one tool call: refused once the budget is used up, or run with a note to wrap up. */
export interface StepCheck {
  refusal?: string;
  note?: string;
}

/** Checks the tool call that takes step number `step` of a budget of `steps`. */
export function stepCheck(step: number, steps: number): StepCheck {
  if (step > steps) return { refusal: `Manki: all ${steps} tool steps are used, so this call did not run. Call no more tools and give your final answer now.` };
  if (step === steps - WRAP_UP_STEPS) return { note: `Manki: only ${WRAP_UP_STEPS} tool steps are left after this one. Finish the check you are on, then give your final answer.` };
  return {};
}

/**
 * Takes the next step number by creating a file named after it in `dir`. Creating a file fails when it exists, so two
 * hooks that run at the same time never get the same number.
 */
export function claimStep(dir: string): number {
  for (let step = 1; ; step++) {
    try {
      closeSync(openSync(join(dir, String(step)), 'wx'));
      return step;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/** Returns the PreToolUse hook output for a tool call, or an empty string to let it run unchanged. */
export function stepHookOutput(check: StepCheck): string {
  if (check.refusal) return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: check.refusal } });
  if (check.note) return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: check.note } });
  return '';
}

/**
 * Runs as the Claude CLI's PreToolUse hook: takes a step in `dir` and refuses the call or adds the wrap-up note.
 * A hook that fails lets the call run, and the CLI's turn limit still ends the call.
 */
export async function runStepHook(dir: string | undefined, steps: string | undefined): Promise<void> {
  process.stdin.resume();
  await once(process.stdin, 'end');
  const budget = Number(steps);
  if (!dir || !Number.isInteger(budget) || budget <= 0) {
    process.stderr.write(`Manki step hook: needs a directory and a step budget, got ${dir} and ${steps}\n`);
    process.exit(1);
  }
  process.stdout.write(stepHookOutput(stepCheck(claimStep(dir), budget)));
}
