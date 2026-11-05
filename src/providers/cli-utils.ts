import { spawn } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { StringDecoder } from 'string_decoder';

import * as core from '@actions/core';

import { sanitizeTokens } from '../utils';
import { SendMessageOptions } from './types';

export const STALE_TIMEOUT_MS = 90_000;
const HARD_TIMEOUT_MS = 1_200_000;
const KILL_GRACE_MS = 5000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const REPLY_TAIL_CHARS = 2000;

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

/** Appends `text` to the reply tail kept for `warnReplyTail`, dropping all but its last characters. */
export function appendReplyTail(tail: string, text: string): string {
  return (tail + text).slice(-REPLY_TAIL_CHARS);
}

/** Logs the end of a reply that failed, was refused or reached the output limit, so the log shows what the model was writing. */
export function warnReplyTail(label: string, reply: string): void {
  const tail = reply.trim().slice(-REPLY_TAIL_CHARS);
  if (tail) core.warning(`${label} reply ended with: ${sanitizeLogOutput(sanitizeTokens(tail))}`);
}

// How the Claude, Codex and Gemini CLIs and APIs word a used-up usage limit, quota or rate limit.
const QUOTA_TEXT = /\b(?:hit your (?:\w+ )?limit|(?:usage|rate|weekly|daily|session|opus|sonnet|\d+-hour) limit (?:reached|exceeded)|quota (?:exceeded|exhausted|limit|will reset)|exceeded your current quota|exhausted your (?:\w+ )?(?:quota|capacity)|resource_exhausted|rate_limit_(?:error|exceeded)|insufficient_quota|too many requests)\b/i;
const OVERLOADED_TEXT = /\boverloaded(?:_error)?\b/i;
// "resets Nov 6, 8pm (UTC)", "try again at 20 Aug 2026, 16:29", "retry in 23.5s", "reset after 2s".
const RESET_TEXT = /\b(?:resets\s+|(?:try again|retry|reset)\s+(?=(?:at|in|after)\s))(.+?)(?=\.(?:\s|$)|[·∙|"\n[{]|$)/i;
// CLIs print their final error last, so only the end of a long output is read.
const QUOTA_TAIL_CHARS = 2000;

export interface QuotaMatch {
  /** The provider is short of capacity, rather than the caller out of quota. */
  overloaded: boolean;
  /** When the limit lifts, as the provider wrote it. */
  resetsAt?: string;
}

/** Returns the used-up limit or overload that `text` reports, or `undefined` when it reports none. */
export function matchQuotaText(text: string): QuotaMatch | undefined {
  const tail = text.slice(-QUOTA_TAIL_CHARS);
  const quota = QUOTA_TEXT.test(tail);
  if (!quota && !OVERLOADED_TEXT.test(tail)) return undefined;
  const resetsAt = RESET_TEXT.exec(tail)?.[1].replace(/[^\w\s,:.()+/-]/g, '').replace(/[\s.,:]+$/, '').trim().slice(0, 60);
  return { overloaded: !quota, ...(resetsAt && { resetsAt }) };
}

/**
 * Runs `call` with a signal that aborts after `timeoutMs` or with `signal`, or without one when neither is set.
 * A timeout is thrown as an error naming `label` and the limit. An abort from `signal` throws its reason.
 */
export async function callWithTimeout<T>(label: string, { timeoutMs, signal }: SendMessageOptions = {}, call: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const signals = [timeout, signal].filter((s): s is AbortSignal => s !== undefined);
  if (signals.length === 0) return call();
  try {
    return await call(AbortSignal.any(signals));
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout?.aborted) throw new Error(`${label} timed out after ${timeoutMs! / 1000}s`, { cause: error });
    throw error;
  }
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
   *
   * - Omit this field entirely to suppress the result section from the output
   *   (appropriate for providers whose CLIs do not emit a terminal result event).
   * - Pass `null` explicitly to show `<no result event>`, signalling that the
   *   CLI exited before flushing a terminal event (used by the Claude path when
   *   `lastResultEvent` was never set during streaming).
   * - Pass the parsed event object to render `is_error`, `subtype`, etc.
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

let emptyCwd: string | undefined;

/**
 * Returns an empty directory, created once per process, to run the CLIs in. In the PR
 * checkout they would load the PR's own hooks, MCP servers and settings files.
 */
function emptyCliCwd(): string {
  if (!emptyCwd) {
    const dir = mkdtempSync(join(tmpdir(), 'manki-cli-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    emptyCwd = dir;
  }
  return emptyCwd;
}

export interface RunCliOptions {
  /** Provider name used in error messages, e.g. `Claude`. */
  label: string;
  cliPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  input: string;
  /** Receives decoded stdout text as it arrives, including the decoder's final flush. */
  onStdout: (chunk: string) => void;
  /** Whether stderr output also resets the stale timer. */
  stderrResetsStale?: boolean;
  /** Kills the CLI after this long whatever its output. Defaults to `HARD_TIMEOUT_MS`. */
  hardTimeoutMs?: number;
  /** Kills the CLI once it aborts. The run then rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface CliExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  lastStdoutChunk: string;
}

/**
 * Spawn a provider CLI in an empty directory, feed it `input` on stdin and resolve once it exits. Rejects when
 * the CLI fails to spawn, stalls for `STALE_TIMEOUT_MS`, runs past the hard timeout,
 * exceeds the output cap or stdin cannot be written. A non-zero exit still resolves, so
 * the caller can build its own diagnostics.
 */
export function runCli(opts: RunCliOptions): Promise<CliExit> {
  const { label } = opts;
  const hardTimeoutMs = opts.hardTimeoutMs ?? HARD_TIMEOUT_MS;
  if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
  return new Promise((resolve, reject) => {
    const child = spawn(opts.cliPath, opts.args, {
      cwd: emptyCliCwd(),
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let timedOut = false;
    let stale = false;
    let aborted = false;
    let outputExceeded = false;
    let settled = false;
    let lastStdoutChunk = '';
    let rawBytes = 0;
    const killTimers: NodeJS.Timeout[] = [];

    const terminate = (): void => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, KILL_GRACE_MS);
      killTimer.unref();
      killTimers.push(killTimer);
    };

    const clearAllTimers = (): void => {
      clearTimeout(timer);
      clearTimeout(staleTimer);
      killTimers.forEach(clearTimeout);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      clearTimeout(staleTimer);
      terminate();
    }, hardTimeoutMs);
    timer.unref();

    const handleStale = (): void => {
      if (outputExceeded || timedOut || aborted) return;
      stale = true;
      clearTimeout(timer);
      terminate();
    };
    let staleTimer = setTimeout(handleStale, STALE_TIMEOUT_MS);
    staleTimer.unref();
    const resetStaleTimer = (): void => {
      clearTimeout(staleTimer);
      staleTimer = setTimeout(handleStale, STALE_TIMEOUT_MS);
      staleTimer.unref();
    };

    const onAbort = (): void => {
      aborted = true;
      clearTimeout(timer);
      clearTimeout(staleTimer);
      terminate();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const countBytes = (n: number): boolean => {
      rawBytes += n;
      if (rawBytes <= MAX_OUTPUT_BYTES) return true;
      if (!outputExceeded) {
        outputExceeded = true;
        clearTimeout(timer);
        clearTimeout(staleTimer);
        terminate();
      }
      return false;
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const takeStdout = (chunk: string): void => {
      if (!chunk) return;
      lastStdoutChunk = chunk.length >= 500 ? chunk.slice(-500) : (lastStdoutChunk + chunk).slice(-500);
      opts.onStdout(chunk);
    };

    child.stdout.on('data', (data: Buffer) => {
      if (outputExceeded || settled || stale || timedOut || aborted) return;
      resetStaleTimer();
      if (!countBytes(data.length)) return;
      takeStdout(stdoutDecoder.write(data));
    });
    child.stderr.on('data', (data: Buffer) => {
      if (outputExceeded || settled) return;
      if (opts.stderrResetsStale && !stale && !timedOut) resetStaleTimer();
      stderr += stderrDecoder.write(data);
      countBytes(data.length);
    });

    child.on('close', (code, signal) => {
      clearAllTimers();
      if (settled) return;
      settled = true;
      takeStdout(stdoutDecoder.end());
      stderr += stderrDecoder.end();
      if (aborted) {
        reject(opts.signal?.reason);
        return;
      }
      if (stale) {
        const details = buildTimeoutDiagnostics(lastStdoutChunk, stderr);
        const msg = `${label} CLI stale — no output for ${STALE_TIMEOUT_MS / 1000}s${details ? `. ${details}` : ''}`;
        core.warning(msg);
        reject(new Error(msg));
        return;
      }
      if (timedOut) {
        const details = buildTimeoutDiagnostics(lastStdoutChunk, stderr);
        const msg = `${label} CLI timed out after ${hardTimeoutMs / 1000}s${details ? `. ${details}` : ''}`;
        core.warning(msg);
        reject(new Error(msg));
        return;
      }
      if (outputExceeded) {
        reject(new Error(`${label} CLI output exceeded 50MB limit`));
        return;
      }
      resolve({ code, signal, stderr, lastStdoutChunk });
    });

    child.on('error', (error) => {
      clearAllTimers();
      if (settled) return;
      settled = true;
      reject(new Error(`${label} CLI spawn failed: ${error.message}`));
    });

    child.stdin.on('error', (err) => {
      core.warning(`stdin write error: ${err.message}`);
    });

    // `write()` never writes partially: a `false` return only means the buffer is above
    // `highWaterMark`, so `end()` waits for `drain`.
    try {
      if (child.stdin.write(opts.input)) {
        try { child.stdin.end(); } catch { /* stream may be destroyed */ }
      } else {
        child.stdin.once('drain', () => {
          if (!settled) {
            try { child.stdin.end(); } catch { /* stream already destroyed */ }
          }
        });
      }
    } catch (err) {
      core.warning(`stdin write failed: ${(err as Error).message}`);
      if (!settled) {
        settled = true;
        clearAllTimers();
        reject(new Error(`stdin write failed: ${(err as Error).message}`));
      }
      terminate();
    }
  });
}
