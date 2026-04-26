import { parseCommand, buildReplyContext, parseTriageBody, extractFindingContent, triageTitlePrefix, extractPrNumber, ParsedCommand, isBotComment, hasBotMention, isReviewRequest, isBotMentionNonReview, handlePRComment, handleReviewCommentReply, handleReviewCommentCommand, scopeDiffToFile, isRepoUser, isLLMAccessAllowed } from './interaction';
import { ReviewConfig } from './types';
import * as github from '@actions/github';
import * as core from '@actions/core';
import { ClaudeClient } from './claude';
import * as memory from './memory';
import * as ghUtils from './github';
import * as state from './state';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  getInput: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  context: {
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
    actor: 'test-user',
  },
  getOctokit: jest.fn(() => 'mock-memory-octokit'),
}));

jest.mock('./memory', () => ({
  writeSuppression: jest.fn().mockResolvedValue(undefined),
  writeLearning: jest.fn().mockResolvedValue(undefined),
  removeLearning: jest.fn().mockResolvedValue({ removed: null, remaining: 0 }),
  removeSuppression: jest.fn().mockResolvedValue({ removed: null, remaining: 0 }),
  batchUpdatePatternDecisions: jest.fn().mockResolvedValue(undefined),
  sanitizeMemoryField: jest.fn((v: string) => v),
}));

jest.mock('./github', () => ({
  reactToIssueComment: jest.fn().mockResolvedValue(undefined),
  reactToReviewComment: jest.fn().mockResolvedValue(undefined),
  fetchPRDiff: jest.fn().mockResolvedValue(''),
}));

jest.mock('./review', () => ({
  truncateDiff: jest.fn((s: string) => s),
}));

jest.mock('./state', () => ({
  checkAndAutoApprove: jest.fn().mockResolvedValue(false),
  fetchBotReviewThreads: jest.fn().mockResolvedValue([]),
}));

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

  it('parses @manki-review prefix', () => {
    const result = parseCommand('@manki-review explain the error handling');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the error handling' });
  });

  it('parses @manki-review dismiss', () => {
    const result = parseCommand('@manki-review dismiss null-check-warning');
    expect(result).toEqual<ParsedCommand>({ type: 'dismiss', args: 'null-check-warning' });
  });

  it('parses @manki-review help', () => {
    const result = parseCommand('@manki-review help');
    expect(result).toEqual<ParsedCommand>({ type: 'help', args: '' });
  });

  it('is case-insensitive for /manki prefix', () => {
    const result = parseCommand('/Manki EXPLAIN the changes');
    expect(result).toEqual<ParsedCommand>({ type: 'explain', args: 'the changes' });
  });

  it('is case-insensitive for @manki-review prefix', () => {
    const result = parseCommand('@Manki-Review EXPLAIN the changes');
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
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].title).toBe('Null check missing');
    expect(result.accepted[0].ref).toBe('src/index.ts:42');
    expect(result.accepted[0].section).toContain('Null check missing');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].title).toBe('Unused import');
    expect(result.rejected[0].ref).toBe('src/utils.ts:10');
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
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].title).toBe('Style nit');
    expect(result.accepted[0].ref).toBe('src/app.ts:7');
    expect(result.accepted[0].section).toContain('Consider using const');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].title).toBe('Rename variable');
    expect(result.rejected[0].ref).toBe('src/app.ts:15');
  });

  it('parses blocker emoji in new format', () => {
    const body = '- [x] <details><summary>🚫 **Security flaw** — <code>src/auth.ts:99</code></summary>\n</details>';
    const result = parseTriageBody(body);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].title).toBe('Security flaw');
    expect(result.accepted[0].ref).toBe('src/auth.ts:99');
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

  it('still parses legacy 💡 suggestion emoji from pre-rename triage comments', () => {
    const body = [
      '- [x] 💡 **Legacy accepted** — `src/legacy.ts:1`',
      '- [ ] 💡 **Legacy rejected** — `src/legacy.ts:2`',
    ].join('\n');
    const result = parseTriageBody(body);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].title).toBe('Legacy accepted');
    expect(result.accepted[0].ref).toBe('src/legacy.ts:1');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].title).toBe('Legacy rejected');
    expect(result.rejected[0].ref).toBe('src/legacy.ts:2');
  });
});

