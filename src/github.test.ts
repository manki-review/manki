import { formatFindingComment, mapVerdictToEvent, BOT_MARKER, buildNitIssueBody } from './github';
import { Finding } from './types';

describe('formatFindingComment', () => {
  const baseFinding: Finding = {
    severity: 'blocking',
    title: 'Null pointer dereference',
    file: 'src/main.ts',
    line: 42,
    description: 'This code will throw if the value is undefined.',
    reviewers: ['Security & Correctness'],
  };

  it('formats a blocking finding with correct emoji and label', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).toContain('🚫 **Blocking**');
    expect(comment).toContain(baseFinding.title);
    expect(comment).toContain(baseFinding.description);
  });

  it('formats a suggestion finding with correct emoji and label', () => {
    const finding: Finding = { ...baseFinding, severity: 'suggestion' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('💡 **Suggestion**');
  });

  it('formats a question finding with correct emoji and label', () => {
    const finding: Finding = { ...baseFinding, severity: 'question' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('❓ **Question**');
  });

  it('wraps suggested fix in a collapsible details section', () => {
    const finding: Finding = { ...baseFinding, suggestedFix: 'if (value != null) { use(value); }' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<details>\n<summary>Suggested fix</summary>');
    expect(comment).toContain('```suggestion');
    expect(comment).toContain('if (value != null) { use(value); }');
    expect(comment).not.toContain('<details open');
  });

  it('omits suggested fix section when not present', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).not.toContain('<summary>Suggested fix</summary>');
    expect(comment).not.toContain('```suggestion');
  });

  it('includes AI agent prompt in a collapsible details section with labeled fields', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).toContain('<details>\n<summary>🤖 Prompt for AI Agents</summary>');
    expect(comment).toContain(`**File:** \`${baseFinding.file}\``);
    expect(comment).toContain(`**Line:** ${baseFinding.line}`);
    expect(comment).toContain(`**Finding:** ${baseFinding.title}`);
    expect(comment).toContain(`**Severity:** ${baseFinding.severity}`);
    expect(comment).toContain(`**Description:**\n${baseFinding.description}`);
    expect(comment).toContain('> **Important:** Before applying this fix, validate the finding');
    expect(comment).not.toContain('<details open');
  });

  it('includes suggested fix in AI agent prompt when suggestedFix is present', () => {
    const finding: Finding = { ...baseFinding, suggestedFix: 'if (value != null) { use(value); }' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('**Suggested fix:**\n```\nif (value != null) { use(value); }\n```');
  });

  it('omits suggested fix from AI agent prompt when no suggestedFix', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).not.toContain('**Suggested fix:**\n```');
  });

  it('includes reviewer attribution', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).toContain('<sub>Flagged by: Security & Correctness</sub>');
  });

  it('includes multiple reviewer attributions', () => {
    const finding: Finding = { ...baseFinding, reviewers: ['Security', 'Testing'] };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<sub>Flagged by: Security, Testing</sub>');
  });

  it('omits reviewer attribution when reviewers is empty', () => {
    const finding: Finding = { ...baseFinding, reviewers: [] };
    const comment = formatFindingComment(finding);
    expect(comment).not.toContain('Flagged by');
  });

  it('includes metadata marker with severity and sanitized title', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).toContain('<!-- manki:blocking:Null-pointer-dereference -->');
  });

  it('sanitizes special characters in metadata marker title', () => {
    const finding: Finding = { ...baseFinding, title: 'Bug: foo() returns "bar"!' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<!-- manki:blocking:Bug--foo---returns--bar-- -->');
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

describe('BOT_MARKER', () => {
  it('is an HTML comment', () => {
    expect(BOT_MARKER).toMatch(/^<!--.*-->$/);
  });
});

describe('buildNitIssueBody', () => {
  const suggestion: Finding = {
    severity: 'suggestion',
    title: 'Use const instead of let',
    file: 'src/utils.ts',
    line: 10,
    description: 'Variable is never reassigned.',
    reviewers: ['Style'],
  };

  const question: Finding = {
    severity: 'question',
    title: 'Is this timeout intentional?',
    file: 'src/client.ts',
    line: 55,
    description: 'The timeout of 60s seems high for this endpoint.',
    reviewers: ['Performance'],
  };

  const blocking: Finding = {
    severity: 'blocking',
    title: 'Null dereference',
    file: 'src/main.ts',
    line: 1,
    description: 'Will crash at runtime.',
    reviewers: ['Security'],
  };

  it('filters to only suggestion and question findings', () => {
    const body = buildNitIssueBody(42, [blocking, suggestion, question], 'myorg');
    expect(body).toContain('Use const instead of let');
    expect(body).toContain('Is this timeout intentional?');
    expect(body).not.toContain('Null dereference');
  });

  it('formats checklist items with file and line', () => {
    const body = buildNitIssueBody(42, [suggestion], 'myorg');
    expect(body).toContain('- [ ]');
    expect(body).toContain('`src/utils.ts:10`');
    expect(body).toContain('Variable is never reassigned.');
  });

  it('includes PR reference in header', () => {
    const body = buildNitIssueBody(99, [suggestion], 'myorg');
    expect(body).toContain('PR #99');
  });

  it('includes suggested fix when present', () => {
    const withFix: Finding = { ...suggestion, suggestedFix: 'const x = 1;' };
    const body = buildNitIssueBody(42, [withFix], 'myorg');
    expect(body).toContain('**Suggested fix:**');
    expect(body).toContain('`const x = 1;`');
  });

  it('omits suggested fix when not present', () => {
    const body = buildNitIssueBody(42, [suggestion], 'myorg');
    expect(body).not.toContain('Suggested fix');
  });

  it('truncates long suggested fixes to 100 chars', () => {
    const longFix = 'a'.repeat(200);
    const withFix: Finding = { ...suggestion, suggestedFix: longFix };
    const body = buildNitIssueBody(42, [withFix], 'myorg');
    expect(body).toContain('`' + 'a'.repeat(100) + '`');
    expect(body).not.toContain('a'.repeat(101));
  });

  it('uses correct emoji for suggestion vs question', () => {
    const body = buildNitIssueBody(42, [suggestion, question], 'myorg');
    // suggestion gets lightbulb, question gets question mark
    expect(body).toContain('\u{1F4A1} **Use const instead of let**');
    expect(body).toContain('\u{2753} **Is this timeout intentional?**');
  });
});
