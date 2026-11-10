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

// A line shorter than this, such as `}`, recurs too often to anchor anything on its own.
const MIN_LOCATABLE_CHARS = 4;
// How many lines of the posted window must line up at one place in the head before the code counts as found there.
const MIN_MATCHING_LINES = 3;

/**
 * Returns where line `line` of `posted` sits in `current`: the place where the most lines of the posted window around
 * it line up again, the one nearest `line` when several tie, or `undefined` when fewer than `MIN_MATCHING_LINES` do.
 * One generic line, such as `return result;`, never places the code on its own.
 */
export function locatePostedLine(posted: string, line: number, current: string): number | undefined {
  const old = posted.split('\n');
  const now = current.split('\n');
  // Indexed in one pass, and only lines long enough to vote, so a file of repeated short lines stays linear.
  const at = new Map<string, number[]>();
  now.forEach((l, i) => {
    const text = l.trim();
    if (text.length < MIN_LOCATABLE_CHARS) return;
    const lines = at.get(text);
    if (lines) lines.push(i + 1);
    else at.set(text, [i + 1]);
  });
  const votes = new Map<number, number>();
  for (let d = -OPEN_THREAD_CODE_WINDOW; d <= OPEN_THREAD_CODE_WINDOW; d++) {
    const text = old[line - 1 + d]?.trim() ?? '';
    if (text.length < MIN_LOCATABLE_CHARS) continue;
    for (const i of at.get(text) ?? []) votes.set(i - d, (votes.get(i - d) ?? 0) + 1);
  }
  let best: number | undefined;
  for (const [anchor, n] of votes) {
    if (n < MIN_MATCHING_LINES || anchor < 1 || anchor > now.length) continue;
    const bestVotes = best === undefined ? 0 : votes.get(best)!;
    if (n > bestVotes || (n === bestVotes && Math.abs(anchor - line) < Math.abs(best! - line))) best = anchor;
  }
  return best;
}

/**
 * Whether the code around line `line` of `posted` differs from the code around line `now` of `current`, or the code was
 * not found at all (`now` undefined). Indentation does not count.
 */
export function postedCodeChanged(posted: string, line: number, current: string, now: number | undefined): boolean {
  if (now === undefined) return true;
  const old = posted.split('\n');
  const cur = current.split('\n');
  for (let d = -OPEN_THREAD_CODE_WINDOW; d <= OPEN_THREAD_CODE_WINDOW; d++) {
    const was = old[line - 1 + d];
    if (was !== undefined && was.trim() !== (cur[now - 1 + d] ?? '').trim()) return true;
  }
  return false;
}
