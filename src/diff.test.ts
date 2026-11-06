import {
  changeDigest,
  parsePRDiff,
  filterDiff,
  filterFilesWithAttribution,
  filterRawDiff,
  isLineInDiff,
  isDiffTooLarge,
  isSameChange,
  rebuildRawDiff,
  tagFindingOrigins,
} from './diff';
import { DEFAULT_CONFIG } from './config';
import { DiffFile, Finding, ParsedDiff } from './types';

// -- Test fixtures --

const SIMPLE_DIFF = `diff --git a/src/main.ts b/src/main.ts
index abc1234..def5678 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -10,6 +10,8 @@ function main() {
   const x = 1;
   const y = 2;
+  const z = 3;
+  console.log(z);
   return x + y;
 }
`;

const MULTI_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,3 +5,4 @@ export function b() {
   return 1;
+  return 2;
 }
`;

const ADDED_FILE_DIFF = `diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,5 @@
+export function hello() {
+  console.log('hello');
+}
+
+export default hello;
`;

const DELETED_FILE_DIFF = `diff --git a/src/old-file.ts b/src/old-file.ts
deleted file mode 100644
index abcdef1..0000000
--- a/src/old-file.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function goodbye() {
-  console.log('goodbye');
-}
`;

const RENAMED_FILE_DIFF = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 90%
rename from src/old-name.ts
rename to src/new-name.ts
index abc1234..def5678 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,4 @@
 export function renamed() {
+  // this was renamed
   return true;
 }
`;

const BINARY_FILE_DIFF = `diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..abcdef1
Binary files /dev/null and b/assets/logo.png differ
`;

const MULTIPLE_HUNKS_DIFF = [
  'diff --git a/src/utils.ts b/src/utils.ts',
  'index abc1234..def5678 100644',
  '--- a/src/utils.ts',
  '+++ b/src/utils.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' const c = 3;',
  ' const d = 4;',
  '@@ -20,3 +21,4 @@',
  ' const x = 10;',
  '+const y = 20;',
  ' const z = 30;',
  ' const w = 40;',
].join('\n');

const GENERATED_FIRST_DIFF = `diff --git a/dist/index.js.map b/dist/index.js.map
index 1111111..2222222 100644
--- a/dist/index.js.map
+++ b/dist/index.js.map
@@ -1 +1 @@
-{"version":3}
+{"version":3,"mappings":"${'A'.repeat(200000)}"}
${MULTI_FILE_DIFF}`;

// -- Tests --

describe('parsePRDiff', () => {
  it('parses a simple one-file diff', () => {
    const result = parsePRDiff(SIMPLE_DIFF);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/main.ts');
    expect(result.files[0].changeType).toBe('modified');
    expect(result.files[0].hunks).toHaveLength(1);
    expect(result.totalAdditions).toBe(2);
    expect(result.totalDeletions).toBe(0);
  });

  it('parses a multi-file diff', () => {
    const result = parsePRDiff(MULTI_FILE_DIFF);

    expect(result.files).toHaveLength(2);
    expect(result.files[0].path).toBe('src/a.ts');
    expect(result.files[1].path).toBe('src/b.ts');
    expect(result.totalAdditions).toBe(2);
    expect(result.totalDeletions).toBe(0);
  });

  it('detects added files', () => {
    const result = parsePRDiff(ADDED_FILE_DIFF);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/new-file.ts');
    expect(result.files[0].changeType).toBe('added');
    expect(result.files[0].oldPath).toBeUndefined();
    expect(result.totalAdditions).toBe(5);
  });

  it('detects deleted files', () => {
    const result = parsePRDiff(DELETED_FILE_DIFF);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/old-file.ts');
    expect(result.files[0].changeType).toBe('deleted');
    expect(result.files[0].oldPath).toBe('src/old-file.ts');
    expect(result.totalDeletions).toBe(3);
  });

  it('detects renamed files', () => {
    const result = parsePRDiff(RENAMED_FILE_DIFF);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/new-name.ts');
    expect(result.files[0].changeType).toBe('renamed');
    expect(result.files[0].oldPath).toBe('src/old-name.ts');
  });

  it('skips binary files', () => {
    const result = parsePRDiff(BINARY_FILE_DIFF);

    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);
  });

  it('records binary-skipped paths for attribution', () => {
    const result = parsePRDiff(BINARY_FILE_DIFF);
    expect(result.binarySkipped).toEqual(['assets/logo.png']);
  });

  it('returns an empty `binarySkipped` array when no binaries are present', () => {
    const result = parsePRDiff(SIMPLE_DIFF);
    expect(result.binarySkipped).toEqual([]);
  });

  it('returns empty result for empty diff', () => {
    const result = parsePRDiff('');

    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);
  });

  it('returns empty result for whitespace-only diff', () => {
    const result = parsePRDiff('   \n\n  ');

    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);
  });

  it('parses hunks with correct start/lines values', () => {
    const result = parsePRDiff(SIMPLE_DIFF);
    const hunk = result.files[0].hunks[0];

    expect(hunk.oldStart).toBe(10);
    expect(hunk.oldLines).toBe(6);
    expect(hunk.newStart).toBe(10);
    expect(hunk.newLines).toBe(8);
    expect(hunk.content).toContain('const z = 3');
  });

  it('parses multiple hunks per file', () => {
    const result = parsePRDiff(MULTIPLE_HUNKS_DIFF);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].hunks).toHaveLength(2);
    expect(result.files[0].hunks[0].newStart).toBe(1);
    expect(result.files[0].hunks[1].newStart).toBe(21);
  });
});

