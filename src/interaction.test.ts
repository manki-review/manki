import { parseCommand, buildReplyContext, parseTriageBody, ParsedCommand, isBotComment, hasBotMention, isReviewRequest, isBotMentionNonReview } from './interaction';

describe('parseCommand', () => {
  it('parses @manki explain with args', () => {
    const result = parseCommand('@manki explain the error handling');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the error handling' });
  });

  it('parses @manki explain without args', () => {
    const result = parseCommand('@manki explain');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: '' });
  });

  it('parses @manki dismiss with finding reference', () => {
    const result = parseCommand('@manki dismiss null-check-warning');
    expect(result).toEqual<ParsedCommand>({ type: 'dismiss', args: 'null-check-warning' });
  });

  it('parses @manki dismiss without args', () => {
    const result = parseCommand('@manki dismiss');
    expect(result).toEqual<ParsedCommand>({ type: 'dismiss', args: '' });
  });

  it('parses @manki help', () => {
    const result = parseCommand('@manki help');
    expect(result).toEqual<ParsedCommand>({ type: 'help', args: '' });
  });

  it('returns generic for unrecognized @manki text', () => {
    const body = '@manki what do you think about this approach?';
    const result = parseCommand(body);
    expect(result).toEqual<ParsedCommand>({ type: 'generic', args: body });
  });

  it('returns generic when no @manki mention present', () => {
    const body = 'just a regular comment';
    const result = parseCommand(body);
    expect(result).toEqual<ParsedCommand>({ type: 'generic', args: body });
  });

  it('is case-insensitive for commands', () => {
    const result = parseCommand('@Manki EXPLAIN the changes');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the changes' });
  });

  it('handles @manki in the middle of a comment', () => {
    const result = parseCommand('Hey @manki explain this function please');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'this function please' });
  });

  it('parses /manki prefix', () => {
    const result = parseCommand('/manki explain the error handling');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the error handling' });
  });

  it('parses /manki dismiss', () => {
    const result = parseCommand('/manki dismiss null-check-warning');
    expect(result).toEqual<ParsedCommand>({ type: 'dismiss', args: 'null-check-warning' });
  });

  it('parses /manki help', () => {
    const result = parseCommand('/manki help');
    expect(result).toEqual<ParsedCommand>({ type: 'help', args: '' });
  });

  it('parses @manki-labs prefix', () => {
    const result = parseCommand('@manki-labs explain the error handling');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the error handling' });
  });

  it('parses @manki-labs dismiss', () => {
    const result = parseCommand('@manki-labs dismiss null-check-warning');
    expect(result).toEqual<ParsedCommand>({ type: 'dismiss', args: 'null-check-warning' });
  });

  it('parses @manki-labs help', () => {
    const result = parseCommand('@manki-labs help');
    expect(result).toEqual<ParsedCommand>({ type: 'help', args: '' });
  });

  it('is case-insensitive for /manki prefix', () => {
    const result = parseCommand('/Manki EXPLAIN the changes');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the changes' });
  });

  it('is case-insensitive for @manki-labs prefix', () => {
    const result = parseCommand('@Manki-Labs EXPLAIN the changes');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the changes' });
  });

  it('parses @manki remember with instruction', () => {
    const result = parseCommand('@manki remember always check for SQL injection in query builders');
    expect(result).toEqual<ParsedCommand>({ type: 'remember', args: 'always check for sql injection in query builders' });
  });

  it('parses @manki remember without args', () => {
    const result = parseCommand('@manki remember');
    expect(result).toEqual<ParsedCommand>({ type: 'remember', args: '' });
  });

  it('parses @manki forget with args', () => {
    const result = parseCommand('@manki forget something');
    expect(result).toEqual<ParsedCommand>({ type: 'forget', args: 'something' });
  });

  it('parses @manki forget suppression with pattern', () => {
    const result = parseCommand('@manki forget suppression unused variable');
    expect(result).toEqual<ParsedCommand>({ type: 'forget', args: 'suppression unused variable' });
  });

  it('parses @manki forget without args', () => {
    const result = parseCommand('@manki forget');
    expect(result).toEqual<ParsedCommand>({ type: 'forget', args: '' });
  });

  it('parses @manki check with args', () => {
    const result = parseCommand('@manki check memory');
    expect(result).toEqual<ParsedCommand>({ type: 'check', args: 'memory' });
  });

  it('parses @manki triage', () => {
    const result = parseCommand('@manki triage');
    expect(result).toEqual<ParsedCommand>({ type: 'triage', args: '' });
  });

  it('parses @manki triage case-insensitively', () => {
    const result = parseCommand('@Manki TRIAGE');
    expect(result).toEqual<ParsedCommand>({ type: 'triage', args: '' });
  });

});

