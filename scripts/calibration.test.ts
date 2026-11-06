import { readFileSync } from 'fs';
import { join } from 'path';

import { FindingFingerprintEntry } from '../src/types';
import { Evidence, findThread, HistoryLine, labelFinding, LabelledFinding, renderReport, roundsByPullRequest, selectSet, Thread } from './calibration';

function thread(slug: string, ...replies: Array<[bot: boolean, body: string]>): Thread {
  return {
    id: `T_${slug}`,
    path: 'src/lib.rs',
    comments: [
      { body: `🚫 **Blocker:** ${slug}\n\nThe text.\n\n<!-- manki:blocker:${slug} -->`, bot: true, url: `https://github.com/o/r/pull/1#${slug}` },
      ...replies.map(([bot, body]) => ({ body, bot })),
    ],
  };
}

function entry(slug: string, severity: FindingFingerprintEntry['severity'] = 'blocker'): FindingFingerprintEntry {
  return { fingerprint: { file: 'src/lib.rs', lineStart: 10, lineEnd: 10, slug }, severity, title: `Title ${slug}` };
}

function labelled(slug: string, severity: FindingFingerprintEntry['severity'], label: LabelledFinding['label'], pr = 1, withThread = true): LabelledFinding {
  return {
    repo: 'o/r', pr, commitSha: 'abc', entry: entry(slug, severity), label, source: label === 'false' ? 'reply-withdrawn' : label === 'real' ? 'line-changed' : 'untouched',
    ...(withThread && { thread: thread(slug) }),
  };
}

describe('labelFinding', () => {
  const none: Evidence = { lineChanged: false, judgeAddressed: false };

  it.each<[string, Evidence, [string, string]]>([
    ['Manki\'s "Fixed." reply', { ...none, thread: thread('a', [false, 'Pushing back.'], [true, '**Fixed.** The guard is in.']) }, ['real', 'reply-fixed']],
    ['Manki\'s "Withdrawn." reply, even when the line changed', { lineChanged: true, judgeAddressed: true, thread: thread('a', [true, 'Withdrawn. The early return covers it.']) }, ['false', 'reply-withdrawn']],
    ['a person saying they fixed it', { ...none, thread: thread('a', [false, 'Fixed in c7251bb. The check runs first.']) }, ['real', 'author-fixed']],
    ['a person saying they added it', { ...none, thread: thread('a', [false, 'Added in db359aa5: a test for the cap.']) }, ['real', 'author-fixed']],
    ['a person turning it down, even when the line changed', { lineChanged: true, judgeAddressed: false, thread: thread('a', [false, 'Pushing back: this is intentional.']) }, ['false', 'author-declined']],
    ['a person skipping it', { ...none, thread: thread('a', [false, 'Skipping. The single slot is intentional.']) }, ['false', 'author-declined']],
    ['a person disagreeing in other words', { ...none, thread: thread('a', [false, 'That is by design, see the docs.']) }, ['false', 'author-declined']],
    ['a person only agreeing, which needs a change to count', { ...none, thread: thread('a', [false, 'Good catch, agreed.']) }, ['unclear', 'untouched']],
    ['the judge marking the thread addressed', { lineChanged: false, judgeAddressed: true, thread: thread('a', [true, 'Unverified. A maintainer should confirm.']) }, ['real', 'judge-addressed']],
    ['a change to the flagged lines', { lineChanged: true, judgeAddressed: false }, ['real', 'line-changed']],
    ['Manki keeping it', { ...none, thread: thread('a', [true, 'Still open. The loop still reads past the end.']) }, ['unclear', 'reply-kept']],
    ['Manki agreeing', { ...none, thread: thread('a', [true, 'Agreed. Deferring is fine.']) }, ['unclear', 'reply-agreed']],
    ['Manki unable to verify', { ...none, thread: thread('a', [true, 'Unverified. A maintainer should confirm.']) }, ['unclear', 'reply-unverified']],
    ['nothing at all', { ...none, thread: thread('a') }, ['unclear', 'untouched']],
  ])('labels a finding from %s', (_case, evidence, expected) => {
    expect(labelFinding(evidence)).toEqual(expected);
  });
});