describe('filterFilesWithAttribution patterns', () => {
  const files: DiffFile[] = [
    { path: 'src/main.ts', changeType: 'modified', hunks: [] },
    { path: 'src/utils.ts', changeType: 'modified', hunks: [] },
    { path: 'tests/main.test.ts', changeType: 'modified', hunks: [] },
    { path: 'docs/README.md', changeType: 'modified', hunks: [] },
    { path: 'package.json', changeType: 'modified', hunks: [] },
    { path: 'dist/index.js', changeType: 'modified', hunks: [] },
  ];

  it('returns all files when no exclude patterns specified', () => {
    const result = filterFilesWithAttribution(files, []).included;
    expect(result).toHaveLength(6);
  });

  it('filters by exclude patterns', () => {
    const result = filterFilesWithAttribution(files, ['dist/**']).included;
    expect(result).toHaveLength(5);
    expect(result.map((f) => f.path)).not.toContain('dist/index.js');
  });

  it('applies multiple exclude patterns', () => {
    const result = filterFilesWithAttribution(files, ['tests/**', 'dist/**']).included;
    expect(result).toHaveLength(4);
    expect(result.map((f) => f.path)).not.toContain('tests/main.test.ts');
    expect(result.map((f) => f.path)).not.toContain('dist/index.js');
  });

  it('supports matchBase for patterns without slashes', () => {
    const result = filterFilesWithAttribution(files, ['*.json']).included;
    expect(result).toHaveLength(5);
    expect(result.map((f) => f.path)).not.toContain('package.json');
  });

  it('excludes dotfiles when pattern targets them', () => {
    const dotfiles: DiffFile[] = [
      { path: '.env', changeType: 'modified', hunks: [] },
      { path: '.gitignore', changeType: 'modified', hunks: [] },
      { path: 'src/main.ts', changeType: 'modified', hunks: [] },
    ];
    const result = filterFilesWithAttribution(dotfiles, ['.*']).included;
    expect(result.map((f) => f.path)).toEqual(['src/main.ts']);
  });

  it('includes dotfiles when no exclude pattern targets them', () => {
    const dotfiles: DiffFile[] = [
      { path: '.manki.yml', changeType: 'modified', hunks: [] },
      { path: '.github/workflows/ci.yml', changeType: 'modified', hunks: [] },
      { path: '.gitignore', changeType: 'modified', hunks: [] },
      { path: 'src/main.ts', changeType: 'modified', hunks: [] },
    ];
    const result = filterFilesWithAttribution(dotfiles, []).included;
    expect(result).toHaveLength(4);
    expect(result.map((f) => f.path)).toContain('.manki.yml');
    expect(result.map((f) => f.path)).toContain('.github/workflows/ci.yml');
    expect(result.map((f) => f.path)).toContain('.gitignore');
  });
});

