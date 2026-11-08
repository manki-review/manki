import { codeTokensFromDiff, highlightCode } from './highlight';
import { ParsedDiff } from './types';

const diff: ParsedDiff = {
  files: [{
    path: 'src/github.ts',
    changeType: 'modified',
    hunks: [{
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
      content: [
        '-const oldName = 1;',
        '+const { data } = await octokit.rest.pulls.get({ owner, repo });',
        '+if (excludePaths.length) return createReview(review_body);',
        ' const ReviewResult = unchanged_context;',
      ].join('\n'),
    }],
  }],
  totalAdditions: 2,
  totalDeletions: 1,
};

describe('codeTokensFromDiff', () => {
  it('collects code-like identifiers from added lines and the changed file paths', () => {
    const tokens = codeTokensFromDiff(diff);
    expect([...tokens].sort()).toEqual([
      'createReview', 'excludePaths', 'excludePaths.length', 'github.ts', 'octokit.rest.pulls.get', 'review_body', 'src/github.ts',
    ]);
  });
});

describe('highlightCode', () => {
  const tokens = codeTokensFromDiff(diff);

  it('wraps whole tokens from the diff in backticks', () => {
    expect(highlightCode('The skip calls createReview from src/github.ts and bypasses excludePaths.', tokens))
      .toBe('The skip calls `createReview` from `src/github.ts` and bypasses `excludePaths`.');
    expect(highlightCode('It calls octokit.rest.pulls.get twice.', tokens)).toBe('It calls `octokit.rest.pulls.get` twice.');
  });

  it('leaves plain words, partial matches and unknown identifiers alone', () => {
    const text = 'The data owner reviews createReviewLater and pulls.get in otherFile.ts.';
    expect(highlightCode(text, tokens)).toBe(text);
  });

  it('never touches inline code, code blocks, links or HTML comments', () => {
    const text = [
      'Already `createReview` here, and ``createReview`` too.',
      '```ts',
      'createReview(review_body);',
      '```',
      'See [createReview](https://example.com/src/github.ts) and https://example.com/excludePaths.',
      '<!-- manki:blocker:createReview -->',
    ].join('\n');
    expect(highlightCode(text, tokens)).toBe(text);

    // A run of backticks with no closing run of the same length stays text and protects nothing after it.
    const unclosed = 'Adds `x += `${`y`} `` here.\n- [`src/github.ts:3`](https://example.com/a) and `createReview`.';
    expect(highlightCode(unclosed, tokens)).toBe(unclosed);
    expect(highlightCode('Opens ` here.\n\nThen createReview runs.', tokens)).toBe('Opens ` here.\n\nThen `createReview` runs.');
  });

  it('wraps tokens in a summary in code tags, since GitHub does not parse Markdown there', () => {
    const link = '<a href="https://example.com/src/github.ts"><code>src/github.ts:3</code></a>';
    expect(highlightCode(`<summary><b>createReview skips <code>excludePaths</code></b><br><sub>${link}</sub></summary>\nThen createReview.`, tokens))
      .toBe(`<summary><b><code>createReview</code> skips <code>excludePaths</code></b><br><sub>${link}</sub></summary>\nThen \`createReview\`.`);
  });
});
