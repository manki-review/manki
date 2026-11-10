import { parseCase } from '../src/bench';
import { FOUND_AGAIN_MARKER } from '../src/recap';
import { fixedMarker } from '../src/state';
import { makeFindingFingerprintEntry, makeRoundContext } from '../src/test-utils';
import { FindingFingerprintEntry, PRE_EXISTING_TAG } from '../src/types';
import { collectFollowUps, collectMisses, draftCase, plainReferences } from './missed-blockers';

function entry(title: string, overrides: Partial<FindingFingerprintEntry> & { file?: string } = {}): FindingFingerprintEntry {
  return { ...makeFindingFingerprintEntry({ title, file: overrides.file, severity: 'blocker' }), origin: 'reviewed', ...overrides };
}

function round(n: number, entries: FindingFingerprintEntry[]) {
  return makeRoundContext(n, { findings: { count: entries.length, severityCounts: {}, entries } });
}

describe('collectMisses', () => {
  it('keeps blockers on code the previous round reviewed that no earlier round raised, by the commit that round reviewed', () => {
    const deadlock = entry('Deadlock in stop', { file: 'src/a.rs', judgeNotes: 'Both paths take the lock.' });
    const misses = collectMisses([
      round(3, [entry('Lock order', { file: 'src/b.rs' }), entry('Old warning', { severity: 'warning' }), deadlock]),
      round(1, [entry('Found first', { file: 'src/c.rs', origin: 'new' })]),
      round(2, [
        entry('Fresh code', { origin: 'new' }),
        entry('Pre-existing bug', { tags: [PRE_EXISTING_TAG] }),
        entry('Found first', { file: 'src/c.rs' }),
        entry('Overflow', { file: 'src/d.rs', threadId: 'T1' }),
      ]),
      round(4, [entry('Overflow, renamed', { file: 'src/d.rs', threadId: 'T1' }), entry('Lock order', { file: 'src/b.rs' })]),
    ]);

    expect(misses.map(({ missedBy, foundIn, head, blockers }) => ({ missedBy, foundIn, head, titles: blockers.map(b => b.title) }))).toEqual([
      { missedBy: 1, foundIn: [2], head: 'sha1', titles: ['Overflow'] },
      { missedBy: 2, foundIn: [3], head: 'sha2', titles: ['Lock order', 'Deadlock in stop'] },
    ]);
  });

  it('finds no miss in a single round', () => {
    expect(collectMisses([round(1, [entry('On reviewed code')])])).toEqual([]);
  });
});

