/**
 * The steps of the benchmark workflow around `manki bench`. It lists the cases to run as a job matrix, merges the
 * report of each case job into one, and applies the release gate to merged reports. It calls no model.
 *
 * Usage:
 *   npm run bench-report -- matrix --set <holdout|tuning|both> [--cases "<id> ..."]
 *   npm run bench-report -- merge --set <set> [--cases "<id> ..."] --dir <case reports> --out <report.json> [--ref <ref>] [--commit <sha>]
 *   npm run bench-report -- gate --baseline <report.json> [--baseline ...] --candidate <report.json> [--candidate ...]
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { BenchCase, BenchReport, CaseSet, formatBenchSummary, formatComparison, formatGate, gateReports, loadCases, mergeReports, parseCase } from '../src/bench';

const SET_DIRS: Record<CaseSet, string> = { tuning: 'bench/cases', holdout: 'bench/holdout' };
const SET_CHOICES: Record<string, CaseSet[]> = { holdout: ['holdout'], tuning: ['tuning'], both: ['tuning', 'holdout'] };

/** One job of the benchmark matrix: a case and what its job needs to fetch. */
export interface MatrixEntry {
  id: string;
  set: CaseSet;
  repo: string;
  base: string;
  head: string;
  /** The case file, relative to the checkout. */
  file: string;
}

/** Returns the cases of `set` (`holdout`, `tuning` or `both`), or only those whose id is in `only`. */
export function selectCases(set: string, only: string[], root = '.'): BenchCase[] {
  const sets = SET_CHOICES[set];
  if (!sets) throw new Error(`--set must be one of ${Object.keys(SET_CHOICES).join(', ')}`);
  return loadCases(Object.fromEntries(sets.map(s => [s, join(root, SET_DIRS[s])])), only);
}

/** Returns one matrix entry per case, naming the file each case is read from. */
export function benchMatrix(cases: BenchCase[], root = '.'): MatrixEntry[] {
  const files = new Map<string, string>();
  for (const set of new Set(cases.map(c => c.set))) {
    for (const name of readdirSync(join(root, SET_DIRS[set])).filter(f => f.endsWith('.yml'))) {
      const file = join(SET_DIRS[set], name);
      files.set(parseCase(readFileSync(join(root, file), 'utf-8'), file, set).id, file);
    }
  }
  return cases.map(({ id, set, repo, base, head }) => ({ id, set, repo, base, head, file: files.get(id)! }));
}

/** Returns the Markdown summary of a merged report: the comparison table, then every case and run in a fold. */
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

function readReport(file: string): BenchReport {
  return JSON.parse(readFileSync(file, 'utf-8')) as BenchReport;
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

function main(argv: string[]): number {
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
    console.log(JSON.stringify(benchMatrix(selectCases(required('--set'), only))));
  } else if (command === 'merge') {
    const dir = required('--dir');
    const parts = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readReport(join(dir, f)));
    const report = mergeReports(parts, selectCases(required('--set'), only), { ref: one('--ref'), commit: one('--commit') });
    writeFileSync(required('--out'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(formatReportSummary(report));
  } else if (command === 'gate') {
    const [baseline, candidate] = ['--baseline', '--candidate'].map(flag => (flags.get(flag) ?? []).map(readReport));
    console.log(`## Release gate\n\n${formatGate(gateReports(baseline, candidate))}`);
  } else {
    throw new Error('Usage: npm run bench-report -- <matrix|merge|gate> [options], see the top of scripts/bench-report.ts');
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
