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
 * `maxErrorLineLen` caps the returned ERROR line to avoid embedding
 * pathologically large strings in annotations and error objects.
 */
export function extractCliErrorSnippet(
  stderrText: string,
  maxFallbackChars = 500,
  maxErrorLineLen = 16_384,
): string {
  const sanitized = sanitizeLogOutput(stderrText);
  if (!sanitized) return '';
  const errorLine = findLastErrorLine(sanitized, maxErrorLineLen);
  if (errorLine) return errorLine;
  return sanitized.slice(0, maxFallbackChars);
}

function findLastErrorLine(text: string, maxLen = 16_384): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/^ERROR:\s/.test(line)) {
      return line.length <= maxLen ? line : line.slice(0, maxLen) + '…';
    }
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

export interface ExitDiagnosticsInput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  lastStdoutChunk: string;
  model: string;
  effort?: string;
  promptChars: number;
  elapsedMs: number;
  /**
   * The full parsed terminal `result` event from a stream-json CLI (currently
   * only Claude). When provided, the diagnostic appends a compact summary of
   * `is_error`, `subtype`, and the first 300 chars of the result/message text.
   * Pass `null` (the default if omitted) to render `<no result event>`, which
   * is informative on its own: it tells us the CLI exited before flushing a
   * terminal event.
   */
  resultEvent?: unknown;
}

/**
 * Build a single descriptive string for the non-zero-exit branch of a CLI
 * invocation. Captures runtime context (model, effort, prompt size, elapsed
 * time, byte counts) and a 500-char stdout tail so empty-stderr failures are
 * still actionable. The caller interpolates this inside its own
 * `"<provider> CLI failed (...)"` framing.
 */
export function buildExitDiagnostics(input: ExitDiagnosticsInput): string {
  const { exitCode, signal, stderr, lastStdoutChunk, model, effort, promptChars, elapsedMs, resultEvent } = input;
  const signalPart = signal ? `, signal ${signal}` : '';
  const stderrSnippet = extractCliErrorSnippet(stderr);
  const stdoutTail = sanitizeLogOutput(lastStdoutChunk.slice(-500));
  const head = `exit ${exitCode}${signalPart}: ${stderrSnippet || '<empty stderr>'}`;
  const ctx: string[] = [`model=${model}`];
  if (effort) ctx.push(`effort=${effort}`);
  ctx.push(`promptChars=${promptChars}`);
  ctx.push(`elapsedMs=${elapsedMs}`);
  ctx.push(`stderrChars=${stderr.length}`);
  if ('resultEvent' in input) ctx.push(...summarizeResultEvent(resultEvent));
  ctx.push(`lastStdout=${stdoutTail || '<none>'}`);
  return `${head} [${ctx.join(', ')}]`;
}

function summarizeResultEvent(resultEvent: unknown): string[] {
  if (resultEvent === null || resultEvent === undefined) return ['<no result event>'];
  if (typeof resultEvent !== 'object') {
    return [`result=${sanitizeLogOutput(String(resultEvent)).slice(0, 300)}`];
  }
  const event = resultEvent as Record<string, unknown>;
  const parts: string[] = [];
  if ('is_error' in event) parts.push(`result.is_error=${Boolean(event.is_error)}`);
  if (typeof event.subtype === 'string') parts.push(`result.subtype=${sanitizeLogOutput(event.subtype)}`);
  const rawText = pickResultText(event);
  if (rawText) {
    const snippet = sanitizeLogOutput(rawText).slice(0, 300);
    parts.push(`result.text=${JSON.stringify(snippet)}`);
  }
  return parts.length > 0 ? parts : ['result.<empty>'];
}

function pickResultText(event: Record<string, unknown>): string {
  if (typeof event.result === 'string' && event.result.length > 0) return event.result;
  if (typeof event.message === 'string' && event.message.length > 0) return event.message;
  if (event.error && typeof event.error === 'object') {
    const err = event.error as Record<string, unknown>;
    if (typeof err.message === 'string' && err.message.length > 0) return err.message;
  }
  return '';
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
