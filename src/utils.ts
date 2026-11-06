import * as core from '@actions/core';

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
 * Appends hidden HTML comment markers after `body`. Notifications preview the start of
 * a comment as plain text, so markers at the top would show up there as blank lines.
 */
export function withMarkers(body: string, ...markers: string[]): string {
  return `${body}\n\n${markers.join('\n')}`;
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

// A shorter value would also redact ordinary words.
const MIN_SECRET_LENGTH = 8;
const registeredSecrets = new Set<string>();
// The `-----BEGIN ... KEY-----` lines of a private key carry nothing secret.
const PEM_ARMOR = /^-----[A-Z0-9 ]+-----$/;

/** Masks `value` in the log and adds it to the values `redactSecrets` removes. A value under 8 characters is ignored. */
export function registerSecret(value: string): void {
  if (value.length < MIN_SECRET_LENGTH) return;
  core.setSecret(value);
  registeredSecrets.add(value);
}

/**
 * Replaces Manki's own secret values in `text` with `[REDACTED]`: the values passed to `registerSecret` and the action
 * inputs named like a secret. Each line of a multi-line value and the base64 encodings of each value are replaced too.
 */
export function redactSecrets(text: string): string {
  return secretForms().reduce((result, form) => result.replaceAll(form, '[REDACTED]'), text);
}

/** Returns every form of a secret value that `redactSecrets` replaces, longest first. */
function secretForms(): string[] {
  const inputs = Object.entries(process.env).flatMap(([name, value]) => (/^INPUT_/i.test(name) && SECRET_NAME.test(name) && value ? [value] : []));
  const forms = [...registeredSecrets, ...inputs].flatMap((secret) => {
    const value = secret.trim();
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => !PEM_ARMOR.test(line));
    return [value, ...lines, ...base64Forms(value)];
  });
  return [...new Set(forms)].filter((form) => form.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

/**
 * Returns the base64 text that encodes `value` wherever it starts in a longer encoded string, such as the
 * `x-access-token:<token>` header a checkout writes. Characters that also depend on the bytes around `value` are left out.
 */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value);
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    return encoded.slice(Math.ceil((offset * 4) / 3), Math.floor((offset + bytes.length) / 3) * 4);
  });
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

/** Matches a variable name that holds a credential, such as `*_TOKEN`, `*_KEY` or `*_PASSWORD`. */
export const SECRET_NAME = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASSPHRASE|PAT|CREDENTIALS?|AUTH)$/i;

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