describe('parseTriageBody', () => {
  it('parses old backtick format with suggestion and question emojis', () => {
    const body = [
      '- [x] 💡 **Null check missing** — `src/index.ts:42`',
      '- [ ] ❓ **Unused import** — `src/utils.ts:10`',
    ].join('\n');
    const result = parseTriageBody(body);
    expect(result.accepted).toEqual([{ title: 'Null check missing', ref: 'src/index.ts:42' }]);
    expect(result.rejected).toEqual([{ title: 'Unused import', ref: 'src/utils.ts:10' }]);
  });

  it('parses new details/summary format with code tags', () => {
    const body = [
      '- [x] <details><summary>📝 **Style nit** — <code>src/app.ts:7</code></summary>',
      '',
      'Consider using const instead of let.',
      '</details>',
      '- [ ] <details><summary>📝 **Rename variable** — <code>src/app.ts:15</code></summary>',
      '',
      'Use a more descriptive name.',
      '</details>',
    ].join('\n');
    const result = parseTriageBody(body);
    expect(result.accepted).toEqual([{ title: 'Style nit', ref: 'src/app.ts:7' }]);
    expect(result.rejected).toEqual([{ title: 'Rename variable', ref: 'src/app.ts:15' }]);
  });

  it('parses blocker emoji in new format', () => {
    const body = '- [x] <details><summary>🚫 **Security flaw** — <code>src/auth.ts:99</code></summary>\n</details>';
    const result = parseTriageBody(body);
    expect(result.accepted).toEqual([{ title: 'Security flaw', ref: 'src/auth.ts:99' }]);
  });

  it('handles mix of old and new formats', () => {
    const body = [
      '- [x] 💡 **Old finding** — `src/old.ts:1`',
      '- [x] <details><summary>📝 **New finding** — <code>src/new.ts:2</code></summary>',
      '</details>',
      '- [ ] ❓ **Old rejected** — `src/old.ts:5`',
      '- [ ] <details><summary>🚫 **New rejected** — <code>src/new.ts:8</code></summary>',
      '</details>',
    ].join('\n');
    const result = parseTriageBody(body);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
    expect(result.accepted[0].title).toBe('Old finding');
    expect(result.accepted[1].title).toBe('New finding');
    expect(result.rejected[0].title).toBe('Old rejected');
    expect(result.rejected[1].title).toBe('New rejected');
  });

  it('returns empty arrays when no findings match', () => {
    const result = parseTriageBody('No findings here.');
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe('buildReplyContext', () => {
  const BOT_MARKER = '<!-- manki -->';
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

describe('isBotComment', () => {
  it('detects new manki bot marker', () => {
    expect(isBotComment('<!-- manki -->\nsome content')).toBe(true);
  });

  it('detects new manki metadata marker', () => {
    expect(isBotComment('content <!-- manki:blocking:test -->')).toBe(true);
  });

  it('returns false for unrelated comments', () => {
    expect(isBotComment('just a regular comment')).toBe(false);
  });
});

describe('hasBotMention', () => {
  it('detects @manki mention', () => {
    expect(hasBotMention('@manki explain this')).toBe(true);
  });

  it('detects /manki mention', () => {
    expect(hasBotMention('/manki explain this')).toBe(true);
  });

  it('detects @manki-labs mention', () => {
    expect(hasBotMention('@manki-labs explain this')).toBe(true);
  });

  it('returns false for unrelated text', () => {
    expect(hasBotMention('just a comment')).toBe(false);
  });

  it('is case-insensitive for @manki', () => {
    expect(hasBotMention('@MANKI help')).toBe(true);
  });

  it('is case-insensitive for /manki', () => {
    expect(hasBotMention('/MANKI help')).toBe(true);
  });

  it('is case-insensitive for @manki-labs', () => {
    expect(hasBotMention('@MANKI-LABS help')).toBe(true);
  });
});

describe('isReviewRequest', () => {
  it('detects @manki review', () => {
    expect(isReviewRequest('@manki review')).toBe(true);
  });

  it('detects /manki review', () => {
    expect(isReviewRequest('/manki review')).toBe(true);
  });

  it('detects @manki-labs review', () => {
    expect(isReviewRequest('@manki-labs review')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isReviewRequest('@Manki Review')).toBe(true);
  });

  it('returns false for non-review commands', () => {
    expect(isReviewRequest('@manki explain')).toBe(false);
    expect(isReviewRequest('/manki help')).toBe(false);
  });

  it('returns false for text without bot mention', () => {
    expect(isReviewRequest('please review this')).toBe(false);
  });
});

describe('isBotMentionNonReview', () => {
  it('detects @manki explain', () => {
    expect(isBotMentionNonReview('@manki explain')).toBe(true);
  });

  it('detects /manki help', () => {
    expect(isBotMentionNonReview('/manki help')).toBe(true);
  });

  it('detects @manki-labs dismiss', () => {
    expect(isBotMentionNonReview('@manki-labs dismiss')).toBe(true);
  });

  it('returns false for review commands', () => {
    expect(isBotMentionNonReview('@manki review')).toBe(false);
    expect(isBotMentionNonReview('/manki review')).toBe(false);
    expect(isBotMentionNonReview('@manki-labs review')).toBe(false);
  });

  it('returns false for text without bot mention', () => {
    expect(isBotMentionNonReview('just a comment')).toBe(false);
  });
});
