import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildTimeoutDiagnostics, sanitizeLogOutput, seedAuthFile } from './cli-utils';

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

  it('truncates stderr to first 500 chars', () => {
    const long = 'y'.repeat(600);
    const result = buildTimeoutDiagnostics('', long);
    expect(result).toContain('stderr: ' + 'y'.repeat(500));
    expect(result).not.toContain('y'.repeat(501));
  });

  it('sanitizes workflow commands in both snippets', () => {
    const result = buildTimeoutDiagnostics('::error::leaked', '::warning::secret');
    expect(result).not.toContain('::error');
    expect(result).not.toContain('::warning');
    expect(result).toContain('[redacted-workflow-cmd]');
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

  it('passes the inputName and bootstrapHint through to error messages', () => {
    expect(() => seedAuthFile(opts({ inputName: 'gemini_oauth_token', secret: '' })))
      .toThrow(/gemini_oauth_token is empty\. Bootstrap with `cmd`\./);
  });
});
