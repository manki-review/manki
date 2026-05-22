import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildExitDiagnostics, buildTimeoutDiagnostics, extractCliErrorSnippet, sanitizeLogOutput, seedAuthFile } from './cli-utils';

function encode(json: unknown): string {
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
}

describe('sanitizeLogOutput', () => {
  it('redacts a single workflow command line', () => {
    expect(sanitizeLogOutput('::error::message')).toBe('[redacted-workflow-cmd]');
  });

  it('redacts all workflow command lines in a multiline string', () => {
    const input = 'safe line\n::warning::secret\nanother safe line\n::set-output name=foo::bar';
    const result = sanitizeLogOutput(input);
    expect(result).not.toContain('::warning');
    expect(result).not.toContain('::set-output');
    expect(result).toContain('safe line');
    expect(result).toContain('another safe line');
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeLogOutput('')).toBe('');
  });

  it('does not alter text without workflow commands', () => {
    const text = 'plain output\nno commands here';
    expect(sanitizeLogOutput(text)).toBe(text);
  });

  it('handles a chunk exactly at the 500-char boundary without truncation', () => {
    const clean = 'a'.repeat(500);
    expect(sanitizeLogOutput(clean)).toBe(clean);
  });

  it('redacts workflow commands case-insensitively on the command letter', () => {
    // The regex uses /i so ::Error:: and ::ERROR:: are both matched
    expect(sanitizeLogOutput('::Error::msg')).toBe('[redacted-workflow-cmd]');
  });
});

describe('buildTimeoutDiagnostics', () => {
  it('includes last stdout and stderr snippets', () => {
    const result = buildTimeoutDiagnostics('stdout content', 'stderr content');
    expect(result).toContain('Last stdout: stdout content');
    expect(result).toContain('stderr: stderr content');
  });

  it('omits empty parts', () => {
    expect(buildTimeoutDiagnostics('', '')).toBe('');
    expect(buildTimeoutDiagnostics('only stdout', '')).toBe('Last stdout: only stdout');
    expect(buildTimeoutDiagnostics('', 'only stderr')).toBe('stderr: only stderr');
  });

  it('truncates stdout to last 500 chars', () => {
    const long = 'x'.repeat(600);
    const result = buildTimeoutDiagnostics(long, '');
    expect(result).toContain('Last stdout: ' + 'x'.repeat(500));
    expect(result).not.toContain('x'.repeat(501));
  });

  it('falls back to first 500 chars of stderr when no ERROR line is present', () => {
    const long = 'y'.repeat(600);
    const result = buildTimeoutDiagnostics('', long);
    expect(result).toContain('stderr: ' + 'y'.repeat(500));
    expect(result).not.toContain('y'.repeat(501));
  });

  it('preserves a long final ERROR line in stderr without truncation', () => {
    const longMessage = 'The model id is not supported for this account. '.repeat(20);
    const errorLine = `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"${longMessage}"}}`;
    const stderr = `noise line 1\nnoise line 2\n${errorLine}\n`;
    const result = buildTimeoutDiagnostics('', stderr);
    expect(result).toContain(errorLine);
    expect(result).toContain(longMessage);
  });

  it('sanitizes workflow commands in both snippets', () => {
    const result = buildTimeoutDiagnostics('::error::leaked', '::warning::secret');
    expect(result).not.toContain('::error');
    expect(result).not.toContain('::warning');
    expect(result).toContain('[redacted-workflow-cmd]');
  });
});

