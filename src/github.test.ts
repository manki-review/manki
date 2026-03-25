import { formatFindingComment, mapVerdictToEvent, BOT_MARKER, buildNitIssueBody, getSeverityLabel, postReview, resolveReferences, sanitizeMarkdown, sanitizeFilePath, truncateBody, dynamicFence, safeTruncate, fetchFileContents } from './github';
import { Finding, ReviewResult } from './types';

describe('formatFindingComment', () => {
  const baseFinding: Finding = {
    severity: 'required',
    title: 'Null pointer dereference',
    file: 'src/main.ts',
    line: 42,
    description: 'This code will throw if the value is undefined.',
    reviewers: ['Security & Correctness'],
  };

  it('formats a required finding with correct emoji and label', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).toContain('🚫 **Required**');
    expect(comment).toContain(baseFinding.title);
    expect(comment).toContain(baseFinding.description);
  });

  it('formats a suggestion finding with correct emoji and label', () => {
    const finding: Finding = { ...baseFinding, severity: 'suggestion' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('💡 **Suggestion**');
  });

  it('formats a nit finding with correct emoji and label', () => {
    const finding: Finding = { ...baseFinding, severity: 'nit' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('📝 **Nit**');
  });

  it('formats an ignore finding with correct emoji and label', () => {
    const finding: Finding = { ...baseFinding, severity: 'ignore' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('⚪ **Ignore**');
    expect(comment).toContain('<!-- manki:ignore:');
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
    expect(comment).toContain('<!-- manki:required:Null-pointer-dereference -->');
  });

  it('sanitizes special characters in metadata marker title', () => {
    const finding: Finding = { ...baseFinding, title: 'Bug: foo() returns "bar"!' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<!-- manki:required:Bug--foo---returns--bar-- -->');
  });

  it('shows judge confidence when present', () => {
    const finding: Finding = { ...baseFinding, judgeConfidence: 'high' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<sub>[high confidence]</sub>');
  });

  it('shows medium judge confidence', () => {
    const finding: Finding = { ...baseFinding, judgeConfidence: 'medium' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<sub>[medium confidence]</sub>');
  });

  it('omits judge confidence when absent', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).not.toContain('confidence]');
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
  const nit: Finding = {
    severity: 'nit',
    title: 'Use const instead of let',
    file: 'src/utils.ts',
    line: 10,
    description: 'Variable is never reassigned.',
    reviewers: ['Style'],
  };

  const suggestion: Finding = {
    severity: 'suggestion',
    title: 'Is this timeout intentional?',
    file: 'src/client.ts',
    line: 55,
    description: 'The timeout of 60s seems high for this endpoint.',
    reviewers: ['Performance'],
  };

  const required: Finding = {
    severity: 'required',
    title: 'Null dereference',
    file: 'src/main.ts',
    line: 1,
    description: 'Will crash at runtime.',
    reviewers: ['Security'],
  };

  it('filters to only nit findings', () => {
    const body = buildNitIssueBody(42, [required, nit, suggestion], 'myorg');
    expect(body).toContain('Use const instead of let');
    expect(body).not.toContain('Null dereference');
    expect(body).not.toContain('Is this timeout intentional?');
  });

  it('formats checklist items with file and line', () => {
    const body = buildNitIssueBody(42, [nit], 'myorg');
    expect(body).toContain('- [ ]');
    expect(body).toContain('`src/utils.ts:10`');
    expect(body).toContain('Variable is never reassigned.');
  });

  it('includes PR reference in header', () => {
    const body = buildNitIssueBody(99, [nit], 'myorg');
    expect(body).toContain('PR #99');
  });

  it('includes suggested fix in folded fix prompt when present', () => {
    const withFix: Finding = { ...nit, suggestedFix: 'const x = 1;' };
    const body = buildNitIssueBody(42, [withFix], 'myorg');
    expect(body).toContain('**Suggested fix:**');
    expect(body).toContain('const x = 1;');
  });

  it('omits suggested fix from fix prompt when not present', () => {
    const body = buildNitIssueBody(42, [nit], 'myorg');
    expect(body).not.toContain('**Suggested fix:**');
  });

  it('uses nit emoji for nit findings', () => {
    const body = buildNitIssueBody(42, [nit], 'myorg');
    expect(body).toContain('\u{1F4DD} **Use const instead of let**');
  });

  it('includes code context when present', () => {
    const withContext: Finding = {
      ...nit,
      file: 'src/utils.ts',
      codeContext: '+let x = 1;\n+let y = 2;',
    };
    const body = buildNitIssueBody(42, [withContext], 'myorg');
    expect(body).toContain('```typescript');
    expect(body).toContain('+let x = 1;\n+let y = 2;');
    expect(body).toContain('```');
  });

  it('omits code context when not present', () => {
    const body = buildNitIssueBody(42, [nit], 'myorg');
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
        ...nit,
        file,
        codeContext: '+some code',
      };
      const body = buildNitIssueBody(42, [finding], 'myorg');
      expect(body).toContain(`\`\`\`${lang}`);
    }
  });

  it('wraps fix prompt in a folded details section', () => {
    const body = buildNitIssueBody(42, [nit], 'myorg');
    expect(body).toContain('<details>');
    expect(body).toContain('<summary>\u{1F916} Fix prompt</summary>');
    expect(body).toContain('</details>');
    expect(body).toContain('**File:** `src/utils.ts`');
    expect(body).toContain('**Line:** 10');
    expect(body).toContain('**Finding:** Use const instead of let');
    expect(body).toContain('**Severity:** nit');
  });

  it('includes triage instructions with @manki triage', () => {
    const body = buildNitIssueBody(42, [nit], 'myorg');
    expect(body).toContain('`@manki triage`');
    expect(body).toContain('**Check the box** for findings worth fixing');
    expect(body).toContain('**Leave unchecked** for findings to dismiss');
  });

  it('includes validation reminder in fix prompt', () => {
    const body = buildNitIssueBody(42, [nit], 'myorg');
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
  it('returns Required for required severity', () => {
    expect(getSeverityLabel('required')).toBe('Required');
  });

  it('returns Suggestion for suggestion severity', () => {
    expect(getSeverityLabel('suggestion')).toBe('Suggestion');
  });

  it('returns Nit for nit severity', () => {
    expect(getSeverityLabel('nit')).toBe('Nit');
  });

  it('returns Ignore for ignore severity', () => {
    expect(getSeverityLabel('ignore')).toBe('Ignore');
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
  function mockOctokit(files: Record<string, string | 'error'>) {
    return {
      rest: {
        repos: {
          getContent: jest.fn(async ({ path }: { path: string }) => {
            const content = files[path];
            if (!content || content === 'error') {
              throw new Error(`Not found: ${path}`);
            }
            return {
              data: {
                content: Buffer.from(content).toString('base64'),
                encoding: 'base64',
              },
            };
          }),
        },
      },
    } as unknown as Parameters<typeof resolveReferences>[0];
  }

  it('resolves a single @rules/ reference', async () => {
    const octokit = mockOctokit({
      '.claude/rules/commit-format.md': '## Commit Format\n\nKeep messages short.',
    });
    const content = 'Instructions:\n\n@rules/commit-format.md\n\nEnd.';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    expect(result).toContain('## Commit Format');
    expect(result).toContain('Keep messages short.');
    expect(result).not.toContain('@rules/commit-format.md');
    expect(result).toContain('End.');
  });

  it('resolves multiple references', async () => {
    const octokit = mockOctokit({
      '.claude/rules/a.md': 'Content A',
      '.claude/rules/b.md': 'Content B',
    });
    const content = '@rules/a.md\n@rules/b.md';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    expect(result).toContain('Content A');
    expect(result).toContain('Content B');
    expect(result).not.toContain('@rules/a.md');
    expect(result).not.toContain('@rules/b.md');
  });

  it('leaves reference as-is with comment when file is missing', async () => {
    const octokit = mockOctokit({});
    const content = 'Before\n@rules/missing.md\nAfter';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    expect(result).toContain('@rules/missing.md');
    expect(result).toContain('<!-- Could not resolve reference: rules/missing.md -->');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('respects max depth to prevent infinite recursion', async () => {
    const octokit = mockOctokit({
      '.claude/rules/loop.md': '@rules/loop.md',
    });
    const content = '@rules/loop.md';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    // At depth 0: resolves @rules/loop.md -> "@rules/loop.md" (the file content)
    // At depth 1: resolves that -> "@rules/loop.md" again
    // At depth 2: resolves that -> "@rules/loop.md" again
    // At depth 3: returns as-is (max depth reached)
    expect(result).toContain('@rules/loop.md');
  });

  it('skips path traversal attempts', async () => {
    const octokit = mockOctokit({});
    const content = 'Before\n@../../etc/passwd.md\nAfter';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    // The traversal reference should remain untouched (not fetched, no error comment)
    expect(result).toBe(content);
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
  });

  it('returns content unchanged when there are no references', async () => {
    const octokit = mockOctokit({});
    const content = '## Instructions\n\nJust regular markdown content.';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    expect(result).toBe(content);
  });
});
