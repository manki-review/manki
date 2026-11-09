/** Starts the line that holds a finding's issue box, or what replaced it, so readers of the finding can skip it. */
export const ISSUE_BOX_ANCHOR = '<!-- manki-issue-box -->';

const ISSUE_BOX_LABEL = 'Create an issue for this';

// A box is a task list line that ends with the finding's id. GitHub turns `[ ]` into `[x]` on a tick.
const ISSUE_BOX_LINE = /^[ \t]*[-*] \[([ xX])\] .*<!-- manki-box:issue:(.+?) -->[ \t]*\r?$/;

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** Returns the unticked box line of the finding `id`. */
export function issueBoxLine(id: string): string {
  return `- [ ] ${ISSUE_BOX_LABEL} <!-- manki-box:issue:${id} -->`;
}

/** Returns the box that offers to file the finding `id` as an issue, after its anchor. */
export function issueBox(id: string): string {
  return `${ISSUE_BOX_ANCHOR}\n${issueBoxLine(id)}`;
}

/**
 * Returns the boxes Manki posted in `body`, with their line numbers. A box counts only right under its anchor and
 * outside a code fence, so a box line a model wrote into a fix, which Manki posts fenced and uncleaned, is never one.
 */
function issueBoxes(lines: string[]): Array<{ line: number; id: string; ticked: boolean }> {
  const fenced = fencedLines(lines);
  return lines.flatMap((text, i) => {
    const match = fenced[i] ? null : text.match(ISSUE_BOX_LINE);
    return match && lines[i - 1]?.trim() === ISSUE_BOX_ANCHOR ? [{ line: i, id: match[2], ticked: match[1] !== ' ' }] : [];
  });
}

/** Returns, for each of `lines`, whether it is a code fence or inside one. */
function fencedLines(lines: string[]): boolean[] {
  let fence: string | undefined;
  return lines.map(text => {
    const opener = text.match(FENCE_RE)?.[1];
    if (fence) {
      // A fence closes on a line of the same character, at least as long, and nothing else.
      if (opener && opener[0] === fence[0] && opener.length >= fence.length && text.trim() === opener) fence = undefined;
      return true;
    }
    if (opener) fence = opener;
    return !!opener;
  });
}

/** Returns `body` with every line inside a code fence blanked, so a search finds only what Manki wrote outside one. */
export function withoutFences(body: string): string {
  const lines = body.split('\n');
  const fenced = fencedLines(lines);
  return lines.map((text, i) => (fenced[i] ? ' '.repeat(text.length) : text)).join('\n');
}

/** Returns the ids of the issue boxes ticked in `body`. */
export function tickedIssueBoxes(body: string): string[] {
  return issueBoxes(body.split('\n')).filter(box => box.ticked).map(box => box.id);
}

/** Returns where in `body` the box of `id` starts, or -1 when `body` has none. */
export function issueBoxOffset(body: string, id: string): number {
  const lines = body.split('\n');
  const box = issueBoxes(lines).find(b => b.id === id);
  return box ? lines.slice(0, box.line).reduce((offset, text) => offset + text.length + 1, 0) : -1;
}

/** Returns `body` with the ticked box line of `id` replaced by `text`, and every other line as it was. */
export function replaceIssueBox(body: string, id: string, text: string): string {
  const lines = body.split('\n');
  // A body someone saved in the web editor ends its lines with CRLF, which the replaced line keeps.
  for (const box of issueBoxes(lines)) if (box.id === id && box.ticked) lines[box.line] = `${text}${lines[box.line].endsWith('\r') ? '\r' : ''}`;
  return lines.join('\n');
}

/** Marks an issue Manki filed for the finding `id`, so a later tick links it instead of filing another. */
export function filedIssueMarker(id: string): string {
  return `<!-- manki-issue:${id} -->`;
}
