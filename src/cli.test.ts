import { existsSync, readdirSync } from 'fs';

import { exitCodeOf, formatReviewJson, formatReviewText, parseReviewArgs, runCliCommand, runReviewCommand } from './cli';
import type { ApprovalHeld } from './github';
import type { LocalReview } from './local-review';
import type { Finding, RoundContext, RoundOutcome } from './types';

const finding: Finding = {
  severity: 'blocker', title: 'Off by one', file: 'src/a.ts', line: 2, description: 'Reads past the end.', suggestedFix: 'Stop at `len - 1`.',
  reviewers: ['reviewer'], evidence: { checks: ['src/a.ts:2 reads `items[len]`'], proof: ['src/a.ts:2'] }, cell: { row: 'severe', column: 'normal' },
};

function review(outcome: RoundOutcome, findings: Finding[] = [], approvalHeld: ApprovalHeld = false): LocalReview {
  return {
    result: { verdict: outcome === 'READY' ? 'APPROVE' : 'REQUEST_CHANGES', outcome, summary: 'Summary of the round', findings, highlights: [], reviewComplete: outcome !== 'INCOMPLETE', agentNames: ['reviewer'] },
    context: {} as RoundContext,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    approvalHeld,
  };
}

describe('parseReviewArgs', () => {
  it.each([
    [[], { head: 'HEAD' }],
    [['main'], { base: 'main', head: 'HEAD' }],
    [['main..topic'], { base: 'main', head: 'topic' }],
    [['origin/main...topic'], { base: 'origin/main', head: 'topic' }],
    [['--patch', 'p.diff', '--config', 'c.yml', '--title', 'T', '--body-file', 'b.md', '--record', 'r.json', '--json'],
      { head: 'HEAD', patch: 'p.diff', config: 'c.yml', title: 'T', bodyFile: 'b.md', record: 'r.json', json: true }],
    [['--help'], { help: true }],
  ])('reads %j', (argv, expected) => {
    expect(parseReviewArgs(argv)).toMatchObject({ json: false, help: false, ...expected });
  });

  it.each([
    [['--record'], '--record requires a value'],
    [['--title', '--json'], '--title requires a value'],
    [['--bogus'], 'Unknown option --bogus'],
    [['main', 'topic'], 'Unexpected argument topic'],
    [['..topic'], 'No base in ..topic'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseReviewArgs(argv)).toThrow(message);
  });
});

describe('exitCodeOf', () => {
  it.each([
    ['READY', 0],
    ['ADDRESS_FIRST', 1],
    ['NOT_CONVERGING', 1],
    ['INCOMPLETE', 2],
  ] as const)('exits %s with %i', (outcome, code) => {
    expect(exitCodeOf(review(outcome))).toBe(code);
  });

  it('exits 1 for a ready review whose config did not load, since a pull request round holds its approval', () => {
    expect(exitCodeOf(review('READY', [], 'config'))).toBe(1);
  });
});

describe('formatReviewJson', () => {
  it('round-trips the outcome, summary and findings, with every control character escaped', () => {
    const steered = { ...finding, title: 'Off \u001b[2J by \u009b2J one\u007f' };
    const local = review('ADDRESS_FIRST', [finding, steered]);
    const json = formatReviewJson(local);
    expect(json).not.toMatch(/(?![\n])\p{Cc}/u);
    expect(JSON.parse(json)).toEqual({
      outcome: 'ADDRESS_FIRST', verdict: 'REQUEST_CHANGES', summary: 'Summary of the round', base: local.base, head: local.head, findings: [finding, steered],
    });
  });
});

