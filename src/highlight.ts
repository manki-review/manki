import { ParsedDiff } from './types';

const TOKEN_RE = /[A-Za-z_$][\w$]*(?:[./][A-Za-z_$][\w$-]*)*/g;
// Text that already renders as code or must not change: fences, inline code, HTML comments and tags, links and URLs.
const PROTECTED_RE = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*(?=\n|$)|(`+)[\s\S]*?\2|<!--[\s\S]*?-->|<\/?[A-Za-z][^>\n]*>|!?\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/[^\s)]+/g;

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
  const wrap = (plain: string): string => plain.replace(TOKEN_RE, token => (tokens.has(token) ? `\`${token}\`` : token));
  let out = '';
  let last = 0;
  for (const match of text.matchAll(PROTECTED_RE)) {
    out += wrap(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + wrap(text.slice(last));
}