describe('extractFindingContent', () => {
  it('extracts description from a details/summary section', () => {
    const section = [
      '- [x] <details><summary>📝 **Style nit** — <code>src/app.ts:7</code></summary>',
      '',
      'Consider using const instead of let.',
      '</details>',
    ].join('\n');
    const result = extractFindingContent(section);
    expect(result.description).toBe('Consider using const instead of let.');
    expect(result.permalink).toBeNull();
    expect(result.suggestedFix).toBeNull();
  });

  it('extracts permalink from section', () => {
    const section = [
      '- [x] <details><summary>📝 **Bug** — <code>src/a.ts:1</code></summary>',
      '',
      'Description here.',
      'https://github.com/owner/repo/blob/abc123/src/a.ts#L1',
      '</details>',
    ].join('\n');
    const result = extractFindingContent(section);
    expect(result.description).toBe('Description here.');
    expect(result.permalink).toBe('https://github.com/owner/repo/blob/abc123/src/a.ts#L1');
  });

  it('extracts suggested fix from section', () => {
    const section = [
      '- [x] <details><summary>📝 **Fix me** — <code>src/b.ts:5</code></summary>',
      '',
      'This needs fixing.',
      '**Suggested fix:**',
      '```',
      'const x = 1;',
      '```',
      '</details>',
    ].join('\n');
    const result = extractFindingContent(section);
    expect(result.description).toBe('This needs fixing.');
    expect(result.suggestedFix).toBe('const x = 1;');
  });

  it('returns empty description for minimal sections', () => {
    const section = '- [x] 💡 **Simple** — `src/a.ts:1`';
    const result = extractFindingContent(section);
    expect(result.description).toBe('');
    expect(result.permalink).toBeNull();
    expect(result.suggestedFix).toBeNull();
  });
});

describe('triageTitlePrefix', () => {
  it('returns test for missing test titles', () => {
    expect(triageTitlePrefix('Missing test for edge case')).toBe('test');
  });

  it('returns test for no test titles', () => {
    expect(triageTitlePrefix('No test coverage for parser')).toBe('test');
  });

  it('returns fix for other titles', () => {
    expect(triageTitlePrefix('Null check missing')).toBe('fix');
    expect(triageTitlePrefix('Unused import')).toBe('fix');
  });
});

