import { parseCase } from '../src/bench';
import { makeFindingFingerprintEntry, makeRoundContext } from '../src/test-utils';
import { FindingFingerprintEntry, PRE_EXISTING_TAG } from '../src/types';
import { collectMisses, draftCase, plainReferences } from './missed-blockers';

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

describe('draftCase', () => {
  const miss = { missedBy: 1, foundIn: [2, 3], head: 'b'.repeat(40), blockers: [entry('Deadlock in stop', { file: 'src/a.rs', judgeNotes: 'Both take the lock, see dashpay/dash#9.' })] };

  it('writes a draft that parses as a case with key_version 0 and one must_catch blocker per missed finding', () => {
    const { id, text } = draftCase('xdustinface/rust-dashcore', { number: 184, title: 'fix: stop @someone', body: 'Closes dashpay/rust-dashcore#1171' }, miss, 'a'.repeat(40));

    expect(id).toBe('rust-dashcore-184-r1');
    expect(text).toMatch(/^# Draft from Manki's round records: round 2, 3 found these blockers on code round 1 reviewed at b{40}\./);
    expect(text).not.toMatch(/dashpay\//);
    expect(parseCase(text, `${id}.yml`)).toEqual({
      id, repo: 'xdustinface/rust-dashcore', source: 'xdustinface/rust-dashcore#184: round 2, 3 raised blockers on code round 1 had reviewed',
      base: 'a'.repeat(40), head: 'b'.repeat(40), title: 'fix: stop someone', body: 'Closes rust-dashcore upstream PR 1171', keyVersion: 0,
      mustCatch: [{ id: 'K1', severity: 'blocker', mechanism: 'Deadlock in stop. Both take the lock, see dash upstream PR 9.', locations: ['src/a.rs'] }],
      niceToHave: [],
    });
  });

  it('names a pull request of another owner in plain text', () => {
    const { text } = draftCase('dashpay/rust-dashcore', { number: 1295, title: 'fix', body: null }, miss, 'a'.repeat(40));
    expect(parseCase(text, 'x.yml')).toMatchObject({ id: 'rust-dashcore-1295-r1', source: 'rust-dashcore upstream PR 1295: round 2, 3 raised blockers on code round 1 had reviewed', body: '' });
  });
});
