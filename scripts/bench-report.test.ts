import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

import { benchMatrix, formatReportSummary, selectCases } from './bench-report';
import { BenchCase, buildReport, mergeReports } from '../src/bench';

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
      base: 'd9c30a7cb2c6f305cd528833193497500160aa1c', head: '63a021e6c52d7be694e779a0b3ba403e7ee7a881', prior: '',
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
    expect(summary).toMatch(/^## Benchmark of `main` at `a{40}`\n\nManki 7\.3\.0, 1 run per case, matcher model-a\. Cases: 1 tuning, 0 hold-out\.\n\n\| Metric \| base \|\n/);
    expect(summary).toContain('<details><summary>Every case and run</summary>\n\n```text\n== base\nrdc-1295');
  });

  it('shows the findings and failure reasons of a tuning case, and of a hold-out case only its id and counts', () => {
    const [tuning] = selectCases('tuning', ['rdc-1295']);
    const summaryOf = (benchCase: BenchCase, text: string): string => {
      const part = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [] }]);
      const report = mergeReports([part], [{ ...benchCase, source: `source ${text}` }], { ref: 'main' });
      const [scored] = report.variants[0].cases;
      const finding = { severity: 'blocker' as const, title: `title ${text}`, file: `src/${text}.rs`, line: 3, description: `description ${text}` };
      scored.runs = [{ ...scored.runs[0], outcome: 'ADDRESS_FIRST', complete: true, findings: [finding], falseBlockers: 1, extraFindings: 1 }, { ...scored.runs[0], error: `failed on ${text}` }];
      return formatReportSummary(report);
    };
    const shown = summaryOf(tuning, 'SHOWN-TEXT');
    for (const text of ['(source SHOWN-TEXT)', 'src/SHOWN-TEXT.rs:3: title SHOWN-TEXT', '    description SHOWN-TEXT', 'run 2: FAILED: failed on SHOWN-TEXT']) expect(shown).toContain(text);
    const held = summaryOf({ ...tuning, set: 'holdout' }, 'HOLDOUT-TEXT');
    expect(held).toContain('\nrdc-1295\n');
    expect(held).toContain('  run 2: FAILED: the reason is in the report\n');
    expect(held).not.toContain('HOLDOUT-TEXT');
  });
});

describe('the benchmark workflow', () => {
  type Step = { name?: string; env?: Record<string, string>; run?: string };
  const workflow = parseYaml(readFileSync(join(__dirname, '..', '.github', 'workflows', 'bench.yml'), 'utf-8')) as { jobs: Record<string, { steps: Step[] }> };

  it('shows what the bench prints for a tuning case only, and keeps the exit code of a hold-out case', () => {
    const step = workflow.jobs.case.steps.find(s => s.name === 'Review and score the case')!;
    expect(step.env).toMatchObject({ CASE_SET: '${{ matrix.case.set }}' });
    const dir = mkdtempSync(join(tmpdir(), 'manki-bench-step-'));
    try {
      // Stands in for the bench of any ref: it prints a finding on both streams and exits as told.
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'node'), '#!/bin/sh\necho "stdout FINDING-TEXT"\necho "stderr FINDING-TEXT" >&2\nexit "$BENCH_EXIT"\n');
      chmodSync(join(dir, 'bin', 'node'), 0o755);
      writeFileSync(join(dir, 'case.yml'), 'id: demo\n');
      const run = (set: string, exit = '0') => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run!], {
        cwd: dir, encoding: 'utf-8',
        env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: dir, CASE_ID: 'demo', CASE_SET: set, CASE_REPO: 'o/r', CASE_FILE: 'case.yml', RUNS: '1', VARIANTS: 'base', BENCH_EXIT: exit },
      });
      expect(run('tuning')).toMatchObject({ status: 0, stdout: 'stdout FINDING-TEXT\n', stderr: 'stderr FINDING-TEXT\n' });
      expect(run('tuning', '2').status).toBe(2);
      for (const set of ['holdout', '', 'anything else']) {
        const hidden = run(set, '2');
        expect(hidden.status).toBe(2);
        expect(hidden.stdout + hidden.stderr).toBe('The output of a hold-out case is not shown. Each run and the reason of a failed one are in the case report.\n');
      }
      expect(run('holdout').status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
