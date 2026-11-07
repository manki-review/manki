import * as core from '@actions/core';

import { truncate, formatDuration, mapWithConcurrency, redactSecrets, registerSecret, safeJsonParse, safeTruncate, sanitizeTokens, withMarkers } from './utils';

jest.mock('@actions/core');

describe('utils', () => {
  describe('truncate', () => {
    it('returns the original string if within maxLength', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('returns the original string if exactly maxLength', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });

    it('truncates and appends "..." when string exceeds maxLength', () => {
      expect(truncate('hello world', 8)).toBe('hello...');
    });

    it('handles empty strings', () => {
      expect(truncate('', 5)).toBe('');
    });
  });

  describe('safeTruncate', () => {
    it('returns text unchanged when shorter than max', () => {
      expect(safeTruncate('hello', 10)).toBe('hello');
    });

    it('truncates normal text at boundary', () => {
      expect(safeTruncate('hello world', 5)).toBe('hello...');
    });

    it('avoids splitting a surrogate pair at the boundary', () => {
      // U+1F600 (grinning face) is a surrogate pair: 😀
      const text = 'ab\u{1F600}cd';
      const result = safeTruncate(text, 3);
      expect(result).toBe('ab...');
    });
  });

  describe('formatDuration', () => {
    it('formats sub-second durations', () => {
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(0)).toBe('0ms');
    });

    it('formats durations in seconds', () => {
      expect(formatDuration(1000)).toBe('1s');
      expect(formatDuration(45000)).toBe('45s');
    });

    it('formats durations in minutes and seconds', () => {
      expect(formatDuration(60000)).toBe('1m 0s');
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(125000)).toBe('2m 5s');
    });

    it('works with values passed through a helper', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const durations: any[] = [100, 2000, 65000];
      const results = durations.map((d) => formatDuration(d));
      expect(results).toEqual(['100ms', '2s', '1m 5s']);
    });
  });

  describe('safeJsonParse', () => {
    it('parses valid JSON', () => {
      expect(safeJsonParse('{"key": "value"}')).toEqual({ key: 'value' });
    });

    it('parses JSON arrays', () => {
      expect(safeJsonParse('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    it('parses JSON primitives', () => {
      expect(safeJsonParse('"hello"')).toBe('hello');
      expect(safeJsonParse('42')).toBe(42);
      expect(safeJsonParse('true')).toBe(true);
      expect(safeJsonParse('null')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(safeJsonParse('not json')).toBeNull();
      expect(safeJsonParse('{broken')).toBeNull();
      expect(safeJsonParse('')).toBeNull();
    });
  });

  describe('redactSecrets', () => {
    afterEach(() => {
      delete process.env.INPUT_OPENAI_API_KEY;
      delete process.env.INPUT_CONFIG_PATH;
      delete process.env.INPUT_GEMINI_API_KEY;
      delete process.env.INPUT_MANKI_TOKEN_URL;
    });

    it('redacts registered values and secret action inputs, and masks registered values in the log', () => {
      registerSecret('minted-app-token-1');
      process.env.INPUT_OPENAI_API_KEY = 'sk-openai-input-key';
      process.env.INPUT_CONFIG_PATH = '.github/manki-config.yml';
      process.env.INPUT_MANKI_TOKEN_URL = 'https://manki-api.example/token';

      expect(redactSecrets('a minted-app-token-1 b sk-openai-input-key c .github/manki-config.yml https://manki-api.example/token'))
        .toBe('a [REDACTED] b [REDACTED] c .github/manki-config.yml https://manki-api.example/token');
      expect(core.setSecret).toHaveBeenCalledWith('minted-app-token-1');
    });

    it('leaves values too short to tell from ordinary words', () => {
      process.env.INPUT_GEMINI_API_KEY = 'short';
      expect(redactSecrets('a short reply')).toBe('a short reply');
    });

    it('redacts each line of a multi-line value, but not the armor lines of a private key', () => {
      registerSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecretline\n-----END RSA PRIVATE KEY-----');
      expect(redactSecrets('the line MIIEpAIBAAKCAQEAsecretline leaked')).toBe('the line [REDACTED] leaked');
      expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----')).toBe('-----BEGIN RSA PRIVATE KEY-----');
    });

    // Only the characters that also encode `x-access-token:`, the prefix or the token's last partial group are kept.
    it.each([
      ['', 'eC1hY2Nlc3MtdG9rZW46[REDACTED]ZW4='],
      ['a', 'eC1hY2Nlc3MtdG9rZW46YW[REDACTED]'],
      ['ab', 'eC1hY2Nlc3MtdG9rZW46YWJ[REDACTED]bg=='],
    ])('redacts a value inside base64 text after the prefix %p', (prefix, expected) => {
      registerSecret('ghs_checkoutHeaderToken');
      const header = Buffer.from(`x-access-token:${prefix}ghs_checkoutHeaderToken`).toString('base64');
      expect(redactSecrets(`AUTHORIZATION: basic ${header}`)).toBe(`AUTHORIZATION: basic ${expected}`);
    });
  });

  describe('sanitizeTokens', () => {
    it('redacts ghp_ tokens', () => {
      expect(sanitizeTokens('token: ghp_ABCDEF123')).toBe('token: [REDACTED]');
    });

    it('redacts ghs_ tokens, including stateless JWT-format ones', () => {
      expect(sanitizeTokens('ghs_ABCDEF123')).toBe('[REDACTED]');
      expect(sanitizeTokens('auth ghs_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2ln-YXR1cmVfXw failed')).toBe('auth [REDACTED] failed');
    });

    it('redacts ghu_ and ghr_ tokens', () => {
      expect(sanitizeTokens('ghu_ABCDEF123 ghr_ABCDEF456')).toBe('[REDACTED] [REDACTED]');
    });

    it('redacts gho_ tokens', () => {
      expect(sanitizeTokens('gho_ABCDEF123')).toBe('[REDACTED]');
    });

    it('redacts github_pat_ tokens', () => {
      expect(sanitizeTokens('github_pat_ABCDEF123')).toBe('[REDACTED]');
    });

    it('redacts tokens embedded in URLs', () => {
      expect(sanitizeTokens('https://x:ghp_TOKEN@host')).toBe('https://x:[REDACTED]@host');
    });

    it('leaves strings with no token unchanged', () => {
      expect(sanitizeTokens('no token here')).toBe('no token here');
    });

    it('redacts multiple tokens in one string', () => {
      const result = sanitizeTokens('a=ghp_TOKEN1 b=ghs_TOKEN2');
      expect(result).toBe('a=[REDACTED] b=[REDACTED]');
    });
  });

  describe('withMarkers', () => {
    it('keeps the body first and puts each marker on its own line after a blank line', () => {
      expect(withMarkers('**Done.**', '<!-- a -->', '<!-- b -->')).toBe('**Done.**\n\n<!-- a -->\n<!-- b -->');
    });
  });
});

describe('mapWithConcurrency', () => {
  it('keeps the order and runs at most `limit` calls at once', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async n => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
    expect(await mapWithConcurrency([], 4, async n => n)).toEqual([]);
  });

  it('starts no further call after one rejects', async () => {
    const started: number[] = [];
    await expect(mapWithConcurrency([1, 2, 3, 4, 5], 2, async n => {
      started.push(n);
      if (n === 1) throw new Error('slice 1 failed');
      await new Promise(resolve => setTimeout(resolve, 5));
      return n;
    })).rejects.toThrow('slice 1 failed');
    expect(started).toEqual([1, 2]);
  });
});
