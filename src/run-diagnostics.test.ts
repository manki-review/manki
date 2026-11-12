import * as core from '@actions/core';
import * as github from '@actions/github';

import { formatRunner, parseProcStatus, parsePsOutput, recordQueueWait, runnerDiagnostics, startMemorySampler, trackCliProcess, treeMemoryBytes } from './run-diagnostics';
import { RoundRunner } from './types';

jest.mock('@actions/core', () => ({ info: jest.fn() }));
jest.mock('@actions/github', () => ({ context: { repo: { owner: 'owner', repo: 'repo' }, runId: 7 } }));

type Octokit = ReturnType<typeof github.getOctokit>;

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function octokitWithRun(getWorkflowRun: jest.Mock): Octokit {
  return { rest: { actions: { getWorkflowRun } } } as unknown as Octokit;
}

describe('treeMemoryBytes', () => {
  const rows = [
    { pid: 1, ppid: 0, rssBytes: 1 },
    { pid: 10, ppid: 1, rssBytes: 100 },
    { pid: 11, ppid: 10, rssBytes: 20 },
    { pid: 12, ppid: 11, rssBytes: 3 },
    { pid: 20, ppid: 1, rssBytes: 5000 },
  ];

  it('sums a process and all its descendants, and nothing beside or above it', () => {
    expect(treeMemoryBytes(rows, 10)).toBe(123);
    expect(treeMemoryBytes(rows, 12)).toBe(3);
    expect(treeMemoryBytes(rows, 99)).toBe(0);
  });

  it('counts each process once when a reused pid makes the parents loop', () => {
    expect(treeMemoryBytes([{ pid: 1, ppid: 2, rssBytes: 4 }, { pid: 2, ppid: 1, rssBytes: 8 }], 1)).toBe(12);
  });
});

describe('process listings', () => {
  it('reads the parent and the resident memory from a /proc status file', () => {
    expect(parseProcStatus(42, 'Name:\tnode\nPid:\t42\nPPid:\t7\nVmPeak:\t  900 kB\nVmRSS:\t   2048 kB\n')).toEqual({ pid: 42, ppid: 7, rssBytes: 2048 * 1024 });
    // A kernel thread holds no memory of its own.
    expect(parseProcStatus(2, 'Name:\tkthreadd\nPid:\t2\nPPid:\t0\n')).toBeUndefined();
  });

  it('reads pid, parent and KiB from ps output and skips other lines', () => {
    expect(parsePsOutput('    1     0   9216\n  501   1 1024\n\nPID PPID RSS\n')).toEqual([
      { pid: 1, ppid: 0, rssBytes: 9216 * 1024 },
      { pid: 501, ppid: 1, rssBytes: 1024 * 1024 },
    ]);
  });
});

