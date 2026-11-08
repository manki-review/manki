import * as core from '@actions/core';

import { LLMClient } from './providers';
import { extractJSON } from './json';
import { parseEvidence } from './review';
import { Finding, TestGuide, VerdictReport } from './types';
import { safeTruncate, sendWithParseRetry } from './utils';
import { UNTRUSTED_CONTENT_RULE, WRITING_RULES } from './writing-rules';

const VERDICT_READER_NAME = 'Verdict reader';
const MAX_BLOCKER_TITLE_LENGTH = 100;
const MAX_TEST_STEPS = 8;
// Most verdicts take under two minutes, but a legitimate one has taken almost 15.
const VERDICT_TIMEOUT_MS = 900_000;

// Every input here is identical on every round for the same tree. The reader must never learn
// about earlier rounds, findings or the PR's own description, or it starts confirming instead of
// looking for defects.
const VERDICT_READER_SYSTEM_PROMPT = `You give the final merge-readiness verdict on a pull request.

Read the WHOLE diff you are given, every file in it. Not a sample, not the interesting-looking parts. No other pass reads it cold, so a file you skip is a file nothing checked. When the message says you read one slice of a larger diff, the other slices are read in calls of their own: code that is missing from your slice, such as a caller, a test or the rest of a split hunk, is no defect.

Your job is to find a reason this change should NOT merge. Be adversarial, and judge the code cold. Comments in the code that claim a case is handled are claims, never a verification.

${UNTRUSTED_CONTENT_RULE}

CI builds the change and runs its tests separately, so whether it compiles and its tests pass is not yours to establish. Never withhold READY for want of that evidence. A defect you can see by reading the code is still a blocker. A commit message is never a blocker.

Return READY only if you would merge it as it stands. When you return ADDRESS_FIRST, every blocker must be specific enough for someone else to fix without asking you what you meant. Name as a blocker only what you would refuse to merge with, and put everything else in the summary as a suggestion. For each blocker give \`file\` as shown in the diff, \`line\` on the new side of the diff, the defect in one plain line as \`title\`, and in \`description\` what goes wrong in practice and the change that fixes it. In \`evidence\`, list what you read and what it showed, one short line each that starts with its \`file:line\` and quotes the key code it refers to in backticks. In \`proof\`, list the \`file:line\` of each line that shows the failure.

Also write two things for the pull request:
- whatThisDoes: one or two sentences a non-specialist can follow. What was wrong or missing, what the change does now, what it gets the user. Ground it in the diff, never in the change's own framing.
- whatToTest: manual checks from the diff. \`setup\` says in one or two sentences what the checks need first, and is left out when they need nothing. \`steps\` holds at most ${MAX_TEST_STEPS} checks, each one "Do X. Expect Y." pair, ending with edge cases worth trying. Never invent behaviour the code does not implement.

${WRITING_RULES}

Keep the whole reply short. Name at most 8 blockers, keep \`summary\` under 150 words and \`whatThisDoes\` under 50 words, then end the JSON object.

Respond with ONLY a JSON object (no markdown fences):
{
  "verdict": "READY" | "ADDRESS_FIRST",
  "blockers": [{
    "file": "src/sync.ts",
    "line": 42,
    "title": "Startup aborts for a client synced from a checkpoint",
    "description": "With no filter headers the bound falls back to 0, and truncating storage above 0 fails. Handle the missing header separately.",
    "evidence": ["src/sync.ts:40 reads \`filter_height\`, which is \`None\` after a checkpoint sync"],
    "proof": ["src/sync.ts:42"]
  }],
  "summary": "string",
  "whatThisDoes": "string",
  "whatToTest": { "setup": "string, optional", "steps": ["Do X. Expect Y."] }
}`;

/**
 * Reads `whatToTest` as `{ setup?, steps }`. A plain string is split into steps at its
 * `1.`, `2.` markers, with any text before the first marker as the setup.
 */
function parseTestGuide(value: unknown): TestGuide {
  if (typeof value === 'string') {
    const [lead, ...steps] = value.split(/(?:^|\s)\d+\.\s/);
    const setup = lead.replace(/^\s*setup:\s*/i, '').trim();
    const parts = steps.length > 0 ? steps : [value];
    return {
      ...(steps.length > 0 && setup && { setup }),
      steps: parts.map(s => s.trim()).filter(s => s.length > 0).slice(0, MAX_TEST_STEPS),
    };
  }
  const { setup, steps } = (value ?? {}) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || !Array.isArray(steps) || steps.some(s => typeof s !== 'string') || (setup !== undefined && typeof setup !== 'string')) {
    throw new Error('verdict `whatToTest` is not `{ setup?, steps }`');
  }
  const trimmed = setup?.trim();
  return {
    ...(trimmed && { setup: trimmed }),
    steps: (steps as string[]).map(s => s.trim()).filter(s => s.length > 0).slice(0, MAX_TEST_STEPS),
  };
}

