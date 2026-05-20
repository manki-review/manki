const REDACTED = '<redacted>';

const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const OPENAI_KEY_RE = /sk-[A-Za-z0-9_-]{20,}/g;
const BEARER_RE = /Bearer\s+([^\s]{20,})/gi;
const JSON_TOKEN_KEY_RE =
  /"(?:refresh_token|access_token|id_token)"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/g;

function isPlausibleToken(s: string): boolean {
  return s.length >= 40;
}

export function redactSensitiveSubstrings(input: string): string {
  let out = input;

  out = out.replace(JWT_RE, (match) => (isPlausibleToken(match) ? REDACTED : match));
  out = out.replace(OPENAI_KEY_RE, REDACTED);
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = out.replace(JSON_TOKEN_KEY_RE, (match, value) => match.replace(`"${value}"`, `"${REDACTED}"`));

  return out;
}

const ELLIPSIS = ' …';

export function truncateLogLine(line: string, maxLen: number): string {
  if (maxLen <= 0) {
    throw new RangeError(`maxLen must be > 0, got ${maxLen}`);
  }
  if (line.length <= maxLen) return line;
  const truncated = line.length - maxLen;
  const suffix = `${ELLIPSIS} (truncated ${truncated} more chars)`;
  const keep = maxLen - suffix.length;
  if (keep <= 0) return suffix.trimStart();
  return line.slice(0, keep) + suffix;
}

export function sanitizeCliOutput(raw: string, opts?: { maxLineLen?: number }): string {
  const maxLineLen = opts?.maxLineLen ?? 1024;
  const trailingNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (trailingNewline) lines.pop();
  const result = lines
    .map((line) => truncateLogLine(redactSensitiveSubstrings(line), maxLineLen))
    .join('\n');
  return trailingNewline ? result + '\n' : result;
}
