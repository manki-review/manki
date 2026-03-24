import { parseCommand, buildReplyContext, ParsedCommand } from './interaction';

describe('parseCommand', () => {
  it('parses @claude explain with args', () => {
    const result = parseCommand('@claude explain the error handling');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the error handling' });
  });

  it('parses @claude explain without args', () => {
    const result = parseCommand('@claude explain');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: '' });
  });

  it('parses @claude dismiss with finding reference', () => {
    const result = parseCommand('@claude dismiss null-check-warning');
    expect(result).toEqual<ParsedCommand>({ type: 'dismiss', args: 'null-check-warning' });
  });

  it('parses @claude dismiss without args', () => {
    const result = parseCommand('@claude dismiss');
    expect(result).toEqual<ParsedCommand>({ type: 'dismiss', args: '' });
  });

  it('parses @claude help', () => {
    const result = parseCommand('@claude help');
    expect(result).toEqual<ParsedCommand>({ type: 'help', args: '' });
  });

  it('returns generic for unrecognized @claude text', () => {
    const body = '@claude what do you think about this approach?';
    const result = parseCommand(body);
    expect(result).toEqual<ParsedCommand>({ type: 'generic', args: body });
  });

  it('returns generic when no @claude mention present', () => {
    const body = 'just a regular comment';
    const result = parseCommand(body);
    expect(result).toEqual<ParsedCommand>({ type: 'generic', args: body });
  });

  it('is case-insensitive for commands', () => {
    const result = parseCommand('@Claude EXPLAIN the changes');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the changes' });
  });

  it('handles @claude in the middle of a comment', () => {
    const result = parseCommand('Hey @claude explain this function please');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'this function please' });
  });
});

describe('buildReplyContext', () => {
  const BOT_MARKER = '<!-- claude-review -->';

  it('builds context with file path and line number', () => {
    const result = buildReplyContext(
      `${BOT_MARKER}\nThis variable could be null.`,
      'Good point, I will add a check.',
      'src/index.ts',
      42,
    );

    expect(result).toContain('## Original Review Comment');
    expect(result).toContain('This variable could be null.');
    expect(result).not.toContain(BOT_MARKER);
    expect(result).toContain('File: `src/index.ts` (line 42)');
    expect(result).toContain('## Developer Reply');
    expect(result).toContain('Good point, I will add a check.');
  });

  it('builds context with file path but no line number', () => {
    const result = buildReplyContext(
      'Review comment body',
      'Developer reply',
      'src/utils.ts',
      null,
    );

    expect(result).toContain('File: `src/utils.ts`');
    expect(result).not.toContain('(line');
  });

  it('builds context without file path', () => {
    const result = buildReplyContext(
      'Review comment body',
      'Developer reply',
      null,
      null,
    );

    expect(result).not.toContain('File:');
    expect(result).toContain('## Original Review Comment');
    expect(result).toContain('## Developer Reply');
  });

  it('builds context with undefined file path', () => {
    const result = buildReplyContext(
      'Some comment',
      'Some reply',
      undefined,
      undefined,
    );

    expect(result).not.toContain('File:');
  });

  it('strips bot marker from original comment', () => {
    const result = buildReplyContext(
      `${BOT_MARKER}\nActual review content here`,
      'Reply',
    );

    expect(result).not.toContain(BOT_MARKER);
    expect(result).toContain('Actual review content here');
  });
});
