import { truncate, formatDuration, safeJsonParse } from './utils';

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
});
