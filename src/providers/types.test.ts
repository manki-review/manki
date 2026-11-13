import { addUsage, readCount, ZERO_USAGE } from './types';

describe('readCount', () => {
  it('returns a finite non-negative integer for a positive number', () => {
    expect(readCount(42)).toBe(42);
  });

  it('truncates fractional numbers', () => {
    expect(readCount(7.9)).toBe(7);
  });

  it('returns 0 for a negative number', () => {
    expect(readCount(-1)).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(readCount(NaN)).toBe(0);
  });

  it('returns 0 for Infinity', () => {
    expect(readCount(Infinity)).toBe(0);
  });

  it('parses a valid numeric string', () => {
    expect(readCount('100')).toBe(100);
  });

  it('truncates a fractional numeric string', () => {
    expect(readCount('3.7')).toBe(3);
  });

  it('returns 0 for a non-numeric string', () => {
    expect(readCount('abc')).toBe(0);
  });

  it('returns 0 for a negative numeric string', () => {
    expect(readCount('-5')).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(readCount(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(readCount(undefined)).toBe(0);
  });

  it('returns 0 for an object', () => {
    expect(readCount({})).toBe(0);
  });

  it('returns 0 for zero', () => {
    expect(readCount(0)).toBe(0);
  });
});

describe('addUsage', () => {
  it('sums all fields from two non-zero operands', () => {
    const a = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 1 };
    const b = { inputTokens: 3, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 4 };
    expect(addUsage(a, b)).toEqual({ inputTokens: 13, outputTokens: 12, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 5 });
  });

  it('sums the 1-hour cache writes when either operand reports them, and leaves them out otherwise', () => {
    const a = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 6, reasoningTokens: 0, cacheWrite1hTokens: 4 };
    expect(addUsage(a, { ...a, cacheWrite1hTokens: 1 }).cacheWrite1hTokens).toBe(5);
    expect(addUsage(ZERO_USAGE, a).cacheWrite1hTokens).toBe(4);
    expect(addUsage(a, ZERO_USAGE).cacheWrite1hTokens).toBe(4);
    expect(addUsage(ZERO_USAGE, ZERO_USAGE)).not.toHaveProperty('cacheWrite1hTokens');
  });

  it('returns a copy equal to the non-zero operand when adding ZERO_USAGE', () => {
    const a = { inputTokens: 8, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 2 };
    expect(addUsage(a, ZERO_USAGE)).toEqual(a);
    expect(addUsage(ZERO_USAGE, a)).toEqual(a);
  });

  it('returns ZERO_USAGE values when both operands are zero', () => {
    expect(addUsage(ZERO_USAGE, ZERO_USAGE)).toEqual(ZERO_USAGE);
  });

  it('does not mutate either operand', () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 4 };
    const b = { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 0, reasoningTokens: 8 };
    const aCopy = { ...a };
    const bCopy = { ...b };
    addUsage(a, b);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });

  it('returns a new object each call', () => {
    const result1 = addUsage(ZERO_USAGE, ZERO_USAGE);
    const result2 = addUsage(ZERO_USAGE, ZERO_USAGE);
    expect(result1).not.toBe(result2);
  });
});