describe('filterFilesWithAttribution', () => {
  const files: DiffFile[] = [
    { path: 'src/main.ts', changeType: 'modified', hunks: [] },
    { path: 'dist/index.js', changeType: 'modified', hunks: [] },
    { path: 'tests/main.test.ts', changeType: 'modified', hunks: [] },
    { path: 'package.json', changeType: 'modified', hunks: [] },
  ];

  it('records the matched pattern for each excluded file', () => {
    const result = filterFilesWithAttribution(files, ['dist/**', 'tests/**']);
    expect(result.included.map(f => f.path)).toEqual(['src/main.ts', 'package.json']);
    expect(result.excluded).toEqual([
      { path: 'dist/index.js', matchedPattern: 'dist/**' },
      { path: 'tests/main.test.ts', matchedPattern: 'tests/**' },
    ]);
  });

  it('records the FIRST matching pattern when multiple patterns would match the same path', () => {
    const result = filterFilesWithAttribution(files, ['*.js', 'dist/**']);
    expect(result.excluded).toEqual([
      { path: 'dist/index.js', matchedPattern: '*.js' },
    ]);
  });

  it('returns empty `excluded` and the full `included` list when no patterns match', () => {
    const result = filterFilesWithAttribution(files, ['nothing/**']);
    expect(result.included).toHaveLength(files.length);
    expect(result.excluded).toEqual([]);
  });
});

