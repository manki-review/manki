import { formatFindingComment, mapVerdictToEvent, BOT_MARKER } from './github';
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

  it('includes suggested fix in a suggestion code block when present', () => {
    const finding: Finding = { ...baseFinding, suggestedFix: 'if (value != null) { use(value); }' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('**Suggested fix:**');
    expect(comment).toContain('```suggestion');
    expect(comment).toContain('if (value != null) { use(value); }');
  });

  it('omits suggested fix section when not present', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).not.toContain('**Suggested fix:**');
    expect(comment).not.toContain('```suggestion');
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
    expect(comment).toContain('<!-- claude-review:blocking:Null-pointer-dereference -->');
  });

  it('sanitizes special characters in metadata marker title', () => {
    const finding: Finding = { ...baseFinding, title: 'Bug: foo() returns "bar"!' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<!-- claude-review:blocking:Bug--foo---returns--bar-- -->');
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
