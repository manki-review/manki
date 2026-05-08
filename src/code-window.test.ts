import { extractCurrentCodeWindow } from './code-window';

describe('extractCurrentCodeWindow', () => {
  function makeFile(lineCount: number): string {
    return Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n');
  }

  it('returns a windowed snippet with `>>>` marker on the flagged line', () => {
    const fileContents = new Map([['src/a.ts', makeFile(80)]]);
    const out = extractCurrentCodeWindow(fileContents, 'src/a.ts', 40);
    expect(out).toContain('>>> 40: line 40');
    // line 40 ± 25 inclusive
    expect(out).toContain('   15: line 15');
    expect(out).toContain('   65: line 65');
    // outside the window
    expect(out).not.toContain('line 14');
    expect(out).not.toContain('line 66');
  });

  it('includes a fix located 10 lines from the anchor (PMPX-style drift case)', () => {
    // GitHub-anchored thread line points at anchor=35; the actual fix lives at
    // line 10 (25 lines away). The widened ±25 window reaches line 10 but the
    // old ±5 window would have stopped at line 30. Assert the boundary.
    const fileContents = new Map([['src/a.ts', makeFile(80)]]);
    const out = extractCurrentCodeWindow(fileContents, 'src/a.ts', 35);
    expect(out).toContain('   10: line 10');
    expect(out).not.toContain('   9: line 9');
  });

  it('clamps the window start at line 1 for early flagged lines', () => {
    const fileContents = new Map([['src/a.ts', makeFile(80)]]);
    const out = extractCurrentCodeWindow(fileContents, 'src/a.ts', 1);
    const lines = out.split('\n');
    expect(lines[0]).toBe('>>> 1: line 1');
    // Window upper bound is line 1 + 25 = 26
    expect(out).toContain('   26: line 26');
    expect(out).not.toContain('line 27');
  });

  it('clamps the window end at the last line for late flagged lines', () => {
    const fileContents = new Map([['src/a.ts', makeFile(30)]]);
    const out = extractCurrentCodeWindow(fileContents, 'src/a.ts', 30);
    const lines = out.split('\n');
    expect(lines[lines.length - 1]).toBe('>>> 30: line 30');
    // Window lower bound is 30 - 25 = 5
    expect(out).toContain('   5: line 5');
    expect(out).not.toContain('   4: line 4');
  });

  it('returns `(file content unavailable)` when `line` is past the file end but within window reach', () => {
    // file has 8 lines, flagged line 30 is beyond EOF but within `line - WINDOW <= lines.length`
    // (30 - 25 = 5 <= 8). Without the guard, the function would emit a window without a `>>>`
    // marker because `i === line` is never true in `start..lines.length`.
    const fileContents = new Map([['src/a.ts', makeFile(8)]]);
    expect(extractCurrentCodeWindow(fileContents, 'src/a.ts', 30)).toBe('(file content unavailable)');
  });

  it('returns `(file content unavailable)` when the file is missing from the map', () => {
    const fileContents = new Map<string, string>();
    expect(extractCurrentCodeWindow(fileContents, 'src/missing.ts', 5)).toBe('(file content unavailable)');
  });

  it('returns `(file content unavailable)` when fileContents is undefined', () => {
    expect(extractCurrentCodeWindow(undefined, 'src/a.ts', 5)).toBe('(file content unavailable)');
  });

  it('returns empty string for invalid line numbers', () => {
    const fileContents = new Map([['src/a.ts', makeFile(10)]]);
    expect(extractCurrentCodeWindow(fileContents, 'src/a.ts', 0)).toBe('');
    expect(extractCurrentCodeWindow(fileContents, 'src/a.ts', -3)).toBe('');
    expect(extractCurrentCodeWindow(fileContents, 'src/a.ts', NaN)).toBe('');
    expect(extractCurrentCodeWindow(fileContents, 'src/a.ts', Infinity)).toBe('');
  });

  it('returns empty string for empty file path', () => {
    const fileContents = new Map([['src/a.ts', makeFile(10)]]);
    expect(extractCurrentCodeWindow(fileContents, '', 5)).toBe('');
  });
});