describe('formatReviewText', () => {
  it('lists the outcome, the summary and each finding with its location, fix and checks, without hidden markers', () => {
    const text = formatReviewText(review('ADDRESS_FIRST', [finding]));
    expect(text).toMatch(/^## Changes requested: aaaaaaa\.\.bbbbbbb\n\nSummary of the round\n/);
    expect(text).toContain('**Off by one**');
    expect(text).toContain('`src/a.ts:2`');
    expect(text).toContain('Reads past the end.');
    expect(text).toContain('Stop at `len - 1`.');
    expect(text).toContain('On the flagged line: Reads `items[len]`');
    expect(text).not.toContain('manki-checks');
    // A check that rests on a line of a related repo names that line, linked when the review recorded the fetched commit.
    const commit = 'ab'.repeat(20);
    const local = review('ADDRESS_FIRST', [{
      ...finding,
      refutation: { outcome: 'confirmed', defect: 'confirmed', reason: 'The consumer reads the last item.', relatedProof: ['acme/app:src/list.ts:7'], files: ['src/a.ts'], codeDigest: 'abc' },
      pairRefutation: { outcome: 'unsettled', reason: 'The caller may be gone.', relatedProof: ['acme/tool:lib/run.py:3-4', 'acme/gone:lib/run.py:3'], files: ['src/a.ts'], codeDigest: 'abc' },
    }]);
    const withRelated = formatReviewText({ ...local, result: { ...local.result, relatedRepos: [{ repo: 'acme/app', status: 'fetched', commit }, { repo: 'acme/tool', status: 'fetched' }, { repo: 'acme/gone', status: 'failed', reason: 'not found' }] } });
    expect(withRelated).toContain(`In a related repository: [\`acme/app:src/list.ts:7\`](https://github.com/acme/app/blob/${commit}/src/list.ts#L7)\n`);
    expect(withRelated).toContain('The caller may be gone. See `acme/tool:lib/run.py:3-4`.');
    expect(formatReviewText(local)).not.toMatch(/acme\//);
  });

  it('shows only the outcome and summary when nothing was found, and a held approval as the round would', () => {
    expect(formatReviewText(review('READY'))).toBe('## Approved: aaaaaaa..bbbbbbb\n\nSummary of the round\n');
    expect(formatReviewText(review('READY', [], 'config'))).toMatch(/^## Approval held: a config file did not load: /);
    // The judge's summary is left out when the refuter disproved the round's only finding.
    const clean = review('READY');
    const disproved = { ...clean, result: { ...clean.result, allJudgedFindings: [{ ...finding, title: 'Never reset', severity: 'ignore' as const, gradePath: [{ from: 'blocker' as const, to: 'ignore' as const, by: 'refutation' as const }] }] } };
    expect(formatReviewText(disproved)).toBe('## Approved: aaaaaaa..bbbbbbb\n');
    expect(JSON.parse(formatReviewJson(disproved)).summary).toBe('');
    // A round that requests changes then says what blocks with the top blocker's description.
    const blocked = { ...disproved, result: { ...disproved.result, verdict: 'REQUEST_CHANGES' as const, outcome: 'ADDRESS_FIRST' as const, findings: [finding] } };
    expect(formatReviewText(blocked)).toMatch(/^## Changes requested: aaaaaaa\.\.bbbbbbb\n\nReads past the end\.\n\n---\n/);
    expect(JSON.parse(formatReviewJson(blocked)).summary).toBe('Reads past the end.');
  });

  it('drops control characters a model wrote, keeping tabs and line breaks', () => {
    const text = formatReviewText(review('ADDRESS_FIRST', [{ ...finding, title: 'Off \u001b]52;c;aGk=\u0007by one', description: 'Line\tone\u009b2J' }]));
    expect(text).toContain('**Off ]52;c;aGk=by one**');
    expect(text).toContain('Line\tone2J');
    expect(text).not.toMatch(/(?![\t\n])\p{Cc}/u);
  });
});

describe('runReviewCommand', () => {
  const savedEnv = process.env;
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    process.env = savedEnv;
  });

  it('prints the usage to stdout for --help', async () => {
    expect(await runReviewCommand(['--help'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: manki review'));
  });

  it('fails with exit code 2 on stderr without credentials or with a bad option, and restores stdout', async () => {
    process.env = {};
    const write = process.stdout.write;
    expect(await runReviewCommand([])).toBe(2);
    expect(await runReviewCommand(['--bogus'])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('manki review: No credentials set.'));
    expect(stderr).toHaveBeenCalledWith('manki review: Unknown option --bogus\n');
    expect(stdout).not.toHaveBeenCalled();
    expect(process.stdout.write).toBe(write);
  });
});

describe('runCliCommand', () => {
  it('drops the secret mask lines core logs, and gives the command an empty Codex home it removes afterwards', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const saved = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    let home: string | undefined;
    try {
      const code = await runCliCommand('test', async (out) => {
        process.stdout.write('::add-mask::secret-token\n');
        process.stdout.write('a log line\n');
        home = process.env.CODEX_HOME;
        expect(home && readdirSync(home)).toEqual([]);
        out('');
        return 0;
      });
      expect(code).toBe(0);
      expect(stderr).toHaveBeenCalledWith('a log line\n');
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('secret-token'));
      expect(existsSync(home!)).toBe(false);
      expect(process.env.CODEX_HOME).toBeUndefined();
    } finally {
      stderr.mockRestore();
      if (saved !== undefined) process.env.CODEX_HOME = saved;
    }
  });
});
