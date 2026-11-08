import { ParsedDiff } from './types';

const TOKEN_RE = /[A-Za-z_$][\w$]*(?:[./][A-Za-z_$][\w$-]*)*/g;
// Text that already renders as code or must not change: fences, inline code, HTML comments and tags, links and URLs.
// A `<summary>` comes first, since GitHub renders its content as HTML only and it gets `<code>` instead of backticks.
// As in Markdown, inline code closes only on a run of as many backticks, within its paragraph, and an escaped backtick
// is text. An unclosed run stays text, so it cannot pair with a backtick further on and leave the code after it unprotected.
const PROTECTED_RE = /<summary>[^\n]*?<\/summary>|(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*(?=\n|$)|\\`|(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\2(?!`)|<!--[\s\S]*?-->|<\/?[A-Za-z][^>\n]*>|!?\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/[^\s)]+/g;
// Inside a `<summary>`: existing code and the tags, which hold attributes such as link targets.
const SUMMARY_PROTECTED_RE = /<code>[\s\S]*?<\/code>|<[^>]*>/g;

/** Whether a token looks like code rather than a word: snake_case, camelCase, PascalCase with an inner capital, or dotted. */
function isCodeLike(token: string): boolean {
  return token.length >= 3 && (/_/.test(token) || /[a-z\d][A-Z]/.test(token) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(token));
}

/** Collects the identifiers on the diff's added lines and the changed file paths, for `highlightCode`. */
export function codeTokensFromDiff(diff: ParsedDiff): Set<string> {
  const tokens = new Set<string>();
  for (const file of diff.files) {
    tokens.add(file.path);
    const base = file.path.split('/').pop() ?? '';
    if (base.includes('.') && base.length >= 3) tokens.add(base);
    for (const hunk of file.hunks) {
      for (const line of hunk.content.split('\n')) {
        if (!line.startsWith('+')) continue;
        for (const token of line.slice(1).match(TOKEN_RE) ?? []) {
          for (const part of [token, ...token.split(/[./]/)]) {
            if (isCodeLike(part)) tokens.add(part);
          }
        }
      }
    }
  }
  return tokens;
}

/** Wraps every whole token of `text` found in `tokens` in backticks, outside existing code, links and HTML. */
export function highlightCode(text: string, tokens: ReadonlySet<string>): string {
  if (tokens.size === 0) return text;
  const markdown = (plain: string): string => plain.replace(TOKEN_RE, token => (tokens.has(token) ? `\`${token}\`` : token));
  const html = (plain: string): string => plain.replace(TOKEN_RE, token => (tokens.has(token) ? `<code>${token}</code>` : token));
  return wrapOutside(text, PROTECTED_RE, markdown, kept => (kept.startsWith('<summary>') ? wrapOutside(kept, SUMMARY_PROTECTED_RE, html, tag => tag) : kept));
}

/** Applies `wrap` to the text between the matches of `protectedRe`, and `keep` to each match. */
function wrapOutside(text: string, protectedRe: RegExp, wrap: (plain: string) => string, keep: (match: string) => string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(protectedRe)) {
    out += wrap(text.slice(last, match.index)) + keep(match[0]);
    last = match.index + match[0].length;
  }
  return out + wrap(text.slice(last));
}
