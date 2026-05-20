import { redactSensitiveSubstrings, sanitizeCliOutput, truncateLogLine } from './redact';

// Helpers to build plausible token-shaped strings without embedding real secrets.
function b64url(len: number): string {
  return 'A'.repeat(len);
}

function makeJwt(lenA = 20, lenB = 20, lenC = 20): string {
  return `${b64url(lenA)}.${b64url(lenB)}.${b64url(lenC)}`;
}

describe('redactSensitiveSubstrings', () => {
  describe('JWT-shaped tokens', () => {
    it('redacts a plausible JWT (total length >= 40)', () => {
      const jwt = makeJwt(20, 20, 20);
      expect(jwt.length).toBeGreaterThanOrEqual(40);
      expect(redactSensitiveSubstrings(`token: ${jwt}`)).toBe('token: <redacted>');
    });

    it('leaves a short JWT-shaped string alone (total length < 40)', () => {
      const short = 'abc.def.ghi';
      expect(short.length).toBeLessThan(40);
      const result = redactSensitiveSubstrings(short);
      expect(result).toBe(short);
    });

    it('redacts a JWT mid-sentence', () => {
      const jwt = makeJwt(20, 20, 20);
      const result = redactSensitiveSubstrings(`Authorization: Bearer ${jwt} -- end`);
      expect(result).not.toContain(jwt);
    });
  });

  describe('OpenAI-style API keys', () => {
    it('redacts sk- key with 20+ chars', () => {
      const key = 'sk-' + 'A'.repeat(24);
      expect(redactSensitiveSubstrings(`key=${key}`)).toBe('key=<redacted>');
    });

    it('does not redact sk- key shorter than 20 suffix chars', () => {
      const short = 'sk-' + 'A'.repeat(10);
      const result = redactSensitiveSubstrings(short);
      expect(result).toBe(short);
    });

    it('redacts multiple sk- keys on one line', () => {
      const key = 'sk-' + 'B'.repeat(24);
      const line = `key1=${key} key2=${key}`;
      const result = redactSensitiveSubstrings(line);
      expect(result).toBe('key1=<redacted> key2=<redacted>');
    });
  });

  describe('Bearer header values', () => {
    it('redacts a Bearer token of >= 20 chars (case-insensitive)', () => {
      const tok = 'A'.repeat(24);
      expect(redactSensitiveSubstrings(`Authorization: Bearer ${tok}`)).toBe(
        'Authorization: Bearer <redacted>',
      );
      expect(redactSensitiveSubstrings(`authorization: bearer ${tok}`)).toBe(
        'authorization: Bearer <redacted>',
      );
    });

    it('does not redact a short Bearer token (< 20 chars)', () => {
      const short = 'A'.repeat(10);
      const line = `Authorization: Bearer ${short}`;
      expect(redactSensitiveSubstrings(line)).toBe(line);
    });
  });

  describe('JSON token keys', () => {
    it('redacts refresh_token JSON value', () => {
      const json = '{"refresh_token": "super_secret_value_here"}';
      const result = redactSensitiveSubstrings(json);
      expect(result).toContain('"refresh_token"');
      expect(result).not.toContain('super_secret_value_here');
      expect(result).toContain('<redacted>');
    });

    it('redacts access_token JSON value', () => {
      const json = '{"access_token":"tok_abc123"}';
      const result = redactSensitiveSubstrings(json);
      expect(result).toContain('"access_token"');
      expect(result).not.toContain('tok_abc123');
    });

    it('redacts id_token JSON value', () => {
      const json = '{"id_token": "some.id.value"}';
      const result = redactSensitiveSubstrings(json);
      expect(result).toContain('"id_token"');
      expect(result).not.toContain('some.id.value');
    });

    it('keeps the JSON key intact while redacting the value', () => {
      const json = '{"refresh_token":"secret","other":"field"}';
      const result = redactSensitiveSubstrings(json);
      expect(result).toContain('"refresh_token"');
      expect(result).toContain('"other":"field"');
      expect(result).not.toContain('"secret"');
    });
  });

  describe('safe pass-through strings', () => {
    it('does not alter a plain log line', () => {
      const line = 'INFO: request completed in 123ms status=200';
      expect(redactSensitiveSubstrings(line)).toBe(line);
    });

    it('does not alter ANSI color codes', () => {
      const ansi = '[32mOK[0m step finished';
      expect(redactSensitiveSubstrings(ansi)).toBe(ansi);
    });

    it('does not alter a JavaScript stack trace', () => {
      const trace =
        'Error: something failed\n    at Object.<anonymous> (src/foo.ts:12:5)\n    at runMicrotasks (<anonymous>)';
      expect(redactSensitiveSubstrings(trace)).toBe(trace);
    });

    it('does not alter an empty string', () => {
      expect(redactSensitiveSubstrings('')).toBe('');
    });
  });
});

