import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { parsePRDiff } from './diff';
import * as mcpServer from './mcp-server';
import { checkReply, ReplySources, statementList, statementRecords, statementSummary } from './reply-check';
import { RelatedRepoTools } from './types';

const REPLY = 'The exporter writes rows as CSV columns.\nNothing   calls `Ledger::snapshot`. The mobile app never stores them, see @alice and [the docs](https://example.com).';
const UNPROVEN = 'I could not point to a line of this repository that shows it, so a maintainer should decide and resolve this thread.';
const DIFF = parsePRDiff('diff --git a/src/ledger.rs b/src/ledger.rs\n--- a/src/ledger.rs\n+++ b/src/ledger.rs\n@@ -2,2 +2,3 @@\n context\n+    rows.write_csv();\n context');

describe('checkReply', () => {
  let root: string;
  let sources: ReplySources;
  let related: RelatedRepoTools;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'manki-reply-check-'));
    const workspace = join(root, 'pr');
    const reports = join(root, 'reports');
    const stateDir = join(root, 'state');
    for (const dir of [join(workspace, 'src'), join(reports, 'lib'), stateDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(workspace, 'src/ledger.rs'), 'pub struct Ledger;\nimpl Ledger {\n    rows.write_csv();\n    pub fn snapshot(&self) {}\n}\n// --force is not read here\n');
    writeFileSync(join(workspace, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(join(reports, 'lib/rows.py'), 'import csv\nrows = csv.reader(source)\n');
    writeFileSync(join(stateDir, `${encodeURIComponent('acme/reports')}.done`), reports);
    related = {
      repos: [{ repo: 'acme/reports', kind: 'consumer', paths: ['lib/', 'docs/*.md'] }, { repo: 'acme/billing', kind: 'consumer' }],
      cacheDir: join(root, 'cache'),
      stateDir,
    };
    sources = { workspace, related, relatedNames: ['acme/reports', 'acme/billing'], diff: DIFF };
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const answer = (fields: Record<string, unknown>) => JSON.stringify({ outcome: 'Unverified', answer: 'A maintainer should confirm it.', ...fields });
  const csv = 'The exporter writes rows as CSV columns.';
  const snapshot = 'Nothing calls `Ledger::snapshot`.';

  it.each<[string, Record<string, unknown>, string]>([
    ['a line of the PR that exists confirms', { quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }, `- Confirmed at \`src/ledger.rs:3\`: "${csv}"`],
    ['a line of a fetched related repo confirms', { quote: csv, status: 'confirmed', places: ['acme/reports:lib/rows.py:2'] }, `- Confirmed at \`acme/reports:lib/rows.py:2\`: "${csv}"`],
    ['a line that exists contradicts', { quote: csv, status: 'contradicted', places: ['`src/ledger.rs:3` writes CSV, not columns'] }, `- Contradicted at \`src/ledger.rs:3\`: "${csv}"`],
    ['a line past the end of the file confirms nothing', { quote: csv, status: 'confirmed', places: ['src/ledger.rs:99'] }, `- Not checked, no line that exists was cited for it: "${csv}"`],
    ['a line of a repo that was not fetched confirms nothing', { quote: csv, status: 'contradicted', places: ['acme/billing:lib/rows.py:2'] }, `- Not checked, no line that exists was cited for it: "${csv}"`],
    ['a related line is never read as a line of the PR', { quote: csv, status: 'confirmed', places: ['acme/reports:src/ledger.rs:3'] }, `- Not checked, no line that exists was cited for it: "${csv}"`],
    ['a confirmation without a place confirms nothing', { quote: csv, status: 'confirmed' }, `- Not checked, no line that exists was cited for it: "${csv}"`],
    ['the model says that no code can show it', { quote: csv, status: 'not_checkable', why: 'outside_code', places: ['src/ledger.rs:3'] }, `- Not checked, code cannot show it: "${csv}"`],
    ['the model could not reach the code', { quote: csv, status: 'not_checkable', why: 'not_reachable' }, `- Not checked, the code that would show it could not be read: "${csv}"`],
    ['an unknown status and reason count as not checked', { quote: csv, status: 'true', why: 'because I say so' }, `- Not checked, code cannot show it: "${csv}"`],
    // The search is Manki's own. The model's word that one came back empty counts for nothing.
    ['a search that finds no line says what was searched', { quote: snapshot, status: 'confirmed', search: 'Ledger::snapshot(' },
      `- Searched \`Ledger::snapshot(\` in this repository, no line found (1 file not searched: binary or over 1 MB): "${snapshot}"`],
    ['a search that finds a line confirms nothing, whatever line is cited', { quote: snapshot, status: 'confirmed', search: 'fn snapshot', places: ['src/ledger.rs:1'] },
      `- Not checked, a search for \`fn snapshot\` found a line: "${snapshot}"`],
    ['a longer name also counts as a line found', { quote: snapshot, status: 'confirmed', search: 'snap' }, `- Not checked, a search for \`snap\` found a line: "${snapshot}"`],
    ['a term that starts with a dash is searched as text', { quote: snapshot, status: 'confirmed', search: '--force' }, `- Not checked, a search for \`--force\` found a line: "${snapshot}"`],
    ['a search in a related repo names the paths it is limited to', { quote: snapshot, status: 'confirmed', search: 'snapshot', repo: 'acme/reports' },
      `- Searched \`snapshot\` in \`acme/reports\`, no line found (only \`lib/\`, \`docs/*.md\` of that repository is fetched): "${snapshot}"`],
    ['a search in a related repo that was not fetched confirms nothing', { quote: snapshot, status: 'confirmed', search: 'snapshot', repo: 'acme/billing' },
      `- Not checked, \`acme/billing\` was not fetched: "${snapshot}"`],
    ['a search in a repo that is not configured confirms nothing', { quote: snapshot, status: 'confirmed', search: 'snapshot', repo: '../pr' },
      `- Not checked, the repository to search is not a configured related repository: "${snapshot}"`],
    ['a term under 3 characters is not searched', { quote: snapshot, status: 'confirmed', search: ' zz ' }, `- Not checked, a search needs one line of 3 to 200 characters: "${snapshot}"`],
    ['a term over 200 characters is not searched', { quote: snapshot, status: 'confirmed', search: 'z'.repeat(201) }, `- Not checked, a search needs one line of 3 to 200 characters: "${snapshot}"`],
    ['a term of two lines is not searched', { quote: snapshot, status: 'confirmed', search: 'zzz\nyyy' }, `- Not checked, a search needs one line of 3 to 200 characters: "${snapshot}"`],
    ['a blank search falls back to the cited line', { quote: snapshot, status: 'confirmed', search: ' ', places: ['src/ledger.rs:4'] }, `- Confirmed at \`src/ledger.rs:4\`: "${snapshot}"`],
    ['a search cannot contradict', { quote: snapshot, status: 'contradicted', search: 'zzzz' }, `- Not checked, no line that exists was cited for it: "${snapshot}"`],
  ])('checks a statement itself: %s', (_name, statement, line) => {
    const checked = checkReply(answer({ statements: [statement] }), REPLY, sources);

    expect(statementList(checked)).toBe(`**Statements of this reply, checked in the code:**\n${line}`);
    // No status moves the outcome.
    expect(checked.text).toBe('Unverified. A maintainer should confirm it.');
  });

  it.each<[string, () => unknown, string]>([
    ['stopped at its file limit', () => ({ matches: [], stopped: false, cut: true, skipped: 0 }), 'the search did not reach every file'],
    ['failed', () => { throw new Error('EACCES'); }, 'the search failed'],
  ])('confirms nothing by a search that %s', (_name, result, reason) => {
    const spy = jest.spyOn(mcpServer, 'findLines').mockImplementation(result as typeof mcpServer.findLines);
    try {
      const checked = checkReply(answer({ statements: [{ quote: snapshot, status: 'confirmed', search: 'Ledger::snapshot(' }] }), REPLY, sources);
      expect(statementList(checked)).toBe(`**Statements of this reply, checked in the code:**\n- Not checked, ${reason}: "${snapshot}"`);
      expect(spy).toHaveBeenCalledWith(sources.workspace, { text: 'Ledger::snapshot(', maxResults: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it('lists only the developer\'s own words, cut after the check, and at most five statements', () => {
    const long = `${'The cache is warm. '.repeat(12)}It never expires.`;
    const reply = `${REPLY} ${long} One. Two. Three. Four.`;
    const quotes = [
      'Nothing calls `Ledger::snapshot`.', // The reply holds it with other whitespace.
      'The exporter writes rows as JSON columns.', // Not what the developer wrote.
      'see @alice and [the docs](https://example.com)',
      long,
      'Nothing calls `Ledger::snapshot`.',
      'One.', 'Two.', 'Three.', 'Four.',
      42,
    ];
    const checked = checkReply(answer({ statements: quotes.map(quote => ({ quote, status: 'not_checkable' })) }), reply, sources);

    const cut = `${'The cache is warm. '.repeat(8)}The cach`;
    expect(cut).toHaveLength(160);
    expect(statementList(checked)).toBe([
      '**Statements of this reply, checked in the code:**',
      '- Not checked, code cannot show it: "Nothing calls `Ledger::snapshot`."',
      // A mention and a link in the developer's words are posted as text.
      '- Not checked, code cannot show it: "see @​alice and the docs"',
      `- Not checked, code cannot show it: "${cut}…"`,
      '- Not checked, code cannot show it: "One."',
      '- Not checked, code cannot show it: "Two."',
      '- 2 more statements not checked: a reply gets at most 5.',
    ].join('\n'));
    expect(checked).toMatchObject({ unchecked: 2, dropped: 3 });
    // The record holds no word of the developer and no search term.
    expect(statementRecords(checkReply(answer({ statements: [
      { quote: csv, status: 'confirmed', places: ['src/ledger.rs:3', 'acme/reports:lib/rows.py:2', 'src/ledger.rs:99'] },
      { quote: snapshot, status: 'confirmed', search: 'Ledger::snapshot(' },
      { quote: 'The mobile app never stores them', status: 'confirmed', search: 'snapshot', repo: 'acme/reports' },
      { quote: 'see @alice', status: 'confirmed', search: 'fn snapshot' },
    ] }), REPLY, sources))).toEqual([
      { status: 'confirmed', places: ['src/ledger.rs:3', 'acme/reports:lib/rows.py:2'] },
      { status: 'confirmed', searched: 'pr' },
      { status: 'confirmed', searched: 'acme/reports' },
      { status: 'not_checkable', why: 'search_found' },
    ]);
    expect(statementList(checkReply(answer({}), REPLY, sources))).toBeUndefined();
  });

  it.each<[string, string, unknown, string]>([
    ['Withdrawn', 'holds on a line of the PR', ['src/ledger.rs:3'], 'Withdrawn. The exporter writes CSV.'],
    ['Withdrawn', 'holds on a line of the PR next to a related line', ['acme/reports:lib/rows.py:2', 'src/ledger.rs:3'], 'Withdrawn. The exporter writes CSV.'],
    ['Withdrawn', 'becomes Unverified on related lines alone', ['acme/reports:lib/rows.py:2'], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Withdrawn', 'becomes Unverified on a line that does not exist', ['src/ledger.rs:99'], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Withdrawn', 'becomes Unverified without proof', undefined, `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Fixed', 'holds without proof', undefined, 'Fixed. The exporter writes CSV.'],
    ['Fixed', 'holds on a line of the PR next to a related line', ['src/ledger.rs:3', 'acme/reports:lib/rows.py:2'], 'Fixed. The exporter writes CSV.'],
    ['Fixed', 'becomes Unverified on related lines alone', ['acme/reports:lib/rows.py:2'], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Fixed', 'becomes Unverified on a related line that was not fetched', ['acme/billing:lib/rows.py:2'], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Agreed', 'needs no proof', ['acme/reports:lib/rows.py:2'], 'Agreed. The exporter writes CSV.'],
    ['Kept', 'is left to the check for new lines', undefined, 'Kept. The exporter writes CSV.'],
    ['Unverified', 'stays', ['src/ledger.rs:3'], 'Unverified. The exporter writes CSV.'],
    ['Resolved', 'is no outcome', ['src/ledger.rs:3'], 'Unverified. I could not check this reply, so a maintainer should decide and resolve this thread.'],
  ])('lets the proof only ever turn an outcome into Unverified: %s %s', (outcome, _name, proof, text) => {
    // Every statement is confirmed, which changes nothing.
    const statements = [{ quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }];
    expect(checkReply(JSON.stringify({ outcome, answer: `${outcome}. The exporter writes CSV.`, proof, statements }), REPLY, sources).text).toBe(text);
  });

  it.each([
    ['plain text', 'Withdrawn. The exporter writes CSV.'],
    ['a list', '["Withdrawn"]'],
    ['no answer', '{"outcome": "Withdrawn", "proof": ["src/ledger.rs:3"]}'],
  ])('answers Unverified when the model returns %s', (_name, content) => {
    expect(checkReply(content, REPLY, sources)).toEqual({
      text: 'Unverified. I could not check this reply, so a maintainer should decide and resolve this thread.', statements: [], unchecked: 0, dropped: 0,
    });
  });

  it('counts only a line inside the diff as a line of the PR when the run has no checkout, and searches nothing', () => {
    const noCheckout: ReplySources = { relatedNames: ['acme/reports'], diff: DIFF };
    const withdrawn = (proof: string[], from = noCheckout) => checkReply(JSON.stringify({ outcome: 'Withdrawn', answer: 'The exporter writes CSV.', proof }), REPLY, from).text;

    expect(withdrawn(['src/ledger.rs:3'])).toBe('Withdrawn. The exporter writes CSV.');
    expect(withdrawn(['src/ledger.rs:9'])).toBe(`Unverified. The exporter writes CSV. ${UNPROVEN}`);
    expect(withdrawn(['src/other.rs:3'])).toBe(`Unverified. The exporter writes CSV. ${UNPROVEN}`);
    expect(withdrawn(['acme/reports:src/ledger.rs:3'])).toBe(`Unverified. The exporter writes CSV. ${UNPROVEN}`);
    expect(withdrawn(['src/ledger.rs:3'], { relatedNames: [] })).toBe(`Unverified. The exporter writes CSV. ${UNPROVEN}`);

    const checked = checkReply(answer({ statements: [
      { quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] },
      { quote: snapshot, status: 'confirmed', search: 'Ledger::snapshot(' },
      { quote: 'The mobile app never stores them', status: 'confirmed', places: ['acme/reports:lib/rows.py:2'] },
    ] }), REPLY, noCheckout);
    expect(statementList(checked)).toBe([
      '**Statements of this reply, checked in the code:**',
      `- Confirmed at \`src/ledger.rs:3\`: "${csv}"`,
      `- Not checked, this run had no checkout to search: "${snapshot}"`,
      '- Not checked, no line that exists was cited for it: "The mobile app never stores them"',
    ].join('\n'));
  });

  it.each<[string, Record<string, unknown>[], number, string, string]>([
    ['every statement checked', [{ quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }, { quote: snapshot, status: 'confirmed', search: 'Ledger::snapshot(' }], 0,
      'I checked each of these statements as listed.', 'What they mean for this finding is for a maintainer to decide.'],
    ['one not checked', [{ quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }, { quote: snapshot, status: 'not_checkable' }], 0,
      'I could not check every one of these statements.', 'A maintainer has to judge the unchecked ones, and what the statements mean for this finding.'],
    ['more statements than a reply gets', [{ quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }], 1,
      'I could not check every one of these statements.', 'A maintainer has to judge the unchecked ones, and what the statements mean for this finding.'],
    ['one contradicted', [{ quote: csv, status: 'contradicted', places: ['src/ledger.rs:3'] }, { quote: snapshot, status: 'confirmed', search: 'Ledger::snapshot(' }], 0,
      'The code contradicts at least one of these statements.', 'What they mean for this finding is for a maintainer to decide.'],
    ['one contradicted and one not checked', [{ quote: csv, status: 'contradicted', places: ['src/ledger.rs:3'] }, { quote: snapshot, status: 'not_checkable' }], 0,
      'The code contradicts at least one of these statements.', 'A maintainer has to judge the unchecked ones, and what the statements mean for this finding.'],
  ])('sums the checks up without a word on the finding, and leaves a blocking one to a maintainer: %s', (_name, statements, unchecked, checks, decision) => {
    const checked = { ...checkReply(answer({ statements }), REPLY, sources), unchecked };

    expect(statementSummary(checked, false)).toBe(checks);
    expect(statementSummary(checked, true)).toBe(`${checks} ${decision}`);
  });
});
