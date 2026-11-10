const OPEN_THREAD_CODE_WINDOW = 25;

/**
 * Extract a small line window (line ± `OPEN_THREAD_CODE_WINDOW`) from the
 * current source so the judge can evaluate whether an open thread's flagged
 * region still exhibits the original concern. Returns
 * `'(file content unavailable)'` when the file is not present in the fetched
 * contents map (deleted, skipped due to size cap, fetch failure, or never
 * requested) and an empty string for invalid inputs. The neutral wording
 * avoids asserting removal in cases 2-4, which would mislead the judge into
 * marking threads addressed/not_addressed for the wrong reason.
 */
export function extractCurrentCodeWindow(
  fileContents: Map<string, string> | undefined,
  file: string,
  line: number,
): string {
  if (!file || !Number.isFinite(line) || line < 1) return '';
  const content = fileContents?.get(file);
  if (content === undefined) return '(file content unavailable)';
  const lines = content.split('\n');
  if (line > lines.length) return '(file content unavailable)';
  const start = Math.max(1, line - OPEN_THREAD_CODE_WINDOW);
  const end = Math.min(lines.length, line + OPEN_THREAD_CODE_WINDOW);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const marker = i === line ? '>>>' : '   ';
    out.push(`${marker} ${i}: ${lines[i - 1] ?? ''}`);
  }
  return out.join('\n');
}

// A line shorter than this, such as `}` or `return;`, recurs too often to tell where the code went.
const MIN_LOCATABLE_CHARS = 8;

/**
 * Returns where line `line` of `posted` sits in `current`: the line holding the same trimmed text, the one nearest
 * `line` when several do, or `gone` when none does. A line too short to tell apart gives `unknown`.
 */
export function locatePostedLine(posted: string, line: number, current: string): number | 'gone' | 'unknown' {
  const text = posted.split('\n')[line - 1]?.trim() ?? '';
  if (text.length < MIN_LOCATABLE_CHARS) return 'unknown';
  const matches = current.split('\n').flatMap((l, i) => (l.trim() === text ? [i + 1] : []));
  if (matches.length === 0) return 'gone';
  return matches.reduce((best, m) => (Math.abs(m - line) < Math.abs(best - line) ? m : best));
}
