import { readFileSync } from 'fs';

import { DEFAULT_CONFIG, GROUP_REVIEWER_KEYS, KNOWN_KEYS, MODEL_KEYS, RELATED_REPO_KEYS, REVIEW_KEYS } from '../src/config';
import { ANALYZERS } from '../src/types';
import { REFERENCE_PATH, SETTINGS, withReference } from './config-reference';

/** Returns the path of every value in `value` that is not a map with keys, such as `models.judge`. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('configuration reference', () => {
  const documented = SETTINGS.map(s => s.key);

  it('documents every config key, and no key the config does not accept', () => {
    const accepted = new Set([
      ...KNOWN_KEYS,
      ...leafPaths(DEFAULT_CONFIG),
      ...[...MODEL_KEYS].map(k => `models.${k}`),
      ...[...REVIEW_KEYS].map(k => `review.${k}`),
      ...[...GROUP_REVIEWER_KEYS].map(k => `review.groups.<name>.reviewers[].${k}`),
      ...[...RELATED_REPO_KEYS].map(k => `related_repos[].${k}`),
      ...ANALYZERS.map(a => `static_analysis.analyzers.${a}`),
      // Nested keys `validateConfig` checks one by one, which no exported set lists.
      'metrics.fix_rate', 'reviewers[].name', 'reviewers[].focus',
    ]);
    expect([...accepted].filter(key => !documented.includes(key))).toEqual([]);
    expect(documented.filter(key => !accepted.has(key))).toEqual([]);
    expect(documented.filter((key, i) => documented.indexOf(key) !== i)).toEqual([]);
  });

  it('matches `docs/configuration.md`, so run `npm run config-reference` after a change', () => {
    const page = readFileSync(REFERENCE_PATH, 'utf-8');
    expect(page).toBe(withReference(page));
  });
});
