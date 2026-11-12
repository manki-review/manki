import * as core from '@actions/core';
import * as github from '@actions/github';
import { execFile } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import * as os from 'os';

import { RoundRunner } from './types';
import { formatDuration } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;

/** One process as a memory sample sees it. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  rssBytes: number;
}

const SAMPLE_INTERVAL_MS = 2000;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

let peakMemoryBytes = 0;
let cliProcesses = 0;
let peakCliProcesses = 0;
let queuedMs: number | undefined;

/** Returns the resident memory of process `root` and all its descendants in `rows`. */
export function treeMemoryBytes(rows: readonly ProcessRow[], root: number): number {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const seen = new Set<number>();
  const pending = rows.filter(row => row.pid === root);
  let total = 0;
  for (let row = pending.pop(); row; row = pending.pop()) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    total += row.rssBytes;
    pending.push(...(children.get(row.pid) ?? []));
  }
  return total;
}

/** Reads one process from the text of its `/proc/<pid>/status`. A kernel thread has no `VmRSS` and gives `undefined`. */
export function parseProcStatus(pid: number, status: string): ProcessRow | undefined {
  const ppid = /^PPid:\s+(\d+)/m.exec(status);
  const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
  return ppid && rss ? { pid, ppid: Number(ppid[1]), rssBytes: Number(rss[1]) * 1024 } : undefined;
}

/** Reads the processes from the output of `ps -A -o pid=,ppid=,rss=`, which gives the memory in KiB. */
export function parsePsOutput(output: string): ProcessRow[] {
  return output.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), rssBytes: Number(row[3]) * 1024 }] : [];
  });
}

/** Lists the running processes, or `undefined` on a platform this cannot read. Linux reads `/proc`, since a slim runner image has no `ps`. */
async function listProcesses(): Promise<ProcessRow[] | undefined> {
  if (process.platform === 'linux') {
    const pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(Number);
    // A process can exit between the listing and the read.
    const rows = await Promise.all(pids.map(pid => readFile(`/proc/${pid}/status`, 'utf8').then(status => parseProcStatus(pid, status), () => undefined)));
    return rows.filter((row): row is ProcessRow => !!row);
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], (error, stdout) => error ? reject(error) : resolve(parsePsOutput(stdout)));
    });
  }
  return undefined;
}

/**
 * Starts sampling the memory of this process and its descendants, and returns a function that stops it. A sample that
 * fails is skipped, which can only lower the recorded peak.
 */
export function startMemorySampler(): () => void {
  let sampling = false;
  const sample = async (): Promise<void> => {
    if (sampling) return;
    sampling = true;
    try {
      const rows = await listProcesses();
      if (rows) peakMemoryBytes = Math.max(peakMemoryBytes, treeMemoryBytes(rows, process.pid));
    } catch {
      // skipped
    } finally {
      sampling = false;
    }
  };
  void sample();
  const timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Counts one model CLI process as running, and returns the function that counts it as ended. Calling that twice counts once. */
export function trackCliProcess(): () => void {
  cliProcesses += 1;
  peakCliProcesses = Math.max(peakCliProcesses, cliProcesses);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    cliProcesses -= 1;
  };
}

/**
 * Records how long this workflow run waited before the action started. The wait covers the queue for a runner and the
 * job's steps before Manki. A run that cannot be read leaves the wait unrecorded.
 */
export async function recordQueueWait(octokit: Octokit): Promise<void> {
  const { owner, repo } = github.context.repo;
  try {
    const { data } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: github.context.runId });
    // A re-run keeps `created_at` of the first attempt.
    const queuedAt = Date.parse(data.run_started_at ?? data.created_at);
    const startedAt = Date.now() - process.uptime() * 1000;
    if (Number.isFinite(queuedAt)) queuedMs = Math.max(0, Math.round(startedAt - queuedAt));
  } catch (error) {
    core.info(`Could not read when this run was queued, so its wait for a runner is not recorded: ${error instanceof Error ? error.message : error}`);
  }
}

/** Returns the runner this process is on and what the run has taken from it so far. */
export function runnerDiagnostics(): RoundRunner {
  const memoryBytes = os.totalmem();
  const limit = process.constrainedMemory();
  // The record is posted with the review, so it holds nothing that names a self-hosted machine, such as `RUNNER_NAME`.
  const environment = process.env.RUNNER_ENVIRONMENT;
  return {
    ...(environment && { environment }),
    os: process.platform,
    arch: process.arch,
    cpus: os.availableParallelism(),
    memoryBytes,
    // Without a limit the value is 0 or far above the machine's memory.
    ...(limit > 0 && limit < memoryBytes && { memoryLimitBytes: limit }),
    ...(queuedMs !== undefined && { queuedMs }),
    ...(peakMemoryBytes > 0 && { peakMemoryBytes }),
    peakCliProcesses,
  };
}

function formatMemory(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;
}

/**
 * Returns one line on `runner`: its kind, the wait for it, and the peak memory against the memory the run may use.
 * `detailed` adds the CPU count and the most model CLI processes at once.
 */
export function formatRunner(runner: RoundRunner, detailed = false): string {
  const available = runner.memoryLimitBytes ?? runner.memoryBytes;
  const parts = [
    runner.environment ?? runner.os,
    runner.queuedMs !== undefined && `waited ${formatDuration(runner.queuedMs)}`,
    runner.peakMemoryBytes !== undefined ? `peak memory ${formatMemory(runner.peakMemoryBytes)} of ${formatMemory(available)}` : `${formatMemory(available)} memory`,
    detailed && `${runner.cpus} ${runner.cpus === 1 ? 'CPU' : 'CPUs'}`,
    detailed && `up to ${runner.peakCliProcesses} model CLI ${runner.peakCliProcesses === 1 ? 'process' : 'processes'} at once`,
  ].filter((part): part is string => !!part);
  return `Runner: ${parts.join(' · ')}`;
}
