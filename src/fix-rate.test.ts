import * as core from '@actions/core';

import { aggregateFixRates, calibrate, finderModel, readFixRateHistory, recordFixRate } from './fix-rate';
import { MemoryStore } from './memory';
import { fetchRecapState, PreviousFinding } from './recap';
import { makeFindingFingerprintEntry, makeRoundContext, TEST_BOT } from './test-utils';
import { Finding, RoundRouting } from './types';

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

const PR = { number: 42, headSha: 'head', mergedSha: 'merged', authorLogin: 'author', clearRole: 'maintain' as const };

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
          routing: routing('full', 'digest-1'),
          findings: {
            count: 4,
            severityCounts: {},
            entries: [
              { ...makeFindingFingerprintEntry({ title: 'Changed line', file: 'src/a.ts', lineStart: 10, severity: 'warning', specialist: 'Security' }), checkStatus: 'confirmed', toolEvidence: 'confirmed', category: 'security', effort: 'quick', evidence: { checks: ['read src/a.ts:10'], proof: ['src/a.ts:10'] }, refutation: { outcome: 'confirmed', reason: 'Reachable.', files: ['src/a.ts'], codeDigest: 'd' } },
              makeFindingFingerprintEntry({ title: 'Judge addressed', file: 'src/b.ts', lineStart: 5, severity: 'note', specialist: 'Style', threadId: 'T_B' }),
              // A finding whose only proof is a line of a related repo cited evidence too.
              { ...makeFindingFingerprintEntry({ title: 'Human resolved', file: 'src/b.ts', lineStart: 20, severity: 'warning', specialist: 'Security', threadId: 'T_C' }), checkStatus: 'confirmed', toolEvidence: 'confirmed', category: 'security', effort: 'quick', evidence: { checks: [], proof: [], relatedProof: ['acme/reports:src/import.ts:2'] }, refutation: { outcome: 'confirmed', reason: 'Reachable.', files: ['src/a.ts'], codeDigest: 'd' } },
              { ...makeFindingFingerprintEntry({ title: 'Far from change', file: 'src/a.ts', lineStart: 80, severity: 'warning', reviewers: ['Security', 'Style'] }), checkStatus: 'unconfirmed', toolEvidence: 'none', category: 'style', effort: 'moderate' },
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
        thread('T_D', { status: 'replied', authorReplyLogin: 'author', authorReplyText: 'Good catch', replyAgreed: true }),
        thread('T_F', { status: 'replied', authorReplyLogin: 'someone', authorReplyText: 'Good catch', replyAgreed: true }),
      ],
    });
  });

  it('counts fixed, dismissed and untouched findings per specialist and category, and per check status, tool evidence, category, effort, evidence and judge check, and appends them to the memory repo', async () => {
    const github = mockOctokit();
    const memory = mockMemoryStore();

    await recordFixRate(github.octokit, TEST_BOT, 'owner', 'repo', PR, memory);

    const expected = {
      pr: 42,
      mergedSha: 'merged',
      rounds: 2,
      mankiVersion: '5.0.0-test',
      class: 'security',
      group: 'deep',
      configDigest: 'digest-2',
      counts: [
        { severity: 'warning', specialist: 'Security', category: 'security', posted: 2, fixed: 1, dismissed: 1, untouched: 0 },
        { severity: 'note', specialist: 'Style', category: 'unknown', posted: 3, fixed: 1, dismissed: 1, untouched: 1 },
        { severity: 'warning', specialist: 'Security', category: 'style', posted: 1, fixed: 0, dismissed: 0, untouched: 1 },
      ],
      calibration: [
        { severity: 'warning', checkStatus: 'confirmed', toolEvidence: 'confirmed', category: 'security', effort: 'quick', hadEvidence: true, judgeChecked: true, posted: 2, fixed: 1, dismissed: 1, untouched: 0 },
        { severity: 'note', checkStatus: 'unknown', toolEvidence: 'unknown', category: 'unknown', effort: 'unknown', hadEvidence: false, judgeChecked: false, posted: 3, fixed: 1, dismissed: 1, untouched: 1 },
        { severity: 'warning', checkStatus: 'unconfirmed', toolEvidence: 'none', category: 'style', effort: 'moderate', hadEvidence: false, judgeChecked: false, posted: 1, fixed: 0, dismissed: 0, untouched: 1 },
      ],
    };
    expect(summaryLine()).toEqual(expected);
    expect(core.summary.write).toHaveBeenCalled();
    expect(github.repos.compareCommits).toHaveBeenCalledWith(expect.objectContaining({ base: 'sha1', head: 'head' }));
    // The threads are read with the role a PR author needs, so an override counts as it did on the PR.
    expect(fetchRecapState).toHaveBeenCalledWith(expect.anything(), TEST_BOT, 'owner', 'repo', 42, 'author', 'maintain');

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

  it.each([
    ['the lower of two versions, compared as numbers', ['7.7.10', '7.7.6'], '7.7.6'],
    ['the lower version of an earlier round', ['7.7.6', '7.7.10'], '7.7.6'],
    ['no version when a round has none', ['7.7.6', undefined], undefined],
    ['no version when a round could not read its own', ['unknown', '7.7.6'], undefined],
    ['no version when the only round could not read its own', ['unknown'], undefined],
  ])('records %s', async (_case, versions, expected) => {
    jest.mocked(fetchRecapState).mockResolvedValue({
      priorRounds: versions.map((mankiVersion, i) => {
        const round = makeRoundContext(i + 1);
        return { ...round, meta: { ...round.meta, mankiVersion: mankiVersion as string } };
      }),
      previousFindings: [],
    });

    await recordFixRate(mockOctokit().octokit, TEST_BOT, 'owner', 'repo', PR);

    expect(summaryLine()).toMatchObject({ rounds: versions.length });
    expect(summaryLine().mankiVersion).toBe(expected);
  });

  it('records nothing when Manki never reviewed the pull request', async () => {
    jest.mocked(fetchRecapState).mockResolvedValue({ priorRounds: [], previousFindings: [] });
    const memory = mockMemoryStore();

    await recordFixRate(mockOctokit().octokit, TEST_BOT, 'owner', 'repo', PR, memory);

    expect(core.summary.write).not.toHaveBeenCalled();
    expect(memory.append).not.toHaveBeenCalled();
  });
});

