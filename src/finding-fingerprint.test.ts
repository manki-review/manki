import { indexThreadEvaluations, isPriorAddressedByJudge } from './finding-fingerprint';
import { makeFindingFingerprintEntry } from './test-utils';
import { ThreadEvaluation } from './types';

const makeEval = (threadId: string, status: ThreadEvaluation['status']): ThreadEvaluation => ({
  threadId,
  status,
  reason: 'test',
});

describe('indexThreadEvaluations', () => {
  it('returns an empty Map for an empty array', () => {
    expect(indexThreadEvaluations([])).toEqual(new Map());
  });

  it('returns an empty Map for undefined input', () => {
    expect(indexThreadEvaluations(undefined)).toEqual(new Map());
  });

  it('indexes entries by threadId', () => {
    const a = makeEval('t1', 'addressed');
    const b = makeEval('t2', 'not_addressed');
    const result = indexThreadEvaluations([a, b]);
    expect(result.size).toBe(2);
    expect(result.get('t1')).toBe(a);
    expect(result.get('t2')).toBe(b);
  });

  it('last entry wins on duplicate threadId', () => {
    const first = makeEval('t1', 'not_addressed');
    const last = makeEval('t1', 'addressed');
    const result = indexThreadEvaluations([first, last]);
    expect(result.size).toBe(1);
    expect(result.get('t1')).toBe(last);
  });
});

describe('isPriorAddressedByJudge', () => {
  it('returns true when status is addressed', () => {
    const map = new Map([['t1', makeEval('t1', 'addressed')]]);
    const prior = makeFindingFingerprintEntry({ threadId: 't1' });
    expect(isPriorAddressedByJudge(prior, map)).toBe(true);
  });

  it('returns false when status is not_addressed', () => {
    const map = new Map([['t1', makeEval('t1', 'not_addressed')]]);
    const prior = makeFindingFingerprintEntry({ threadId: 't1' });
    expect(isPriorAddressedByJudge(prior, map)).toBe(false);
  });

  it('returns false when status is uncertain', () => {
    const map = new Map([['t1', makeEval('t1', 'uncertain')]]);
    const prior = makeFindingFingerprintEntry({ threadId: 't1' });
    expect(isPriorAddressedByJudge(prior, map)).toBe(false);
  });

  it('returns false when prior has no threadId', () => {
    const map = new Map([['t1', makeEval('t1', 'addressed')]]);
    const prior = makeFindingFingerprintEntry();
    expect(isPriorAddressedByJudge(prior, map)).toBe(false);
  });

  it('returns false when no matching entry in map', () => {
    const map = new Map([['t2', makeEval('t2', 'addressed')]]);
    const prior = makeFindingFingerprintEntry({ threadId: 't1' });
    expect(isPriorAddressedByJudge(prior, map)).toBe(false);
  });
});
