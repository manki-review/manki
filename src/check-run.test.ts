import * as core from '@actions/core';

import { RunCancelledError, stopWritesOn } from './abort';
import { completeReviewCheck, ReviewCheck, startReviewCheck } from './check-run';

describe('completeReviewCheck', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('tries once more after a failed completion, and warns only when that fails too', async () => {
    jest.useFakeTimers();
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const update = jest.fn().mockRejectedValueOnce(new Error('Not Found')).mockResolvedValueOnce({});
    const check = { octokit: { rest: { checks: { update } } }, owner: 'o', repo: 'r', id: 5 } as unknown as ReviewCheck;
    const complete = async () => {
      const done = completeReviewCheck(check, { conclusion: 'success', title: 'Approved', summary: '' });
      await jest.advanceTimersByTimeAsync(3_000);
      await done;
    };

    await complete();
    expect(update.mock.calls).toEqual([1, 2].map(() => [{ owner: 'o', repo: 'r', check_run_id: 5, status: 'completed', conclusion: 'success', output: { title: 'Approved', summary: 'Approved' } }]));
    expect(warning).not.toHaveBeenCalled();

    update.mockRejectedValue(new Error('Not Found'));
    await complete();
    expect(update).toHaveBeenCalledTimes(4);
    expect(warning.mock.calls).toEqual([['Could not complete the Manki check: Not Found']]);
  });

  it('skips the retry once the run is cancelled during the wait', async () => {
    jest.useFakeTimers();
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const update = jest.fn().mockRejectedValue(new Error('Not Found'));
    const check = { octokit: { rest: { checks: { update } } }, owner: 'o', repo: 'r', id: 5 } as unknown as ReviewCheck;
    const done = completeReviewCheck(check, { conclusion: 'success', title: 'Approved', summary: '' });
    const { release } = stopWritesOn(AbortSignal.abort(new RunCancelledError('SIGTERM')));
    try {
      await jest.advanceTimersByTimeAsync(3_000);
      await done;
    } finally {
      release();
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls).toEqual([['Could not complete the Manki check: The run was cancelled by SIGTERM']]);
  });
});

describe('startReviewCheck', () => {
  it('throws before any write once the run is cancelled', async () => {
    const checks = { create: jest.fn(), update: jest.fn() };
    const octokit = { rest: { checks } } as unknown as Parameters<typeof startReviewCheck>[0];
    const { release } = stopWritesOn(AbortSignal.abort(new RunCancelledError('SIGTERM')));
    try {
      await expect(startReviewCheck(octokit, 'o', 'r', 'abc123')).rejects.toBeInstanceOf(RunCancelledError);
    } finally {
      release();
    }
    expect(checks.create).not.toHaveBeenCalled();
    expect(checks.update).not.toHaveBeenCalled();
  });
});
