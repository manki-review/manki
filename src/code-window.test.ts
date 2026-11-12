import { extractCurrentCodeWindow, locatePostedFile, locatePostedLine } from './code-window';
import { expectLinearTime } from './test-utils';

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
    // line 10, which is 25 lines away. The ±25 window reaches line 10 but
    // stops before line 9. Assert the exact boundary.
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

describe('locatePostedLine', () => {
  const body = ['function read(path) {', '  const data = fs.readFileSync(path);', '  if (!data) return null;', '  return parse(data);', '}'];
  const posted = body.join('\n');

  it('finds the posted code where it moved by the lines around it, and never by one generic line', () => {
    expect(locatePostedLine(posted, 2, ['// header', '', '', ...body].join('\n'))).toBe(5);
    // Indentation does not count, and the nearest place wins when the code appears twice.
    expect(locatePostedLine(posted, 2, [...body.map(l => `  ${l}`), '', ...body].join('\n'))).toBe(2);
    // The flagged line was edited in place: its neighbours still place it.
    expect(locatePostedLine(posted, 2, posted.replace('fs.readFileSync(path)', 'await fs.promises.readFile(path)'))).toBe(2);
    // Only one generic line of the window is left, so nothing places the code.
    expect(locatePostedLine(posted, 4, ['function other() {', '  return parse(data);', '}'].join('\n'))).toBeUndefined();
    expect(locatePostedLine(posted, 2, 'nothing here')).toBeUndefined();
  });

  it('stays linear on a head file of many repeated lines, which the PR author controls', async () => {
    await expectLinearTime((size) => {
      const repeated = [...Array(2 * size).fill(''), ...Array(size).fill('  return parse(data);'), ...body].join('\n');
      const started = performance.now();
      expect(locatePostedLine(posted, 2, repeated)).toBe(3 * size + 2);
      return performance.now() - started;
    }, 100_000);
    // A size too small to divide, or a smaller size that is not smaller, would pass without comparing anything.
    await expect(expectLinearTime(() => 0, 7)).rejects.toThrow('needs 0 < smaller < size, got smaller 0 and size 7');
    await expect(expectLinearTime(() => 0, 100, { smaller: 100 })).rejects.toThrow('needs 0 < smaller < size');
  }, 60_000);

  it('finds the posted code in another file only when exactly one holds its whole window unchanged', () => {
    const whole = ['// header', ...body.map(l => `  ${l}`)].join('\n');
    const part = posted.replace('return null', 'throw new Error()');
    expect(locatePostedFile(posted, 2, [['src/part.ts', part], ['src/whole.ts', whole]])).toEqual({ file: 'src/whole.ts', line: 3 });
    // A file that holds only part of the window does not hold the code, and two files that hold it give no certain place.
    expect(locatePostedFile(posted, 2, [['src/part.ts', part]])).toBeUndefined();
    expect(locatePostedFile(posted, 2, [['src/a.ts', whole], ['src/b.ts', posted]])).toBeUndefined();
    expect(locatePostedFile(posted, 2, [['src/other.ts', 'nothing here']])).toBeUndefined();
    expect(locatePostedFile(posted, 2, [])).toBeUndefined();
  });
});
