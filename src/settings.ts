/** Ends the settings block of Manki's newest progress comment. The Worker reads the boxes above it. */
export const SETTINGS_MARKER = '<!-- manki-settings -->';

export type SettingsBox = 'pause' | 'full' | 'cancel' | 'draft' | 'force';

/** The label of each box, in the order the block lists them. */
const BOX_LABELS: Record<SettingsBox, string> = {
  pause: 'Pause automatic reviews',
  full: 'Full review',
  cancel: 'Cancel this review',
  draft: 'Review this draft',
  force: 'Force review',
};

/** What the settings block shows. */
export interface SettingsView {
  /** The last commit Manki reviewed. */
  lastReviewed?: string;
  head: string;
  /** What Manki is doing on the PR, such as "review running" or "up to date". */
  status: string;
  boxes: ReadonlySet<SettingsBox>;
  ticked: ReadonlySet<SettingsBox>;
}

// Hidden markers another writer appends after the block, such as the answered marker of a command, stay after it.
const BLOCK_RE = /(?:^|\n+)---\n(?:Last reviewed `([0-9a-f]+)`|Not reviewed yet) · head `([0-9a-f]+)` · ([^\n]*)\n((?:- \[[ xX]\] [^\n]*\n)*)<!-- manki-settings -->((?:\n<!-- [^\n]* -->)*)\s*$/;
const BOX_LINE_RE = /^- \[([ xX])\] [^\n]*<!-- manki-box:(\w+) -->$/gm;

export function isSettingsBox(name: string): name is SettingsBox {
  return Object.hasOwn(BOX_LABELS, name);
}

const short = (sha: string): string => sha.slice(0, 7);

/** Renders the block: a rule, the status line, one line per applicable box and `SETTINGS_MARKER`. */
export function renderSettingsBlock(view: SettingsView): string {
  const reviewed = view.lastReviewed ? `Last reviewed \`${short(view.lastReviewed)}\`` : 'Not reviewed yet';
  const boxes = (Object.keys(BOX_LABELS) as SettingsBox[])
    .filter(box => view.boxes.has(box))
    .map(box => `- [${view.ticked.has(box) ? 'x' : ' '}] ${BOX_LABELS[box]} <!-- manki-box:${box} -->`);
  return ['---', `${reviewed} · head \`${short(view.head)}\` · ${view.status}`, ...boxes, SETTINGS_MARKER].join('\n');
}

/** Reads the settings block `body` ends with, or `undefined` when it has none. */
export function parseSettingsBlock(body: string): SettingsView | undefined {
  const match = body.match(BLOCK_RE);
  if (!match) return undefined;
  const boxes = new Set<SettingsBox>();
  const ticked = new Set<SettingsBox>();
  for (const [, mark, box] of match[4].matchAll(BOX_LINE_RE)) {
    if (!isSettingsBox(box)) continue;
    boxes.add(box);
    if (mark !== ' ') ticked.add(box);
  }
  return { ...(match[1] && { lastReviewed: match[1] }), head: match[2], status: match[3], boxes, ticked };
}

/** Removes the settings block `body` ends with. */
export function stripSettingsBlock(body: string): string {
  return body.replace(BLOCK_RE, (...match: string[]) => match[5]);
}

/** Appends the block for `view` to `body`, or returns `body` unchanged without a view. */
export function withSettingsBlock(body: string, view: SettingsView | undefined): string {
  return view ? `${body}\n\n${renderSettingsBlock(view)}` : body;
}
