import { formatFindingComment, mapVerdictToEvent, BOT_MARKER, buildNitIssueBody, getSeverityLabel, postReview, sanitizeMarkdown, sanitizeFilePath, truncateBody, dynamicFence, safeTruncate } from './github';
import { Finding, ReviewResult } from './types';

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

  it('sanitizes reviewer names containing markdown or HTML', () => {
    const finding: Finding = { ...baseFinding, reviewers: ['<script>alert(1)</script>', '@evil/team'] };
    const comment = formatFindingComment(finding);
    expect(comment).not.toContain('<script>');
    expect(comment).not.toContain('</script>');
    expect(comment).toContain('@\u200Bevil/team');
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

  it('includes suggested fix in folded fix prompt when present', () => {
    const withFix: Finding = { ...suggestion, suggestedFix: 'const x = 1;' };
    const body = buildNitIssueBody(42, [withFix], 'myorg');
    expect(body).toContain('**Suggested fix:**');
    expect(body).toContain('const x = 1;');
  });

  it('omits suggested fix from fix prompt when not present', () => {
    const body = buildNitIssueBody(42, [suggestion], 'myorg');
    expect(body).not.toContain('**Suggested fix:**');
  });

  it('uses correct emoji for suggestion vs question', () => {
    const body = buildNitIssueBody(42, [suggestion, question], 'myorg');
    expect(body).toContain('\u{1F4A1} **Use const instead of let**');
    expect(body).toContain('\u{2753} **Is this timeout intentional?**');
  });

  it('includes code context when present', () => {
    const withContext: Finding = {
      ...suggestion,
      file: 'src/utils.ts',
      codeContext: '+let x = 1;\n+let y = 2;',
    };
    const body = buildNitIssueBody(42, [withContext], 'myorg');
    expect(body).toContain('```typescript');
    expect(body).toContain('+let x = 1;\n+let y = 2;');
    expect(body).toContain('```');
  });

  it('omits code context when not present', () => {
    const body = buildNitIssueBody(42, [suggestion], 'myorg');
    expect(body).not.toContain('```typescript');
  });

  it('detects language from file extension', () => {
    const extensions: Array<[string, string]> = [
      ['src/app.ts', 'typescript'],
      ['src/app.tsx', 'typescript'],
      ['src/app.js', 'javascript'],
      ['src/app.jsx', 'javascript'],
      ['src/lib.rs', 'rust'],
      ['src/main.py', 'python'],
      ['src/main.go', 'go'],
      ['styles.css', 'css'],
      ['config.yml', 'yaml'],
    ];

    for (const [file, lang] of extensions) {
      const finding: Finding = {
        ...suggestion,
        file,
        codeContext: '+some code',
      };
      const body = buildNitIssueBody(42, [finding], 'myorg');
      expect(body).toContain(`\`\`\`${lang}`);
    }
  });

  it('wraps fix prompt in a folded details section', () => {
    const body = buildNitIssueBody(42, [suggestion], 'myorg');
    expect(body).toContain('<details>');
    expect(body).toContain('<summary>\u{1F916} Fix prompt</summary>');
    expect(body).toContain('</details>');
    expect(body).toContain('**File:** `src/utils.ts`');
    expect(body).toContain('**Line:** 10');
    expect(body).toContain('**Finding:** Use const instead of let');
    expect(body).toContain('**Severity:** suggestion');
  });

  it('includes triage instructions with @manki triage', () => {
    const body = buildNitIssueBody(42, [suggestion], 'myorg');
    expect(body).toContain('`@manki triage`');
    expect(body).toContain('**Check the box** for findings worth fixing');
    expect(body).toContain('**Leave unchecked** for findings to dismiss');
  });

  it('includes validation reminder in fix prompt', () => {
    const body = buildNitIssueBody(42, [suggestion], 'myorg');
    expect(body).toContain('Before applying this fix, validate the finding');
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
          severity: 'suggestion',
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
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const call = mockCreateReview.mock.calls[0][0];
    expect(call.event).toBe('APPROVE');
    expect(call.body).toContain('Fix: `try { op(); } catch (e) { handle(e); }`');
  });

  it('omits Fix line when finding has no suggestedFix', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
          title: 'Add error handling',
          file: '',
          line: 0,
          description: 'Missing try/catch.',
          reviewers: ['Correctness'],
        },
      ],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const call = mockCreateReview.mock.calls[0][0];
    expect(call.event).toBe('APPROVE');
    expect(call.body).not.toContain('Fix:');
  });

  it('truncates long suggestedFix to 200 chars in general findings', async () => {
    const longFix = 'x'.repeat(250);
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
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
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('x'.repeat(200) + '...');
    expect(body).not.toContain('x'.repeat(201));
  });

  it('uses code block for suggestedFix containing backticks', async () => {
    const fixWithBackticks = 'use `foo` instead of `bar`';
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
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
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('```');
    expect(body).toContain(fixWithBackticks);
    expect(body).not.toContain('Fix: `');
  });

  it('uses longer fence when suggestedFix contains triple backticks', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
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
          severity: 'suggestion',
          title: 'Some title',
          file: '',
          line: 0,
          description: 'Important description here.',
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
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
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body.length).toBeLessThanOrEqual(60000 + 50); // cap + truncation message
    expect(body).toContain('*(Review body truncated)*');
  });

  it('includes file path in general findings when file is set but line is invalid', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
          title: 'Some title',
          file: 'src/utils.ts',
          line: 0,
          description: 'Desc.',
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('`src/utils.ts`');
  });
});

describe('getSeverityLabel', () => {
  it('returns Blocking for blocking severity', () => {
    expect(getSeverityLabel('blocking')).toBe('Blocking');
  });

  it('returns Suggestion for suggestion severity', () => {
    expect(getSeverityLabel('suggestion')).toBe('Suggestion');
  });

  it('returns Question for question severity', () => {
    expect(getSeverityLabel('question')).toBe('Question');
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

describe('safeTruncate', () => {
  it('returns text unchanged when shorter than max', () => {
    expect(safeTruncate('hello', 10)).toBe('hello');
  });

  it('truncates normal text at boundary', () => {
    expect(safeTruncate('hello world', 5)).toBe('hello...');
  });

  it('avoids splitting a surrogate pair at the boundary', () => {
    // U+1F600 (grinning face) is a surrogate pair: \uD83D\uDE00
    const text = 'ab\u{1F600}cd';
    // maxLen=3 would land between the high and low surrogate; safeTruncate backs up
    const result = safeTruncate(text, 3);
    expect(result).toBe('ab...');
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
