import * as core from '@actions/core';

import { recordFixRate } from './fix-rate';
import { fetchRecapState, PreviousFinding } from './recap';
import { makeFindingFingerprintEntry, makeRoundContext } from './test-utils';

jest.mock('@actions/core', () => {
  const summary = {
    addHeading: jest.fn().mockReturnThis(),
    addCodeBlock: jest.fn().mockReturnThis(),
    write: jest.fn().mockResolvedValue(undefined),
  };
  return { info: jest.fn(), warning: jest.fn(), debug: jest.fn(), summary };
});

jest.mock('./recap', () => ({
  ...jest.requireActual('./recap'),
  fetchRecapState: jest.fn(),
}));

type Octokit = Parameters<typeof recordFixRate>[0];

const DIFF_SINCE_ROUND_1 = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -9,3 +9,3 @@',
  ' line9',
  '-line10',
  '+line10 fixed',
  ' line11',
  '',
].join('\n');

function thread(threadId: string, overrides: Partial<PreviousFinding> = {}): PreviousFinding {
  return { title: threadId, file: 'src/b.ts', line: 1, severity: 'warning', status: 'open', threadId, ...overrides };
}

function mockOctokit(existingMetrics: string | null = null) {
  const repos = {
    compareCommits: jest.fn(async ({ base }: { base: string }) => ({ data: base === 'sha1' ? DIFF_SINCE_ROUND_1 : '' })),
    getContent: jest.fn(async () => {
      if (existingMetrics === null) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { data: { sha: 'file-sha', encoding: 'base64', content: Buffer.from(existingMetrics).toString('base64') } };
    }),
    createOrUpdateFileContents: jest.fn().mockResolvedValue({}),
  };
  return { repos, octokit: { rest: { repos } } as unknown as Octokit };
}

const PR = { number: 42, headSha: 'head', mergedSha: 'merged', authorLogin: 'author' };

function summaryLine(): Record<string, unknown> {
  return JSON.parse(jest.mocked(core.summary.addCodeBlock).mock.calls[0][0]);
}

describe('recordFixRate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(fetchRecapState).mockResolvedValue({
      priorRounds: [
        makeRoundContext(1, {
          findings: {
            count: 4,
            severityCounts: {},
            entries: [
              makeFindingFingerprintEntry({ title: 'Changed line', file: 'src/a.ts', lineStart: 10, severity: 'warning', specialist: 'Security' }),
              makeFindingFingerprintEntry({ title: 'Judge addressed', file: 'src/b.ts', lineStart: 5, severity: 'suggestion', specialist: 'Style', threadId: 'T_B' }),
              makeFindingFingerprintEntry({ title: 'Human resolved', file: 'src/b.ts', lineStart: 20, severity: 'warning', specialist: 'Security', threadId: 'T_C' }),
              makeFindingFingerprintEntry({ title: 'Far from change', file: 'src/a.ts', lineStart: 80, severity: 'warning', specialist: 'Security' }),
            ],
          },
        }),
        makeRoundContext(2, {
          judge: { summary: '', threadEvaluations: [{ threadId: 'T_B', status: 'addressed', reason: 'fixed' }] },
          findings: {
            count: 2,
            severityCounts: {},
            entries: [
              makeFindingFingerprintEntry({ title: 'Author agreed', file: 'src/c.ts', lineStart: 3, severity: 'nitpick', specialist: 'Style', threadId: 'T_D' }),
              makeFindingFingerprintEntry({ title: 'Bystander agreed', file: 'src/c.ts', lineStart: 30, severity: 'nitpick', specialist: 'Style', threadId: 'T_F' }),
            ],
          },
        }),
      ],
      previousFindings: [
        thread('T_B', { status: 'resolved' }),
        thread('T_C', { status: 'resolved' }),
        thread('T_D', { status: 'replied', authorReplyLogin: 'author', authorReplyText: 'Good catch' }),
        thread('T_F', { status: 'replied', authorReplyLogin: 'someone', authorReplyText: 'Good catch' }),
      ],
    });
  });

  it('counts fixed, dismissed and untouched findings and appends them to the memory repo', async () => {
    const github = mockOctokit();
    const memory = mockOctokit('{"pr":41}\n');

    await recordFixRate(github.octokit, 'owner', 'repo', PR, { octokit: memory.octokit, repo: 'owner/review-memory' });

    const expected = {
      pr: 42,
      mergedSha: 'merged',
      rounds: 2,
      counts: [
        { severity: 'warning', specialist: 'Security', posted: 3, fixed: 1, dismissed: 1, untouched: 1 },
        { severity: 'suggestion', specialist: 'Style', posted: 1, fixed: 1, dismissed: 0, untouched: 0 },
        { severity: 'nitpick', specialist: 'Style', posted: 2, fixed: 0, dismissed: 1, untouched: 1 },
      ],
    };
    expect(summaryLine()).toEqual(expected);
    expect(core.summary.write).toHaveBeenCalled();
    expect(github.repos.compareCommits).toHaveBeenCalledWith(expect.objectContaining({ base: 'sha1', head: 'head' }));

    const write = memory.repos.createOrUpdateFileContents.mock.calls[0][0];
    expect(write).toMatchObject({ owner: 'owner', repo: 'review-memory', path: 'repo/metrics/fix-rate.jsonl', sha: 'file-sha' });
    expect(Buffer.from(write.content, 'base64').toString('utf-8')).toBe(`{"pr":41}\n${JSON.stringify(expected)}\n`);
  });

  it('writes only the job summary without a memory repo, and marks a failed compare as partial', async () => {
    const github = mockOctokit();
    github.repos.compareCommits.mockRejectedValueOnce(new Error('diff too large'));

    await recordFixRate(github.octokit, 'owner', 'repo', PR);

    expect(summaryLine()).toMatchObject({ pr: 42, partial: true });
    expect(github.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('records nothing when Manki never reviewed the pull request', async () => {
    jest.mocked(fetchRecapState).mockResolvedValue({ priorRounds: [], previousFindings: [] });
    const memory = mockOctokit();

    await recordFixRate(mockOctokit().octokit, 'owner', 'repo', PR, { octokit: memory.octokit, repo: 'owner/review-memory' });

    expect(core.summary.write).not.toHaveBeenCalled();
    expect(memory.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });
});
