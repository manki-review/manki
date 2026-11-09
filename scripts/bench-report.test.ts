import { benchMatrix, formatReportSummary, selectCases } from './bench-report';
import { buildReport, mergeReports } from '../src/bench';

jest.mock('@actions/core');

describe('selectCases and benchMatrix', () => {
  it('lists the cases of each set choice with the file and commits each job fetches', () => {
    const holdout = selectCases('holdout', []);
    const tuning = selectCases('tuning', []);
    expect(holdout.length).toBeGreaterThanOrEqual(8);
    expect(holdout.every(c => c.set === 'holdout') && tuning.every(c => c.set === 'tuning')).toBe(true);
    expect(selectCases('both', [])).toHaveLength(holdout.length + tuning.length);

    const [entry] = benchMatrix(selectCases('both', ['rdc-1295']));
    expect(entry).toEqual({
      id: 'rdc-1295', set: 'tuning', repo: 'xdustinface/rust-dashcore', file: 'bench/cases/rdc-1295.yml',
      base: 'd9c30a7cb2c6f305cd528833193497500160aa1c', head: '63a021e6c52d7be694e779a0b3ba403e7ee7a881',
    });
    expect(benchMatrix(holdout).every(e => e.file.startsWith('bench/holdout/'))).toBe(true);
    expect(() => selectCases('all', [])).toThrow('--set must be one of holdout, tuning, both');
    expect(() => selectCases('holdout', ['rdc-1295'])).toThrow('No case with id rdc-1295');
  });
});

describe('formatReportSummary', () => {
  it('heads the summary with the ref, the commit and the case counts, then the comparison table and every run in a fold', () => {
    const cases = selectCases('both', ['rdc-1295']);
    const part = { ...buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [] }]), mankiVersion: '7.3.0' };
    const report = mergeReports([part], cases, { ref: 'main', commit: 'a'.repeat(40) });
    const summary = formatReportSummary(report);
    expect(summary).toMatch(/^## Benchmark of `main` at `aaaaaaaaaaaa`\n\nManki 7\.3\.0, 1 run per case, matcher model-a\. Cases: 1 tuning, 0 hold-out\.\n\n\| Metric \| base \|\n/);
    expect(summary).toContain('<details><summary>Every case and run</summary>\n\n```text\n== base\nrdc-1295');
  });
});