describe('roundsByPullRequest and findThread', () => {
  it('groups rounds per pull request oldest first, fills missing blocks and skips reply records and records without a commit', () => {
    const lines: HistoryLine[] = [
      { repo: 'o/r', pr: 1, record: { meta: { prNumber: 1, commitSha: 'b', round: 2, timestamp: '' }, findings: { count: 1, severityCounts: {}, entries: [entry('x')] } } as HistoryLine['record'] },
      { repo: 'o/r', pr: 1, record: { meta: { prNumber: 1, commitSha: 'a', round: 1, timestamp: '' } } as HistoryLine['record'] },
      { repo: 'o/r', pr: 2, record: {} },
      { kind: 'reply', repo: 'o/r', pr: 3, record: { meta: { prNumber: 3, commitSha: 'c', round: 1, timestamp: '' } } as HistoryLine['record'] },
    ];

    const rounds = roundsByPullRequest(lines);

    expect([...rounds.keys()]).toEqual(['o/r#1']);
    expect(rounds.get('o/r#1')!.map(r => [r.meta.commitSha, r.findings.entries.length, r.judge])).toEqual([['a', 0, {}], ['b', 1, {}]]);
  });

  it('matches a finding to the thread its record names, or else to a Manki thread by file and marker slug', () => {
    const quoted = thread('x');
    quoted.comments[0] = { ...quoted.comments[0], bot: false };
    const threads = [thread('other'), { ...thread('x'), path: 'src/main.rs' }, quoted, thread('x')];

    expect(findThread(threads, entry('x'))).toBe(threads[3]);
    expect(findThread(threads, { ...entry('x'), threadId: 'T_other' })).toBe(threads[0]);
    expect(findThread(threads, entry('missing'))).toBeUndefined();
  });
});

describe('renderReport', () => {
  it('reports blocker precision per repo, the fix-rate blockers, labels and the fixed findings graded below blocker', () => {
    const findings = [
      labelled('b1', 'blocker', 'real'), labelled('b2', 'blocker', 'real'), labelled('b3', 'blocker', 'false'), labelled('b4', 'blocker', 'unclear'),
      labelled('s1', 'suggestion', 'real'), labelled('w1', 'warning', 'real', 2, false), labelled('n1', 'nitpick', 'false'),
      { ...labelled('o1', 'blocker', 'real'), repo: 'o/other' },
    ];
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fixRate = readFileSync(join(__dirname, 'fixtures', 'fix-rate.jsonl'), 'utf-8').split('\n');

    const report = renderReport(findings, fixRate);
    errorSpy.mockRestore();

    expect(report).toContain('8 posted findings on 3 pull requests.');
    expect(report).toContain([
      '| repo | blockers | real | false | unclear | precision | precision of labelled |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| o/other | 1 | 1 | 0 | 0 | 100% | 100% |',
      '| o/r | 4 | 2 | 1 | 1 | 50% | 67% |',
    ].join('\n'));
    expect(report).toContain('| posted | fixed | dismissed | untouched | precision |\n| ---: | ---: | ---: | ---: | ---: |\n| 1 | 1 | 0 | 0 | 100% |');
    expect(report).toContain('| blocker | 5 | 3 | 1 | 1 |\n| warning | 1 | 1 | 0 | 0 |\n| suggestion | 1 | 1 | 0 | 0 |\n| nitpick | 1 | 0 | 1 | 0 |');
    expect(report).toContain('| line-changed | 5 |\n| reply-withdrawn | 2 |\n| untouched | 1 |');
    expect(report.split('## Missed blockers')[1]).toBe([
      '',
      '',
      'Findings graded below blocker that were fixed. Check whether each one should have blocked.',
      '',
      '- o/r#2 `src/lib.rs:10` warning: Title w1 (line-changed)',
      '- [o/r#1](https://github.com/o/r/pull/1#s1) `src/lib.rs:10` suggestion: Title s1 (line-changed)',
      '',
    ].join('\n'));
    expect(renderReport([])).not.toContain('fix-rate.jsonl');
    expect(renderReport([])).toContain('## Missed blockers\n\nFindings graded below blocker that were fixed. Check whether each one should have blocked.\n\nNone.\n');
  });
});

describe('selectSet', () => {
  it('exports labelled findings with a posted comment, false ones first, then real blockers, newest first, up to the limit', () => {
    const findings = [
      labelled('s-old', 'suggestion', 'real', 1), labelled('b-old', 'blocker', 'real', 1), labelled('u', 'blocker', 'unclear', 3),
      labelled('b-new', 'blocker', 'real', 2), labelled('f', 'warning', 'false', 1), labelled('no-thread', 'blocker', 'real', 4, false),
    ];

    const set = selectSet(findings, 4);

    expect(set.map(s => [s.id, s.label])).toEqual([
      ['o/r#1:src/lib.rs:f', 'false'], ['o/r#2:src/lib.rs:b-new', 'real'], ['o/r#1:src/lib.rs:b-old', 'real'], ['o/r#1:src/lib.rs:s-old', 'real'],
    ]);
    expect(set[0]).toEqual({
      id: 'o/r#1:src/lib.rs:f', repo: 'o/r', pr: 1, commitSha: 'abc', file: 'src/lib.rs', lineStart: 10, lineEnd: 10, severity: 'warning',
      title: 'Title f', comment: '🚫 **Blocker:** f\n\nThe text.', label: 'false', labelSource: 'reply-withdrawn', threadUrl: 'https://github.com/o/r/pull/1#f',
    });
    expect(selectSet(findings, 1)).toHaveLength(1);
  });
});
