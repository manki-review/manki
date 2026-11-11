import * as core from '@actions/core';

import { recordFixRate } from './fix-rate';
import { MemoryStore } from './memory';
import { fetchRecapState, PreviousFinding } from './recap';
import { makeFindingFingerprintEntry, makeRoundContext, TEST_BOT } from './test-utils';
import { RoundRouting } from './types';

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

function mockOctokit() {
  const repos = {
    compareCommits: jest.fn(async ({ base }: { base: string }) => ({ data: base === 'sha1' ? DIFF_SINCE_ROUND_1 : '' })),
  };
  return { repos, octokit: { rest: { repos } } as unknown as Octokit };
}

function mockMemoryStore() {
  return { name: 'owner/review-memory', load: jest.fn(), read: jest.fn(), write: jest.fn(), append: jest.fn().mockResolvedValue(undefined) } satisfies MemoryStore;
}

const PR = { number: 42, headSha: 'head', mergedSha: 'merged', authorLogin: 'author' };

function routing(group: string, configDigest: string): RoundRouting {
  return {
    class: 'security', rank: 100, matched: ['security', 'behavior'], classSource: 'paths', group, groupSource: 'routing',
    floor: 'security', configSource: 'base', configDigest, reviewers: [],
  };
}

function summaryLine(): Record<string, unknown> {
  return JSON.parse(jest.mocked(core.summary.addCodeBlock).mock.calls[0][0]);
}

describe('recordFixRate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(fetchRecapState).mockResolvedValue({
      priorRounds: [
        makeRoundContext(1, {
          routing: routing('pair', 'digest-1'),
          findings: {
            count: 4,
            severityCounts: {},
            entries: [
              { ...makeFindingFingerprintEntry({ title: 'Changed line', file: 'src/a.ts', lineStart: 10, severity: 'warning', specialist: 'Security' }), judgeConfidence: 'high', toolEvidence: 'confirmed', category: 'security', effort: 'quick', evidence: { checks: ['read src/a.ts:10'], proof: ['src/a.ts:10'] }, refutation: { outcome: 'confirmed', reason: 'Reachable.', files: ['src/a.ts'], codeDigest: 'd' } },
              makeFindingFingerprintEntry({ title: 'Judge addressed', file: 'src/b.ts', lineStart: 5, severity: 'note', specialist: 'Style', threadId: 'T_B' }),
              { ...makeFindingFingerprintEntry({ title: 'Human resolved', file: 'src/b.ts', lineStart: 20, severity: 'warning', specialist: 'Security', threadId: 'T_C' }), judgeConfidence: 'high', toolEvidence: 'confirmed', category: 'security', effort: 'quick', evidence: { checks: ['read src/a.ts:10'], proof: ['src/a.ts:10'] }, refutation: { outcome: 'confirmed', reason: 'Reachable.', files: ['src/a.ts'], codeDigest: 'd' } },
              { ...makeFindingFingerprintEntry({ title: 'Far from change', file: 'src/a.ts', lineStart: 80, severity: 'warning', reviewers: ['Security', 'Style'] }), judgeConfidence: 'low', toolEvidence: 'none', category: 'style', effort: 'moderate' },
            ],
          },
        }),
        makeRoundContext(2, {
          routing: routing('deep', 'digest-2'),
          judge: { summary: '', threadEvaluations: [{ threadId: 'T_B', status: 'addressed', reason: 'fixed' }] },
          findings: {
            count: 2,
            severityCounts: {},
            entries: [
              makeFindingFingerprintEntry({ title: 'Author agreed', file: 'src/c.ts', lineStart: 3, severity: 'note', specialist: 'Style', threadId: 'T_D' }),
              makeFindingFingerprintEntry({ title: 'Bystander agreed', file: 'src/c.ts', lineStart: 30, severity: 'note', specialist: 'Style', threadId: 'T_F' }),
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

  it('counts fixed, dismissed and untouched findings per specialist and per confidence, tool evidence, category, effort, evidence and judge check, and appends them to the memory repo', async () => {
    const github = mockOctokit();
    const memory = mockMemoryStore();

    await recordFixRate(github.octokit, TEST_BOT, 'owner', 'repo', PR, memory);

    const expected = {
      pr: 42,
      mergedSha: 'merged',
      rounds: 2,
      class: 'security',
      group: 'deep',
      configDigest: 'digest-2',
      counts: [
        { severity: 'warning', specialist: 'Security', posted: 3, fixed: 1, dismissed: 1, untouched: 1 },
        { severity: 'note', specialist: 'Style', posted: 3, fixed: 1, dismissed: 1, untouched: 1 },
      ],
      calibration: [
        { severity: 'warning', confidence: 'high', toolEvidence: 'confirmed', category: 'security', effort: 'quick', hadEvidence: true, judgeChecked: true, posted: 2, fixed: 1, dismissed: 1, untouched: 0 },
        { severity: 'note', confidence: 'unknown', toolEvidence: 'unknown', category: 'unknown', effort: 'unknown', hadEvidence: false, judgeChecked: false, posted: 3, fixed: 1, dismissed: 1, untouched: 1 },
        { severity: 'warning', confidence: 'low', toolEvidence: 'none', category: 'style', effort: 'moderate', hadEvidence: false, judgeChecked: false, posted: 1, fixed: 0, dismissed: 0, untouched: 1 },
      ],
    };
    expect(summaryLine()).toEqual(expected);
    expect(core.summary.write).toHaveBeenCalled();
    expect(github.repos.compareCommits).toHaveBeenCalledWith(expect.objectContaining({ base: 'sha1', head: 'head' }));

    expect(memory.append).toHaveBeenCalledWith('metrics/fix-rate.jsonl', [JSON.stringify(expected)], 'Record fix rate of owner/repo#42');
  });

  it('writes only the job summary without a memory repo, and marks a failed compare as partial', async () => {
    const github = mockOctokit();
    github.repos.compareCommits.mockRejectedValueOnce(new Error('diff too large'));
    const state = await fetchRecapState(github.octokit, TEST_BOT, 'owner', 'repo', PR.number);
    jest.mocked(fetchRecapState).mockResolvedValueOnce({ ...state, priorRounds: state.priorRounds.map(r => ({ ...r, routing: undefined })) });

    await recordFixRate(github.octokit, TEST_BOT, 'owner', 'repo', PR);

    expect(summaryLine()).toMatchObject({ pr: 42, partial: true });
    const line = summaryLine();
    expect(line).not.toHaveProperty('class');
    expect(line).not.toHaveProperty('group');
    expect(line).not.toHaveProperty('configDigest');
  });

  it('records nothing when Manki never reviewed the pull request', async () => {
    jest.mocked(fetchRecapState).mockResolvedValue({ priorRounds: [], previousFindings: [] });
    const memory = mockMemoryStore();

    await recordFixRate(mockOctokit().octokit, TEST_BOT, 'owner', 'repo', PR, memory);

    expect(core.summary.write).not.toHaveBeenCalled();
    expect(memory.append).not.toHaveBeenCalled();
  });
});
