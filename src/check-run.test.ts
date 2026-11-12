import * as core from '@actions/core';
import * as github from '@actions/github';

import { cancelOpenReviewCheck, CheckReport, completeReviewCheck, outcomeReport, startReviewCheck } from './check-run';
import { mockChecks, TEST_APP_ID } from './test-utils';

jest.mock('@actions/core');
jest.mock('@actions/github', () => ({ context: { serverUrl: 'https://github.com', runId: 12345 } }));

type Octokit = ReturnType<typeof github.getOctokit>;

const OWNER = 'test-owner';
const REPO = 'test-repo';
const HEAD = 'abc123';
const RUN_URL = 'https://github.com/test-owner/test-repo/actions/runs/12345';

/** The App's `Manki` checks as GitHub lists them: this run's check 901, completed, and `others` as pairs of id and status. */
const listed = (...others: Array<[number, string]>) => {
  const check_runs = [...others, [901, 'completed'] as const].map(([id, status]) => ({ id, status }));
  return { data: { total_count: check_runs.length, check_runs } };
};

/** The checks API with this run's check 901, where `others` are the App's other `Manki` checks on `HEAD`. */
function checksApi(others: number[] = []) {
  const checks = mockChecks(901, others);
  return { checks, octokit: { rest: { checks } } as unknown as Octokit };
}

const APPROVED: CheckReport = outcomeReport('READY', 'Nothing blocks.');
const completed = { status: 'completed', conclusion: 'success', output: { title: 'Approved', summary: 'Nothing blocks.' } };
const extraCheck = { owner: OWNER, repo: REPO, name: 'Manki', head_sha: HEAD, details_url: RUN_URL, ...completed };

/** The results a required check passes on. */
const PASSING: CheckReport[] = [APPROVED, outcomeReport('READY', 'Nothing blocks.', 'draft'), { conclusion: 'skipped', title: 'Skipped', summary: 'A skip rule matched.' }];
/** The results that block a required check. */
const BLOCKING: CheckReport[] = [
  outcomeReport('ADDRESS_FIRST', '1 blocker.'),
  { conclusion: 'action_required', title: 'Not reviewed', summary: 'Too big to review.' },
];

const NOT_ALONE = `this run's check is not the only Manki check of the App on ${HEAD}`;
const RUNNING = `another Manki check of the App on ${HEAD} has not completed`;
const NOT_WHOLE = `the list of Manki checks on ${HEAD} is not whole`;
const NO_APP = 'the App that owns this run\'s check is unknown';

