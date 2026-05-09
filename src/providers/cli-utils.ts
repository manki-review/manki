import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const STALE_TIMEOUT_MS = 90_000;

/** Strip GitHub Actions workflow commands to prevent injection when logging CLI output. */
export function sanitizeLogOutput(text: string): string {
  // Matches any line segment starting with :: followed by a letter — covers all workflow commands
  // regardless of parameter format (e.g. ::error file=foo.ts,line=5::message)
  return text.replace(/::[a-z].*$/gim, '[redacted-workflow-cmd]');
}

/** Build diagnostic snippets for timeout/stale error messages. */
export function buildTimeoutDiagnostics(lastStdoutChunk: string, stderrText: string): string {
  const stdoutSnippet = sanitizeLogOutput(lastStdoutChunk.slice(-500));
  const stderrSnippet = sanitizeLogOutput(stderrText.slice(0, 500));
  const parts: string[] = [];
  if (stdoutSnippet) parts.push(`Last stdout: ${stdoutSnippet}`);
  if (stderrSnippet) parts.push(`stderr: ${stderrSnippet}`);
  return parts.join('. ');
}

export function resolveCodexHome(): string {
  const explicit = process.env.CODEX_HOME;
  if (explicit) return explicit;
  const home = process.env.HOME;
  if (!home) {
    throw new Error(
      'Cannot resolve CODEX_HOME: neither $CODEX_HOME nor $HOME is set in the environment.',
    );
  }
  return join(home, '.codex');
}

export function resolveGeminiCredsDir(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('Cannot seed Gemini OAuth credentials: $HOME is not set in the environment.');
  }
  return join(home, '.gemini');
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
