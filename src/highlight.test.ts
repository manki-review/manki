import { codeTokensFromDiff, highlightCode } from './highlight';
import { ParsedDiff } from './types';

const diff: ParsedDiff = {
  files: [{
    path: 'src/github.ts',
    changeType: 'modified',
    hunks: [{
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 4,
      content: [
        '-const oldName = 1;',
        '+const { data } = await octokit.rest.pulls.get({ owner, repo });',
        '+if (excludePaths.length) return createReview(review_body);',
        '+const MAX_COMPACT_SIZE = 32; // MiB, not KiB, GiB or MB, on macOS and iOS, read by readBytes and fetchPRDiff, not toJSON',
        '+const mask = 0x7fff_ffff & 0b1010_0000;',
        ' const ReviewResult = unchanged_context;',
      ].join('\n'),
    }],
  }],
  totalAdditions: 3,
  totalDeletions: 1,
};

describe('codeTokensFromDiff', () => {
  it('collects code-like identifiers from added lines and the changed file paths, but not units or mixed-case names', () => {
    const tokens = codeTokensFromDiff(diff);
    expect([...tokens].sort()).toEqual([
      'MAX_COMPACT_SIZE', 'createReview', 'excludePaths', 'excludePaths.length', 'fetchPRDiff', 'github.ts', 'octokit.rest.pulls.get', 'readBytes', 'review_body', 'src/github.ts',
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
    const units = 'Each length is capped at `MAX_COMPACT_SIZE` (32 MiB), but nothing bounds the sum.';
    expect(highlightCode(units, tokens)).toBe(units);
    // A number is not an identifier, even one whose tail looks like one.
    const number = 'The mask is 0x7fff_ffff, and the flag 0b1010_0000.';
    expect(highlightCode(number, new Set(['x7fff_ffff', 'b1010_0000']))).toBe(number);
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
    // An escaped backtick is text, so it opens no span that would swallow the code after it.
    expect(highlightCode('Calls \\`run( then `src/github.ts` and createReview.', tokens)).toBe('Calls \\`run( then `src/github.ts` and `createReview`.');
    // Text between escaped backticks is code shown as text, so no token in it gets backticks of its own.
    const escaped = 'The overrides of \\`Vec<T>::consensus_decode\\` and \\`Vec<u8>::consensus_decode\\` now call the finite-reader decode.';
    expect(highlightCode(escaped, new Set(['consensus_decode']))).toBe(escaped);
    expect(highlightCode('Escaped \\`run createReview\\` stays, then createReview.', tokens)).toBe('Escaped \\`run createReview\\` stays, then `createReview`.');
  });

  it('wraps tokens in a summary in code tags, since GitHub does not parse Markdown there', () => {
    const link = '<a href="https://example.com/src/github.ts"><code>src/github.ts:3</code></a>';
    expect(highlightCode(`<summary><b>createReview skips <code>excludePaths</code></b><br><sub>${link}</sub></summary>\nThen createReview.`, tokens))
      .toBe(`<summary><b><code>createReview</code> skips <code>excludePaths</code></b><br><sub>${link}</sub></summary>\nThen \`createReview\`.`);
  });
});
