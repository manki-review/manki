import * as core from '@actions/core';

import { fenceText } from './github';
import { LLMClient, SendMessageOptions } from './providers';
import { CLAIMS_MISSING_RULE, parseFindings, PRE_EXISTING_RULE } from './review';
import { CodeExcerpt, LimitQuestion, SiblingFieldQuestion, SiblingImplementationQuestion, SiblingQuestions } from './symbol-uses';
import { EffortLevel, Finding, RelatedRepoTools, RoundComparison } from './types';
import { mapWithConcurrency, sendWithParseRetry } from './utils';
import { UNTRUSTED_CONTENT_RULE, VERIFY_CLAIMS_RULE, WRITING_RULES } from './writing-rules';

const MAX_FIELD_QUESTIONS = 6;
const MAX_IMPLEMENTATION_QUESTIONS = 6;
const MAX_LIMIT_QUESTIONS = 4;
const MAX_PARALLEL_QUESTIONS = 4;
const COMPARE_STEPS = 12;
// A safety net. The step budget is what normally ends the call.
const COMPARE_TIMEOUT_MS = 600_000;

function systemPrompt(tools: boolean): string {
  return `You compare code a pull request changes with the code beside it, to answer one question. Other reviewers read the whole change, so report only defects that answer this question.

Respond with ONLY a JSON array (no markdown fences, no explanation), one entry per defect:

[{"severity": "blocker" | "warning" | "suggestion", "title": "The defect in one plain line", "file": "path/to/file.ext", "line": <line number in the NEW file>, "description": "At most three sentences: what goes wrong in practice, the decisive evidence, and the change that fixes it.", "evidence": ["file:line, then what you read there and what it showed, quoting the key code in backticks"], "proof": ["file:line of each line that shows the failure"]}]

- **blocker**: wrong results, lost data, a crash or a security hole. List in \`proof\` the \`file:line\` of each line that shows the failure.
- **warning**: a real case that fails, but not catastrophically.
- **suggestion**: an inconsistency that works today.
- Put each defect on the line that needs the fix, in the changed code where you can.
- When the answer is no, or the code already handles the case, respond with [].
- ${CLAIMS_MISSING_RULE}
- ${PRE_EXISTING_RULE}${tools ? `
- You can read the repository with read-only tools. Check the code your answer rests on before you report it.` : ''}
- ${UNTRUSTED_CONTENT_RULE}
- ${VERIFY_CLAIMS_RULE}

${WRITING_RULES}`;
}

