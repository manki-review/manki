import { readFileSync, writeFileSync } from 'fs';

import { outcomeReport } from './check-run';
import { loadConfig } from './config';
import { CHECKS_MARKER, formatFindingBlock } from './github';
import { LocalReview, reviewLocal } from './local-review';
import { hasAnyProviderCredentials, readProviderInputsFromEnv, removeSeededAuthFiles } from './providers';
import { runGit } from './workspace';

export const REVIEW_COMMAND = 'review';

const USAGE = `Usage: manki review [<base>[..<head>]] [options]

Reviews the change from the merge base of <base> and <head> to <head>, as a pull request
shows it, with the pipeline a pull request round runs. Nothing is written to GitHub.
<base> defaults to the remote's default branch, <head> to HEAD.

Options:
  --patch <file>      Review a patch against <head> instead of the commits.
  --config <file>     Use this config instead of the base's .manki.yml.
  --title <text>      Pull request title shown to the models. Defaults to the head commit's subject.
  --body-file <file>  Pull request description shown to the models.
  --json              Print the outcome, summary and findings as JSON.
  --record <file>     Write the round record a pull request round would post.
  --help              Print this message.

Credentials come from CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_OAUTH_TOKEN,
OPENAI_API_KEY, GEMINI_OAUTH_TOKEN or GEMINI_API_KEY.

Exit codes: 0 nothing blocks, 1 something blocks, 2 the review is incomplete or failed.`;

interface ReviewArgs {
  base?: string;
  head: string;
  patch?: string;
  config?: string;
  title?: string;
  bodyFile?: string;
  json: boolean;
  record?: string;
  help: boolean;
}

export function parseReviewArgs(argv: string[]): ReviewArgs {
  const args: ReviewArgs = { head: 'HEAD', json: false, help: false };
  let range: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--patch') args.patch = value();
    else if (arg === '--config') args.config = value();
    else if (arg === '--title') args.title = value();
    else if (arg === '--body-file') args.bodyFile = value();
    else if (arg === '--record') args.record = value();
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else if (range === undefined) range = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if (range !== undefined) {
    const [base, head] = range.split(/\.{2,3}/, 2);
    if (!base) throw new Error(`No base in ${range}`);
    args.base = base;
    if (head) args.head = head;
  }
  return args;
}

/** Exit code for a review: 0 when nothing blocks, 1 when something does, 2 when the review is incomplete. */
export function exitCodeOf({ result }: LocalReview): number {
  if (result.outcome === 'INCOMPLETE') return 2;
  return outcomeReport(result.outcome, result.summary).conclusion === 'success' ? 0 : 1;
}

/** Returns the outcome, summary and findings as JSON. Parsing it gives back the same values. */
export function formatReviewJson({ result, base, head }: LocalReview): string {
  return `${JSON.stringify({ outcome: result.outcome, verdict: result.verdict, summary: result.summary, base, head, findings: result.findings }, null, 2)}\n`;
}

/** Returns the review as Markdown: the outcome and summary, then each finding as the review body lists it. */
export function formatReviewText({ result, base, head }: LocalReview): string {
  const links = { linkTo: (file: string, line: number, end?: number) => `${file}:${line}${end && end !== line ? `-${end}` : ''}`, files: new Map() };
  const title = outcomeReport(result.outcome, result.summary).title;
  const blocks = result.findings.map(f => formatFindingBlock(f, links));
  const lead = [`## ${title}: ${base.slice(0, 7)}..${head.slice(0, 7)}`, result.summary].filter(Boolean).join('\n\n');
  const text = [lead, ...blocks].join('\n\n---\n\n');
  return `${text.split(`${CHECKS_MARKER}\n`).join('')}\n`;
}

async function defaultBase(root: string): Promise<string> {
  return (await runGit(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => 'main')).trim();
}

/**
 * Runs a subcommand's `body` and returns its exit code, 2 when it throws. `out` writes the result to stdout, and every
 * log line goes to stderr. `signal` aborts on the first Ctrl-C.
 */
export async function runCliCommand(name: string, body: (out: (text: string) => void, signal: AbortSignal) => Promise<number>): Promise<number> {
  const write = process.stdout.write;
  const out = write.bind(process.stdout);
  // `@actions/core` logs to stdout, which here carries only the result.
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  const cancel = new AbortController();
  // The first Ctrl-C stops the command at its next step. A second one exits at once.
  const onSignal = (): void => (cancel.signal.aborted ? process.exit(130) : cancel.abort(new Error('Interrupted')));
  process.on('SIGINT', onSignal);
  try {
    return await body(text => out(text), cancel.signal);
  } catch (error) {
    process.stderr.write(`manki ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    process.off('SIGINT', onSignal);
    removeSeededAuthFiles();
    process.stdout.write = write;
  }
}

/** Runs `manki review` and returns its exit code. */
export function runReviewCommand(argv: string[]): Promise<number> {
  return runCliCommand(REVIEW_COMMAND, async (out, signal) => {
    const args = parseReviewArgs(argv);
    if (args.help) {
      out(`${USAGE}\n`);
      return 0;
    }
    const providerInputs = readProviderInputsFromEnv();
    if (!hasAnyProviderCredentials(providerInputs)) throw new Error(`No credentials set.\n\n${USAGE}`);
    const repoRoot = (await runGit(process.cwd(), ['rev-parse', '--show-toplevel'])).trim();
    const review = await reviewLocal({
      repoRoot,
      base: args.base ?? await defaultBase(repoRoot),
      head: args.head,
      ...(args.patch !== undefined && { patch: readFileSync(args.patch, 'utf-8') }),
      ...(args.config !== undefined && { config: loadConfig(readFileSync(args.config, 'utf-8'), args.config) }),
      ...(args.title !== undefined && { title: args.title }),
      ...(args.bodyFile !== undefined && { body: readFileSync(args.bodyFile, 'utf-8') }),
      providerInputs,
      signal,
    });
    if (args.record) writeFileSync(args.record, `${JSON.stringify(review.context, null, 2)}\n`);
    out(args.json ? formatReviewJson(review) : formatReviewText(review));
    return exitCodeOf(review);
  });
}
