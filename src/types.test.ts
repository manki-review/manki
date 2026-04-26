import { migrateLegacySeverity } from './types';

describe('migrateLegacySeverity', () => {
  it('maps `required` to `blocker`', () => {
    expect(migrateLegacySeverity('required')).toBe('blocker');
  });

  it('maps `nit` to `nitpick`', () => {
    expect(migrateLegacySeverity('nit')).toBe('nitpick');
  });

  it.each(['blocker', 'warning', 'suggestion', 'nitpick', 'ignore'])(
    'passes through current severity `%s` unchanged',
    severity => {
      expect(migrateLegacySeverity(severity)).toBe(severity);
    },
  );

  it('passes through unknown values unchanged', () => {
    expect(migrateLegacySeverity('unknown-severity')).toBe('unknown-severity');
  });

  it('passes through the empty string unchanged', () => {
    expect(migrateLegacySeverity('')).toBe('');
  });
});
