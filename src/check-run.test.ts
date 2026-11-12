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

/** The App's `Manki` checks as GitHub lists them. */
const listed = (...ids: number[]) => ({ data: { total_count: ids.length, check_runs: ids.map(id => ({ id })) } });

/** The checks API with this run's check 901, where `others` are the App's other `Manki` checks on `HEAD`. */
function checksApi(others: number[] = []) {
  const checks = mockChecks(901, others);
  return { checks, octokit: { rest: { checks } } as unknown as Octokit };
}

const APPROVED: CheckReport = outcomeReport('READY', 'Nothing blocks.');
const completed = { status: 'completed', conclusion: 'success', output: { title: 'Approved', summary: 'Nothing blocks.' } };
const NOT_ALONE = `this run's check is not the only Manki check of the App on ${HEAD}`;
const extraCheck = { owner: OWNER, repo: REPO, name: 'Manki', head_sha: HEAD, details_url: RUN_URL, ...completed };

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

  it('writes the verdict into this run\'s check alone while it is the only `Manki` check of the App on the head', async () => {
    const mock = checksApi();

    expect(await complete(mock)).toEqual([]);

    expect(mock.checks.update.mock.calls).toEqual([[{ owner: OWNER, repo: REPO, check_run_id: 901, ...completed }]]);
    // Only checks of the App that owns this run's check are listed, in every state, so a `Manki` check of another App changes nothing.
    expect(mock.checks.listForRef.mock.calls).toEqual([[{ owner: OWNER, repo: REPO, ref: HEAD, check_name: 'Manki', app_id: TEST_APP_ID, filter: 'all', per_page: 100 }]]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each<[string, (mock: ReturnType<typeof checksApi>) => void, string]>([
    ['another check of the App is on the head, with a higher id', () => {}, NOT_ALONE],
    ['another check of the App is on the head, with a lower id', mock => mock.checks.listForRef.mockResolvedValue(listed(901, 5)), NOT_ALONE],
    ['the list holds more checks than the page returned', mock => mock.checks.listForRef.mockResolvedValue({ data: { total_count: 101, check_runs: [{ id: 901 }] } }), NOT_ALONE],
    ['the list names one check that is not this run\'s', mock => mock.checks.listForRef.mockResolvedValue(listed(5)), NOT_ALONE],
    ['the list is empty', mock => mock.checks.listForRef.mockResolvedValue(listed()), NOT_ALONE],
    ['the list call fails', mock => mock.checks.listForRef.mockRejectedValue(new Error('API 502')), `the Manki checks on ${HEAD} could not be listed (API 502)`],
    ['the completed check names no App', mock => mock.checks.update.mockResolvedValue({ data: { id: 901, app: null } }), 'the App that owns this run\'s check is unknown'],
    ['this run\'s check cannot be completed', mock => mock.checks.update.mockRejectedValue(new Error('API 500')), 'the App that owns this run\'s check is unknown'],
  ])('also writes the verdict into a new check when %s', async (name, arrange, reason) => {
    const mock = checksApi(name.includes('higher id') ? [950] : []);
    arrange(mock);

    expect(await complete(mock)).toEqual([extraCheck]);

    expect(mock.checks.update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 901, ...completed }));
    expect(jest.mocked(core.info).mock.calls.at(-1)?.[0]).toBe(`Wrote "Approved" into a new Manki check as well, since ${reason}`);
    // Without the App there is nothing to list by.
    if (reason.includes('unknown')) expect(mock.checks.listForRef).not.toHaveBeenCalled();
    expect(jest.mocked(core.warning).mock.calls.map(([message]) => message)).toEqual(
      name.includes('cannot be completed') ? ['Could not complete the Manki check: API 500'] : [],
    );
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