describe('buildExitDiagnostics', () => {
  const base = {
    exitCode: 1,
    signal: null,
    stderr: 'boom',
    lastStdoutChunk: 'last bits',
    model: 'claude-opus-4-6',
    promptChars: 12345,
    elapsedMs: 4567,
  } as const;

  it('includes exit code, model, promptChars, elapsedMs, and stderrChars', () => {
    const result = buildExitDiagnostics({ ...base });
    expect(result).toContain('exit 1');
    expect(result).toContain('model=claude-opus-4-6');
    expect(result).toContain('promptChars=12345');
    expect(result).toContain('elapsedMs=4567');
    expect(result).toContain('stderrChars=4');
    expect(result).toContain('lastStdout=last bits');
  });

  it('includes effort when set and omits when unset', () => {
    expect(buildExitDiagnostics({ ...base, effort: 'high' })).toContain('effort=high');
    expect(buildExitDiagnostics({ ...base })).not.toContain('effort=');
  });

  it('surfaces empty stderr explicitly so silent failures are not blank', () => {
    const result = buildExitDiagnostics({ ...base, stderr: '', lastStdoutChunk: 'tail-of-stdout' });
    expect(result).toContain('<empty stderr>');
    expect(result).toContain('stderrChars=0');
    expect(result).toContain('lastStdout=tail-of-stdout');
  });

  it('marks lastStdout as <none> when no stdout was captured', () => {
    const result = buildExitDiagnostics({ ...base, lastStdoutChunk: '' });
    expect(result).toContain('lastStdout=<none>');
  });

  it('includes the signal when the process was killed', () => {
    const result = buildExitDiagnostics({ ...base, exitCode: null, signal: 'SIGTERM' });
    expect(result).toContain('exit null');
    expect(result).toContain('signal SIGTERM');
  });

  it('caps the stdout tail at 500 chars and sanitizes workflow commands in it', () => {
    const tail = '::warning::leaked\n' + 'z'.repeat(600);
    const result = buildExitDiagnostics({ ...base, lastStdoutChunk: tail });
    expect(result).not.toContain('::warning');
    expect(result).not.toContain('z'.repeat(501));
    expect(result).toContain('z'.repeat(500));
  });

  it('omits the result.* field entirely when resultEvent is not passed', () => {
    const result = buildExitDiagnostics({ ...base });
    expect(result).not.toContain('result.');
    expect(result).not.toContain('<no result event>');
  });

  it('renders <no result event> when resultEvent is explicitly null', () => {
    const result = buildExitDiagnostics({ ...base, resultEvent: null });
    expect(result).toContain('<no result event>');
  });

  it('summarizes a structured result event with is_error, subtype, and result text', () => {
    const result = buildExitDiagnostics({
      ...base,
      resultEvent: {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Maximum tokens exceeded',
      },
    });
    expect(result).toContain('result.is_error=true');
    expect(result).toContain('result.subtype=error_during_execution');
    expect(result).toContain('Maximum tokens exceeded');
  });

  it('renders success result events as is_error=false subtype=success', () => {
    const result = buildExitDiagnostics({
      ...base,
      resultEvent: { type: 'result', subtype: 'success', is_error: false, result: 'all good' },
    });
    expect(result).toContain('result.is_error=false');
    expect(result).toContain('result.subtype=success');
  });

  it('falls back to error.message when result and message are absent', () => {
    const result = buildExitDiagnostics({
      ...base,
      resultEvent: { type: 'result', is_error: true, error: { message: 'rate limited' } },
    });
    expect(result).toContain('rate limited');
  });

  it('caps the result text at 300 chars and sanitizes workflow commands inside it', () => {
    const long = '::warning::leaked\n' + 'q'.repeat(400);
    const result = buildExitDiagnostics({
      ...base,
      resultEvent: { type: 'result', is_error: true, result: long },
    });
    expect(result).not.toContain('::warning');
    expect(result).not.toContain('q'.repeat(301));
    expect(result).toContain('q'.repeat(200));
  });
});

describe('extractCliErrorSnippet', () => {
  it('returns the empty string for empty input', () => {
    expect(extractCliErrorSnippet('')).toBe('');
  });

  it('returns the last ERROR line whole when present', () => {
    const stderr = 'warm-up line\nERROR: short error 1\nlater noise\nERROR: short error 2\n';
    expect(extractCliErrorSnippet(stderr)).toBe('ERROR: short error 2');
  });

  it('preserves a >500-char ERROR JSON payload end-to-end including the message field', () => {
    const fullMessage = "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.";
    const payload = JSON.stringify({
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: fullMessage,
        details: 'x'.repeat(600),
      },
    });
    const stderr = `2025-05-14T00:00:00Z some preamble\nERROR: ${payload}\n`;
    expect(stderr.length).toBeGreaterThan(500);
    const snippet = extractCliErrorSnippet(stderr);
    expect(snippet).toContain(`"message":"${fullMessage}"`);
    expect(snippet.endsWith('}')).toBe(true);
    expect(snippet.length).toBeGreaterThan(500);
  });

  it('falls back to head slice when no ERROR line is present', () => {
    const stderr = 'z'.repeat(800);
    const snippet = extractCliErrorSnippet(stderr);
    expect(snippet).toBe('z'.repeat(500));
  });

  it('respects a custom fallback length', () => {
    const stderr = 'a'.repeat(800);
    expect(extractCliErrorSnippet(stderr, 100)).toBe('a'.repeat(100));
  });

  it('sanitizes workflow commands inside an ERROR line', () => {
    const stderr = 'ERROR: ::warning::leaked secret here';
    const snippet = extractCliErrorSnippet(stderr);
    expect(snippet).not.toContain('::warning');
    expect(snippet).toContain('[redacted-workflow-cmd]');
  });

  it('handles ERROR lines with surrounding whitespace', () => {
    const stderr = 'noise\n   ERROR: trimmed payload   \nmore noise\n';
    expect(extractCliErrorSnippet(stderr)).toBe('ERROR: trimmed payload');
  });

  it('truncates an ERROR line exceeding the default 16 384-char cap with an ellipsis', () => {
    const longPayload = 'x'.repeat(20_000);
    const stderr = `ERROR: ${longPayload}`;
    const snippet = extractCliErrorSnippet(stderr);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBe(16_384 + 1); // cap chars + ellipsis
  });

  it('respects a custom maxErrorLineLen cap', () => {
    const stderr = `ERROR: ${'y'.repeat(200)}`;
    const snippet = extractCliErrorSnippet(stderr, 500, 100);
    expect(snippet).toBe('ERROR: ' + 'y'.repeat(93) + '…');
  });
});

