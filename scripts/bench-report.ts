/**
 * The steps of the benchmark workflow around `manki bench`. It lists the cases to run as a job matrix, merges the
 * report of each case job into one, applies the release gate to merged reports, and lists the findings of a report
 * that match no key item. It calls no model. Of a hold-out case it prints the id and counts only, except for
 * `unmatched --set holdout`, which refuses to run in a workflow job. `caseSet` alone says which set a case is in:
 * `merge` writes that set into the merged report, and `gate` and `unmatched` refuse a report that calls another case a
 * tuning case.
 *
 * Usage:
 *   npm run bench-report -- matrix --set <holdout|tuning|both> [--cases "<id> ..."]
 *   npm run bench-report -- merge --set <set> [--cases "<id> ..."] --dir <case reports> --out <report.json> [--ref <ref>] [--commit <sha>]
 *   npm run bench-report -- gate --baseline <report.json> [--baseline ...] --candidate <report.json> [--candidate ...]
 *   npm run bench-report -- unmatched --report <report.json> [--set <holdout|tuning|both>]
 */

import { readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { BenchCase, BenchReport, CASE_DIRS, CaseSet, formatBenchSummary, formatComparison, formatGate, formatUnmatched, gateReports, loadCases, mergeReports, readReport } from '../src/bench';

const SET_CHOICES: Record<string, CaseSet[]> = { holdout: ['holdout'], tuning: ['tuning'], both: ['tuning', 'holdout'] };

/** One job of the benchmark matrix: a case and what its job needs to fetch. */
export interface MatrixEntry {
  id: string;
  set: CaseSet;
  repo: string;
  base: string;
  head: string;
  /** The commit the earlier round of a follow-up case reviewed, or an empty string. */
  prior: string;
  /** The case file, relative to the checkout. */
  file: string;
}

/** Returns the cases of `set` (`holdout`, `tuning` or `both`), or only those whose id is in `only`. */
export function selectCases(set: string, only: string[], root = '.'): BenchCase[] {
  const sets = SET_CHOICES[set];
  if (!sets) throw new Error(`--set must be one of ${Object.keys(SET_CHOICES).join(', ')}`);
  return loadCases(sets.map(s => join(root, CASE_DIRS[s])), only, root);
}

/** Returns one matrix entry per case, naming the file each case is read from, which is named after the case's id. */
export function benchMatrix(cases: BenchCase[]): MatrixEntry[] {
  return cases.map(({ id, set, repo, base, head, priorRound }) => ({ id, set, repo, base, head, prior: priorRound?.head ?? '', file: join(CASE_DIRS[set], `${id}.yml`) }));
}

/**
 * Returns the Markdown summary of a merged report: the comparison table, the unmatched blockers and unexpected warnings
 * on tuning cases, then every case and run in a fold.
 */
export function formatReportSummary(report: BenchReport): string {
  const cases = report.variants[0]?.cases ?? [];
  const count = (set: CaseSet) => cases.filter(c => c.set === set).length;
  return [
    `## Benchmark of \`${report.ref ?? 'unknown ref'}\`${report.commit ? ` at \`${report.commit}\`` : ''}`,
    '',
    `Manki ${report.mankiVersion}, ${report.runsPerCase} ${report.runsPerCase === 1 ? 'run' : 'runs'} per case, matcher ${report.matcherModel}. Cases: ${count('tuning')} tuning, ${count('holdout')} hold-out.`,
    '',
    formatComparison(report.variants),
    '',
    ...[formatUnmatched(report.variants)].filter(Boolean),
    '<details><summary>Every case and run</summary>',
    '',
    '```text',
    formatBenchSummary(report).trimEnd(),
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}

function parseArgs(args: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!flag.startsWith('--') || value === undefined) throw new Error(`Expected --<flag> <value>, got ${flag}`);
    flags.set(flag, [...(flags.get(flag) ?? []), value]);
  }
  return flags;
}

/** Runs one command on the case files and reports under `root`, and returns the exit code. */
export function main(argv: string[], root = '.'): number {
  const [command, ...rest] = argv;
  const flags = parseArgs(rest);
  const one = (flag: string) => flags.get(flag)?.at(-1);
  const required = (flag: string) => {
    const value = one(flag);
    if (!value) throw new Error(`${command} needs ${flag}`);
    return value;
  };
  const only = (one('--cases') ?? '').split(/[\s,]+/).filter(Boolean);
  if (command === 'matrix') {
    console.log(JSON.stringify(benchMatrix(selectCases(required('--set'), only, root))));
  } else if (command === 'merge') {
    const dir = required('--dir');
    // The report of a case job of an older ref calls every case a tuning case. `mergeReports` gives each case the set `caseSet` names.
    const parts = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readReport(join(dir, f), 'unchecked'));
    const report = mergeReports(parts, selectCases(required('--set'), only, root), { ref: one('--ref'), commit: one('--commit') });
    writeFileSync(required('--out'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(formatReportSummary(report));
  } else if (command === 'gate') {
    const [baseline, candidate] = ['--baseline', '--candidate'].map(flag => (flags.get(flag) ?? []).map(path => readReport(path, 'checked', root)));
    console.log(`## Release gate\n\n${formatGate(gateReports(baseline, candidate))}`);
  } else if (command === 'unmatched') {
    const sets = SET_CHOICES[one('--set') ?? 'tuning'];
    if (!sets) throw new Error(`--set must be one of ${Object.keys(SET_CHOICES).join(', ')}`);
    const report = readReport(required('--report'), 'checked', root);
    const skipped = [...new Set(report.variants.flatMap(v => v.cases).filter(c => !sets.includes(c.set)).map(c => c.id))];
    console.log(formatUnmatched(report.variants, sets) || 'Every blocker and warning on the listed sets matches a key item.');
    if (skipped.length > 0) console.log(`Not listed, in another set: ${skipped.join(', ')}`);
  } else {
    throw new Error('Usage: npm run bench-report -- <matrix|merge|gate|unmatched> [options], see the top of scripts/bench-report.ts');
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