describe('extractPrNumber', () => {
  it('extracts PR number from triage issue title', () => {
    expect(extractPrNumber('triage: findings from PR #42')).toBe(42);
  });

  it('returns null for non-matching titles', () => {
    expect(extractPrNumber('some other issue')).toBeNull();
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

  it('detects @manki-review mention', () => {
    expect(hasBotMention('@manki-review explain this')).toBe(true);
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

  it('is case-insensitive for @manki-review', () => {
    expect(hasBotMention('@MANKI-REVIEW help')).toBe(true);
  });
});

describe('isReviewRequest', () => {
  it('detects @manki review', () => {
    expect(isReviewRequest('@manki review')).toBe(true);
  });

  it('detects /manki review', () => {
    expect(isReviewRequest('/manki review')).toBe(true);
  });

  it('detects @manki-review review', () => {
    expect(isReviewRequest('@manki-review review')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isReviewRequest('@Manki Review')).toBe(true);
  });

  it('returns false for non-review commands', () => {
    expect(isReviewRequest('@manki explain')).toBe(false);
    expect(isReviewRequest('/manki help')).toBe(false);
  });

  it('returns false for @manki-review with non-review action', () => {
    expect(isReviewRequest('@manki-review dismiss')).toBe(false);
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

  it('detects @manki-review dismiss', () => {
    expect(isBotMentionNonReview('@manki-review dismiss')).toBe(true);
  });

  it('returns false for review commands', () => {
    expect(isBotMentionNonReview('@manki review')).toBe(false);
    expect(isBotMentionNonReview('/manki review')).toBe(false);
    expect(isBotMentionNonReview('@manki-review review')).toBe(false);
  });

  it('returns false for text without bot mention', () => {
    expect(isBotMentionNonReview('just a comment')).toBe(false);
  });
});

// --- Handler tests ---

function createMockOctokit() {
  return {
    rest: {
      issues: {
        createComment: jest.fn().mockResolvedValue({ data: {} }),
        get: jest.fn().mockResolvedValue({ data: { body: '' } }),
        create: jest.fn().mockResolvedValue({ data: { number: 100 } }),
        update: jest.fn().mockResolvedValue({ data: {} }),
        removeLabel: jest.fn().mockResolvedValue({ data: {} }),
      },
      pulls: {
        get: jest.fn().mockResolvedValue({ data: 'diff content' }),
        getReviewComment: jest.fn().mockResolvedValue({ data: { body: '<!-- manki -->\nOriginal comment', path: 'src/file.ts', line: 10 } }),
        createReplyForReviewComment: jest.fn().mockResolvedValue({ data: {} }),
        createReview: jest.fn().mockResolvedValue({ data: { id: 1 } }),
      },
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createMockClient() {
  return {
    sendMessage: jest.fn().mockResolvedValue({ content: 'AI response here' }),
  } as unknown as ClaudeClient;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setContext(overrides: Record<string, any> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = github.context as any;
  ctx.payload = {
    comment: {
      id: 42,
      body: '@manki help',
      user: { type: 'User' },
      author_association: 'COLLABORATOR',
    },
    issue: { pull_request: { url: 'https://...' } },
    pull_request: { number: 1 },
    ...overrides,
  };
  ctx.repo = { owner: 'test-owner', repo: 'test-repo' };
  ctx.actor = 'test-user';
}

beforeEach(() => {
  jest.clearAllMocks();
  setContext();
});

describe('handlePRComment', () => {
  it('returns early when comment is missing', async () => {
    setContext({ comment: undefined });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('returns early for bot comments', async () => {
    setContext({ comment: { id: 1, body: '<!-- manki -->\nbot message', user: { type: 'Bot' } } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('returns early when no bot mention', async () => {
    setContext({ comment: { id: 1, body: 'just a regular comment', user: { type: 'User' } } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('rejects PR-only commands on non-PR issues', async () => {
    setContext({
      comment: { id: 1, body: '@manki check', user: { type: 'User' }, author_association: 'COLLABORATOR' },
      issue: {},
    });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('only works on pull requests') }),
    );
  });

  it('dispatches help command', async () => {
    setContext({ comment: { id: 42, body: '@manki help', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, '+1');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Here's what I can do") }),
    );
  });

  it('dispatches explain command with client', async () => {
    setContext({ comment: { id: 42, body: '@manki explain the changes', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handlePRComment(octokit, client, 'test-owner', 'test-repo', 1);
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('the changes'),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('AI response here') }),
    );
  });

  it('warns when explain command has no client', async () => {
    setContext({ comment: { id: 42, body: '@manki explain the changes', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(core.warning).toHaveBeenCalledWith('Claude client required for explain command');
  });

  it('dispatches dismiss command', async () => {
    setContext({ comment: { id: 42, body: '@manki dismiss null-check', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, '+1');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Dismissed') }),
    );
  });

  it('dispatches remember command', async () => {
    setContext({ comment: { id: 42, body: '@manki remember always check for SQL injection in queries', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const memoryConfig = { enabled: true, repo: 'test-owner/memory' };
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, memoryConfig, 'mem-token');
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(memory.writeLearning).toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("I'll remember that") }),
    );
  });

  it('dispatches forget command', async () => {
    (memory.removeLearning as jest.Mock).mockResolvedValueOnce({ removed: { content: 'old learning' }, remaining: 2 });
    setContext({ comment: { id: 42, body: '@manki forget old learning', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const memoryConfig = { enabled: true, repo: 'test-owner/memory' };
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, memoryConfig, 'mem-token');
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(memory.removeLearning).toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Removed') }),
    );
  });

  it('dispatches check command', async () => {
    setContext({ comment: { id: 42, body: '@manki check', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const config = { auto_approve: true } as Partial<ReviewConfig> as ReviewConfig;
    (state.checkAndAutoApprove as jest.Mock).mockResolvedValueOnce(true);
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, undefined, undefined, config);
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(state.checkAndAutoApprove).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 1);
  });

  it('dispatches triage command', async () => {
    setContext({ comment: { id: 42, body: '@manki triage', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    octokit.rest.issues.get.mockResolvedValue({ data: { body: '- [x] ✨ **Fix bug** — `src/a.ts:1`\n- [ ] 📝 **Nitpick** — `src/b.ts:2`' } });
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(octokit.rest.issues.create).toHaveBeenCalled();
    expect(octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'closed' }),
    );
  });

  it('dispatches generic question when no known command', async () => {
    setContext({ comment: { id: 42, body: '@manki what do you think?', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handlePRComment(octokit, client, 'test-owner', 'test-repo', 1);
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('what do you think?'),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('AI response here') }),
    );
  });

  it('warns when generic question has no client', async () => {
    setContext({ comment: { id: 42, body: '@manki what do you think?', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(core.warning).toHaveBeenCalledWith('Claude client required for generic questions');
  });

  it('blocks explain command from NONE association non-PR-author', async () => {
    setContext({
      comment: { id: 42, body: '@manki explain something', user: { type: 'User' }, author_association: 'NONE' },
      sender: { login: 'stranger' },
      issue: { pull_request: { url: 'https://...' }, user: { login: 'pr-author' } },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handlePRComment(octokit, client, 'test-owner', 'test-repo', 1);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Only repo contributors can use this command') }),
    );
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Ignoring @manki command from non-contributor'));
  });

  it('blocks generic question from FIRST_TIME_CONTRIBUTOR non-PR-author', async () => {
    setContext({
      comment: { id: 42, body: '@manki what is this?', user: { type: 'User' }, author_association: 'FIRST_TIME_CONTRIBUTOR' },
      sender: { login: 'newcomer' },
      issue: { pull_request: { url: 'https://...' }, user: { login: 'pr-author' } },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handlePRComment(octokit, client, 'test-owner', 'test-repo', 1);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Only repo contributors can use this command') }),
    );
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Ignoring @manki command from non-contributor'));
  });

  it('blocks "what do you think?" from NONE association non-PR-author', async () => {
    setContext({
      comment: { id: 42, body: '@manki what do you think?', user: { type: 'User' }, author_association: 'NONE' },
      sender: { login: 'stranger' },
      issue: { pull_request: { url: 'https://...' }, user: { login: 'pr-author' } },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handlePRComment(octokit, client, 'test-owner', 'test-repo', 1);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Only repo contributors can use this command') }),
    );
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Ignoring @manki command from non-contributor'));
  });

  it('allows explain command from CONTRIBUTOR', async () => {
    setContext({
      comment: { id: 42, body: '@manki explain the changes', user: { type: 'User' }, author_association: 'CONTRIBUTOR' },
      sender: { login: 'contributor-user' },
      issue: { pull_request: { url: 'https://...' }, user: { login: 'pr-author' } },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handlePRComment(octokit, client, 'test-owner', 'test-repo', 1);
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(client.sendMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('the changes'));
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('AI response here') }),
    );
  });

  it('allows explain command from PR author with NONE association', async () => {
    setContext({
      comment: { id: 42, body: '@manki explain the changes', user: { type: 'User' }, author_association: 'NONE' },
      sender: { login: 'pr-author' },
      issue: { pull_request: { url: 'https://...' }, user: { login: 'pr-author' } },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handlePRComment(octokit, client, 'test-owner', 'test-repo', 1);
    expect(ghUtils.reactToIssueComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 42, 'eyes');
    expect(client.sendMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('the changes'));
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('AI response here') }),
    );
  });

  it('allows generic question from PR author with NONE association', async () => {
    setContext({
      comment: { id: 42, body: '@manki what do you think?', user: { type: 'User' }, author_association: 'NONE' },
      sender: { login: 'pr-author' },
      issue: { pull_request: { url: 'https://...' }, user: { login: 'pr-author' } },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handlePRComment(octokit, client, 'test-owner', 'test-repo', 1);
    expect(client.sendMessage).toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith(expect.any(String), expect.not.stringContaining('@manki'));
    expect(core.info).not.toHaveBeenCalledWith(expect.stringContaining('Ignoring @manki command from non-contributor'));
  });

  it('does not block non-LLM commands for NONE association users', async () => {
    setContext({
      comment: { id: 42, body: '@manki help', user: { type: 'User' }, author_association: 'NONE' },
      sender: { login: 'stranger' },
      issue: { pull_request: { url: 'https://...' }, user: { login: 'pr-author' } },
    });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Here's what I can do") }),
    );
  });
});

describe('isRepoUser', () => {
  it('returns true for OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR', () => {
    expect(isRepoUser('OWNER')).toBe(true);
    expect(isRepoUser('MEMBER')).toBe(true);
    expect(isRepoUser('COLLABORATOR')).toBe(true);
    expect(isRepoUser('CONTRIBUTOR')).toBe(true);
  });

  it('returns false for NONE, FIRST_TIME_CONTRIBUTOR, null, undefined', () => {
    expect(isRepoUser('NONE')).toBe(false);
    expect(isRepoUser('FIRST_TIME_CONTRIBUTOR')).toBe(false);
    expect(isRepoUser(null)).toBe(false);
    expect(isRepoUser(undefined)).toBe(false);
  });
});

describe('isLLMAccessAllowed', () => {
  it('returns true when sender is a repo user regardless of PR author', () => {
    expect(isLLMAccessAllowed('OWNER', 'anyone', undefined)).toBe(true);
    expect(isLLMAccessAllowed('CONTRIBUTOR', 'anyone', 'someone-else')).toBe(true);
  });

  it('returns true when sender login matches PR author login', () => {
    expect(isLLMAccessAllowed('NONE', 'pr-author', 'pr-author')).toBe(true);
  });

  it('returns false when non-repo-user does not match PR author', () => {
    expect(isLLMAccessAllowed('NONE', 'stranger', 'pr-author')).toBe(false);
    expect(isLLMAccessAllowed('FIRST_TIME_CONTRIBUTOR', 'newcomer', 'pr-author')).toBe(false);
  });

  it('logs a diagnostic and returns false when prAuthorLogin is undefined', () => {
    expect(isLLMAccessAllowed('NONE', 'stranger', undefined)).toBe(false);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('PR author login unavailable'),
    );
  });
});

describe('handleReviewCommentReply', () => {
  it('returns early when comment is missing', async () => {
    setContext({ comment: undefined });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.pulls.getReviewComment).not.toHaveBeenCalled();
  });

  it('skips bot comments', async () => {
    setContext({ comment: { id: 1, body: '<!-- manki -->\nbot reply', user: { type: 'Bot' }, in_reply_to_id: 99 }, pull_request: { number: 1 } });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(core.info).toHaveBeenCalledWith('Skipping bot comment');
  });

  it('skips comments that are not replies', async () => {
    setContext({ comment: { id: 1, body: 'standalone comment', user: { type: 'User' }, author_association: 'CONTRIBUTOR' }, pull_request: { number: 1 } });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(core.info).toHaveBeenCalledWith('Not a reply to an existing comment');
  });

  it('blocks reply from NONE-association non-PR-author', async () => {
    setContext({
      comment: { id: 1, body: 'reply text', user: { type: 'User' }, in_reply_to_id: 99, author_association: 'NONE' },
      pull_request: { number: 1, user: { login: 'pr-author' } },
      sender: { login: 'stranger' },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Ignoring reply from non-contributor stranger'));
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('allows reply from PR author with NONE association', async () => {
    setContext({
      comment: {
        id: 1,
        body: 'Actually this is intentional because we validate the input upstream before this point in the pipeline',
        user: { type: 'User' },
        in_reply_to_id: 99,
        author_association: 'NONE',
      },
      pull_request: { number: 1, user: { login: 'pr-author' } },
      sender: { login: 'pr-author' },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(core.info).not.toHaveBeenCalledWith(expect.stringContaining('Ignoring reply from non-contributor'));
    expect(ghUtils.reactToReviewComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 1, 'eyes');
    expect(client.sendMessage).toHaveBeenCalled();
  });

  it('allows reply from CONTRIBUTOR (repo user)', async () => {
    setContext({
      comment: {
        id: 1,
        body: 'Can you elaborate on this?',
        user: { type: 'User' },
        in_reply_to_id: 99,
        author_association: 'CONTRIBUTOR',
      },
      pull_request: { number: 1, user: { login: 'pr-author' } },
      sender: { login: 'some-contributor' },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(core.info).not.toHaveBeenCalledWith(expect.stringContaining('Ignoring reply from non-contributor'));
    expect(client.sendMessage).toHaveBeenCalled();
  });

  it('skips when parent comment is not from bot', async () => {
    setContext({ comment: { id: 1, body: 'reply', user: { type: 'User' }, in_reply_to_id: 99, author_association: 'CONTRIBUTOR' }, pull_request: { number: 1 } });
    const octokit = createMockOctokit();
    octokit.rest.pulls.getReviewComment.mockResolvedValue({ data: { body: 'not a bot comment', path: 'file.ts', line: 5 } });
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(core.info).toHaveBeenCalledWith('Parent comment is not from Manki');
  });

  it('posts a reply when parent is a bot comment', async () => {
    setContext({ comment: { id: 1, body: 'Can you explain more?', user: { type: 'User' }, in_reply_to_id: 99, author_association: 'MEMBER' }, pull_request: { number: 1 } });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(ghUtils.reactToReviewComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 1, 'eyes');
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Can you explain more?'),
    );
    expect(octokit.rest.pulls.createReplyForReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('AI response here'),
        pull_number: 1,
      }),
    );
    expect(core.info).toHaveBeenCalledWith('Posted reply to review comment');
  });

  it('includes scoped PR diff context in the Claude prompt', async () => {
    setContext({ comment: { id: 1, body: 'Why did you change this?', user: { type: 'User' }, in_reply_to_id: 99, author_association: 'MEMBER' }, pull_request: { number: 1 } });
    const octokit = createMockOctokit();
    const client = createMockClient();
    const fileDiff = 'diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line';
    const otherDiff = 'diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-x\n+y';
    (ghUtils.fetchPRDiff as jest.Mock).mockResolvedValueOnce(`${fileDiff}\n${otherDiff}`);
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(ghUtils.fetchPRDiff).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 1);
    const sentContext = (client.sendMessage as jest.Mock).mock.calls[0][1] as string;
    expect(sentContext).toContain('## PR Changes Context');
    expect(sentContext).toContain('src/file.ts');
    expect(sentContext).not.toContain('src/other.ts');
  });

  it('stores learning for substantive trusted replies with memory enabled', async () => {
    setContext({
      comment: {
        id: 1,
        body: 'Actually this pattern is fine because we always validate input upstream in the middleware layer before reaching this point',
        user: { type: 'User' },
        in_reply_to_id: 99,
        author_association: 'OWNER',
      },
      pull_request: { number: 1 },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    const memoryConfig = { enabled: true, repo: 'test-owner/memory' };
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1, memoryConfig, 'mem-token');
    expect(memory.writeLearning).toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('Stored user context as learning');
  });

  it('does not store learning for short replies', async () => {
    setContext({
      comment: { id: 1, body: 'ok', user: { type: 'User' }, in_reply_to_id: 99, author_association: 'OWNER' },
      pull_request: { number: 1 },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'test-owner/memory' }, 'mem-token');
    expect(memory.writeLearning).not.toHaveBeenCalled();
  });

  it('does not store learning for non-trusted users', async () => {
    setContext({
      comment: {
        id: 1,
        body: 'I think this is wrong because the validation logic is actually handled differently in our codebase and the upstream check covers this',
        user: { type: 'User' },
        in_reply_to_id: 99,
        author_association: 'CONTRIBUTOR',
      },
      pull_request: { number: 1 },
    });
    const octokit = createMockOctokit();
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'test-owner/memory' }, 'mem-token');
    expect(memory.writeLearning).not.toHaveBeenCalled();
  });

  it('handles API errors gracefully', async () => {
    setContext({ comment: { id: 1, body: 'reply text', user: { type: 'User' }, in_reply_to_id: 99, author_association: 'CONTRIBUTOR' }, pull_request: { number: 1 } });
    const octokit = createMockOctokit();
    octokit.rest.pulls.getReviewComment.mockRejectedValue(new Error('API error'));
    const client = createMockClient();
    await handleReviewCommentReply(octokit, client, 'test-owner', 'test-repo', 1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to handle review comment reply'));
  });
});

describe('handleDismiss (via handlePRComment)', () => {
  it('acknowledges dismiss from non-collaborator without persisting', async () => {
    setContext({ comment: { id: 42, body: '@manki dismiss null-check', user: { type: 'User' }, author_association: 'CONTRIBUTOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('non-collaborator'));
    expect(memory.writeSuppression).not.toHaveBeenCalled();
  });

  it('stores suppression for trusted collaborator with memory enabled', async () => {
    setContext({ comment: { id: 42, body: '@manki dismiss null-check-warning', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'test-owner/memory' }, 'mem-token');
    expect(memory.writeSuppression).toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Stored as suppression') }),
    );
  });

  it('warns when finding reference is too short', async () => {
    setContext({ comment: { id: 42, body: '@manki dismiss ab', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(core.warning).toHaveBeenCalledWith('Finding reference too short to create suppression');
  });

  it('dismiss without args still posts acknowledgment', async () => {
    setContext({ comment: { id: 42, body: '@manki dismiss', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Dismissed') }),
    );
  });
});

describe('handleRemember (via handlePRComment)', () => {
  it('rejects non-collaborators', async () => {
    setContext({ comment: { id: 42, body: '@manki remember always check for sql injection in query builders', user: { type: 'User' }, author_association: 'CONTRIBUTOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Only repo collaborators can teach me') }),
    );
  });

  it('rejects too-short instructions', async () => {
    setContext({ comment: { id: 42, body: '@manki remember hi', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("too short") }),
    );
  });

  it('reports when memory is disabled', async () => {
    setContext({ comment: { id: 42, body: '@manki remember always check for sql injection in query builders', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Memory isn't enabled") }),
    );
  });

  it('stores global-scoped learning with global: prefix', async () => {
    setContext({ comment: { id: 42, body: '@manki remember global: always prefer immutable data structures in all repos', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'test-owner/memory' }, 'mem-token');
    expect(memory.writeLearning).toHaveBeenCalledWith(
      expect.anything(),
      'test-owner/memory',
      'test-repo',
      expect.objectContaining({ scope: 'global' }),
    );
  });

  it('reports error when writeLearning fails', async () => {
    (memory.writeLearning as jest.Mock).mockRejectedValueOnce(new Error('write failed'));
    setContext({ comment: { id: 42, body: '@manki remember always check for sql injection in query builders', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to store learning'));
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Couldn't save that") }),
    );
  });
});

describe('handleForget (via handlePRComment)', () => {
  it('rejects non-collaborators', async () => {
    setContext({ comment: { id: 42, body: '@manki forget some learning', user: { type: 'User' }, author_association: 'CONTRIBUTOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Only repo collaborators can manage memories') }),
    );
  });

  it('rejects too-short search terms', async () => {
    setContext({ comment: { id: 42, body: '@manki forget ab', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Search term too short') }),
    );
  });

  it('reports when memory is disabled', async () => {
    setContext({ comment: { id: 42, body: '@manki forget some learning', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Memory isn't enabled") }),
    );
  });

  it('removes a matching learning', async () => {
    (memory.removeLearning as jest.Mock).mockResolvedValueOnce({ removed: { content: 'old learning' }, remaining: 3 });
    setContext({ comment: { id: 42, body: '@manki forget old learning', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Removed: `old learning`') }),
    );
  });

  it('reports when no matching learning found', async () => {
    (memory.removeLearning as jest.Mock).mockResolvedValueOnce({ removed: null, remaining: 0 });
    setContext({ comment: { id: 42, body: '@manki forget nonexistent thing', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('No matching learning found') }),
    );
  });

  it('removes a matching suppression', async () => {
    (memory.removeSuppression as jest.Mock).mockResolvedValueOnce({ removed: { pattern: 'unused-var' }, remaining: 1 });
    setContext({ comment: { id: 42, body: '@manki forget suppression unused-var', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(memory.removeSuppression).toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Removed suppression: `unused-var`') }),
    );
  });

  it('reports when no matching suppression found', async () => {
    (memory.removeSuppression as jest.Mock).mockResolvedValueOnce({ removed: null, remaining: 0 });
    setContext({ comment: { id: 42, body: '@manki forget suppression nonexistent', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('No matching suppression found') }),
    );
  });

  it('rejects too-short suppression search term', async () => {
    setContext({ comment: { id: 42, body: '@manki forget suppression ab', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Search term too short') }),
    );
  });

  it('handles memory error gracefully', async () => {
    (memory.removeLearning as jest.Mock).mockRejectedValueOnce(new Error('API failure'));
    setContext({ comment: { id: 42, body: '@manki forget some learning text', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, { enabled: true, repo: 'mem' }, 'token');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to remove memory'));
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Couldn't remove that") }),
    );
  });
});

describe('handleCheck (via handlePRComment)', () => {
  it('rejects non-collaborators', async () => {
    setContext({ comment: { id: 42, body: '@manki check', user: { type: 'User' }, author_association: 'CONTRIBUTOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, undefined, undefined, { auto_approve: true } as Partial<ReviewConfig> as ReviewConfig);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Only repo collaborators can trigger auto-approve') }),
    );
  });

  it('reports when auto-approve is disabled', async () => {
    setContext({ comment: { id: 42, body: '@manki check', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, undefined, undefined, {} as Partial<ReviewConfig> as ReviewConfig);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Auto-approve is disabled') }),
    );
  });

  it('reports open required issues when not auto-approved', async () => {
    setContext({ comment: { id: 42, body: '@manki check', user: { type: 'User' }, author_association: 'OWNER' } });
    (state.checkAndAutoApprove as jest.Mock).mockResolvedValueOnce(false);
    (state.fetchBotReviewThreads as jest.Mock).mockResolvedValueOnce([
      { findingTitle: 'Null deref', isRequired: true, isResolved: false },
      { findingTitle: 'Style nit', isRequired: false, isResolved: false },
    ]);
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, undefined, undefined, { auto_approve: true } as Partial<ReviewConfig> as ReviewConfig);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('1 required issue(s) still open') }),
    );
  });

  it('reports checking status when no required issues but not approved', async () => {
    setContext({ comment: { id: 42, body: '@manki check', user: { type: 'User' }, author_association: 'OWNER' } });
    (state.checkAndAutoApprove as jest.Mock).mockResolvedValueOnce(false);
    (state.fetchBotReviewThreads as jest.Mock).mockResolvedValueOnce([]);
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, undefined, undefined, { auto_approve: true } as Partial<ReviewConfig> as ReviewConfig);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('No required issues found') }),
    );
  });

  it('does not post comment when auto-approve succeeds', async () => {
    setContext({ comment: { id: 42, body: '@manki check', user: { type: 'User' }, author_association: 'OWNER' } });
    (state.checkAndAutoApprove as jest.Mock).mockResolvedValueOnce(true);
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, undefined, undefined, { auto_approve: true } as Partial<ReviewConfig> as ReviewConfig);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});

describe('handleTriage (via handlePRComment)', () => {
  it('rejects non-collaborators', async () => {
    setContext({ comment: { id: 42, body: '@manki triage', user: { type: 'User' }, author_association: 'CONTRIBUTOR' } });
    const octokit = createMockOctokit();
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Only repo collaborators can triage') }),
    );
  });

  it('reports when no findings can be parsed', async () => {
    setContext({ comment: { id: 42, body: '@manki triage', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    octokit.rest.issues.get.mockResolvedValue({ data: { body: 'No checkboxes here' } });
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Couldn't parse any findings") }),
    );
  });

  it('creates issues for accepted findings and closes the triage issue', async () => {
    setContext({ comment: { id: 42, body: '@manki triage', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    octokit.rest.issues.get.mockResolvedValue({
      data: {
        title: 'triage: findings from PR #10',
        body: '- [x] 💡 **Fix null check** — `src/a.ts:1`\n- [ ] 📝 **Rename var** — `src/b.ts:2`',
      },
    });
    octokit.rest.issues.create.mockResolvedValue({ data: { number: 200 } });
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 5);

    expect(octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'fix: Fix null check',
        body: expect.stringContaining('## Context'),
      }),
    );
    // Body should reference triage issue and PR
    expect(octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('PR #10'),
      }),
    );
    // Body should have structured sections
    expect(octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('## File'),
      }),
    );
    expect(octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('`src/a.ts:1`'),
      }),
    );
    expect(octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'closed', issue_number: 5 }),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Triage complete') }),
    );
  });

  it('stores learnings and suppressions with memory enabled', async () => {
    setContext({ comment: { id: 42, body: '@manki triage', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    octokit.rest.issues.get.mockResolvedValue({
      data: {
        body: '- [x] 💡 **Accepted finding** — `src/a.ts:1`\n- [ ] 📝 **Rejected finding** — `src/b.ts:2`',
      },
    });
    octokit.rest.issues.create.mockResolvedValue({ data: { number: 200 } });
    const memoryConfig = { enabled: true, repo: 'test-owner/memory' };
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1, memoryConfig, 'mem-token');
    expect(memory.writeLearning).toHaveBeenCalled();
    expect(memory.writeSuppression).toHaveBeenCalled();
    expect(memory.batchUpdatePatternDecisions).toHaveBeenCalled();
  });

  it('handles label removal failure gracefully', async () => {
    setContext({ comment: { id: 42, body: '@manki triage', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    octokit.rest.issues.get.mockResolvedValue({
      data: { body: '- [x] 💡 **A finding** — `src/a.ts:1`' },
    });
    octokit.rest.issues.create.mockResolvedValue({ data: { number: 200 } });
    octokit.rest.issues.removeLabel.mockRejectedValue(new Error('Label not found'));
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    // Should not throw, should still close the issue
    expect(octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'closed' }),
    );
  });

  it('handles null issue body as empty findings', async () => {
    setContext({ comment: { id: 42, body: '@manki triage', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    octokit.rest.issues.get.mockResolvedValue({ data: { body: null } });
    await handlePRComment(octokit, null, 'test-owner', 'test-repo', 1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Couldn't parse any findings") }),
    );
  });
});

describe('handlePRComment error propagation', () => {
  it('propagates errors from API calls', async () => {
    setContext({ comment: { id: 42, body: '@manki explain something', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const client = createMockClient();
    client.sendMessage = jest.fn().mockRejectedValue(new Error('API failure'));
    await expect(handlePRComment(octokit, client, 'test-owner', 'test-repo', 1)).rejects.toThrow('API failure');
  });
});

describe('handleReviewCommentCommand', () => {
  it('routes dismiss command and reacts with +1', async () => {
    setContext({ comment: { id: 55, body: '/manki dismiss null-check', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const command = parseCommand('/manki dismiss null-check');
    await handleReviewCommentCommand(octokit, 'test-owner', 'test-repo', 1, 55, command);
    expect(ghUtils.reactToReviewComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 55, '+1');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Dismissed') }),
    );
  });

  it('routes remember command and reacts with eyes', async () => {
    setContext({ comment: { id: 56, body: '@manki remember always validate input before processing data in handlers', user: { type: 'User' }, author_association: 'OWNER' } });
    const octokit = createMockOctokit();
    const command = parseCommand('@manki remember always validate input before processing data in handlers');
    const memoryConfig = { enabled: true, repo: 'test-owner/memory' };
    await handleReviewCommentCommand(octokit, 'test-owner', 'test-repo', 1, 56, command, memoryConfig, 'mem-token');
    expect(ghUtils.reactToReviewComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 56, 'eyes');
    expect(memory.writeLearning).toHaveBeenCalled();
  });

  it('routes forget command and reacts with eyes', async () => {
    setContext({ comment: { id: 57, body: '/manki forget null-check', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const command = parseCommand('/manki forget null-check');
    const memoryConfig = { enabled: true, repo: 'test-owner/memory' };
    await handleReviewCommentCommand(octokit, 'test-owner', 'test-repo', 1, 57, command, memoryConfig, 'mem-token');
    expect(ghUtils.reactToReviewComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 57, 'eyes');
  });

  it('routes help command and reacts with +1', async () => {
    setContext({ comment: { id: 58, body: '/manki help', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const command = parseCommand('/manki help');
    await handleReviewCommentCommand(octokit, 'test-owner', 'test-repo', 1, 58, command);
    expect(ghUtils.reactToReviewComment).toHaveBeenCalledWith(octokit, 'test-owner', 'test-repo', 58, '+1');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Here's what I can do") }),
    );
  });

  it('rejects PR-only commands with a message', async () => {
    setContext({ comment: { id: 59, body: '/manki explain something', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const command = parseCommand('/manki explain something');
    await handleReviewCommentCommand(octokit, 'test-owner', 'test-repo', 1, 59, command);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('only works as a PR-level comment') }),
    );
    expect(ghUtils.reactToReviewComment).not.toHaveBeenCalled();
  });

  it('rejects check command with PR-only message', async () => {
    setContext({ comment: { id: 60, body: '/manki check', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const command = parseCommand('/manki check');
    await handleReviewCommentCommand(octokit, 'test-owner', 'test-repo', 1, 60, command);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('only works as a PR-level comment') }),
    );
  });

  it('does not use reactToIssueComment', async () => {
    setContext({ comment: { id: 61, body: '/manki dismiss test', user: { type: 'User' }, author_association: 'COLLABORATOR' } });
    const octokit = createMockOctokit();
    const command = parseCommand('/manki dismiss test');
    await handleReviewCommentCommand(octokit, 'test-owner', 'test-repo', 1, 61, command);
    expect(ghUtils.reactToIssueComment).not.toHaveBeenCalled();
  });
});

describe('scopeDiffToFile', () => {
  const multiFileDiff = [
    'diff --git a/src/handler.ts b/src/handler.ts',
    'index abc..def 100644',
    '--- a/src/handler.ts',
    '+++ b/src/handler.ts',
    '@@ -1,3 +1,4 @@',
    ' import { foo } from "bar";',
    '+import { baz } from "qux";',
    ' const x = 1;',
    'diff --git a/src/handler.test.ts b/src/handler.test.ts',
    'index 111..222 100644',
    '--- a/src/handler.test.ts',
    '+++ b/src/handler.test.ts',
    '@@ -10,3 +10,4 @@',
    ' test("works", () => {',
    '+  expect(true).toBe(true);',
    ' });',
    'diff --git a/src/utils.ts b/src/utils.ts',
    'index ghi..jkl 100644',
    '--- a/src/utils.ts',
    '+++ b/src/utils.ts',
    '@@ -5,3 +5,4 @@',
    ' export function helper() {',
    '+  return 42;',
    ' }',
  ].join('\n');

  it('extracts a single file diff from a multi-file diff', () => {
    const result = scopeDiffToFile(multiFileDiff, 'src/utils.ts');
    expect(result).toContain('diff --git a/src/utils.ts b/src/utils.ts');
    expect(result).toContain('return 42;');
    expect(result).not.toContain('src/handler.ts');
  });

  it('returns empty string when file is not in the diff', () => {
    const result = scopeDiffToFile(multiFileDiff, 'src/missing.ts');
    expect(result).toBe('');
  });

  it('does not match substring filenames', () => {
    const result = scopeDiffToFile(multiFileDiff, 'src/handler.ts');
    expect(result).toContain('diff --git a/src/handler.ts b/src/handler.ts');
    expect(result).not.toContain('src/handler.test.ts');
    expect(result).not.toContain('src/utils.ts');
  });
});
