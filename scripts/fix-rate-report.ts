/**
 * Aggregates `fix-rate.jsonl` files from the memory repo into markdown tables, one per
 * dimension, so you can see how often findings of each grade are fixed or dismissed.
 *
 * Usage:
 *   npm run fix-rate-report -- <fix-rate.jsonl> [<fix-rate.jsonl> ...]
 */

import { readFileSync } from 'fs';

const OUTCOMES = ['posted', 'fixed', 'dismissed', 'untouched'] as const;

type Totals = Record<(typeof OUTCOMES)[number], number>;

type Row = Totals & Record<string, unknown>;

/** Each dimension and the field of a fix-rate line that holds its rows. Older lines have no `calibration`. */
const DIMENSIONS: ReadonlyArray<{ name: string; source: 'counts' | 'calibration' }> = [
  { name: 'severity', source: 'counts' },
  { name: 'specialist', source: 'counts' },
  { name: 'confidence', source: 'calibration' },
  { name: 'toolEvidence', source: 'calibration' },
  { name: 'category', source: 'calibration' },
  { name: 'effort', source: 'calibration' },
  { name: 'hadEvidence', source: 'calibration' },
  { name: 'judgeChecked', source: 'calibration' },
];

/** Sums the fix-rate lines into one table per dimension. With `prs`, only the lines of those pull requests count. */
export function aggregate(lines: string[], prs?: ReadonlySet<number>): Map<string, Map<string, Totals>> {
  const tables = new Map(DIMENSIONS.map(d => [d.name, new Map<string, Totals>()]));
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: Partial<Record<'counts' | 'calibration', Row[]>> & { pr?: number };
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error(`Skipping a line that is not JSON: ${line.slice(0, 80)}`);
      continue;
    }
    if (prs && !prs.has(Number(parsed?.pr))) continue;
    for (const { name, source } of DIMENSIONS) {
      const table = tables.get(name)!;
      for (const row of parsed?.[source] ?? []) {
        const value = String(row[name] ?? 'unknown');
        const totals = table.get(value) ?? { posted: 0, fixed: 0, dismissed: 0, untouched: 0 };
        for (const outcome of OUTCOMES) totals[outcome] += Number(row[outcome]) || 0;
        table.set(value, totals);
      }
    }
  }
  return tables;
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-';
}

/** Renders the table of one dimension, with `No data.` under its header when it has no rows. */
export function renderTable(name: string, table: Map<string, Totals>): string[] {
  const rows = [...table.entries()].sort((a, b) => b[1].posted - a[1].posted || a[0].localeCompare(b[0]));
  return [
    `| ${name} | posted | fixed | dismissed | untouched | fixed % | dismissed % |`,
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(([value, t]) => `| ${value} | ${t.posted} | ${t.fixed} | ${t.dismissed} | ${t.untouched} | ${percent(t.fixed, t.posted)} | ${percent(t.dismissed, t.posted)} |`),
    ...(rows.length === 0 ? ['', 'No data.'] : []),
  ];
}

export function renderReport(tables: Map<string, Map<string, Totals>>): string {
  const sections = [...tables].map(([name, table]) => [`## By ${name}`, '', ...renderTable(name, table)].join('\n'));
  return `${sections.join('\n\n')}\n`;
}

function main(paths: string[]): number {
  if (paths.length === 0) {
    console.error('Usage: npm run fix-rate-report -- <fix-rate.jsonl> [<fix-rate.jsonl> ...]');
    return 1;
  }
  const lines = paths.flatMap(p => readFileSync(p, 'utf-8').split('\n'));
  process.stdout.write(renderReport(aggregate(lines)));
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