describe('run diagnostics', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('records the peak of model CLI processes running at once, ending each one once', () => {
    const before = runnerDiagnostics().peakCliProcesses;
    const ends = [trackCliProcess(), trackCliProcess(), trackCliProcess()];
    ends[0]();
    ends[0]();
    trackCliProcess()();
    ends.slice(1).forEach(end => end());
    expect(runnerDiagnostics().peakCliProcesses).toBe(Math.max(before, 3));
    // Ending the first twice must not hide a running process from the next peak.
    const more = [trackCliProcess(), trackCliProcess(), trackCliProcess(), trackCliProcess()];
    expect(runnerDiagnostics().peakCliProcesses).toBe(Math.max(before, 4));
    more.forEach(end => end());
  });

  it('describes the runner without its name, with the memory limit only when it is below the machine memory', () => {
    process.env.RUNNER_ENVIRONMENT = 'self-hosted';
    process.env.RUNNER_NAME = 'light-1';
    const limit = jest.spyOn(process, 'constrainedMemory').mockReturnValue(2 * GIB);
    expect(runnerDiagnostics()).toMatchObject({ environment: 'self-hosted', os: process.platform, arch: process.arch, memoryLimitBytes: 2 * GIB });
    // The record is public with the review, so the name of a self-hosted machine stays out of it.
    expect(JSON.stringify(runnerDiagnostics())).not.toContain('light-1');
    expect(runnerDiagnostics().cpus).toBeGreaterThan(0);
    expect(runnerDiagnostics().memoryBytes).toBeGreaterThan(2 * GIB);

    delete process.env.RUNNER_ENVIRONMENT;
    delete process.env.RUNNER_NAME;
    for (const unlimited of [0, Number.MAX_SAFE_INTEGER]) {
      limit.mockReturnValue(unlimited);
      const runner = runnerDiagnostics();
      expect(runner).not.toHaveProperty('memoryLimitBytes');
      expect(runner).not.toHaveProperty('environment');
    }
  });

  it('records the time from the start of the workflow run, and leaves it out when the run cannot be read', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('Resource not accessible by integration'));
    await recordQueueWait(octokitWithRun(failing));
    expect(runnerDiagnostics()).not.toHaveProperty('queuedMs');
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(expect.stringContaining('Resource not accessible by integration'));
    // A caller may leave the lookup running, so it never rejects, also when the repository of the run is unknown.
    const { repo } = github.context;
    Object.defineProperty(github.context, 'repo', { configurable: true, get: () => { throw new Error('context.repo requires a GITHUB_REPOSITORY environment variable'); } });
    await expect(recordQueueWait(octokitWithRun(failing))).resolves.toBeUndefined();
    Object.defineProperty(github.context, 'repo', { configurable: true, value: repo });
    expect(runnerDiagnostics()).not.toHaveProperty('queuedMs');

    const started = Date.now() - process.uptime() * 1000;
    // A re-run keeps the first attempt's `created_at`, so the time counts from `run_started_at`.
    const getWorkflowRun = jest.fn().mockResolvedValue({ data: { created_at: new Date(started - 3_600_000).toISOString(), run_started_at: new Date(started - 90_000).toISOString() } });
    await recordQueueWait(octokitWithRun(getWorkflowRun));
    // The lookup carries a time limit and is not tried again, so a stalled API cannot keep the run open past it.
    expect(getWorkflowRun).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', run_id: 7, request: { signal: expect.any(AbortSignal), retries: 0 } });
    const { queuedMs } = runnerDiagnostics();
    expect(queuedMs).toBeGreaterThan(88_000);
    expect(queuedMs).toBeLessThan(92_000);

    // A clock ahead of GitHub's never gives a negative time.
    await recordQueueWait(octokitWithRun(jest.fn().mockResolvedValue({ data: { created_at: new Date(Date.now() + 60_000).toISOString() } })));
    expect(runnerDiagnostics().queuedMs).toBe(0);
  });

  const sampled = process.platform === 'linux' || process.platform === 'darwin' ? it : it.skip;
  sampled('samples the memory of this process tree', async () => {
    expect(runnerDiagnostics()).not.toHaveProperty('peakMemoryBytes');
    const stop = startMemorySampler();
    try {
      for (let i = 0; i < 100 && runnerDiagnostics().peakMemoryBytes === undefined; i++) await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      stop();
    }
    // At least this Node process, and less than the machine holds.
    expect(runnerDiagnostics().peakMemoryBytes).toBeGreaterThan(10 * MIB);
    expect(runnerDiagnostics().peakMemoryBytes).toBeLessThan(runnerDiagnostics().memoryBytes);
  });
});

describe('formatRunner', () => {
  const runner: RoundRunner = { environment: 'self-hosted', os: 'linux', arch: 'x64', cpus: 4, memoryBytes: 64 * GIB, memoryLimitBytes: 2 * GIB, queuedMs: 663_000, peakMemoryBytes: 1.9 * GIB, peakCliProcesses: 6 };

  it('shows the kind, the time until Manki started and the peak memory against the limit', () => {
    expect(formatRunner(runner)).toBe('Runner: self-hosted · started after 11m 3s · peak memory 1.9 GiB of 2.0 GiB');
    expect(formatRunner(runner, true)).toBe('Runner: self-hosted · started after 11m 3s · peak memory 1.9 GiB of 2.0 GiB · 4 CPUs · up to 6 model CLI processes at once');
    expect(formatRunner({ ...runner, queuedMs: 11_112_000 })).toBe('Runner: self-hosted · started after 3h 5m · peak memory 1.9 GiB of 2.0 GiB');
  });

  it('falls back to the machine memory and leaves out what was not measured', () => {
    expect(formatRunner({ os: 'win32', arch: 'x64', cpus: 1, memoryBytes: 16 * GIB, peakCliProcesses: 1 }, true)).toBe('Runner: win32 · 16.0 GiB memory · 1 CPU · up to 1 model CLI process at once');
    expect(formatRunner({ ...runner, memoryLimitBytes: undefined, queuedMs: 0, peakMemoryBytes: 300 * MIB })).toBe('Runner: self-hosted · started after 0ms · peak memory 300 MiB of 64.0 GiB');
  });
});