describe('collectFollowUps', () => {
  const bot = { login: 'manki-review[bot]', type: 'Bot' };
  const root = (id: number, title: string, file: string, tags: string[] = []) => ({
    id, user: bot, created_at: '2025-01-01T00:00:05Z',
    body: `🚫 **Blocker** · Correctness\n\n**${title}**\n\n**What goes wrong:** ${title} breaks.\n\n<!-- manki-finding: ${JSON.stringify({ file, line: 3, title, howToFix: 'Fix it.', tags })} -->`,
  });
  const reply = (to: number, at: string, body: string) => ({ id: to * 100 + Number(at.slice(8, 10)), user: bot, created_at: at, in_reply_to_id: to, body });
  const at = (round: number) => `2025-01-0${round}T00:00:05Z`;
  const comments = [
    root(1, 'Lock order', 'src/a.go', ['security']), root(2, 'Missing timeout', 'src/b.go'), root(4, 'Old style', 'src/d.go'), root(5, 'Overflow', 'src/e.go'),
    reply(1, at(2), `Fixed in sha2.\n${fixedMarker('sha2')}`),
    reply(2, at(2), `Fixed in sha2.\n${fixedMarker('sha2')}`),
    reply(2, at(3), `This came up again.\n${FOUND_AGAIN_MARKER}`),
    reply(4, '2025-01-01T12:00:00Z', 'Agreed. The style is the project\'s own.'),
    { id: 9, user: { login: 'dev', type: 'User' }, created_at: at(1), body: 'not a Manki thread' },
  ];
  const rounds = [
    round(1, [
      entry('Lock order', { file: 'src/a.go', fingerprint: { file: 'src/a.go', lineStart: 0, lineEnd: 0, slug: '-Lock-order' } }), entry('Missing timeout', { file: 'src/b.go', severity: 'warning' }),
      entry('Name the helper', { file: 'src/c.go', severity: 'suggestion', suggestedFix: 'func name() {}' }),
      entry('Old style', { file: 'src/d.go', severity: 'nitpick' }), entry('Overflow', { file: 'src/e.go' }), entry('Dropped', { severity: 'ignore' }),
    ]),
    round(2, [entry('Name the helper', { file: 'src/c.go', severity: 'suggestion' })]),
    round(3, []),
  ];

  it('keys each follow-up round by the threads it resolved, found again later or left open, and the body findings it posted again', () => {
    const followUps = collectFollowUps(rounds, comments);

    expect([...followUps.keys()]).toEqual([2, 3]);
    expect(followUps.get(2)).toEqual({
      priorHead: 'sha1',
      findings: [
        { id: 'P1', severity: 'blocker', title: 'Lock order', file: 'src/a.go', line: 1, description: 'Lock order breaks.', howToFix: 'Fix it.', security: true, thread: 'open' },
        { id: 'P2', severity: 'warning', title: 'Missing timeout', file: 'src/b.go', line: 10, description: 'Missing timeout breaks.', howToFix: 'Fix it.', thread: 'open' },
        { id: 'P3', severity: 'suggestion', title: 'Name the helper', file: 'src/c.go', line: 10, suggestedFix: 'func name() {}' },
        { id: 'P4', severity: 'nitpick', title: 'Old style', file: 'src/d.go', line: 10, description: 'Old style breaks.', howToFix: 'Fix it.', thread: 'resolved' },
        { id: 'P5', severity: 'blocker', title: 'Overflow', file: 'src/e.go', line: 10, description: 'Overflow breaks.', howToFix: 'Fix it.', thread: 'open' },
      ],
      mustResolve: ['P1'], mustKeepOpen: ['P2'], mustNotRepeat: ['P3', 'P5'],
    });
    expect(followUps.get(3)).toMatchObject({ priorHead: 'sha2', mustResolve: [], mustKeepOpen: [], mustNotRepeat: ['P5'] });
    expect(followUps.get(3)!.findings.map(f => [f.id, f.thread])).toEqual([['P1', 'resolved'], ['P2', 'resolved'], ['P3', undefined], ['P4', 'resolved'], ['P5', 'open']]);
  });

  it('drafts a follow-up case that parses with the earlier round and its follow-up lists', () => {
    const followUp = collectFollowUps(rounds, comments).get(2)!;
    const miss = { missedBy: 2, foundIn: [3], head: 'b'.repeat(40), blockers: [entry('Race on close', { file: 'src/f.go' })] };
    const { id, text } = draftCase('manki-review/token-service', { number: 12, title: 'fix: retry', body: 'Retries.' }, miss, 'a'.repeat(40), { ...followUp, priorHead: 'c'.repeat(40) });

    expect(id).toBe('token-service-12-r2');
    expect(text).toContain(`# Draft from Manki's round records and threads: round 2 reviewed ${'b'.repeat(40)} after the round at ${'c'.repeat(40)}.`);
    const parsed = parseCase(text, `${id}.yml`);
    expect(parsed).toMatchObject({
      source: 'manki-review/token-service#12: round 2, a follow-up of the rounds before it, and round 3 raised blockers on code round 2 had reviewed',
      head: 'b'.repeat(40), keyVersion: 0, mustResolve: ['P1'], mustNotRepeat: ['P3', 'P5'],
      mustKeepOpen: [{ id: 'P2', severity: 'warning', mechanism: 'Missing timeout', locations: ['src/b.go'] }],
      mustCatch: [{ id: 'K1', severity: 'blocker', mechanism: 'Race on close', locations: ['src/f.go'] }],
    });
    expect(parsed.priorRound).toEqual({ head: 'c'.repeat(40), findings: followUp.findings });
  });
});