describe('seedAuthFile', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'manki-seed-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const validBlob = { tokens: { access_token: 'a', refresh_token: 'r' } };
  const opts = (overrides: Partial<Parameters<typeof seedAuthFile>[0]> = {}) => ({
    secret: encode(validBlob),
    inputName: 'openai_oauth_token',
    targetPath: join(tmpRoot, 'sub', 'auth.json'),
    requiredFields: ['tokens.access_token', 'tokens.refresh_token'],
    bootstrapHint: 'Bootstrap with `cmd`.',
    ...overrides,
  });

  it('writes the decoded JSON when the target file is absent', () => {
    const target = join(tmpRoot, 'sub', 'auth.json');
    seedAuthFile(opts());
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(validBlob);
  });

  it('writes the file with mode 0600 and creates the parent dir', () => {
    if (process.platform === 'win32') return; // Windows does not model Unix permission bits
    const target = join(tmpRoot, 'sub', 'auth.json');
    seedAuthFile(opts());
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates parent directory with mode 0700', () => {
    if (process.platform === 'win32') return;
    seedAuthFile(opts());
    const dirMode = statSync(join(tmpRoot, 'sub')).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it('preserves an existing file (does not overwrite refreshed tokens)', () => {
    const target = join(tmpRoot, 'sub', 'auth.json');
    seedAuthFile(opts());
    const refreshed = JSON.stringify({ tokens: { access_token: 'NEW', refresh_token: 'NEW_R' } });
    writeFileSync(target, refreshed);
    seedAuthFile(opts()); // second call must be a no-op
    expect(readFileSync(target, 'utf8')).toBe(refreshed);
  });

  it('rejects an empty secret', () => {
    expect(() => seedAuthFile(opts({ secret: '' }))).toThrow(/openai_oauth_token is empty/);
  });

  it('rejects the legacy single-token shape (non-base64-JSON) with the bootstrap hint', () => {
    // A bare token string base64-decodes to garbage, JSON.parse fails.
    expect(() => seedAuthFile(opts({ secret: 'sk-legacy-single-token-shape' })))
      .toThrow(/openai_oauth_token did not decode to JSON.*Bootstrap with/s);
  });

  it('rejects when a required nested field is missing', () => {
    const blob = { tokens: { access_token: 'a' } };
    expect(() => seedAuthFile(opts({ secret: encode(blob) })))
      .toThrow(/missing required field `tokens.refresh_token`/);
  });

  it('rejects when decoded JSON is not an object', () => {
    expect(() => seedAuthFile(opts({ secret: encode('a string') })))
      .toThrow(/must decode to a JSON object/);
  });

  it('rejects when decoded JSON is an array', () => {
    expect(() => seedAuthFile(opts({ secret: encode([1, 2, 3]) })))
      .toThrow(/must decode to a JSON object/);
  });

  it('passes the inputName and bootstrapHint through to error messages', () => {
    expect(() => seedAuthFile(opts({ inputName: 'gemini_oauth_token', secret: '' })))
      .toThrow(/gemini_oauth_token is empty\. Bootstrap with `cmd`\./);
  });

  it('rejects when a required field is an empty string', () => {
    const blob = { tokens: { access_token: '', refresh_token: 'r' } };
    expect(() => seedAuthFile(opts({ secret: encode(blob) })))
      .toThrow(/missing required field `tokens.access_token`/);
  });

  it('accepts a flat-field (Gemini-shaped) blob with single-segment required fields', () => {
    const blob = { access_token: 'a', refresh_token: 'r' };
    expect(() =>
      seedAuthFile({
        ...opts(),
        secret: encode(blob),
        requiredFields: ['access_token', 'refresh_token'],
      })
    ).not.toThrow();
  });

  it('rejects a flat-field blob missing a top-level required field', () => {
    const blob = { access_token: 'a' };
    expect(() =>
      seedAuthFile({
        ...opts(),
        secret: encode(blob),
        requiredFields: ['access_token', 'refresh_token'],
      })
    ).toThrow(/missing required field `refresh_token`/);
  });
});