describe('filterDiff', () => {
  it('drops excluded files and their lines from the totals', () => {
    const { diff, excluded } = filterDiff(parsePRDiff(GENERATED_FIRST_DIFF), DEFAULT_CONFIG.exclude_paths);
    expect(diff.files.map(f => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(excluded).toEqual([{ path: 'dist/index.js.map', matchedPattern: 'dist/**' }]);
    expect(diff.totalAdditions).toBe(2);
    expect(diff.totalDeletions).toBe(0);
    expect(isDiffTooLarge(diff, 2)).toBe(false);
  });
});

describe('filterRawDiff', () => {
  it('removes excluded files and keeps the hunks of every other file', () => {
    const result = filterRawDiff(GENERATED_FIRST_DIFF, DEFAULT_CONFIG.exclude_paths);
    expect(result).not.toContain('dist/index.js.map');
    expect(result).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(result).toContain('+added line');
    expect(result).toContain('+  return 2;');
  });

  it('returns an empty string for an empty diff or one with only excluded files', () => {
    expect(filterRawDiff('', DEFAULT_CONFIG.exclude_paths)).toBe('');
    expect(filterRawDiff(GENERATED_FIRST_DIFF, ['dist/**', 'src/**'])).toBe('');
  });
});

describe('isSameChange', () => {
  it('ignores hunk positions, index lines and excluded files', () => {
    const excluded = DEFAULT_CONFIG.exclude_paths;
    expect(changeDigest(filterDiff(parsePRDiff(GENERATED_FIRST_DIFF), excluded).diff, excluded)).toBe(changeDigest(parsePRDiff(MULTI_FILE_DIFF), excluded));
    const rebased = MULTI_FILE_DIFF
      .replace('index 1111111..2222222', 'index 5555555..6666666')
      .replace('@@ -5,3 +5,4 @@ export function b() {', '@@ -42,3 +57,4 @@ export function moved() {');
    expect(isSameChange(MULTI_FILE_DIFF, rebased, [])).toBe(true);
    expect(isSameChange(MULTI_FILE_DIFF, GENERATED_FIRST_DIFF, DEFAULT_CONFIG.exclude_paths)).toBe(true);
    expect(isSameChange(MULTI_FILE_DIFF, `${BINARY_FILE_DIFF}${MULTI_FILE_DIFF}`, ['assets/**'])).toBe(true);
  });

  it('detects a changed line, an added file or a changed context line', () => {
    expect(isSameChange(MULTI_FILE_DIFF, MULTI_FILE_DIFF.replace('+added line', '+edited line'), [])).toBe(false);
    expect(isSameChange(MULTI_FILE_DIFF, `${MULTI_FILE_DIFF}${ADDED_FILE_DIFF}`, [])).toBe(false);
    expect(isSameChange(MULTI_FILE_DIFF, MULTI_FILE_DIFF.replace(' line2', ' line2 from base'), [])).toBe(false);
    expect(isSameChange(MULTI_FILE_DIFF, GENERATED_FIRST_DIFF, [])).toBe(false);
    expect(isSameChange(MULTI_FILE_DIFF, `${BINARY_FILE_DIFF}${MULTI_FILE_DIFF}`, [])).toBe(false);
  });
});

describe('tagFindingOrigins', () => {
  const change = (path: string, start: number, lines: string[], oldPath?: string): string =>
    `diff --git a/${oldPath ?? path} b/${path}\n--- a/${oldPath ?? path}\n+++ b/${path}\n@@ -${start},1 +${start},${lines.length + 1} @@\n ctx\n${lines.map(l => `+${l}`).join('\n')}\n`;
  const finding = (file: string, line: number): Finding => ({ severity: 'suggestion', title: 't', file, line, description: 'd', reviewers: [] });
  const tag = (findings: Finding[], current: string, prior?: string) => {
    tagFindingOrigins(findings, parsePRDiff(current), prior === undefined ? undefined : parsePRDiff(prior));
    return findings.map(f => f.origin);
  };

  it('tags every finding new without an earlier change, as on a first or full review', () => {
    expect(tag([finding('src/a.ts', 11), finding('src/b.ts', 1), finding('', 0)], change('src/a.ts', 10, ['x']))).toEqual(['new', 'new', 'new']);
  });

  it('compares added lines by text, so a rebase that moves them keeps them reviewed', () => {
    const prior = change('src/a.ts', 10, ['one', 'two', 'three']);
    const rebased = change('src/a.ts', 40, ['one', 'two', 'three']);
    expect(tag([finding('src/a.ts', 42), finding('src/b.ts', 3)], rebased, prior)).toEqual(['reviewed', 'reviewed']);
  });

  it('tags a finding new within three lines of a line added since, and on a renamed file by its old path', () => {
    const prior = `${change('src/a.ts', 10, ['one', 'two'])}${change('src/old.ts', 1, ['kept'])}`;
    const current = `${change('src/a.ts', 10, ['one', 'two', 'fresh', 'two'])}${change('src/new.ts', 1, ['kept'], 'src/old.ts')}`;
    // `fresh` is line 13 and the second `two` line 14, a duplicate the prior change added once.
    expect(tag([
      finding('src/a.ts', 16), finding('src/a.ts', 18), finding('src/a.ts', 10), finding('src/a.ts', 0), finding('src/new.ts', 2), finding('src/new.ts', 0),
    ], current, prior)).toEqual(['new', 'reviewed', 'new', 'new', 'reviewed', 'reviewed']);
  });

  it('tags a finding new near code removed or restored since: a base line the PR removed or put back, or a line it added before and dropped', () => {
    const removal = (path: string, start: number, removed: string, kept: string[]): string =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${start},${kept.length + 2} +${start},${kept.length + 1} @@\n ctx\n-${removed}\n${kept.map(l => ` ${l}`).join('\n')}\n`;
    const prior = change('src/a.ts', 10, ['guard', 'body']);
    // The PR now also removes `if (!user) return;` from the base, which sits at line 11 of the new file.
    const removesBaseLine = `${change('src/a.ts', 10, ['guard', 'body'])}${removal('src/b.ts', 10, 'if (!user) return;', ['use(user);'])}`;
    expect(tag([finding('src/b.ts', 11), finding('src/b.ts', 20)], removesBaseLine, prior)).toEqual(['new', 'reviewed']);

    // The PR dropped its own `guard` line. Only the diff between the two commits says where it was.
    const droppedOwnLine = change('src/a.ts', 10, ['body']);
    const interRound = removal('src/a.ts', 10, 'guard', ['body']);
    const findings = [finding('src/a.ts', 11)];
    tagFindingOrigins(findings, parsePRDiff(droppedOwnLine), parsePRDiff(prior), parsePRDiff(interRound));
    expect(findings[0].origin).toBe('new');
    expect(tag([finding('src/a.ts', 11)], droppedOwnLine, prior)).toEqual(['reviewed']);

    // The PR puts back a base line it removed before, so `src/b.ts` drops out of its change.
    const priorRemoval = removal('src/b.ts', 10, 'if (!user) return;', ['use(user);']);
    const restored = change('src/b.ts', 10, ['if (!user) return;']);
    const restoredFindings = [finding('src/b.ts', 11), finding('src/b.ts', 30)];
    tagFindingOrigins(restoredFindings, parsePRDiff(change('src/a.ts', 10, ['x'])), parsePRDiff(priorRemoval), parsePRDiff(restored));
    expect(restoredFindings.map(f => f.origin)).toEqual(['new', 'reviewed']);
  });
});

describe('rebuildRawDiff', () => {
  it('rebuilds a diff string from parsed files', () => {
    const diff: ParsedDiff = {
      files: [
        {
          path: 'src/foo.ts',
          changeType: 'modified',
          hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, content: '+new line' }],
        },
      ],
      totalAdditions: 1,
      totalDeletions: 0,
    };
    const raw = rebuildRawDiff(diff);
    expect(raw).toContain('diff --git a/src/foo.ts b/src/foo.ts');
    expect(raw).toContain('@@ -1,3 +1,4 @@');
    expect(raw).toContain('+new line');
  });

  it('handles multiple files in order', () => {
    const diff: ParsedDiff = {
      files: [
        { path: 'a.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: '+a' }] },
        { path: 'b.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: '+b' }] },
      ],
      totalAdditions: 2,
      totalDeletions: 0,
    };
    const raw = rebuildRawDiff(diff);
    const aIdx = raw.indexOf('a/a.ts');
    const bIdx = raw.indexOf('a/b.ts');
    expect(aIdx).toBeLessThan(bIdx);
  });

  it('keeps the old path and `/dev/null` sides of added, deleted and renamed files', () => {
    const raw = rebuildRawDiff(parsePRDiff(ADDED_FILE_DIFF + DELETED_FILE_DIFF + RENAMED_FILE_DIFF));
    expect(raw).toContain('diff --git a/src/new-file.ts b/src/new-file.ts\n--- /dev/null\n+++ b/src/new-file.ts\n');
    expect(raw).toContain('diff --git a/src/old-file.ts b/src/old-file.ts\n--- a/src/old-file.ts\n+++ /dev/null\n');
    expect(raw).toContain('diff --git a/src/old-name.ts b/src/new-name.ts\n--- a/src/old-name.ts\n+++ b/src/new-name.ts\n');
  });
});

describe('isLineInDiff', () => {
  const file: DiffFile = {
    path: 'src/utils.ts',
    changeType: 'modified',
    hunks: [
      { oldStart: 5, oldLines: 3, newStart: 5, newLines: 4, content: '' },
      { oldStart: 20, oldLines: 3, newStart: 21, newLines: 4, content: '' },
    ],
  };

  it('returns true for line at hunk start', () => {
    expect(isLineInDiff(file, 5)).toBe(true);
  });

  it('returns true for line at hunk end', () => {
    expect(isLineInDiff(file, 8)).toBe(true); // 5 + 4 - 1
  });

  it('returns true for line inside hunk', () => {
    expect(isLineInDiff(file, 7)).toBe(true);
  });

  it('returns false for line outside all hunks', () => {
    expect(isLineInDiff(file, 15)).toBe(false);
  });

  it('returns true for line in second hunk', () => {
    expect(isLineInDiff(file, 22)).toBe(true);
  });

  it('returns false for line before first hunk', () => {
    expect(isLineInDiff(file, 1)).toBe(false);
  });
});

describe('isDiffTooLarge', () => {
  const makeFile = (path: string, additions: number, deletions: number): DiffFile => ({
    path,
    changeType: 'modified',
    hunks: [],
    additions,
    deletions,
  });

  it('returns false when diff is within limit', () => {
    const diff = {
      files: [makeFile('src/main.ts', 100, 50)],
      totalAdditions: 100,
      totalDeletions: 50,
    };
    expect(isDiffTooLarge(diff, 200)).toBe(false);
  });

  it('returns true when diff exceeds limit', () => {
    const diff = {
      files: [makeFile('src/main.ts', 500, 600)],
      totalAdditions: 500,
      totalDeletions: 600,
    };
    expect(isDiffTooLarge(diff, 1000)).toBe(true);
  });

  it('returns false when diff exactly equals limit', () => {
    const diff = {
      files: [makeFile('src/main.ts', 50, 50)],
      totalAdditions: 50,
      totalDeletions: 50,
    };
    expect(isDiffTooLarge(diff, 100)).toBe(false);
  });

  it('returns true for empty max', () => {
    const diff = {
      files: [makeFile('src/main.ts', 1, 0)],
      totalAdditions: 1,
      totalDeletions: 0,
    };
    expect(isDiffTooLarge(diff, 0)).toBe(true);
  });
});
