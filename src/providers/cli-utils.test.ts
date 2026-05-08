import { sanitizeLogOutput, buildTimeoutDiagnostics } from './cli-utils';

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
