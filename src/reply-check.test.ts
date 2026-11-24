import * as core from '@actions/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { parsePRDiff } from './diff';
import * as mcpServer from './mcp-server';
import { checkFixedElsewhere, checkReply, ElsewhereSources, fixedElsewhereText, ReplySources, statementList, statementRecords, statementSummary } from './reply-check';
import { ParsedDiff, RelatedRepoTools } from './types';
import { registerSecret } from './utils';

const REPLY = 'The exporter writes rows as CSV columns.\nNothing   calls `Ledger::snapshot`. The mobile app never stores them, see @alice and [the docs](https://example.com). The description no longer names `MAX_ROWS`.';
// What the PR description says at the time of the reply. Its last paragraph is longer than a text Manki looks up.
const DESCRIPTION = `Rewrites the exporter.\n\nIt writes one   row\nper ledger entry, with **no** cap.\n\n${'Every row keeps its order. '.repeat(9)}`;
const HELD = 'writes one row per ledger entry';
const UNPROVEN = 'I could not point to a line of this repository that shows it, so a maintainer should decide.';
const NO_FIXING_PR = 'The reply names no other pull request of this repository that I could check, so a maintainer should decide.';
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
    writeFileSync(join(workspace, 'src/ledger.rs'), 'pub struct Ledger;\nimpl Ledger {\n    rows.write_csv();\n    pub fn snapshot(&self) {}\n}\n// --force is not read here\n// end\n// of\n// file\n');
    writeFileSync(join(workspace, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(join(reports, 'lib/rows.py'), 'import csv\nrows = csv.reader(source)\n');
    writeFileSync(join(stateDir, `${encodeURIComponent('acme/reports')}.done`), reports);
    related = {
      repos: [{ repo: 'acme/reports', kind: 'consumer', paths: ['lib/', 'docs/*.md'] }, { repo: 'acme/billing', kind: 'consumer' }],
      cacheDir: join(root, 'cache'),
      stateDir,
    };
    // Line 3 of `src/ledger.rs` changed since the thread was posted.
    sources = { workspace, related, relatedNames: ['acme/reports', 'acme/billing'], diff: DIFF, description: DESCRIPTION, changedSincePosted: DIFF.files };
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const answer = (fields: Record<string, unknown>) => JSON.stringify({ outcome: 'Unverified', answer: 'The code does not show it.', ...fields });
  const csv = 'The exporter writes rows as CSV columns.';
  const snapshot = 'Nothing calls `Ledger::snapshot`.';
  const rewrote = 'The description no longer names `MAX_ROWS`.';

  it.each<[string, Record<string, unknown>, string]>([
    ['a line of the PR that exists confirms', { quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }, `- Line cited for it exists at \`src/ledger.rs:3\`: "${csv}"`],
    ['a line of a fetched related repo confirms', { quote: csv, status: 'confirmed', places: ['acme/reports:lib/rows.py:2'] }, `- Line cited for it exists at \`acme/reports:lib/rows.py:2\`: "${csv}"`],
    ['lines that exist confirm', { quote: csv, status: 'confirmed', places: ['src/ledger.rs:3', 'acme/reports:lib/rows.py:2'] },
      `- Lines cited for it exist at \`src/ledger.rs:3\`, \`acme/reports:lib/rows.py:2\`: "${csv}"`],
    ['a line that exists contradicts', { quote: csv, status: 'contradicted', places: ['`src/ledger.rs:3` writes CSV, not columns'] }, `- Line cited against it exists at \`src/ledger.rs:3\`: "${csv}"`],
    // The search is Manki's own. The model's word that one came back empty counts for nothing.
    ['a search that finds no line says what was searched', { quote: snapshot, status: 'confirmed', search: 'Ledger::snapshot(' },
      `- No line of this repository holds \`Ledger::snapshot(\`, ignoring case (1 file not searched: binary or over 1 MB): "${snapshot}"`],
    ['a search in a related repo names the paths it is limited to', { quote: snapshot, status: 'confirmed', search: 'snapshot', repo: 'acme/reports' },
      `- No line of \`acme/reports\` holds \`snapshot\`, ignoring case (only \`lib/\`, \`docs/*.md\` of that repository is fetched): "${snapshot}"`],
    ['a blank search falls back to the cited line', { quote: snapshot, status: 'confirmed', search: ' ', places: ['src/ledger.rs:4'] }, `- Line cited for it exists at \`src/ledger.rs:4\`: "${snapshot}"`],
    // The description is the PR author's text. Whether it holds a text is what Manki reads in it, never the model's word.
    ['text the PR description holds confirms, whitespace aside', { quote: rewrote, status: 'confirmed', description: ' writes one row\n per ledger   entry' },
      `- The PR description holds \`${HELD}\`, cited for it: "${rewrote}"`],
    ['text the PR description holds contradicts', { quote: rewrote, status: 'contradicted', description: 'with **no** cap' }, `- The PR description holds \`with **no** cap\`, cited against it: "${rewrote}"`],
    ['a search of the PR description that finds nothing says what was searched', { quote: rewrote, status: 'confirmed', description_search: ' MAX_ROWS ' },
      `- The PR description does not hold \`MAX_ROWS\`, ignoring case: "${rewrote}"`],
    ['the PR description decides alone, whatever line or search is given', { quote: rewrote, status: 'confirmed', description_search: 'MAX_ROWS', description: 'no such text', search: 'fn snapshot', places: ['src/ledger.rs:99'] },
      `- The PR description does not hold \`MAX_ROWS\`, ignoring case: "${rewrote}"`],
    ['a blank description text falls back to the cited line', { quote: rewrote, status: 'confirmed', description: ' ', description_search: '', places: ['src/ledger.rs:4'] },
      `- Line cited for it exists at \`src/ledger.rs:4\`: "${rewrote}"`],
  ])('checks a statement itself: %s', (_name, statement, line) => {
    const checked = checkReply(answer({ statements: [statement] }), REPLY, sources);

    expect(statementList(checked)).toBe(`**Statements of this reply, and what I checked of each:**\n${line}`);
    // No status moves the outcome.
    expect(checked.text(undefined)).toBe('Unverified. The code does not show it. A maintainer should confirm this.');
  });

  type Run = 'checkout' | 'no checkout' | 'no related repo' | 'no description';
  const runs = (): Record<Run, ReplySources> => ({
    'checkout': sources,
    // As the reply handler passes it: without a checkout no related repo can be fetched.
    'no checkout': { relatedNames: sources.relatedNames, diff: DIFF },
    'no related repo': { workspace: sources.workspace, relatedNames: [], diff: DIFF },
    // As the reply handler passes it when GitHub did not return the PR.
    'no description': { ...sources, description: undefined },
  });
  const cutSearch = () => ({ matches: [], stopped: false, cut: true, skipped: 0 });

  // The search mock is a rest parameter, since jest passes a `done` callback to a test that takes more parameters than its row has.
  it.each<[string, Run, Record<string, unknown>, string, (() => unknown)?]>([
    ['a search that finds a line, whatever line is cited', 'checkout', { status: 'confirmed', search: 'fn snapshot', places: ['src/ledger.rs:1'] }, 'a search for `fn snapshot` found a line'],
    ['a longer name that holds the term', 'checkout', { status: 'confirmed', search: 'snap' }, 'a search for `snap` found a line'],
    ['a term in other letter case', 'checkout', { status: 'confirmed', search: 'PUB FN snapshot' }, 'a search for `PUB FN snapshot` found a line'],
    ['a term that starts with a dash, searched as text', 'checkout', { status: 'confirmed', search: '--force' }, 'a search for `--force` found a line'],
    ['a search of a fetched related repo that finds a line', 'checkout', { status: 'confirmed', search: 'csv.reader', repo: 'acme/reports' }, 'a search for `csv.reader` found a line'],
    ['a search that stopped at its file limit', 'checkout', { status: 'confirmed', search: 'Ledger::snapshot(' }, 'the search did not reach every file', cutSearch],
    ['a search that found a line before its file limit', 'checkout', { status: 'confirmed', search: 'Ledger::snapshot(' }, 'a search for `Ledger::snapshot(` found a line',
      () => ({ ...cutSearch(), matches: ['src/ledger.rs:4: x'] })],
    ['a search that failed', 'checkout', { status: 'confirmed', search: 'Ledger::snapshot(' }, 'the search failed', () => { throw new Error('EACCES'); }],
    ['a search of a related repo that was not fetched', 'checkout', { status: 'confirmed', search: 'snapshot', repo: 'acme/billing' }, '`acme/billing` was not fetched'],
    ['a search of a repo that is not configured', 'checkout', { status: 'confirmed', search: 'snapshot', repo: '../pr' }, 'the repository to search is not a configured related repository'],
    ['a search of a repo when none is configured', 'no related repo', { status: 'confirmed', search: 'snapshot', repo: 'acme/reports' }, 'the repository to search is not a configured related repository'],
    ['a term under 3 characters', 'checkout', { status: 'confirmed', search: ' zz ' }, 'a search needs one line of 3 to 200 characters'],
    ['a term over 200 characters', 'checkout', { status: 'confirmed', search: 'z'.repeat(201) }, 'a search needs one line of 3 to 200 characters'],
    ['a term of two lines', 'checkout', { status: 'confirmed', search: 'zzz\nyyy' }, 'a search needs one line of 3 to 200 characters'],
    ['a search without a checkout', 'no checkout', { status: 'confirmed', search: 'Ledger::snapshot(' }, 'this run had no checkout to read'],
    ['a search of a configured related repo without a checkout', 'no checkout', { status: 'confirmed', search: 'snapshot', repo: 'acme/reports' }, 'this run had no checkout to read'],
    ['a search of a repo that is not configured, without a checkout', 'no checkout', { status: 'confirmed', search: 'snapshot', repo: 'acme/other' },
      'the repository to search is not a configured related repository'],
    ['a short term without a checkout', 'no checkout', { status: 'confirmed', search: 'zz' }, 'a search needs one line of 3 to 200 characters'],
    ['a search, which cannot contradict', 'checkout', { status: 'contradicted', search: 'zzzz' }, 'no cited line was found in the code that was read'],
    ['a confirmation without a place', 'checkout', { status: 'confirmed' }, 'no cited line was found in the code that was read'],
    ['a line past the end of the file', 'checkout', { status: 'confirmed', places: ['src/ledger.rs:99'] }, 'no cited line was found in the code that was read'],
    ['a line of a fetched related repo that its checkout does not hold', 'checkout', { status: 'confirmed', places: ['acme/reports:src/ledger.rs:3'] },
      'no cited line was found in the code that was read'],
    ['a line of a repo that is not configured', 'no related repo', { status: 'confirmed', places: ['acme/reports:lib/rows.py:2'] }, 'no cited line was found in the code that was read'],
    ['a line of a related repo that was not fetched', 'checkout', { status: 'contradicted', places: ['acme/billing:lib/rows.py:2'] }, '`acme/billing` was not fetched'],
    ['a line of the PR outside the diff without a checkout', 'no checkout', { status: 'confirmed', places: ['src/ledger.rs:9'] }, 'this run had no checkout to read'],
    ['a line of a related repo without a checkout', 'no checkout', { status: 'confirmed', places: ['acme/reports:lib/rows.py:2'] }, 'this run had no checkout to read'],
    ['a confirmation without a place, without a checkout', 'no checkout', { status: 'confirmed', places: ['not a line'] }, 'no cited line was found in the code that was read'],
    ['the model saying that no code can show it', 'checkout', { status: 'not_checkable', why: 'outside_code', places: ['src/ledger.rs:3'] }, 'the review model says code cannot show it'],
    ['the model not reaching the code', 'checkout', { status: 'not_checkable', why: 'not_reachable' }, 'the review model could not read the code that would show it'],
    ['an unknown status and reason', 'checkout', { status: 'true', why: 'because I say so' }, 'no cited line was found in the code that was read'],
    ['a text the PR description does not hold', 'checkout', { status: 'confirmed', description: 'caps the export at 500 rows' }, 'the PR description does not hold a cited text of 3 to 200 characters'],
    ['a text the PR description holds in other letter case', 'checkout', { status: 'contradicted', description: HELD.toUpperCase() }, 'the PR description does not hold a cited text of 3 to 200 characters'],
    ['a text of the PR description under 3 characters', 'checkout', { status: 'confirmed', description: 'It' }, 'the PR description does not hold a cited text of 3 to 200 characters'],
    ['a text of the PR description over 200 characters', 'checkout', { status: 'confirmed', description: 'Every row keeps its order. '.repeat(8) }, 'the PR description does not hold a cited text of 3 to 200 characters'],
    ['a text the PR description does not hold, whatever line is cited', 'checkout', { status: 'confirmed', description: 'no such text', places: ['src/ledger.rs:3'] },
      'the PR description does not hold a cited text of 3 to 200 characters'],
    ['a search of the PR description that finds the term', 'checkout', { status: 'confirmed', description_search: 'ledger entry' }, 'the PR description holds `ledger entry`, ignoring case'],
    ['a search of the PR description that finds the term in other letter case, across a line break', 'checkout', { status: 'confirmed', description_search: 'ONE ROW  PER' },
      'the PR description holds `ONE ROW PER`, ignoring case'],
    ['a search of the PR description for a term under 3 characters', 'checkout', { status: 'confirmed', description_search: 'zz' }, 'a search needs one line of 3 to 200 characters'],
    ['a search of the PR description for a term over 200 characters', 'checkout', { status: 'confirmed', description_search: 'z'.repeat(201) }, 'a search needs one line of 3 to 200 characters'],
    ['a search of the PR description, which cannot contradict', 'checkout', { status: 'contradicted', description_search: 'MAX_ROWS' }, 'no cited line was found in the code that was read'],
    ['a search of a PR description that could not be read', 'no description', { status: 'confirmed', description_search: 'MAX_ROWS' }, 'the PR description could not be read'],
    ['a text of a PR description that could not be read', 'no description', { status: 'contradicted', description: HELD }, 'the PR description could not be read'],
    ['the model saying that the description is not shown, when it could not be read', 'no description', { status: 'not_checkable', why: 'description_unread' }, 'the PR description could not be read'],
    ['the model saying that the description is not shown, when it was read', 'checkout', { status: 'not_checkable', why: 'description_unread' }, 'no cited line was found in the code that was read'],
  ])('gives the true reason a statement was not checked: %s (%s)', (_name, run, statement, reason, ...[search]) => {
    const from = runs()[run];
    const spy = search && jest.spyOn(mcpServer, 'findLines').mockImplementation(search as typeof mcpServer.findLines);
    try {
      const checked = checkReply(answer({ statements: [{ quote: snapshot, ...statement }] }), REPLY, from);
      expect(statementList(checked)).toBe(`**Statements of this reply, and what I checked of each:**\n- Not checked, ${reason}: "${snapshot}"`);
      expect(checked.text(undefined)).toBe('Unverified. The code does not show it. A maintainer should confirm this.');
      if (spy) expect(spy).toHaveBeenCalledWith(from.workspace, { text: statement.search, maxResults: 1, ignoreCase: true });
    } finally {
      spy?.mockRestore();
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
    const checked = checkReply(answer({ statements: quotes.map(quote => ({ quote, status: 'not_checkable', why: 'outside_code' })) }), reply, sources);

    const cut = `${'The cache is warm. '.repeat(8)}The cach`;
    expect(cut).toHaveLength(160);
    expect(statementList(checked)).toBe([
      '**Statements of this reply, and what I checked of each:**',
      '- Not checked, the review model says code cannot show it: "Nothing calls `Ledger::snapshot`."',
      // A mention and a link in the developer's words are posted as text.
      '- Not checked, the review model says code cannot show it: "see @\u200Balice and the docs"',
      `- Not checked, the review model says code cannot show it: "${cut}…"`,
      '- Not checked, the review model says code cannot show it: "One."',
      '- Not checked, the review model says code cannot show it: "Two."',
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
    // Nor any text of the PR description: only that the description was the source.
    expect(statementRecords(checkReply(answer({ statements: [
      { quote: rewrote, status: 'confirmed', description_search: 'MAX_ROWS' },
      { quote: csv, status: 'contradicted', description: HELD },
      { quote: snapshot, status: 'confirmed', description_search: 'ledger entry' },
    ] }), REPLY, sources))).toEqual([
      { status: 'confirmed', description: 'absent' },
      { status: 'contradicted', description: 'held' },
      { status: 'not_checkable', why: 'description_found' },
    ]);
    expect(statementList(checkReply(answer({}), REPLY, sources))).toBeUndefined();
  });

  it.each<[string, string, unknown, string]>([
    ['Withdrawn', 'holds on a line of the PR', ['src/ledger.rs:3'], 'Withdrawn. The exporter writes CSV.'],
    ['Withdrawn', 'holds on a line of the PR next to a related line', ['acme/reports:lib/rows.py:2', 'src/ledger.rs:3'], 'Withdrawn. The exporter writes CSV.'],
    ['Withdrawn', 'becomes Unverified on related lines alone', ['acme/reports:lib/rows.py:2'], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Withdrawn', 'becomes Unverified on a line that does not exist', ['src/ledger.rs:99'], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Withdrawn', 'becomes Unverified without proof', undefined, `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Withdrawn', 'becomes Unverified on text of the PR description', [HELD], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Fixed', 'holds on a line changed since the thread was posted next to a related line', ['acme/reports:lib/rows.py:2', 'src/ledger.rs:2-4'], 'Fixed. The exporter writes CSV.'],
    // A fix is a change, so a line the PR has not changed since the thread was posted shows none.
    ['Fixed', 'becomes Unverified without proof', undefined, `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Fixed', 'becomes Unverified on a line not changed since the thread was posted', ['src/ledger.rs:4'], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Fixed', 'becomes Unverified on text of the PR description', [HELD], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Fixed', 'becomes Unverified on related lines alone', ['acme/reports:lib/rows.py:2'], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Fixed', 'becomes Unverified on a related line that was not fetched', ['acme/billing:lib/rows.py:2'], `Unverified. The exporter writes CSV. ${UNPROVEN}`],
    ['Agreed', 'needs no proof', ['acme/reports:lib/rows.py:2'], 'Agreed. The exporter writes CSV.'],
    ['Kept', 'is left to the check for new lines', undefined, 'Kept. The exporter writes CSV.'],
    ['Unverified', 'stays', ['src/ledger.rs:3'], 'Unverified. The exporter writes CSV. A maintainer should confirm this.'],
    // A fix in another pull request waits for that pull request's own check, whatever lines of this one are cited.
    ['FixedElsewhere', 'becomes Unverified until another check confirms it', ['src/ledger.rs:3'], `Unverified. The exporter writes CSV. ${NO_FIXING_PR}`],
    ['Resolved', 'is no outcome', ['src/ledger.rs:3'], 'Unverified. I could not check this reply, so a maintainer should decide.'],
  ])('lets the proof only ever turn an outcome into Unverified: %s %s', (outcome, _name, proof, text) => {
    // Every statement is confirmed, by a line and by the PR description, which changes nothing.
    const statements = [
      { quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] },
      { quote: rewrote, status: 'confirmed', description_search: 'MAX_ROWS' },
      { quote: snapshot, status: 'confirmed', description: HELD },
    ];
    expect(checkReply(JSON.stringify({ outcome, answer: `${outcome}. The exporter writes CSV.`, proof, statements }), REPLY, sources).text(undefined)).toBe(text);
    // A rebase rewords only an unproven "Fixed.".
    const rebased = checkReply(JSON.stringify({ outcome, answer: `${outcome}. The exporter writes CSV.`, proof, statements }), REPLY, {
      ...sources, fixScope: { files: ['src/ledger.rs'], hasFile: true, guarded: false, unknown: 'not_descendant', rebased: true },
    });
    const reworded = outcome === 'Fixed' && text.startsWith('Unverified.');
    expect(rebased.unsettled).toBe(reworded || undefined);
    if (reworded) expect(rebased.text(undefined)).toMatch(/^The exporter writes CSV\. This branch was rebased/);
    else expect(rebased.text(undefined)).toBe(text);
    // When what changed since the thread was posted could not be read, no line shows a fix.
    if (outcome === 'Fixed') {
      const unread = checkReply(JSON.stringify({ outcome, answer: 'The guard runs first.', proof: ['src/ledger.rs:3'] }), REPLY, { ...sources, changedSincePosted: undefined });
      expect(unread.text(undefined)).toBe(`Unverified. The guard runs first. ${UNPROVEN}`);
      // A fix that only removes code holds on the line right before or after the removal, and on no line further away.
      const removal = parsePRDiff('diff --git a/src/ledger.rs b/src/ledger.rs\n--- a/src/ledger.rs\n+++ b/src/ledger.rs\n@@ -2,3 +2,2 @@\n context\n-    debug(rows);\n context').files;
      const removed = (at: string) => checkReply(JSON.stringify({ outcome, answer: 'The debug call is gone.', proof: [at] }), REPLY, { ...sources, changedSincePosted: removal }).text(undefined);
      expect(['src/ledger.rs:2', 'src/ledger.rs:3', 'src/ledger.rs:4'].map(removed)).toEqual(['Fixed. The debug call is gone.', 'Fixed. The debug call is gone.', `Unverified. The debug call is gone. ${UNPROVEN}`]);
      // A range wider than a quote holds an unrelated change as easily as a fix, so it counts only when every line in it changed.
      const wide = 'diff --git a/src/ledger.rs b/src/ledger.rs\n--- a/src/ledger.rs\n+++ b/src/ledger.rs\n@@ -1,0 +1,8 @@\n+a\n+b\n+c\n+d\n+e\n+f\n+g\n+h';
      const ranged = (at: string, changed: ParsedDiff) => checkReply(JSON.stringify({ outcome, answer: 'The guard runs first.', proof: [at] }), REPLY, { ...sources, changedSincePosted: changed.files }).text(undefined);
      expect(ranged('src/ledger.rs:1-8', parsePRDiff(wide))).toBe('Fixed. The guard runs first.');
      expect(ranged('src/ledger.rs:1-8', DIFF)).toBe(`Unverified. The guard runs first. ${UNPROVEN}`);
      expect(ranged('src/ledger.rs:1-7', DIFF)).toBe('Fixed. The guard runs first.');
    }
  });

  it('sets `fixedIn` only to a pull request of this repository that the developer\'s own words name', () => {
    const repo = 'acme/ledger';
    const reply = 'This is fixed in #42, see also https://github.com/acme/ledger/pull/57 and https://github.com/acme/other/pull/61, not `#77`.';
    const fixedIn = (n: unknown, from: ReplySources = { ...sources, repo }) => checkReply(JSON.stringify({ outcome: 'FixedElsewhere', answer: 'You name another PR.', fixed_in: n }), reply, from);

    expect(fixedIn(42)).toMatchObject({ outcome: 'Unverified', answer: 'You name another PR.', fixedIn: 42 });
    expect(fixedIn(42).text(undefined)).toBe(`Unverified. You name another PR. ${NO_FIXING_PR}`);
    expect(fixedIn(57).fixedIn).toBe(57);
    // Another repository's pull request, a number in code, one the reply does not name, and one without the repository all name none.
    for (const n of [61, 77, 43, '42']) expect(fixedIn(n).fixedIn).toBeUndefined();
    expect(fixedIn(42, sources).fixedIn).toBeUndefined();
    // The PR's own number never fixes its finding elsewhere.
    expect(fixedIn(42, { ...sources, repo, pr: 42 }).fixedIn).toBeUndefined();
    // Any other outcome names none, whatever `fixed_in` says.
    expect(checkReply(JSON.stringify({ outcome: 'Fixed', answer: 'Done.', fixed_in: 42 }), reply, { ...sources, repo }).fixedIn).toBeUndefined();
  });

  it.each([
    ['plain text', 'Withdrawn. The exporter writes CSV.'],
    ['a list', '["Withdrawn"]'],
    ['no answer', '{"outcome": "Withdrawn", "proof": ["src/ledger.rs:3"]}'],
  ])('answers Unverified when the model returns %s', (_name, content) => {
    const { text, ...rest } = checkReply(content, REPLY, sources);
    expect(text(undefined)).toBe('Unverified. I could not check this reply, so a maintainer should decide.');
    expect(rest).toEqual({
      outcome: 'Unverified', cited: [], answer: '', proof: [], statements: [], unchecked: 0, dropped: 0,
    });
    expect(checkReply(content, REPLY, sources).text('resolved')).toBe('Unverified. I could not check this reply.');
  });

  it.each([
    ['Withdrawn', 'I could not point to a line of this repository that shows it', ', so a maintainer should decide'],
    ['FixedElsewhere', 'The reply names no other pull request of this repository that I could check', ', so a maintainer should decide'],
    ['Unverified', '', 'A maintainer should confirm this'],
  ])('asks a maintainer to resolve only a thread that is open, for %s', (outcome, why, asks) => {
    const { text } = checkReply(JSON.stringify({ outcome, answer: 'The exporter writes CSV.' }), REPLY, sources);
    expect(text('open')).toBe(`Unverified. The exporter writes CSV. ${why}${asks} and resolve this thread.`);
    expect(text(undefined)).toBe(`Unverified. The exporter writes CSV. ${why}${asks}.`);
    expect(text('resolved')).toBe(`Unverified. The exporter writes CSV.${why && ` ${why}.`}`);
  });

  it('keeps the model\'s own outcome and its raw proof entries, bounded and with secrets removed before the cut', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    registerSecret('hunter2-hunter2');
    const proof = ['src/ledger.rs:4', 'src/gone.rs:1 no such file', { file: 'src/ledger.rs', line: 3 }, `${'x'.repeat(180)} ${token}`, 'hunter2-hunter2 is at src/a.ts:1', 'y'.repeat(300), ...Array.from({ length: 10 }, (_, i) => `z${i}`)];
    const checked = checkReply(JSON.stringify({ outcome: 'Fixed', answer: 'The guard runs first.', proof }), REPLY, sources);
    expect(checked).toMatchObject({ outcome: 'Unverified', modelOutcome: 'Fixed', proof: ['src/ledger.rs:4'] });
    expect(checked.cited).toHaveLength(10);
    expect(checked.cited.slice(0, 3)).toEqual(['src/ledger.rs:4', 'src/gone.rs:1 no such file', '{"file":"src/ledger.rs","line":3}']);
    expect(checked.cited[3]).not.toContain('ghp_');
    expect(checked.cited[4]).toBe('[REDACTED] is at src/a.ts:1');
    expect(checked.cited[5]).toBe(`${'y'.repeat(200)}...`);
    expect(checkReply(JSON.stringify({ outcome: 'Agreed', answer: 'Later is fine.' }), REPLY, sources)).toMatchObject({ modelOutcome: 'Agreed', cited: [] });
  });

  it('counts only a line inside the diff as a line of the PR when the run has no checkout', () => {
    const noCheckout: ReplySources = { relatedNames: ['acme/reports'], diff: DIFF };
    const withdrawn = (proof: string[], from = noCheckout) => checkReply(JSON.stringify({ outcome: 'Withdrawn', answer: 'The exporter writes CSV.', proof }), REPLY, from).text(undefined);

    expect(withdrawn(['src/ledger.rs:3'])).toBe('Withdrawn. The exporter writes CSV.');
    expect(withdrawn(['src/ledger.rs:9'])).toBe(`Unverified. The exporter writes CSV. ${UNPROVEN}`);
    expect(withdrawn(['src/other.rs:3'])).toBe(`Unverified. The exporter writes CSV. ${UNPROVEN}`);
    expect(withdrawn(['acme/reports:src/ledger.rs:3'])).toBe(`Unverified. The exporter writes CSV. ${UNPROVEN}`);
    expect(withdrawn(['src/ledger.rs:3'], { relatedNames: [] })).toBe(`Unverified. The exporter writes CSV. ${UNPROVEN}`);

    const checked = checkReply(answer({ statements: [{ quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }] }), REPLY, noCheckout);
    expect(statementList(checked)).toBe(`**Statements of this reply, and what I checked of each:**\n- Line cited for it exists at \`src/ledger.rs:3\`: "${csv}"`);
  });

  it.each<[string, Record<string, unknown>[], number, string, string]>([
    ['every statement checked', [{ quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }, { quote: snapshot, status: 'confirmed', search: 'Ledger::snapshot(' }], 0,
      'Each line says what I checked, not that the statement is right.', 'What they mean for this finding is for a maintainer to decide.'],
    ['one not checked', [{ quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }, { quote: snapshot, status: 'not_checkable' }], 0,
      'I could not check every one of these statements.', 'A maintainer has to judge the unchecked ones, and what the statements mean for this finding.'],
    ['more statements than a reply gets', [{ quote: csv, status: 'confirmed', places: ['src/ledger.rs:3'] }], 1,
      'I could not check every one of these statements.', 'A maintainer has to judge the unchecked ones, and what the statements mean for this finding.'],
    ['one contradicted', [{ quote: csv, status: 'contradicted', places: ['src/ledger.rs:3'] }, { quote: snapshot, status: 'confirmed', search: 'Ledger::snapshot(' }], 0,
      'I cited a line against at least one of these statements.', 'What they mean for this finding is for a maintainer to decide.'],
    ['one contradicted by the PR description', [{ quote: csv, status: 'contradicted', description: HELD }, { quote: rewrote, status: 'confirmed', description_search: 'MAX_ROWS' }], 0,
      'I cited text of the PR description against at least one of these statements.', 'What they mean for this finding is for a maintainer to decide.'],
    ['one contradicted and one not checked', [{ quote: csv, status: 'contradicted', places: ['src/ledger.rs:3'] }, { quote: snapshot, status: 'not_checkable' }], 0,
      'I cited a line against at least one of these statements.', 'A maintainer has to judge the unchecked ones, and what the statements mean for this finding.'],
  ])('sums the checks up without a word on the finding, and leaves a blocking one to a maintainer: %s', (_name, statements, unchecked, checks, decision) => {
    const checked = { ...checkReply(answer({ statements }), REPLY, sources), unchecked };

    expect(statementSummary(checked, false)).toBe(checks);
    expect(statementSummary(checked, true)).toBe(`${checks} ${decision}`);
  });
});

describe('checkFixedElsewhere', () => {
  let workspace: string;
  const HEAD = 'a'.repeat(40);
  const OTHER_HEAD = 'b'.repeat(40);
  const MERGE = 'c'.repeat(40);
  const FIX = 'd'.repeat(40);
  // The commit a detached thread was posted on, which this PR's head holds.
  const POSTED = 'f'.repeat(40);
  // What GitHub's merge of this PR changes against its head: the finding's line 2 is replaced by two lines.
  const SINCE_HEAD = { filename: 'src/ledger.rs', status: 'modified', patch: '@@ -1,2 +1,3 @@\n pub struct Ledger;\n-impl Ledger {}\n+impl Ledger {\n+  fn check() {}' };
  // #7 replaced line 2 of the base with the same two lines.
  const FILE = { ...SINCE_HEAD };
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  // A merge that also holds a change another pull request made to another file.
  const OTHER_CHANGE = { filename: 'src/other.rs', status: 'added', patch: '@@ -0,0 +1,1 @@\n+fn other() {}' };

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'manki-elsewhere-'));
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src/ledger.rs'), 'pub struct Ledger;\nimpl Ledger {\n  fn check() {}\n}\n');
    writeFileSync(join(workspace, 'src/other.rs'), 'fn other() {}\n');
  });

  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  type Pull = { state: string; merged: boolean; head: { sha: string }; base: { ref: string }; merge_commit_sha: string | null; changed_files: number };
  const own: Pull = { state: 'open', merged: false, head: { sha: HEAD }, base: { ref: 'main' }, merge_commit_sha: MERGE, changed_files: 1 };
  const OWN_FILE = { filename: 'src/app.rs', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-a\n+b' };
  const merged: Pull = { state: 'closed', merged: true, head: { sha: OTHER_HEAD }, base: { ref: 'main' }, merge_commit_sha: FIX, changed_files: 1 };
  // A pull request stacked on this one, which the replier can open with any code to back their own claim.
  const stacked: Pull = { state: 'open', merged: false, head: { sha: OTHER_HEAD }, base: { ref: 'feature' }, merge_commit_sha: 'e'.repeat(40), changed_files: 1 };

  /** `holds` lists the `ancestor..commit` pairs where the commit holds the ancestor, and the comparison of `failing` throws. */
  function setup(other: Pull | Error, { holds = [`${HEAD}..${OTHER_HEAD}`, `${HEAD}..${MERGE}`, `${FIX}..${MERGE}`, `${POSTED}..${HEAD}`], failing = '', files = [FILE] as object[], ownFiles = [OWN_FILE] as object[], sinceHead = [SINCE_HEAD] as object[], answer = '' as string | Error, checkout = true as boolean | 'none', line = 2, ownBase = 'main', postedOn, sincePosted = [] as object[] }: {
    holds?: string[]; failing?: string; files?: object[] | Error; ownFiles?: object[]; sinceHead?: object[]; answer?: string | Error; checkout?: boolean | 'none'; line?: number; ownBase?: string; postedOn?: string; sincePosted?: object[];
  } = {}) {
    const octokit = {
      rest: {
        pulls: {
          get: jest.fn(async ({ pull_number }: { pull_number: number }) => {
            if (pull_number === 1) return { data: { ...own, base: { ref: ownBase } } };
            if (other instanceof Error) throw other;
            return { data: other };
          }),
          listFiles: jest.fn(),
        },
        repos: {
          get: jest.fn(async () => ({ data: { default_branch: 'main' } })),
          compareCommits: jest.fn(async ({ base, head }: { base: string; head: string }) => {
            if (`${base}..${head}` === failing) throw new Error('compare failed');
            return {
              data: { status: holds.includes(`${base}..${head}`) ? 'ahead' : 'diverged', ...(base === HEAD && head === MERGE && { files: sinceHead }), ...(base === POSTED && { files: sincePosted }) },
            };
          }),
        },
      },
      paginate: jest.fn(async (_list: unknown, { pull_number }: { pull_number: number }) => {
        if (pull_number === 1) return ownFiles;
        if (files instanceof Error) throw files;
        return files;
      }),
    };
    const ask = answer instanceof Error ? jest.fn().mockRejectedValue(answer) : jest.fn().mockResolvedValue(answer || JSON.stringify({ outcome: 'Fixed', answer: 'The ledger now checks the key.', proof: ['src/ledger.rs:2-3'] }));
    const checkoutFn = jest.fn().mockResolvedValue(checkout ? workspace : undefined);
    const sources: ElsewhereSources = {
      octokit: octokit as unknown as ElsewhereSources['octokit'], owner: 'acme', repo: 'ledger', prNumber: 1, file: 'src/ledger.rs', line, evidenceFiles: [], ask,
      ...(postedOn && { postedOn }),
      ...(checkout !== 'none' && { checkout: checkoutFn }),
    };
    return { sources, ask, checkout: checkoutFn };
  }

  it('confirms a fix #7 made by replacing the finding\'s line, checked at GitHub\'s merge of this PR that holds it', async () => {
    const { sources, ask, checkout } = setup(merged, { sinceHead: [SINCE_HEAD, OTHER_CHANGE] });

    expect(await checkFixedElsewhere(7, sources)).toEqual({ pr: 7, base: 'main', answer: 'The ledger now checks the key.' });
    expect(checkout).toHaveBeenCalledWith(MERGE);
    // The model sees what the other pull request changes in the finding's files, never its text.
    expect(ask).toHaveBeenCalledWith(workspace, expect.stringContaining('+  fn check() {}'), 7, [2, 3]);
  });

  // A detached thread names line 1 of the commit it was posted on. This PR has since put line 1 back above it, so the
  // finding's line is line 2 at the head, which #7 replaced.
  it('confirms a fix on the line a detached finding moved to at this PR\'s head', async () => {
    const { sources, ask } = setup(merged, { line: 1, postedOn: POSTED, sincePosted: [{ filename: 'src/ledger.rs', status: 'modified', patch: '@@ -0,0 +1,1 @@\n+pub struct Ledger;' }] });

    expect(await checkFixedElsewhere(7, sources)).toEqual({ pr: 7, base: 'main', answer: 'The ledger now checks the key.' });
    expect(ask).toHaveBeenCalledWith(workspace, expect.any(String), 7, [2, 3]);
    // A line posted on the head, or in a file this PR has not changed since, keeps its number.
    expect(await checkFixedElsewhere(7, setup(merged, { postedOn: HEAD }).sources)).toEqual({ pr: 7, base: 'main', answer: 'The ledger now checks the key.' });
    expect(await checkFixedElsewhere(7, setup(merged, { postedOn: POSTED, sincePosted: [OTHER_CHANGE] }).sources)).toEqual({ pr: 7, base: 'main', answer: 'The ledger now checks the key.' });
  });

  // #7 changed the file under the name it has on the base, before this PR renamed it.
  it.each<[string, object]>([
    ['renamed and changed', { filename: 'src/ledger.rs', previous_filename: 'src/old_ledger.rs', status: 'renamed', changes: 2, patch: '@@ -5,1 +5,1 @@\n-a\n+b' }],
    ['only renamed', { filename: 'src/ledger.rs', previous_filename: 'src/old_ledger.rs', status: 'renamed', changes: 0 }],
  ])('confirms a fix in a file this PR %s', async (_name, ownFile) => {
    const { sources } = setup(merged, { ownFiles: [ownFile], files: [{ ...FILE, filename: 'src/old_ledger.rs' }] });

    expect(await checkFixedElsewhere(7, sources)).toEqual({ pr: 7, base: 'main', answer: 'The ledger now checks the key.' });
  });

  // A reason that can pass later says when to reply again, and no reason is a final verdict on the claim.
  // Each failed lookup logs its cause.
  it.each<[string, Pull | Error, Parameters<typeof setup>[1], string, string, string | undefined]>([
    ['an open pull request into this PR\'s base', { ...stacked, base: { ref: 'main' } }, {}, '#7 is not merged yet', 'once #7 is merged into `main`', undefined],
    ['a pull request that cannot be read', new Error('Not Found'), {}, '#7 or this PR could not be read', 'in a few minutes', 'Failed to read the repository, this PR or #7: Not Found'],
    ['a comparison of this PR\'s head with its merge that fails', merged, { failing: `${HEAD}..${MERGE}` }, 'GitHub\'s merge of this PR into its base does not hold #7 yet', 'in a few minutes, once this PR merges cleanly with `main`', `Failed to compare this PR's head with its merge ${MERGE}: compare failed`],
    ['a lookup of whether this PR\'s head holds #7 that fails', merged, { failing: `${FIX}..${HEAD}` }, 'whether this PR\'s head holds #7 could not be read', 'in a few minutes', `Failed to compare ${FIX} with ${HEAD}: compare failed`],
    ['a merge of this PR from before its head', merged, { holds: [`${FIX}..${MERGE}`] }, 'GitHub\'s merge of this PR into its base does not hold #7 yet', 'in a few minutes, once this PR merges cleanly with `main`', undefined],
    ['a merge of this PR GitHub has not updated with the fix yet', merged, { holds: [`${HEAD}..${MERGE}`] }, 'GitHub\'s merge of this PR into its base does not hold #7 yet', 'in a few minutes, once this PR merges cleanly with `main`', undefined],
    ['no merge of this PR', { ...merged, merge_commit_sha: null }, {}, 'GitHub\'s merge of this PR into its base does not hold #7 yet', 'in a few minutes, once this PR merges cleanly with `main`', undefined],
    ['files that cannot be read', merged, { files: new Error('boom') }, 'the files this PR and #7 change could not be read', 'in a few minutes', 'Failed to list the files of #7: boom'],
    ['a checkout that fails', merged, { checkout: false }, 'the merge with #7 could not be checked out', 'in a few minutes', undefined],
    ['a check of the merge that fails', merged, { answer: new Error('timed out') }, 'the check of the merge with #7 failed', 'in a few minutes', 'Failed to check the merge with #7: timed out'],
    ['a detached finding whose line at the head cannot be read', merged, { postedOn: POSTED, failing: `${POSTED}..${HEAD}` }, 'where `src/ledger.rs:2` is at this PR\'s head could not be read', 'in a few minutes', `Failed to compare ${POSTED} with this PR's head: compare failed`],
  ])('confirms nothing yet for %s', async (_name, other, options, why, retry, logged) => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const { sources } = setup(other, options);

    expect(await checkFixedElsewhere(7, sources)).toEqual({ why, retry });
    if (logged) expect(warning).toHaveBeenCalledWith(logged);
    else expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it.each<[string, Pull | Error, Parameters<typeof setup>[1], string]>([
    ['an issue, or a number with no pull request', notFound(), {}, '#7 is not a pull request in this repository'],
    // A pull request merged after #7 changed the code #7 put in place of the finding's line again.
    ['a fix a later pull request changed again', merged, { files: [{ ...FILE, patch: '@@ -1,2 +1,3 @@\n pub struct Ledger;\n-impl Ledger {}\n+impl Ledger {\n+  fn check_old() {}' }] }, 'the code that replaced `src/ledger.rs:2` is not the code #7 put there, so a later change may have made the fix'],
    ['a list of files GitHub cut short', { ...merged, changed_files: 2 }, {}, 'GitHub does not list every file this PR and #7 change'],
    ['a merge that deletes the finding\'s file', merged, { sinceHead: [{ filename: 'src/ledger.rs', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-pub struct Ledger;\n-impl Ledger {}' }] }, 'the merge with #7 deletes `src/ledger.rs`'],
    ['a pull request closed without a merge', { ...stacked, state: 'closed', base: { ref: 'main' } }, {}, '#7 is closed without being merged'],
    ['a pull request merged into another branch', { ...merged, base: { ref: 'release' } }, {}, '#7 targets `release`, not the default branch `main`'],
    // Whoever may push to a stacked PR's base branch can merge any code there, so only the default branch counts.
    ['a throwaway pull request stacked on this one', stacked, {}, '#7 targets `feature`, not the default branch `main`'],
    ['a throwaway pull request merged into the base of this stacked PR', { ...merged, base: { ref: 'feature' } }, { ownBase: 'feature' }, 'this PR\'s base `feature` is not the default branch `main`'],
    ['a pull request this PR\'s head already holds', merged, { holds: [`${HEAD}..${MERGE}`, `${FIX}..${MERGE}`, `${FIX}..${HEAD}`] }, 'this PR\'s head already holds #7, so #7 cannot be what fixes it'],
    ['no change to a file the finding cites', merged, { files: [{ ...FILE, filename: 'src/other.rs' }] }, '#7 changes none of the files this finding cites'],
    ['a finding on the whole file', merged, { line: 0 }, 'this finding names no line'],
    ['a merge that keeps the finding\'s line and replaces the next one', merged, { line: 1 }, 'the merge with #7 changes only the lines next to `src/ledger.rs:1`, and the check needs `src/ledger.rs:1` itself replaced'],
    ['a merge that only adds a guard above the finding\'s line', merged, { sinceHead: [{ ...SINCE_HEAD, patch: '@@ -1,2 +1,3 @@\n pub struct Ledger;\n+// guard\n impl Ledger {}' }] }, 'the merge with #7 changes only the lines next to `src/ledger.rs:2`, and the check needs `src/ledger.rs:2` itself replaced'],
    ['a merge that changes the finding\'s file far from its line', merged, { line: 40 }, 'the merge with #7 leaves `src/ledger.rs:40` as it is'],
    ['a merge that does not change the finding\'s file', merged, { sinceHead: [{ ...SINCE_HEAD, filename: 'src/other.rs' }] }, 'the merge with #7 leaves `src/ledger.rs:2` as it is'],
    // A change GitHub does not show in full is no proof either way, so a maintainer decides.
    ['a merge whose change GitHub shows without lines', merged, { sinceHead: [{ ...SINCE_HEAD, patch: undefined }] }, 'GitHub shows no lines of the change the merge with #7 makes to `src/ledger.rs`'],
    ['a merge with more files than GitHub lists', merged, { sinceHead: Array.from({ length: 300 }, (_, i) => ({ ...SINCE_HEAD, filename: `src/f${i}.rs` })) }, 'GitHub lists only 300 of the files the merge with #7 changes, so it does not show `src/ledger.rs`'],
    ['a change of this PR GitHub shows without lines', merged, { ownFiles: [{ filename: 'src/ledger.rs', status: 'modified' }] }, 'GitHub shows no lines of this PR\'s change to `src/ledger.rs`'],
    ['a change of #7 GitHub shows without lines', merged, { files: [{ ...FILE, patch: undefined }] }, 'GitHub shows no lines of the change #7 makes to `src/ledger.rs`'],
    // The merge holds every change on the base since this PR branched, so another merged PR can be what replaced the line.
    ['a fix another merged pull request made, with #7 changing the same file far from it', merged, { files: [{ ...FILE, patch: '@@ -40,1 +40,1 @@\n-old\n+new' }] }, '#7\'s diff does not replace `src/ledger.rs:2`, but it counts lines from #7\'s own base, so whether #7 replaces the line is not certain'],
    ['a fix an earlier pull request made, with #7 changing the line next to it', merged, { files: [{ ...FILE, patch: '@@ -1,1 +1,1 @@\n-pub struct Ledger;\n+pub struct Ledger2;' }] }, '#7\'s diff does not replace `src/ledger.rs:2`, but it counts lines from #7\'s own base, so whether #7 replaces the line is not certain'],
    // This PR removed the first 10 lines, so the finding's line 2 was line 12 on the base, far from #7's change to line 1.
    ['a change #7 made where the finding\'s line was not on the base', merged, { ownFiles: [{ filename: 'src/ledger.rs', status: 'modified', patch: '@@ -1,10 +0,0 @@\n' + '-x\n'.repeat(10).trimEnd() }] }, '#7\'s diff does not replace `src/ledger.rs:2`, but it counts lines from #7\'s own base, so whether #7 replaces the line is not certain'],
    ['a line this PR adds', merged, { ownFiles: [{ filename: 'src/ledger.rs', status: 'modified', patch: '@@ -1,1 +1,2 @@\n pub struct Ledger;\n+impl Ledger {}' }] }, '#7 does not replace `src/ledger.rs:2`'],
    // Where a detached finding's line is now is not certain, so its claim is never confirmed.
    ['a detached finding whose line this PR changed since', merged, { postedOn: POSTED, sincePosted: [{ filename: 'src/ledger.rs', status: 'modified', patch: '@@ -2,1 +2,1 @@\n-impl Ledger {}\n+impl Ledger { }' }] }, 'this PR changed `src/ledger.rs:2` or its file since this finding was posted, so where the line is now is not certain'],
    ['a detached finding whose file this PR renamed since', merged, { postedOn: POSTED, sincePosted: [{ filename: 'src/book.rs', previous_filename: 'src/ledger.rs', status: 'renamed', changes: 0 }] }, 'this PR changed `src/ledger.rs:2` or its file since this finding was posted, so where the line is now is not certain'],
    ['a detached finding posted on a commit a force push dropped', merged, { postedOn: POSTED, holds: [`${HEAD}..${MERGE}`, `${FIX}..${MERGE}`] }, 'this PR\'s head no longer holds the commit this finding was posted on, so where `src/ledger.rs:2` is now is not certain'],
    ['a detached finding whose file GitHub does not list since', merged, { postedOn: POSTED, sincePosted: Array.from({ length: 300 }, (_, i) => ({ ...OTHER_CHANGE, filename: `src/f${i}.rs` })) }, 'GitHub lists only 300 of the files this PR changed since this finding was posted, so where `src/ledger.rs:2` is now is not certain'],
    ['a check that keeps the finding', merged, { answer: JSON.stringify({ outcome: 'Kept', answer: 'Still there.', proof: ['src/ledger.rs:2'] }) }, 'the check of the merge with #7 did not show the defect gone on the lines #7 put there'],
    ['a fix on a line that does not exist', merged, { answer: JSON.stringify({ outcome: 'Fixed', answer: 'Gone.', proof: ['src/ledger.rs:99'] }) }, 'the check of the merge with #7 did not show the defect gone on the lines #7 put there'],
    ['a fix on lines the merge added for another pull request', merged, { sinceHead: [SINCE_HEAD, OTHER_CHANGE], answer: JSON.stringify({ outcome: 'Fixed', answer: 'Gone.', proof: ['src/ledger.rs:2', 'src/other.rs:1'] }) }, 'the check of the merge with #7 did not show the defect gone on the lines #7 put there'],
    ['a fix on a line the merge did not change', merged, { answer: JSON.stringify({ outcome: 'Fixed', answer: 'Gone.', proof: ['src/ledger.rs:1-2'] }) }, 'the check of the merge with #7 did not show the defect gone on the lines #7 put there'],
    // No line can be cited among lines that do not exist, so a fix that only removes the finding's line is not shown.
    ['a fix that only removes the finding\'s line', merged, { sinceHead: [{ ...SINCE_HEAD, patch: '@@ -1,2 +1,1 @@\n pub struct Ledger;\n-impl Ledger {}' }], files: [{ ...FILE, patch: '@@ -1,2 +1,1 @@\n pub struct Ledger;\n-impl Ledger {}' }] }, '#7 only removes `src/ledger.rs:2`, and the check needs a line #7 put in its place'],
    ['a fix without proof', merged, { answer: JSON.stringify({ outcome: 'Fixed', answer: 'Gone.' }) }, 'the check of the merge with #7 did not show the defect gone on the lines #7 put there'],
    ['an answer that cannot be read', merged, { answer: 'Fixed, trust me.' }, 'the check of the merge with #7 did not show the defect gone on the lines #7 put there'],
  ])('confirms nothing for %s', async (_name, other, options, why) => {
    const { sources } = setup(other, options);
    expect(await checkFixedElsewhere(7, sources)).toEqual({ why });
  });

  it('confirms nothing for this PR itself, for a finding tied to no file, or without tools, before it reads GitHub', async () => {
    const { sources, ask } = setup(merged);
    const { checkout: _checkout, ...withoutTools } = sources;
    expect(await checkFixedElsewhere(7, withoutTools)).toEqual({ why: 'this reply runs without repository tools' });
    expect(sources.octokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(await checkFixedElsewhere(1, sources)).toEqual({ why: 'it names this pull request' });
    expect(await checkFixedElsewhere(7, { ...sources, file: '' })).toEqual({ why: 'this finding is not tied to a file' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('says what was confirmed, or why not', () => {
    const checked = checkReply(JSON.stringify({ outcome: 'FixedElsewhere', answer: 'You name #7.', fixed_in: 7 }), 'Fixed in #7.', { relatedNames: [], repo: 'acme/ledger' });

    expect(fixedElsewhereText(checked, { pr: 7, base: 'main', answer: 'The ledger now checks the key.' }))
      .toBe('Confirmed: #7, merged into `main`, replaced the cited line. The ledger now checks the key. This PR\'s own code still has the defect, so this thread stays as it is. Update this branch with `main`, and the next review checks the fix here.');
    expect(fixedElsewhereText(checked, { why: '#7 is not merged yet', retry: 'once #7 is merged into `main`' }))
      .toBe('Unverified. You name #7. I could not check #7 yet: #7 is not merged yet. This thread stays as it is. Reply again once #7 is merged into `main`.');
    expect(fixedElsewhereText(checked, { why: '#7 is closed without being merged' }))
      .toBe('Unverified. You name #7. I could not confirm that #7 fixes this finding: #7 is closed without being merged. A maintainer should decide.');
    const closed = { why: '#7 is closed without being merged' };
    expect(fixedElsewhereText(checked, closed, 'open')).toMatch(/merged\. A maintainer should decide and resolve this thread\.$/);
    expect(fixedElsewhereText(checked, closed, 'resolved')).toMatch(/without being merged\.$/);
  });
});
