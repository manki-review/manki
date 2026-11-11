import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

import { benchMatrix, formatReportSummary, main, selectCases } from './bench-report';
import { BenchCase, BenchReport, buildReport, CaseSet, mergeReports } from '../src/bench';

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

describe('formatReportSummary and the commands on a stored report', () => {
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
    const reportOf = (benchCase: BenchCase, text: string): BenchReport => {
      const part = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [] }]);
      const report = mergeReports([part], [{ ...benchCase, source: `source ${text}` }], { ref: 'main' });
      const [scored] = report.variants[0].cases;
      const finding = { severity: 'blocker' as const, title: `title ${text}`, file: `src/${text}.rs`, line: 3, description: `description ${text}` };
      scored.runs = [{ ...scored.runs[0], outcome: 'ADDRESS_FIRST', complete: true, findings: [finding], falseBlockers: 1, extraFindings: 1 }, { ...scored.runs[0], error: `failed on ${text}` }];
      return report;
    };
    const summaryOf = (benchCase: BenchCase, text: string) => formatReportSummary(reportOf(benchCase, text));
    const shown = summaryOf(tuning, 'SHOWN-TEXT');
    for (const text of ['(source SHOWN-TEXT)', 'src/SHOWN-TEXT.rs:3: title SHOWN-TEXT', '    description SHOWN-TEXT', 'run 2: FAILED: failed on SHOWN-TEXT']) expect(shown).toContain(text);
    const held = summaryOf({ ...tuning, set: 'holdout' }, 'HOLDOUT-TEXT');
    expect(held).toContain('\nrdc-1295\n');
    expect(held).toContain('  run 2: FAILED: the reason is in the report\n');
    expect(held).not.toContain('HOLDOUT-TEXT');

    // A stored report is read by the commands. `caseSet` says which set a case is in, from the case files under the root.
    const root = mkdtempSync(join(tmpdir(), 'manki-bench-report-'));
    const out = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const printed = () => out.mock.calls.join('\n');
    const inWorkflow = process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_ACTIONS;
    try {
      const caseFile = readFileSync(join(__dirname, '..', 'bench', 'cases', 'rdc-1295.yml'), 'utf-8');
      for (const [set, id] of [['cases', 'shown-1'], ['holdout', 'held-1']]) {
        mkdirSync(join(root, 'bench', set), { recursive: true });
        writeFileSync(join(root, 'bench', set, `${id}.yml`), caseFile.replace('id: rdc-1295', `id: ${id}`));
      }
      // The report of a single case job of an older ref calls its hold-out case a tuning case.
      const stored = (name: string, label: CaseSet): string => {
        const [shownReport, heldReport] = [reportOf({ ...tuning, id: 'shown-1' }, 'SHOWN-TEXT'), reportOf({ ...tuning, id: 'held-1', set: label }, 'HOLDOUT-TEXT')];
        const report = { ...shownReport, variants: [{ ...shownReport.variants[0], cases: [shownReport.variants[0].cases[0], heldReport.variants[0].cases[0]] }] };
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, 'report.json'), JSON.stringify(report));
        return join(root, name, 'report.json');
      };
      const [right, wrong] = [stored('right', 'holdout'), stored('wrong', 'tuning')];

      expect(main(['unmatched', '--report', right], root)).toBe(0);
      expect(printed()).toContain('src/SHOWN-TEXT.rs:3: title SHOWN-TEXT\n    description SHOWN-TEXT');
      expect(out).toHaveBeenLastCalledWith('Not listed, in another set: held-1');
      expect(printed()).not.toContain('HOLDOUT-TEXT');
      expect(main(['unmatched', '--report', right, '--set', 'holdout'], root)).toBe(0);
      expect(printed()).toContain('src/HOLDOUT-TEXT.rs:3: title HOLDOUT-TEXT');
      expect(out).toHaveBeenLastCalledWith('Not listed, in another set: shown-1');
      out.mockClear();

      const refused = `The report ${wrong} calls held-1 a tuning case, which its id does not make it. A tuning case has a file named after its id in bench/cases and none in bench/holdout.`;
      for (const flags of [[], ['--set', 'both'], ['--set', 'holdout']]) expect(() => main(['unmatched', '--report', wrong, ...flags], root)).toThrow(new Error(refused));
      expect(() => main(['gate', '--baseline', right, '--candidate', wrong], root)).toThrow(new Error(refused));
      process.env.GITHUB_ACTIONS = 'true';
      expect(() => main(['unmatched', '--report', wrong], root)).toThrow(new Error(refused));
      expect(out).not.toHaveBeenCalled();
      expect(() => main(['unmatched', '--report', right, '--set', 'both'], root)).toThrow('The findings of hold-out cases are not listed in a workflow job');

      // `merge` gives each case the set `caseSet` names, whatever the case job's report says.
      expect(main(['merge', '--set', 'both', '--dir', join(root, 'wrong'), '--out', join(root, 'merged.json')], root)).toBe(0);
      const merged = JSON.parse(readFileSync(join(root, 'merged.json'), 'utf-8')) as BenchReport;
      expect(merged.variants[0].cases.map(c => [c.id, c.set])).toEqual([['shown-1', 'tuning'], ['held-1', 'holdout']]);
      expect(main(['unmatched', '--report', join(root, 'merged.json')], root)).toBe(0);
      expect(printed()).toContain('run 2: FAILED: failed on SHOWN-TEXT');
      expect(printed()).not.toContain('HOLDOUT-TEXT');
    } finally {
      if (inWorkflow === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = inWorkflow;
      out.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
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
