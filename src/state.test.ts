import { areAllRequiredResolved, ReviewThread } from './state';

const makeThread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'thread-1',
  isResolved: false,
  isRequired: false,
  findingTitle: 'Test finding',
  ...overrides,
});

describe('areAllRequiredResolved', () => {
  it('returns true when there are no required threads', () => {
    const threads = [
      makeThread({ id: '1', isRequired: false, isResolved: false }),
      makeThread({ id: '2', isRequired: false, isResolved: true }),
    ];
    expect(areAllRequiredResolved(threads)).toBe(true);
  });

  it('returns true when all required threads are resolved', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: true, isResolved: true }),
    ];
    expect(areAllRequiredResolved(threads)).toBe(true);
  });

  it('returns false when some required threads are unresolved', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: true, isResolved: false }),
    ];
    expect(areAllRequiredResolved(threads)).toBe(false);
  });

  it('returns true when required threads are resolved and suggestions are not', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: false, isResolved: false }),
      makeThread({ id: '3', isRequired: false, isResolved: false }),
    ];
    expect(areAllRequiredResolved(threads)).toBe(true);
  });

  it('returns true for an empty array', () => {
    expect(areAllRequiredResolved([])).toBe(true);
  });
});
