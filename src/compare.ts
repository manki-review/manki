import * as core from '@actions/core';

import { fenceText } from './github';
import { extractJSON } from './json';
import { LLMClient, SendMessageOptions } from './providers';
import { repoTools } from './related-repos';
import { shownLines } from './refute';
import { isUsableElement, parseFindings } from './review';
import { CodeExcerpt, RelatedQuestion, SiblingFieldQuestion, SiblingImplementationQuestion, SiblingQuestions } from './symbol-uses';
import { CheckProgress, EffortLevel, Finding, RelatedRepoKind, RelatedRepoTools, RoundComparison } from './types';
import { mapWithConcurrency, sendWithParseRetry } from './utils';
import { CLAIMS_MISSING_RULE, PRE_EXISTING_RULE, RELATED_REPO_TRUST_RULE, UNTRUSTED_CONTENT_RULE, VERIFY_CLAIMS_RULE, WRITING_RULES } from './writing-rules';

const MAX_FIELD_QUESTIONS = 6;
const MAX_IMPLEMENTATION_QUESTIONS = 6;
/** Related repo counterparts checked in a round, the ones the diff changes most first. */
const MAX_RELATED_QUESTIONS = 8;
const MAX_PARALLEL_QUESTIONS = 4;
const COMPARE_STEPS = 12;
// A safety net. With tools, the step budget is what normally ends the call.
const COMPARE_TIMEOUT_MS = 600_000;

const SEVERITY_RULES = `- **blocker**: wrong results, lost data, a crash or a security hole. List in \`proof\` the \`file:line\` of each line that shows the failure.
- **warning**: a real case that fails, but not catastrophically. List its proving lines in \`proof\` too.
- **note**: an inconsistency that works today.`;

function systemPrompt(tools: boolean): string {
  return `You compare code a pull request changes with the code beside it, to answer one question. Other reviewers read the whole change, so report only defects that answer this question.

Respond with ONLY a JSON array (no markdown fences, no explanation), one entry per defect:

[{"severity": "blocker" | "warning" | "note", "title": "The defect in one plain line", "file": "path/to/file.ext", "line": <line number in the NEW file>, "description": "At most three sentences: what goes wrong in practice and the decisive evidence.", "howToFix": "The change that fixes it, in one or two sentences", "evidence": ["file:line, then what you read there and what it showed, quoting the key code in backticks"], "proof": ["file:line of each line that shows the failure"]}]

${SEVERITY_RULES}
- Put each defect on the line that needs the fix, in the changed code where you can.
- When the answer is no, or the code already handles the case, respond with [].
- ${CLAIMS_MISSING_RULE}
- ${PRE_EXISTING_RULE}${tools ? `
- You can read the repository with read-only tools. Check the code your answer rests on before you report it.` : ''}
- ${UNTRUSTED_CONTENT_RULE}
- ${VERIFY_CLAIMS_RULE}

${WRITING_RULES}`;
}

const RELATED_SYSTEM_PROMPT = `You check a pull request's change against one counterpart in a related repository: a reference it implements, a consumer that uses it, or a dependency it relies on. Other reviewers read the whole change, so report only defects that answer this question.

Respond with ONLY a JSON array (no markdown fences, no explanation), one entry per defect:

[{"severity": "blocker" | "warning" | "note", "title": "The defect in one plain line", "file": "path/to/file.ext", "line": <line number in the NEW file of the PR>, "description": "At most three sentences: what goes wrong in practice and the decisive evidence.", "howToFix": "The change that fixes it, in one or two sentences", "evidence": ["file:line or owner/name:path:line, then what you read there and what it showed, quoting the key code in backticks"], "proof": ["file:line of the PR's head commit", "owner/name:path:line of the related repo"]}]

${SEVERITY_RULES}
- Put each defect on the line of the PR that needs the fix.
- Every defect cites a line on both sides in \`proof\`: at least one \`file:line\` of the PR's head commit and one \`owner/name:path:line\` of the related repo, each a line you read. A defect without both is dropped.
- When the answer is no, when the code on both sides agrees, or when you could not open the counterpart, respond with [].
- ${CLAIMS_MISSING_RULE}
- ${PRE_EXISTING_RULE}
- You can read the repository and the related repos with read-only tools. Check the code your answer rests on before you report it.
- ${RELATED_REPO_TRUST_RULE}
- ${UNTRUSTED_CONTENT_RULE}
- ${VERIFY_CLAIMS_RULE}

${WRITING_RULES}`;

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

