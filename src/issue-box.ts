/** Starts the line that holds a finding's issue box, or what replaced it, so readers of the finding can skip it. */
export const ISSUE_BOX_ANCHOR = '<!-- manki-issue-box -->';

const ISSUE_BOX_LABEL = 'Create an issue for this';

// A box is a task list line that ends with the finding's id. GitHub turns `[ ]` into `[x]` on a tick.
const ISSUE_BOX_LINE = /^[ \t]*[-*] \[([ xX])\] .*<!-- manki-box:issue:(.+?) -->[ \t]*$/gm;

/** Returns the box that offers to file the finding `id` as an issue, after its anchor. */
export function issueBox(id: string): string {
  return `${ISSUE_BOX_ANCHOR}\n- [ ] ${ISSUE_BOX_LABEL} <!-- manki-box:issue:${id} -->`;
}

/** Returns the ids of the issue boxes ticked in `body`. */
export function tickedIssueBoxes(body: string): string[] {
  return [...body.matchAll(ISSUE_BOX_LINE)].filter(match => match[1] !== ' ').map(match => match[2]);
}

/** Returns `body` with the box line of `id` replaced by `text`, and every other line as it was. */
export function replaceIssueBox(body: string, id: string, text: string): string {
  return body.replace(ISSUE_BOX_LINE, (line, _tick: string, boxId: string) => (boxId === id ? text : line));
}

/** Marks an issue Manki filed for the finding `id`, so a later tick links it instead of filing another. */
export function filedIssueMarker(id: string): string {
  return `<!-- manki-issue:${id} -->`;
}
