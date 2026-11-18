import { minimatch } from 'minimatch';
import { posix } from 'path';

/** The characters of a workspace pattern Manki reads, besides `*`. */
const PATTERN_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._@-');

/** The longest workspace pattern Manki reads. */
const MAX_PATTERN = 200;

/**
 * Whether the folder `member`, relative to a workspace's root, matches its member patterns, such as `packages/*`. A
 * pattern that starts with `!` excludes what it matches. Throws for a pattern Manki does not read with certainty: one
 * with a character other than letters, digits, `.`, `_`, `@`, `-` and `*`, more than one `*` in a segment other than
 * `**`, a `..` segment, or more than 200 characters. Matching such a pattern takes time linear in its length.
 */
export function matchesWorkspace(patterns: readonly unknown[], member: string): boolean {
  let included = false;
  let excluded = false;
  for (const raw of patterns) {
    if (typeof raw !== 'string') throw new Error('a workspace pattern is not a string');
    const negated = raw.startsWith('!');
    const pattern = posix.normalize(negated ? raw.slice(1) : raw).split('/').filter(Boolean).join('/');
    const segments = pattern.split('/');
    const readable = raw.length <= MAX_PATTERN && pattern !== '' && pattern !== '.' && segments.every(segment =>
      segment !== '..' && (segment === '**' || ([...segment].every(c => c === '*' || PATTERN_CHARS.has(c)) && segment.split('*').length <= 2)));
    if (!readable) throw new Error(`the workspace pattern ${JSON.stringify(raw.slice(0, 100))} is one Manki does not read`);
    if (!minimatch(member, pattern, { nobrace: true, noext: true, nonegate: true, nocomment: true })) continue;
    if (negated) excluded = true;
    else included = true;
  }
  return included && !excluded;
}
