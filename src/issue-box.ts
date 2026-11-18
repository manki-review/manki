import { boxLabel, MessageBox } from './settings';

/** Starts the line that holds one of Manki's boxes in a message, or what replaced it, so readers of a finding can skip it. */
export const BOX_ANCHOR = '<!-- manki-issue-box -->';

export const ISSUE_BOX_LABEL = 'Create an issue for this';

// A box is a task list line that ends with its kind and, for some kinds, an id. GitHub turns `[ ]` into `[x]` on a tick.
const BOX_LINE = /^[ \t]*[-*] \[([ xX])\] .*<!-- manki-box:([a-z]+)(?::(.+?))? -->[ \t]*\r?$/;

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** Returns the unticked box line of the finding `id`. */
export function issueBoxLine(id: string): string {
  return `- [ ] ${ISSUE_BOX_LABEL} <!-- manki-box:issue:${id} -->`;
}

/** Returns the box that offers to file the finding `id` as an issue, after its anchor. */
export function issueBox(id: string): string {
  return `${BOX_ANCHOR}\n${issueBoxLine(id)}`;
}

/**
 * Returns the boxes Manki posted in `body`, with their line numbers. A box counts only right under its anchor and
 * outside a code fence, so a box line a model wrote into a fix, which Manki posts fenced and uncleaned, is never one.
 */
function anchoredBoxes(lines: string[]): Array<{ line: number; kind: string; id?: string; ticked: boolean }> {
  const fenced = fencedLines(lines);
  return lines.flatMap((text, i) => {
    const match = fenced[i] ? null : text.match(BOX_LINE);
    return match && lines[i - 1]?.trim() === BOX_ANCHOR ? [{ line: i, kind: match[2], ...(match[3] !== undefined && { id: match[3] }), ticked: match[1] !== ' ' }] : [];
  });
}

/** Returns the issue boxes Manki posted in `lines`, each with the id of its finding. */
function issueBoxes(lines: string[]): Array<{ line: number; id: string; ticked: boolean }> {
  return anchoredBoxes(lines).flatMap(box => (box.kind === 'issue' && box.id !== undefined ? [{ line: box.line, id: box.id, ticked: box.ticked }] : []));
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

const MESSAGE_BOXES: readonly string[] = ['again', 'check', 'forget', 'dismiss'] satisfies MessageBox[];

/** Returns the unticked line of `box`. `id` names what the box acts on, such as a learning. */
export function messageBoxLine(box: MessageBox, id?: string): string {
  return `- [ ] ${boxLabel(box)} <!-- manki-box:${box}${id ? `:${id}` : ''} -->`;
}

/** Returns the unticked `box` for a message, after its anchor. */
export function messageBox(box: MessageBox, id?: string): string {
  return `${BOX_ANCHOR}\n${messageBoxLine(box, id)}`;
}

/** Returns `text` followed by each distinct box of `boxes`, in their order. */
export function withMessageBoxes(text: string, boxes: ReadonlyArray<MessageBox | false | undefined>): string {
  const kept = [...new Set(boxes.filter((box): box is MessageBox => !!box))];
  return [text, ...kept.map(box => messageBox(box))].join('\n\n');
}

/** Returns the message boxes ticked in `body`, each with its id when it has one. */
export function tickedMessageBoxes(body: string): Array<{ box: MessageBox; id?: string }> {
  return anchoredBoxes(body.split('\n')).flatMap(({ kind, id, ticked }) =>
    (ticked && MESSAGE_BOXES.includes(kind) ? [{ box: kind as MessageBox, ...(id !== undefined && { id }) }] : []));
}

/** Returns `body` with the ticked line of `box` with `id` replaced by `text`, and every other line as it was. */
export function replaceMessageBox(body: string, box: MessageBox, id: string | undefined, text: string): string {
  const lines = body.split('\n');
  for (const found of anchoredBoxes(lines)) {
    if (found.kind === box && found.id === id && found.ticked) lines[found.line] = `${text}${lines[found.line].endsWith('\r') ? '\r' : ''}`;
  }
  return lines.join('\n');
}

export const FILED_ISSUE_OPENER = '<!-- manki-issue:';

/** Marks an issue Manki filed for the finding `id`, so a later tick links it instead of filing another. */
export function filedIssueMarker(id: string): string {
  return `${FILED_ISSUE_OPENER}${id} -->`;
}