describe('fix-rate calibration', () => {
  const row = (severity: string, specialist: string, posted: number, fixed: number, category?: string) =>
    ({ severity, specialist, ...(category && { category }), posted, fixed, dismissed: 0, untouched: posted - fixed });
  const LINES = [
    JSON.stringify({ pr: 1, counts: [row('warning', 'GPT 6.2 Sol · high', 15, 3, 'correctness'), row('warning', 'GPT 6.2 Sol · high', 4, 0, 'style')] }),
    'not json',
    JSON.stringify({ pr: 2, counts: [row('warning', 'GPT 6.2 Sol · medium · focus', 10, 2, 'correctness')] }),
    // Written before `counts` held the category.
    JSON.stringify({ pr: 3, counts: [row('warning', 'Claude Opus 5.5 · high', 8, 1)] }),
  ];
  const finding = (overrides: Partial<Finding>): Finding => ({
    severity: 'warning', title: 't', file: 'src/a.ts', line: 1, description: 'd', reviewers: ['GPT 6.2 Sol · xhigh'], category: 'correctness', ...overrides,
  });

  it('sums posted and fixed findings per class with and without the category, skipping a line that is no JSON', () => {
    expect(aggregateFixRates(LINES)).toEqual(new Map([
      ['warning · GPT 6.2 Sol', { posted: 29, fixed: 5 }],
      ['warning · GPT 6.2 Sol · correctness', { posted: 25, fixed: 5 }],
      ['warning · GPT 6.2 Sol · style', { posted: 4, fixed: 0 }],
      ['warning · Claude Opus 5.5', { posted: 8, fixed: 1 }],
    ]));
  });

  it.each([
    ['the class with its category once it has 20 posted', finding({}), { class: 'warning · GPT 6.2 Sol · correctness', posted: 25, fixed: 5, rate: 0.2, wouldLower: true }],
    ['the class without the category below 20 posted', finding({ category: 'style' }), { class: 'warning · GPT 6.2 Sol', posted: 29, fixed: 5, rate: 0.17, wouldLower: true }],
    ['a rate just under 30% that rounds to it, which still lowers', finding({ severity: 'note' }),
      { class: 'note · GPT 6.2 Sol', posted: 200, fixed: 59, rate: 0.3, wouldLower: true }, [row('note', 'GPT 6.2 Sol · high', 200, 59)]],
    ['a low rate below the sample size, which lowers nothing', finding({ reviewers: ['Claude Opus 5.5 · high'] }), { class: 'warning · Claude Opus 5.5', posted: 8, fixed: 1, rate: 0.13, wouldLower: false }],
    ['no class for a class without history', finding({ severity: 'blocker' }), undefined],
    ['no class for a security finding', finding({ tags: ['security'] }), undefined],
    ['no class for a tool alert', finding({ toolSource: 'zizmor' }), undefined],
  ])('gives %s', (_case, f, expected, counts: ReturnType<typeof row>[] = []) => {
    expect(calibrate(aggregateFixRates([...LINES, JSON.stringify({ pr: 4, counts })]), f)).toEqual(expected);
  });

  it.each([
    ['GPT 6.2 Sol · high', 'GPT 6.2 Sol'],
    ['Claude Opus 5 · xhigh · Concurrency and locking #2', 'Claude Opus 5'],
    ['Quick check · Claude Sonnet 5.5', 'Claude Sonnet 5.5'],
    ['Quick check · Claude Sonnet 5.5 #2', 'Claude Sonnet 5.5'],
    ['Sweep 1', 'Sweep'],
    ['Second read 2', 'Second read'],
    ['Claim check 4', 'Claim check'],
    ['Fix check 1', 'Fix check'],
    ['Sibling field: utxos vs spent_before_funded', 'Sibling field'],
    ['Pattern check: refresh_reported_addresses', 'Pattern check'],
    ['Verdict reader', 'Verdict reader'],
    ['Security', 'Security'],
  ])('takes the model or kind of reviewer %s', (name, model) => {
    expect(finderModel(name)).toBe(model);
  });

  it('reads the newest 500 lines of the history, and nothing when the file is missing or the read fails', async () => {
    const store = mockMemoryStore();
    const lines = Array.from({ length: 501 }, (_, i) => JSON.stringify({ pr: i, counts: [row('note', 'Claude Opus 5.5 · high', 1, i === 0 ? 0 : 1)] }));
    store.read.mockResolvedValueOnce({ sha: 's', text: `${lines.join('\n')}\n` });
    expect(await readFixRateHistory(store)).toEqual(new Map([['note · Claude Opus 5.5', { posted: 500, fixed: 500 }]]));
    expect(store.read).toHaveBeenCalledWith('metrics/fix-rate.jsonl');

    store.read.mockResolvedValueOnce({ text: null });
    expect(await readFixRateHistory(store)).toBeUndefined();
    store.read.mockRejectedValueOnce(new Error('the token service answered 502 to `/memory/read`'));
    expect(await readFixRateHistory(store)).toBeUndefined();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Failed to read the fix-rate history from owner/review-memory'));
  });
});