/** Appends ` #2`, ` #3` and so on to a name already taken, so each question's findings name it alone. */
export function uniqueNames(labels: string[]): string[] {
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

function questionsOf(siblings: SiblingQuestions): Question[] {
  const labels = [
    ...siblings.fields.map(q => `Sibling field: ${q.field} vs ${q.sibling}`),
    ...siblings.implementations.map(q => `Sibling code: ${q.trait ? `${q.trait}::` : ''}${q.name}`),
  ];
  const names = uniqueNames(labels);
  return [
    ...siblings.fields.map((q, i): Question => ({
      kind: 'field', reviewer: names[i], at: [`${q.lookups[0].file}:${q.lookups[0].line}`], message: tools => fieldMessage(q, tools),
    })),
    ...siblings.implementations.map((q, i): Question => ({
      kind: 'implementations', reviewer: names[siblings.fields.length + i], at: q.members.map(m => `${m.file}:${m.line}`), message: () => implementationMessage(q),
    })),
  ];
}

/** What a counterpart's call is titled, asked, and shown of each kind of related repo. */
const RELATED_KINDS: Record<RelatedRepoKind, { label: string; title: string; task: (name: string) => string }> = {
  reference: {
    label: 'Reference check', title: 'Reference',
    task: name => `The change touches \`${name}\`, and the lines below are where the reference repo holds it. Compare what the change does with what the reference does, in both directions: what the reference checks, handles, emits or rejects that the change does not, and what the change does that the reference does not. Report each difference that is a defect in the change.`,
  },
  consumer: {
    label: 'Consumer check', title: 'Consumer',
    task: name => `The change touches \`${name}\`, and the consumer repo uses it on the lines below. Check that each use still works with the change: what it passes, the fields and values it reads, the format it parses and the errors it expects. Report each use the change breaks.`,
  },
  dependency: {
    label: 'Dependency check', title: 'Dependency',
    task: name => `The change calls or reads \`${name}\`, and the dependency repo holds it on the lines below. Check each assumption the change makes about it against that code: its arguments, return value, errors, units, ordering and side effects. Report each assumption the code does not keep.`,
  },
};

function relatedMessage(q: RelatedQuestion): string {
  const { title, task } = RELATED_KINDS[q.kind];
  const guessed = q.as?.length ? ' Some lines were found by a guess at what that repo calls the name, so check that a line is the counterpart before you use it.' : '';
  const more = q.notShown ? `\n\n${q.notShown} more ${q.notShown === 1 ? 'line' : 'lines'} not shown.` : '';
  const hunks = q.hunks.length > 0 ? `\n\n## Changed Hunks\n\n${q.hunks.map(h => fenceText(h, 'diff')).join('\n\n')}` : '';
  return `## Question

${task(q.name)} Open the counterpart's file with your tools before you answer.${guessed}

## In the ${title} Repo

Each line starts with \`owner/name:path:line\` and is quoted from the related repo's fetched commit. ${RELATED_REPO_TRUST_RULE}

${fenceText(q.quoted.join('\n'))}${more}${hunks}`;
}

function relatedQuestionsOf(questions: readonly RelatedQuestion[]): Question[] {
  const names = uniqueNames(questions.map(q => `${RELATED_KINDS[q.kind].label}: ${q.name}`));
  return questions.map((q, i) => ({ kind: q.kind, reviewer: names[i], at: q.lines, message: () => relatedMessage(q) }));
}

export interface ComparisonOptions {
  effort?: EffortLevel;
  /** The checked-out PR head, which a client with `repoTools` reads with read-only tools. */
  workspace?: string;
  /** The round's related repos, which the tools also read. */
  related?: RelatedRepoTools;
  /** Stops the questions still running or not yet asked, which are then recorded as `timed_out`. */
  signal?: AbortSignal;
  /** Hears how many questions are asked and the findings of each answer. A question skipped for want of tools made no call. */
  progress?: CheckProgress<number>;
}

/** How a step asks its questions: what its log calls them, its system prompt, how it reads a reply, and whether a call needs repository tools. */
interface Asking {
  what: string;
  system: (tools: boolean) => string;
  parse: (content: string, reviewer: string) => { findings: Finding[]; dropped?: number };
  needsTools?: boolean;
}

type Answers = { findings: Finding[]; comparisons: RoundComparison[] };

/**
 * Asks one call per question of `asked`, `MAX_PARALLEL_QUESTIONS` at a time, each on the client `clientFor` returns for
 * its reviewer name, and records each of `cut` as cut. A call that fails is recorded as `failed`, one `signal` stopped
 * as `timed_out`, and with `needsTools` one whose client has no repository tools as `skipped`. It never throws.
 */
async function ask(
  clientFor: (reviewer: string) => LLMClient, asked: Question[], cut: Question[], { effort, workspace, related, signal, progress }: ComparisonOptions, { what, system, parse, needsTools }: Asking,
): Promise<Answers> {
  if (asked.length > 0) core.info(`Asking ${asked.length} ${what} question(s)${cut.length > 0 ? `, ${cut.length} cut by the cap` : ''}`);
  progress?.started(asked.length);
  const answers = await mapWithConcurrency(asked, MAX_PARALLEL_QUESTIONS, async (q): Promise<{ record: RoundComparison; findings: Finding[] }> => {
    const client = clientFor(q.reviewer);
    const tools = !!workspace && !!client.repoTools;
    const record = { kind: q.kind, reviewer: q.reviewer, at: q.at };
    if (needsTools && !tools) return { record: { ...record, status: 'skipped' }, findings: [] };
    if (signal?.aborted) return { record: { ...record, status: 'timed_out' }, findings: [] };
    const options: SendMessageOptions = {
      ...(effort && { effort }),
      ...(signal && { signal }),
      timeoutMs: COMPARE_TIMEOUT_MS,
      ...(tools && { repoTools: repoTools(workspace!, COMPARE_STEPS, related) }),
    };
    try {
      const { findings, dropped } = await sendWithParseRetry(
        q.message(tools),
        message => client.sendMessage(system(tools), message, options),
        reply => {
          if (reply.truncated) throw new Error(`response truncated at the output token limit (length ${reply.content.length})`);
          return parse(reply.content, q.reviewer);
        },
        error => core.warning(`${q.reviewer} reply could not be used (${error}), asking once more`),
        'array',
      );
      core.info(`${q.reviewer}: ${findings.length} finding(s)${dropped ? `, ${dropped} dropped without a cited line on both sides` : ''}`);
      return { record: { ...record, status: 'answered', findings: findings.length, ...(dropped && { dropped }) }, findings };
    } catch (error) {
      if (signal?.aborted) {
        core.warning(`${q.reviewer} was still running when the round stopped waiting, so its question goes unanswered this round`);
        return { record: { ...record, status: 'timed_out' }, findings: [] };
      }
      core.warning(`${q.reviewer} failed, so its question goes unanswered this round: ${error}`);
      return { record: { ...record, status: 'failed' }, findings: [] };
    }
  }, ({ record, findings }) => progress?.ended(record.status === 'skipped' ? undefined : findings.length));
  return {
    findings: answers.flatMap(a => a.findings),
    comparisons: [...answers.map(a => a.record), ...cut.map(q => ({ kind: q.kind, reviewer: q.reviewer, at: q.at, status: 'cut' as const }))],
  };
}

/**
 * Asks one call per sibling question, at most `MAX_FIELD_QUESTIONS` field and `MAX_IMPLEMENTATION_QUESTIONS`
 * implementation questions, as `ask` says. Returns their findings, which carry the question's name, and a record of
 * every question, the ones past the caps as `cut`.
 */
export async function runComparisons(clientFor: (reviewer: string) => LLMClient, siblings: SiblingQuestions, options: ComparisonOptions = {}): Promise<Answers> {
  const questions = questionsOf(siblings);
  const fields = questions.filter(q => q.kind === 'field');
  const implementations = questions.filter(q => q.kind === 'implementations');
  const asked = [...fields.slice(0, MAX_FIELD_QUESTIONS), ...implementations.slice(0, MAX_IMPLEMENTATION_QUESTIONS)];
  const cut = [...fields.slice(MAX_FIELD_QUESTIONS), ...implementations.slice(MAX_IMPLEMENTATION_QUESTIONS)];
  return ask(clientFor, asked, cut, options, { what: 'sibling comparison', system: systemPrompt, parse: (content, reviewer) => ({ findings: parseFindings(content, reviewer) }) });
}

/**
 * Keeps the findings of a counterpart's reply that cite a line on both sides, which `shownLines` finds in `workspace` and
 * in the checkouts of `related`. Their `proof` and `relatedProof` hold only those lines. Returns how many were dropped.
 */
function parseRelatedFindings(content: string, reviewer: string, workspace: string, related?: RelatedRepoTools): { findings: Finding[]; dropped: number } {
  const parsed = parseFindings(content, reviewer);
  // `parseFindings` maps the usable elements in order, so the raw `proof` of each finding is the element at its index.
  const elements = (JSON.parse(extractJSON(content, 'array')) as unknown[]).filter(isUsableElement);
  const findings = parsed.flatMap((finding, i) => {
    const { proof, relatedProof } = shownLines(elements[i].proof, workspace, related);
    if (proof.length === 0 || relatedProof.length === 0) return [];
    return [{ ...finding, evidence: { ...(finding.evidence ?? { checks: [] }), proof, relatedProof } }];
  });
  return { findings, dropped: parsed.length - findings.length };
}

/**
 * Asks one call per counterpart of a related repo, at most `MAX_RELATED_QUESTIONS` in the order of `questions`, as `ask`
 * says. A call runs only with repository tools, so it can open the counterpart, and keeps a finding only with a cited
 * line on both sides. Returns their findings, which carry the counterpart's name, and a record of every counterpart,
 * the ones past the cap as `cut`.
 */
export async function runRelatedChecks(clientFor: (reviewer: string) => LLMClient, questions: readonly RelatedQuestion[], options: ComparisonOptions = {}): Promise<Answers> {
  const all = relatedQuestionsOf(questions);
  const { workspace, related } = options;
  return ask(clientFor, all.slice(0, MAX_RELATED_QUESTIONS), all.slice(MAX_RELATED_QUESTIONS), options, {
    what: 'related repo', system: () => RELATED_SYSTEM_PROMPT, needsTools: true, parse: (content, reviewer) => parseRelatedFindings(content, reviewer, workspace!, related),
  });
}
