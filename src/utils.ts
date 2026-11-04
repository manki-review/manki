/**
 * Truncate a string to a maximum length, appending "..." if truncated.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Truncate a string to `maxLen` code units, backing off one position if the
 * boundary would land inside a UTF-16 surrogate pair, then appending "...".
 */
export function safeTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let end = maxLen;
  if (end > 0 && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF) {
    end--;
  }
  return text.slice(0, end) + '...';
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Safely parse JSON, returning null on failure.
 */
export function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Redact GitHub token literals from a string so they cannot leak into logs
 * or user-visible output.
 */
export function sanitizeTokens(s: string): string {
  // Stateless installation tokens are `ghs_`-prefixed JWTs, so the body can contain `.` and `-`.
  return s.replace(/\b(ghp|ghs|gho|ghu|ghr|github_pat)_[A-Za-z0-9._-]+/g, '[REDACTED]');
}

/**
 * Sends a request and parses its reply. When parsing throws, it sends once more and parses that
 * reply, so a single malformed model reply does not fail the stage. A second failure is thrown.
 */
export async function sendWithParseRetry<R, T>(
  send: () => Promise<R>,
  parse: (reply: R) => T,
  onRetry: (error: unknown) => void,
): Promise<T> {
  const first = await send();
  try {
    return parse(first);
  } catch (error) {
    onRetry(error);
  }
  return parse(await send());
}
