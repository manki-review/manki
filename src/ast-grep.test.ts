import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import * as core from '@actions/core';
import * as napi from '@ast-grep/napi';
import python from '@ast-grep/lang-python';

import { isAstGrepFile, runAstGrep } from './ast-grep';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

const FIXTURES = join(__dirname, '..', 'rules', 'ast-grep', 'fixtures');

napi.registerDynamicLanguage({ python });

/** Returns `line rule-id` for every `expect:` marker in a fixture, one entry per rule id the marker names. */
function expectedResults(content: string): string[] {
  return content.split('\n').flatMap((text, index) => {
    const marker = /expect: (.+)$/.exec(text);
    return marker ? marker[1].trim().split(/\s+/).map(id => `${index + 1} ${id}`) : [];
  });
}

describe('runAstGrep', () => {
  it.each(readdirSync(FIXTURES))('reports exactly the results %s marks', name => {
    const content = readFileSync(join(FIXTURES, name), 'utf-8');

    const signals = runAstGrep(napi, new Map([[`src/${name}`, content]]));

    expect(signals.map(s => `${s.line} ${s.ruleId}`).sort()).toEqual(expectedResults(content).sort());
    for (const s of signals) {
      expect(s).toEqual(expect.objectContaining({ tool: 'ast-grep', file: `src/${name}`, source: 'ast_grep' }));
      expect(s.message.length).toBeGreaterThan(0);
    }
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('maps rule severities and skips files it has no grammar for', () => {
    const files = new Map([
      ['a.ts', 'if (x === NaN) {}\nlist.forEach(async (a) => a);\n'],
      ['b.py', 'if x == None:\n    pass\n'],
      ['c.go', 'eval(x)\n'],
    ]);

    expect(runAstGrep(napi, files).map(s => [s.file, s.ruleId, s.severity])).toEqual([
      ['a.ts', 'async-foreach-callback', 'warning'],
      ['a.ts', 'nan-comparison', 'error'],
      ['b.py', 'python-none-equality', 'note'],
    ]);
    expect(['x.ts', 'x.MTS', 'x.cjs', 'x.jsx', 'x.py'].every(isAstGrepFile)).toBe(true);
    expect(['x.go', 'Makefile', 'x.ts.snap'].some(isAstGrepFile)).toBe(false);
  });
});