describe('truncateLogLine', () => {
  it('returns the line unchanged when length equals maxLen', () => {
    const line = 'a'.repeat(100);
    expect(truncateLogLine(line, 100)).toBe(line);
  });

  it('returns the line unchanged when length is below maxLen', () => {
    const line = 'hello';
    expect(truncateLogLine(line, 100)).toBe(line);
  });

  it('truncates a line one char over maxLen and appends the suffix', () => {
    const line = 'a'.repeat(101);
    const result = truncateLogLine(line, 100);
    expect(result.length).toBeLessThan(line.length);
    expect(result).toContain('(truncated');
    expect(result).toContain('more chars)');
  });

  it('includes the truncated byte count in the suffix', () => {
    const line = 'x'.repeat(200);
    const maxLen = 100;
    const result = truncateLogLine(line, maxLen);
    const excess = line.length - maxLen;
    expect(result).toContain(`${excess} more chars`);
  });

  it('handles a very long line', () => {
    const line = 'z'.repeat(100_000);
    const result = truncateLogLine(line, 1024);
    expect(result.length).toBeLessThan(line.length);
    expect(result).toContain('truncated');
  });

  it('throws RangeError when maxLen is 0', () => {
    expect(() => truncateLogLine('anything', 0)).toThrow(RangeError);
  });

  it('throws RangeError when maxLen is negative', () => {
    expect(() => truncateLogLine('anything', -1)).toThrow(RangeError);
  });

  it('includes the invalid value in the RangeError message', () => {
    expect(() => truncateLogLine('x', -5)).toThrow(/-5/);
  });
});

describe('sanitizeCliOutput', () => {
  it('applies redaction and truncation to each line', () => {
    const key = 'sk-' + 'A'.repeat(24);
    const longLine = 'x'.repeat(2000);
    const raw = `safe line\nkey=${key}\n${longLine}\n`;
    const result = sanitizeCliOutput(raw);
    expect(result).toContain('safe line');
    expect(result).not.toContain(key);
    expect(result).toContain('<redacted>');
    expect(result).toContain('(truncated');
  });

  it('preserves a trailing newline when the input ends with one', () => {
    const raw = 'line one\nline two\n';
    const result = sanitizeCliOutput(raw);
    expect(result.endsWith('\n')).toBe(true);
  });

  it('does not add a trailing newline when the input lacks one', () => {
    const raw = 'line one\nline two';
    const result = sanitizeCliOutput(raw);
    expect(result.endsWith('\n')).toBe(false);
  });

  it('uses a custom maxLineLen from opts', () => {
    const raw = 'x'.repeat(200);
    const result = sanitizeCliOutput(raw, { maxLineLen: 50 });
    expect(result).toContain('(truncated');
  });

  it('defaults maxLineLen to 1024', () => {
    const exactly1024 = 'a'.repeat(1024);
    const result = sanitizeCliOutput(exactly1024);
    expect(result).toBe(exactly1024);

    const over = 'a'.repeat(1025);
    const truncated = sanitizeCliOutput(over);
    expect(truncated).toContain('(truncated');
  });

  it('handles an empty string', () => {
    expect(sanitizeCliOutput('')).toBe('');
  });

  it('handles a realistic Codex CLI 401 error blob', () => {
    const accessTok = 'A'.repeat(40);
    const refreshTok = 'R'.repeat(40);
    const bearer = 'B'.repeat(30);
    const blob = [
      '[codex] refreshing OAuth token...',
      `POST https://auth.openai.com/oauth/token {"grant_type":"refresh_token","refresh_token":"${refreshTok}"}`,
      `HTTP 401 {"error":"invalid_grant","error_description":"Token has been expired or revoked.","access_token":"${accessTok}"}`,
      `Authorization: Bearer ${bearer}`,
      'ERROR: {"type":"error","status":401,"error":{"type":"auth_error","message":"invalid_grant"}}',
    ].join('\n');

    const result = sanitizeCliOutput(blob);
    expect(result).not.toContain(refreshTok);
    expect(result).not.toContain(accessTok);
    expect(result).not.toContain(bearer);
    expect(result).toContain('Bearer <redacted>');
    expect(result).toContain('ERROR:');
  });
});