describe('plainReferences', () => {
  it('writes references to other owners as plain text, and keeps the forks and manki', () => {
    expect(plainReferences([
      'Closes dashpay/rust-dashcore#1171, see https://github.com/dashpay/platform/issues/5381 and github.com/dashpay/dash/pull/42.',
      'Docs at https://github.com/dashpay/dips/blob/master/dip-0026.md, thanks @someone.',
      'Fork xdustinface/rust-dashcore#184 and https://github.com/manki-review/manki/pull/1233 stay, mail a@b.com and `@types/node` too.',
    ].join('\n'))).toBe([
      'Closes rust-dashcore upstream PR 1171, see platform upstream issue 5381 and dash upstream PR 42.',
      'Docs at dips upstream link, thanks someone.',
      'Fork xdustinface/rust-dashcore#184 and https://github.com/manki-review/manki/pull/1233 stay, mail a@b.com and `@types/node` too.',
    ].join('\n'));
  });
});

describe('plainReferences with the drafted repository owner', () => {
  it('writes a bare owner/name of that owner as the name, and leaves paths and other text alone', () => {
    expect(plainReferences('Compare with dashpay/dash and `dashpay/dips`, not src/dashpay/x.rs or mydashpay/y.', 'dashpay'))
      .toBe('Compare with dash and `dips`, not src/dashpay/x.rs or mydashpay/y.');
    expect(plainReferences('See xdustinface/rust-dashcore and manki-review/manki.', 'xdustinface')).toBe('See xdustinface/rust-dashcore and manki-review/manki.');
  });
});

describe('draftCase', () => {
  const miss = { missedBy: 1, foundIn: [2, 3], head: 'b'.repeat(40), blockers: [entry('Deadlock in stop', { file: 'src/a.rs', judgeNotes: 'Both take the lock, see dashpay/dash#9.' })] };

  it('writes a draft that parses as a case with key_version 0 and one must_catch blocker per missed finding', () => {
    const { id, text } = draftCase('xdustinface/rust-dashcore', { number: 184, title: 'fix: stop @someone', body: 'Closes dashpay/rust-dashcore#1171' }, miss, 'a'.repeat(40));

    expect(id).toBe('rust-dashcore-184-r1');
    expect(text).toMatch(/^# Draft from Manki's round records: round 2, 3 found these blockers on code round 1 reviewed at b{40}\./);
    expect(text).not.toMatch(/dashpay\//);
    expect(parseCase(text, `${id}.yml`)).toEqual({
      id, set: 'tuning', repo: 'xdustinface/rust-dashcore', source: 'xdustinface/rust-dashcore#184: round 2, 3 raised blockers on code round 1 had reviewed',
      base: 'a'.repeat(40), head: 'b'.repeat(40), title: 'fix: stop someone', body: 'Closes rust-dashcore upstream PR 1171', keyVersion: 0,
      mustCatch: [{ id: 'K1', severity: 'blocker', mechanism: 'Deadlock in stop. Both take the lock, see dash upstream PR 9.', locations: ['src/a.rs'] }],
      niceToHave: [], mustResolve: [], mustKeepOpen: [], mustNotRepeat: [],
    });
  });

  it('names a pull request of another owner in plain text, and falls back to the slug for a finding without a title', () => {
    const untitled = { ...miss, blockers: [entry('Lock order', { file: 'src/b.rs', title: undefined, judgeNotes: undefined })] };
    const { text } = draftCase('dashpay/rust-dashcore', { number: 1295, title: 'fix', body: 'Matches dashpay/dash.' }, untitled, 'a'.repeat(40));
    expect(parseCase(text, 'x.yml')).toMatchObject({
      id: 'rust-dashcore-1295-r1', source: 'rust-dashcore upstream PR 1295: round 2, 3 raised blockers on code round 1 had reviewed', body: 'Matches dash.',
      mustCatch: [{ id: 'K1', severity: 'blocker', mechanism: untitled.blockers[0].fingerprint.slug, locations: ['src/b.rs'] }],
    });
  });
});