// A path comes from the PR, so it is only ever written inside a fence.
function fenceExcerpt({ file, code }: CodeExcerpt): string {
  return fenceText(`${file}\n${code}`, (file.split('.').pop() || '').replace(/[^\w+#-]/g, ''));
}

const MARKS_NOTE = 'Each block starts with the path of its file. Each line after it starts with its line number in the head commit, and a `+` after the number marks a line the PR adds.';

function fieldMessage(q: SiblingFieldQuestion, tools: boolean): string {
  const read = tools ? ` Read where \`${q.sibling}\` is written before you answer.` : '';
  return `## Question

The change looks up \`${q.item}\` in \`${q.field}\` of \`${q.struct}\`, on the first line below. Can \`${q.item}\` be held in \`${q.sibling}\` instead? If so, does the change handle it?${read}

The changed lines that use \`${q.field}\`:

${fenceText(q.lookups.map(l => `${l.file}:${l.line}: ${l.text}`).join('\n'))}

## \`${q.struct}\`

${MARKS_NOTE}

${fenceExcerpt(q.definition)}

## Changed Hunks

${q.hunks.map(h => fenceText(h, 'diff')).join('\n\n')}`;
}

function implementationMessage(q: SiblingImplementationQuestion): string {
  const what = q.trait ? `These functions implement \`${q.trait}::${q.name}\` on sibling types.` : `Each of these sibling types has its own \`${q.name}\` function.`;
  const members = q.members.map(m => `### \`${m.owner}\`${m.changed ? ' (changed by the PR)' : ''}\n\n${fenceExcerpt(m)}`);
  return `## Question

${what} List every check, guard, version test, bound, error or event one has and another lacks. Report each gap that is a defect, on the function that lacks it. A difference the types themselves explain, such as a field only one type has, is no defect.

${MARKS_NOTE}

${members.join('\n\n')}`;
}

function limitMessage(q: LimitQuestion, reference: boolean): string {
  const change = q.previous ? `lowers the limit \`${q.name}\` from \`${q.previous}\` to \`${q.value}\`` : `adds the limit \`${q.name}\` at \`${q.value}\``;
  return `## Question

The change ${change}, on the line below. Which code produces the values this limit checks, and how large can they get? Search this repository${reference ? ' and the reference repositories' : ''} for every producer, above all one that does not check the limit itself before it sends, stores or waits. Report each producer that can exceed the new limit, on the changed line, and cite the line that produces the value.

The changed line:

${fenceText(`${q.file}:${q.line}: ${q.text}`)}

## Changed Hunk

${fenceText(q.hunk, 'diff')}`;
}

/** Appends ` #2`, ` #3` and so on to a name already taken, so each question's findings name it alone. */
function uniqueNames(labels: string[]): string[] {
  const taken = new Set<string>();
  return labels.map(label => {
    let name = label;
    for (let n = 2; taken.has(name); n++) name = `${label} #${n}`;
    taken.add(name);
    return name;
  });
}

interface Question {
  kind: RoundComparison['kind'];
  reviewer: string;
  at: string[];
  message: (tools: boolean) => string;
}

function questionsOf(siblings: SiblingQuestions, reference: boolean): Question[] {
  const labels = [
    ...siblings.fields.map(q => `Sibling field: ${q.field} vs ${q.sibling}`),
    ...siblings.implementations.map(q => `Sibling code: ${q.trait ? `${q.trait}::` : ''}${q.name}`),
    ...siblings.limits.map(q => `Limit producers: ${q.name}`),
  ];
  const names = uniqueNames(labels);
  const limitsAt = siblings.fields.length + siblings.implementations.length;
  return [
    ...siblings.fields.map((q, i): Question => ({
      kind: 'field', reviewer: names[i], at: [`${q.lookups[0].file}:${q.lookups[0].line}`], message: tools => fieldMessage(q, tools),
    })),
    ...siblings.implementations.map((q, i): Question => ({
      kind: 'implementations', reviewer: names[siblings.fields.length + i], at: q.members.map(m => `${m.file}:${m.line}`), message: () => implementationMessage(q),
    })),
    ...siblings.limits.map((q, i): Question => ({
      kind: 'limit', reviewer: names[limitsAt + i], at: [`${q.file}:${q.line}`], message: () => limitMessage(q, reference),
    })),
  ];
}

export interface ComparisonOptions {
  effort?: EffortLevel;
  /** The checked-out PR head, which a client with `repoTools` reads with read-only tools. */
  workspace?: string;
  /** Stops the questions still running or not yet asked, which are then recorded as `timed_out`. */
  signal?: AbortSignal;
  /** The related repos a limit question may also read with the repository tools. */
  related?: RelatedRepoTools;
}

/**
 * Asks one call per sibling question, at most `MAX_FIELD_QUESTIONS` field, `MAX_IMPLEMENTATION_QUESTIONS`
 * implementation and `MAX_LIMIT_QUESTIONS` limit questions, `MAX_PARALLEL_QUESTIONS` at a time, each on the client
 * `clientFor` returns for its reviewer name. A limit question is asked only when that client can read the repository,
 * since only the code says who produces the values. Returns their findings, which carry that name, and a record of every
 * question asked or cut, the ones past the caps as `cut`. A call that fails is recorded as `failed`, and one `signal`
 * stopped as `timed_out`. It never throws.
 */
export async function runComparisons(
  clientFor: (reviewer: string) => LLMClient, siblings: SiblingQuestions, { effort, workspace, signal, related }: ComparisonOptions = {},
): Promise<{ findings: Finding[]; comparisons: RoundComparison[] }> {
  const questions = questionsOf(siblings, !!related?.repos.some(r => r.kind === 'reference'));
  const clients = new Map<string, LLMClient>();
  const clientOf = (q: Question) => clients.get(q.reviewer) ?? clients.set(q.reviewer, clientFor(q.reviewer)).get(q.reviewer)!;
  const fields = questions.filter(q => q.kind === 'field');
  const implementations = questions.filter(q => q.kind === 'implementations');
  const limits = questions.filter(q => q.kind === 'limit' && !!workspace && !!clientOf(q).repoTools);
  const asked = [...fields.slice(0, MAX_FIELD_QUESTIONS), ...implementations.slice(0, MAX_IMPLEMENTATION_QUESTIONS), ...limits.slice(0, MAX_LIMIT_QUESTIONS)];
  const cut = [...fields.slice(MAX_FIELD_QUESTIONS), ...implementations.slice(MAX_IMPLEMENTATION_QUESTIONS), ...limits.slice(MAX_LIMIT_QUESTIONS)];
  if (asked.length > 0) core.info(`Asking ${asked.length} sibling comparison question(s)${cut.length > 0 ? `, ${cut.length} cut by the cap` : ''}`);
  const answers = await mapWithConcurrency(asked, MAX_PARALLEL_QUESTIONS, async (q): Promise<{ record: RoundComparison; findings: Finding[] }> => {
    const client = clientOf(q);
    const tools = !!workspace && !!client.repoTools;
    const record = { kind: q.kind, reviewer: q.reviewer, at: q.at };
    if (signal?.aborted) return { record: { ...record, status: 'timed_out' }, findings: [] };
    const options: SendMessageOptions = {
      ...(effort && { effort }),
      ...(signal && { signal }),
      ...(tools && { repoTools: { root: workspace!, steps: COMPARE_STEPS, ...(q.kind === 'limit' && related && { related }) }, timeoutMs: COMPARE_TIMEOUT_MS }),
    };
    try {
      const findings = await sendWithParseRetry(
        q.message(tools),
        message => client.sendMessage(systemPrompt(tools), message, options),
        reply => {
          if (reply.truncated) throw new Error(`response truncated at the output token limit (length ${reply.content.length})`);
          return parseFindings(reply.content, q.reviewer);
        },
        error => core.warning(`${q.reviewer} reply could not be used (${error}), asking once more`),
        'array',
      );
      core.info(`${q.reviewer}: ${findings.length} finding(s)`);
      return { record: { ...record, status: 'answered', findings: findings.length }, findings };
    } catch (error) {
      if (signal?.aborted) {
        core.warning(`${q.reviewer} was still running when the round stopped waiting, so its question goes unanswered this round`);
        return { record: { ...record, status: 'timed_out' }, findings: [] };
      }
      core.warning(`${q.reviewer} failed, so its question goes unanswered this round: ${error}`);
      return { record: { ...record, status: 'failed' }, findings: [] };
    }
  });
  return {
    findings: answers.flatMap(a => a.findings),
    comparisons: [...answers.map(a => a.record), ...cut.map(q => ({ kind: q.kind, reviewer: q.reviewer, at: q.at, status: 'cut' as const }))],
  };
}