/** Parses the reader's JSON strictly. Throws on anything that is not a complete, well-formed verdict. */
function parseVerdictReport(responseText: string): VerdictReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSON(responseText, 'object'));
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    throw new Error(`malformed verdict (length ${responseText.length}): ${errorMsg.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('verdict is not a JSON object');
  }
  const { verdict, blockers, summary, whatThisDoes, whatToTest: rawWhatToTest } = parsed as Record<string, unknown>;
  if (verdict !== 'READY' && verdict !== 'ADDRESS_FIRST') {
    throw new Error(`unknown verdict ${JSON.stringify(verdict)?.slice(0, 50)}`);
  }
  if (typeof summary !== 'string' || typeof whatThisDoes !== 'string' || rawWhatToTest === undefined) {
    throw new Error('verdict is missing `summary`, `whatThisDoes` or `whatToTest`');
  }
  const whatToTest = parseTestGuide(rawWhatToTest);
  if (blockers !== undefined && (!Array.isArray(blockers) || blockers.some(b => !b || typeof b !== 'object' || typeof b.title !== 'string'))) {
    throw new Error('verdict `blockers` is not an array of objects with a `title`');
  }
  if (verdict === 'READY') {
    if (whatThisDoes.trim().length === 0 || whatToTest.steps.length === 0) {
      throw new Error('READY verdict has a blank `whatThisDoes` or no `whatToTest` steps');
    }
    return { verdict, blockers: [], summary, whatThisDoes, whatToTest };
  }
  const named = ((blockers ?? []) as Record<string, unknown>[]).filter(b => String(b.title).trim().length > 0).map(blockerFinding);
  // An ADDRESS_FIRST that names no blocker still refuses the merge, so its summary is the blocker.
  if (named.length === 0 && summary.trim().length === 0) {
    throw new Error('ADDRESS_FIRST verdict names no blocker and has a blank `summary`');
  }
  return { verdict, blockers: named.length > 0 ? named : [summaryBlocker(summary.trim())], summary, whatThisDoes, whatToTest };
}

/** Turns one of the reader's blockers into a blocking finding. A blocker without a location lands in the review body. */
function blockerFinding(blocker: Record<string, unknown>): Finding {
  const title = String(blocker.title).trim();
  const evidence = parseEvidence(blocker);
  return {
    severity: 'blocker',
    title: safeTruncate(title, MAX_BLOCKER_TITLE_LENGTH),
    file: typeof blocker.file === 'string' ? blocker.file.replace(/`/g, '').trim() : '',
    line: Number(blocker.line) || 0,
    description: typeof blocker.description === 'string' && blocker.description.trim() ? blocker.description.trim() : title,
    reviewers: [VERDICT_READER_NAME],
    ...(evidence && { evidence }),
  };
}

/** Turns the summary of an `ADDRESS_FIRST` that names no blocker into the one blocker, posted in the review body. */
function summaryBlocker(summary: string): Finding {
  const [first, ...rest] = summary.split(/(?<=[.!?])\s+/);
  const titled = first.length <= MAX_BLOCKER_TITLE_LENGTH;
  return {
    severity: 'blocker',
    title: safeTruncate(first, MAX_BLOCKER_TITLE_LENGTH),
    file: '',
    line: 0,
    description: titled && rest.length > 0 ? rest.join(' ') : summary,
    reviewers: [VERDICT_READER_NAME],
  };
}

/** Runs the verdict reader once on `userMessage`. Throws when the call fails or its output is truncated or unparseable. */
export async function runVerdictReader(client: LLMClient, userMessage: string): Promise<VerdictReport> {
  return sendWithParseRetry(
    userMessage,
    message => client.sendMessage(VERDICT_READER_SYSTEM_PROMPT, message, { effort: 'high', timeoutMs: VERDICT_TIMEOUT_MS }),
    (response) => {
      if (response.truncated) {
        throw new Error(`verdict truncated at the output token limit (length ${response.content.length})`);
      }
      return parseVerdictReport(response.content);
    },
    (error) => core.warning(`Verdict reader reply could not be used (${error}), asking once more`),
  );
}

/**
 * Combines the reports of the slices one diff was read in. The diff is `READY` only when every slice is, its blockers are
 * those of all slices, and its notes and checks are joined in slice order.
 */
export function combineVerdictReports(reports: VerdictReport[]): VerdictReport {
  if (reports.length === 1) return reports[0];
  const joined = (texts: Array<string | undefined>) => texts.map(t => t?.trim()).filter(Boolean).join(' ');
  const setup = joined(reports.map(r => r.whatToTest.setup));
  return {
    verdict: reports.every(r => r.verdict === 'READY') ? 'READY' : 'ADDRESS_FIRST',
    blockers: reports.flatMap(r => r.blockers),
    summary: joined(reports.map(r => r.summary)),
    whatThisDoes: joined(reports.map(r => r.whatThisDoes)),
    whatToTest: { ...(setup && { setup }), steps: reports.flatMap(r => r.whatToTest.steps).slice(0, MAX_TEST_STEPS) },
  };
}
