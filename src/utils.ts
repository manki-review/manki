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

// Control characters other than tab and newline, and format characters, which include zero-width and bidi controls.
const HIDDEN_CHARACTER = /(?![\t\n])[\p{Cc}\p{Cf}]/gu;

/** Returns the distinct hidden characters in `text` as `U+XXXX` code points, in the order they first appear. */
export function hiddenCharacters(text: string): string[] {
  return [...new Set([...text.matchAll(HIDDEN_CHARACTER)].map(([c]) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`))];
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
  if (value.length < MIN_SECRET_LENGTH || registeredSecrets.has(value)) return;
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

/** Applies `redactSecrets` to every string in `value`, through arrays and plain objects. */
export function redactSecretsDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactSecretsDeep);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecretsDeep(entry)]));
  }
  return value;
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

/** Variables a child process needs to run and to reach the network through a proxy. None of them names a credential. */
export const SYSTEM_ENV = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];

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

const MAX_PARSE_ERROR_CHARS = 300;

/** The note a parse retry adds to its user message, so the model learns what was wrong with its reply. */
export function parseRetryNote(error: unknown): string {
  const reason = safeTruncate(error instanceof Error ? error.message : String(error), MAX_PARSE_ERROR_CHARS);
  return `Your previous reply could not be used: ${reason}\n\nReply with only the JSON object the system prompt describes, with no text, markdown or code fence around it.`;
}

/**
 * Sends `message` and parses the reply. When parsing throws, it sends `message` once more with a note that names
 * the parse error, and parses that reply, so a single malformed model reply does not fail the stage. A second failure
 * is thrown.
 */
export async function sendWithParseRetry<R, T>(
  message: string,
  send: (message: string) => Promise<R>,
  parse: (reply: R) => T,
  onRetry: (error: unknown) => void,
): Promise<T> {
  const first = await send(message);
  let note: string;
  try {
    return parse(first);
  } catch (error) {
    onRetry(error);
    note = parseRetryNote(error);
  }
  return parse(await send(`${message}\n\n${note}`));
}

/**
 * Escapes `-->` and `--!>`, which close an HTML comment, inside a JSON payload as `--\u003E` and
 * `--!\u003E`. JSON parsing turns them back into `>`.
 */
export function sanitizeHtmlCommentJson(json: string): string {
  return json.replace(/--(!?)>/g, '--$1\\u003E');
}

/**
 * Maps `items` through `fn` with at most `limit` calls in flight, keeping the order of `items`. After a call
 * rejects, no further call starts and the first rejection is thrown.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
