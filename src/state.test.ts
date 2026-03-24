import { areAllBlockingResolved, ReviewThread } from './state';

const makeThread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'thread-1',
  isResolved: false,
  isBlocking: false,
  findingTitle: 'Test finding',
  ...overrides,
});

describe('areAllBlockingResolved', () => {
  it('returns true when there are no blocking threads', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: false, isResolved: false }),
      makeThread({ id: '2', isBlocking: false, isResolved: true }),
    ];
    expect(areAllBlockingResolved(threads)).toBe(true);
  });

  it('returns true when all blocking threads are resolved', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: true, isResolved: true }),
      makeThread({ id: '2', isBlocking: true, isResolved: true }),
    ];
    expect(areAllBlockingResolved(threads)).toBe(true);
  });

  it('returns false when some blocking threads are unresolved', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: true, isResolved: true }),
      makeThread({ id: '2', isBlocking: true, isResolved: false }),
    ];
    expect(areAllBlockingResolved(threads)).toBe(false);
  });

  it('returns true when blocking threads are resolved and suggestions are not', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: true, isResolved: true }),
      makeThread({ id: '2', isBlocking: false, isResolved: false }),
      makeThread({ id: '3', isBlocking: false, isResolved: false }),
    ];
    expect(areAllBlockingResolved(threads)).toBe(true);
  });

  it('returns true for an empty array', () => {
    expect(areAllBlockingResolved([])).toBe(true);
  });
});
