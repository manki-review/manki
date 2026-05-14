import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export const STALE_TIMEOUT_MS = 90_000;

/** Strip GitHub Actions workflow commands to prevent injection when logging CLI output. */
export function sanitizeLogOutput(text: string): string {
  // Matches any line segment starting with :: followed by a letter — covers all workflow commands
  // regardless of parameter format (e.g. ::error file=foo.ts,line=5::message)
  return text.replace(/::[a-z].*$/gim, '[redacted-workflow-cmd]');
}

/**
 * Extract a useful snippet from CLI stderr for error messages. CLIs (Codex,
 * Gemini, Claude) frequently emit a final `ERROR: {...}` line with a JSON
 * payload that contains the actionable `message` field. Returning that line
 * whole is more useful than a fixed head slice, which routinely cuts the JSON
 * mid-string. When no `ERROR:` line is present, falls back to the first
 * `maxFallbackChars` characters. Always applies `sanitizeLogOutput`.
 */
export function extractCliErrorSnippet(stderrText: string, maxFallbackChars = 500): string {
  const sanitized = sanitizeLogOutput(stderrText);
  if (!sanitized) return '';
  const errorLine = findLastErrorLine(sanitized);
  if (errorLine) return errorLine;
  return sanitized.slice(0, maxFallbackChars);
}

function findLastErrorLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/^ERROR:\s/.test(line)) return line;
  }
  return null;
}

/** Build diagnostic snippets for timeout/stale error messages. */
export function buildTimeoutDiagnostics(lastStdoutChunk: string, stderrText: string): string {
  const stdoutSnippet = sanitizeLogOutput(lastStdoutChunk.slice(-500));
  const stderrSnippet = extractCliErrorSnippet(stderrText);
  const parts: string[] = [];
  if (stdoutSnippet) parts.push(`Last stdout: ${stdoutSnippet}`);
  if (stderrSnippet) parts.push(`stderr: ${stderrSnippet}`);
  return parts.join('. ');
}

export interface SeedAuthFileOptions {
  /** Base64-encoded JSON blob from a GitHub secret. */
  secret: string;
  /** Action input name, used in error messages. */
  inputName: string;
  /** Absolute path the CLI reads on disk. */
  targetPath: string;
  /**
   * Dotted JSON paths the decoded blob must contain (e.g. `tokens.access_token`).
   * Used to fail fast on malformed secrets and to reject the legacy single-token shape.
   */
  requiredFields: string[];
  /** Bootstrap command shown to the user when validation fails. */
  bootstrapHint: string;
}

/**
 * Decode a base64-encoded auth file from a GitHub secret and write it to disk
 * with mode 0600, only when the target file is absent. Preserving an existing
 * file lets CLIs that refresh tokens in place keep their refreshed credentials
 * across invocations on persistent runners.
 */
export function seedAuthFile(opts: SeedAuthFileOptions): void {
  const trimmed = opts.secret.trim();
  if (!trimmed) {
    throw new Error(`${opts.inputName} is empty. ${opts.bootstrapHint}`);
  }

  const decoded = Buffer.from(trimmed, 'base64').toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error(
      `${opts.inputName} did not decode to JSON (got the legacy single-token shape?). ${opts.bootstrapHint}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${opts.inputName} must decode to a JSON object. ${opts.bootstrapHint}`);
  }

  for (const field of opts.requiredFields) {
    if (!hasNestedString(parsed as Record<string, unknown>, field)) {
      throw new Error(
        `${opts.inputName} is missing required field \`${field}\`. ${opts.bootstrapHint}`,
      );
    }
  }

  mkdirSync(dirname(opts.targetPath), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    // mkdirSync's mode hint only applies to newly created directories; on persistent
    // runners the direct parent may already exist with a broader mode. chmodSync
    // unconditionally tightens it. Grandparent directories are the caller's responsibility.
    chmodSync(dirname(opts.targetPath), 0o700);
  }
  try {
    writeFileSync(opts.targetPath, decoded, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw err;
  }
}

function hasNestedString(obj: Record<string, unknown>, dottedPath: string): boolean {
  const parts = dottedPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' && current.length > 0;
}