describe('completeReviewCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Starts this run's check and completes it with `report`, and returns the checks created after the start. */
  async function complete(checks: ReturnType<typeof checksApi>, report = APPROVED) {
    const check = await startReviewCheck(checks.octokit, OWNER, REPO, HEAD);
    expect(check).toMatchObject({ id: 901, headSha: HEAD });
    checks.checks.create.mockClear();
    await completeReviewCheck(check, report);
    return checks.checks.create.mock.calls.map(([params]) => params);
  }

  it('writes the result into this run\'s check alone while it is the only `Manki` check of the App on the head', async () => {
    for (const report of [...BLOCKING, ...PASSING.slice(1)]) expect(await complete(checksApi(), report)).toEqual([]);
    expect(core.info).not.toHaveBeenCalled();
    const mock = checksApi();

    expect(await complete(mock)).toEqual([]);

    expect(mock.checks.update.mock.calls).toEqual([[{ owner: OWNER, repo: REPO, check_run_id: 901, ...completed }]]);
    // Only checks of the App that owns this run's check are listed, in every state, so a `Manki` check of another App changes nothing.
    expect(mock.checks.listForRef.mock.calls).toEqual([[{ owner: OWNER, repo: REPO, ref: HEAD, check_name: 'Manki', app_id: TEST_APP_ID, filter: 'all', per_page: 100 }]]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each<[string, (mock: ReturnType<typeof checksApi>['checks']) => void, string, boolean]>([
    ['another check has completed, with a higher id', checks => checks.listForRef.mockResolvedValue(listed([950, 'completed'])), NOT_ALONE, true],
    ['another check has completed, with a lower id', checks => checks.listForRef.mockResolvedValue(listed([5, 'completed'])), NOT_ALONE, true],
    ['another check is in progress, with a higher id', checks => checks.listForRef.mockResolvedValue(listed([950, 'in_progress'])), RUNNING, false],
    ['another check is in progress, with a lower id', checks => checks.listForRef.mockResolvedValue(listed([5, 'in_progress'])), RUNNING, false],
    ['another check is queued', checks => checks.listForRef.mockResolvedValue(listed([950, 'queued'])), RUNNING, false],
    ['one other check has completed and one is queued', checks => checks.listForRef.mockResolvedValue(listed([5, 'completed'], [950, 'queued'])), RUNNING, false],
    ['the list holds more checks than the page returned', checks => checks.listForRef.mockResolvedValue({ data: { ...listed().data, total_count: 101 } }), NOT_WHOLE, false],
    ['the list does not name this run\'s check', checks => checks.listForRef.mockResolvedValue({ data: { total_count: 1, check_runs: [{ id: 5, status: 'completed' }] } }), NOT_WHOLE, false],
    ['the list is empty', checks => checks.listForRef.mockResolvedValue({ data: { total_count: 0, check_runs: [] } }), NOT_WHOLE, false],
    ['the list call fails', checks => checks.listForRef.mockRejectedValue(new Error('API 502')), `the Manki checks on ${HEAD} could not be listed (API 502)`, false],
    ['the completed check names no App', checks => checks.update.mockResolvedValue({ data: { id: 901, app: null } }), NO_APP, false],
    ['this run\'s check cannot be completed', checks => checks.update.mockRejectedValue(new Error('API 500')), NO_APP, false],
  ])('writes a blocking result into a new check, and a passing one only beside completed checks, when %s', async (name, arrange, why, passingToo) => {
    for (const report of [...PASSING, ...BLOCKING]) {
      const written = passingToo || BLOCKING.includes(report);
      const mock = checksApi();
      arrange(mock.checks);
      jest.mocked(core.warning).mockClear();
      const result = { status: 'completed', conclusion: report.conclusion, output: { title: report.title, summary: report.summary } };

      expect(await complete(mock, report)).toEqual(written ? [{ ...extraCheck, ...result }] : []);

      expect(mock.checks.update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 901, ...result }));
      expect(jest.mocked(core.info).mock.calls.at(-1)?.[0]).toBe(written
        ? `Wrote "${report.title}" into a new Manki check as well, since ${why}`
        : `No new Manki check for "${report.title}", since ${why}`);
      // Without the App there is nothing to list by.
      if (why === NO_APP) expect(mock.checks.listForRef).not.toHaveBeenCalled();
      expect(jest.mocked(core.warning).mock.calls.map(([message]) => message)).toEqual(
        name.includes('cannot be completed') ? ['Could not complete the Manki check: API 500'] : [],
      );
    }
  });

  it('warns and does not throw when the new check cannot be created', async () => {
    const mock = checksApi([950]);
    const check = await startReviewCheck(mock.octokit, OWNER, REPO, HEAD);
    mock.checks.create.mockRejectedValue(new Error('Resource not accessible by integration'));

    await expect(completeReviewCheck(check, APPROVED)).resolves.toBeUndefined();

    expect(core.warning).toHaveBeenCalledWith('Could not write "Approved" into a new Manki check: Resource not accessible by integration');
  });

  it('writes every result but a cancelled one into the new check, with the same title and summary', async () => {
    const failed = { conclusion: 'failure' as const, title: 'Changes requested', summary: '  1 blocker.  ' };
    expect(await complete(checksApi([950]), failed)).toEqual([{ ...extraCheck, conclusion: 'failure', output: { title: 'Changes requested', summary: '1 blocker.' } }]);
    expect(await complete(checksApi([950]), outcomeReport('READY', '', 'draft')))
      .toEqual([{ ...extraCheck, conclusion: 'neutral', output: { title: 'Approval held: the PR is a draft', summary: 'Approval held: the PR is a draft' } }]);

    // A cancelled run reached no verdict, so it never takes the place of a newer check.
    const mock = checksApi([950]);
    expect(await complete(mock, { conclusion: 'cancelled', title: 'Superseded', summary: 'The head moved.' })).toEqual([]);
    expect(mock.checks.update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 901, status: 'completed', conclusion: 'cancelled' }));
    expect(mock.checks.listForRef).not.toHaveBeenCalled();
  });

  it('does nothing without a check', async () => {
    await expect(completeReviewCheck(undefined, APPROVED)).resolves.toBeUndefined();
  });
});

describe('cancelOpenReviewCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(core.getState).mockReturnValue('901');
  });

  it('cancels the check the main step left in progress, and creates no new check beside a newer one', async () => {
    const mock = checksApi([950]);

    await cancelOpenReviewCheck(mock.octokit, OWNER, REPO);

    expect(core.getState).toHaveBeenCalledWith('manki_check_run');
    expect(mock.checks.update.mock.calls).toEqual([[{
      owner: OWNER, repo: REPO, check_run_id: 901, status: 'completed', conclusion: 'cancelled',
      output: { title: 'Review stopped', summary: 'The run ended before the review finished.' },
    }]]);
    expect(mock.checks.listForRef).not.toHaveBeenCalled();
    expect(mock.checks.create).not.toHaveBeenCalled();
  });

  it.each<[string, (mock: ReturnType<typeof checksApi>) => void]>([
    ['a check that already completed', mock => mock.checks.get.mockResolvedValue({ data: { id: 901, status: 'completed', head_sha: HEAD } })],
    ['a check that cannot be read', mock => mock.checks.get.mockRejectedValue(new Error('API 502'))],
    ['a run that started no check', () => jest.mocked(core.getState).mockReturnValue('')],
  ])('leaves %s alone', async (_name, arrange) => {
    const mock = checksApi();
    arrange(mock);

    await cancelOpenReviewCheck(mock.octokit, OWNER, REPO);

    expect(mock.checks.update).not.toHaveBeenCalled();
    expect(mock.checks.create).not.toHaveBeenCalled();
  });
});
