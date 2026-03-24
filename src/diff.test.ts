import {
  parsePRDiff,
  filterFiles,
  isLineInDiff,
  findClosestDiffLine,
  isDiffTooLarge,
} from './diff';
import { DiffFile } from './types';

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

describe('filterFiles', () => {
  const files: DiffFile[] = [
    { path: 'src/main.ts', changeType: 'modified', hunks: [] },
    { path: 'src/utils.ts', changeType: 'modified', hunks: [] },
    { path: 'tests/main.test.ts', changeType: 'modified', hunks: [] },
    { path: 'docs/README.md', changeType: 'modified', hunks: [] },
    { path: 'package.json', changeType: 'modified', hunks: [] },
    { path: 'dist/index.js', changeType: 'modified', hunks: [] },
  ];

  it('returns all files when no patterns specified', () => {
    const result = filterFiles(files, [], []);
    expect(result).toHaveLength(6);
  });

  it('filters by include patterns', () => {
    const result = filterFiles(files, ['src/**/*.ts'], []);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.path)).toEqual(['src/main.ts', 'src/utils.ts']);
  });

  it('filters by exclude patterns', () => {
    const result = filterFiles(files, [], ['dist/**']);
    expect(result).toHaveLength(5);
    expect(result.map((f) => f.path)).not.toContain('dist/index.js');
  });

  it('applies both include and exclude patterns', () => {
    const result = filterFiles(files, ['**/*.ts'], ['tests/**']);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.path)).toEqual(['src/main.ts', 'src/utils.ts']);
  });

  it('supports matchBase for patterns without slashes', () => {
    const result = filterFiles(files, ['*.ts'], []);
    expect(result).toHaveLength(3);
  });

  it('handles multiple include patterns with OR semantics', () => {
    const result = filterFiles(files, ['*.ts', '*.md'], []);
    expect(result).toHaveLength(4);
  });

  it('returns empty array when nothing matches include', () => {
    const result = filterFiles(files, ['*.py'], []);
    expect(result).toHaveLength(0);
  });

  it('excludes dotfiles when pattern targets them', () => {
    const dotfiles: DiffFile[] = [
      { path: '.env', changeType: 'modified', hunks: [] },
      { path: '.gitignore', changeType: 'modified', hunks: [] },
      { path: 'src/main.ts', changeType: 'modified', hunks: [] },
    ];
    const result = filterFiles(dotfiles, ['**/*'], ['.*']);
    expect(result.map((f) => f.path)).toEqual(['src/main.ts']);
  });

  it('includes dotfiles with default include pattern', () => {
    const dotfiles: DiffFile[] = [
      { path: '.manki.yml', changeType: 'modified', hunks: [] },
      { path: '.github/workflows/ci.yml', changeType: 'modified', hunks: [] },
      { path: '.gitignore', changeType: 'modified', hunks: [] },
      { path: 'src/main.ts', changeType: 'modified', hunks: [] },
    ];
    const result = filterFiles(dotfiles, ['**/*'], []);
    expect(result).toHaveLength(4);
    expect(result.map((f) => f.path)).toContain('.manki.yml');
    expect(result.map((f) => f.path)).toContain('.github/workflows/ci.yml');
    expect(result.map((f) => f.path)).toContain('.gitignore');
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

describe('findClosestDiffLine', () => {
  const file: DiffFile = {
    path: 'src/utils.ts',
    changeType: 'modified',
    hunks: [
      { oldStart: 5, oldLines: 3, newStart: 5, newLines: 4, content: '' },
      { oldStart: 20, oldLines: 3, newStart: 21, newLines: 4, content: '' },
    ],
  };

  it('returns exact line when it is in a hunk', () => {
    expect(findClosestDiffLine(file, 6)).toBe(6);
  });

  it('returns closest hunk line when exact line is not in diff', () => {
    // Line 10 is between hunk 1 (5-8) and hunk 2 (21-24)
    // Closest is 8 (end of first hunk)
    expect(findClosestDiffLine(file, 10)).toBe(8);
  });

  it('returns hunk start when line is before first hunk', () => {
    expect(findClosestDiffLine(file, 1)).toBe(5);
  });

  it('returns hunk end when line is after last hunk', () => {
    expect(findClosestDiffLine(file, 50)).toBe(24); // 21 + 4 - 1
  });

  it('returns null for file with no hunks', () => {
    const emptyFile: DiffFile = { path: 'empty.ts', changeType: 'modified', hunks: [] };
    expect(findClosestDiffLine(emptyFile, 10)).toBeNull();
  });

  it('picks the closer hunk when line is between two hunks', () => {
    // Line 19 is closer to hunk 2 start (21) than hunk 1 end (8)
    expect(findClosestDiffLine(file, 19)).toBe(21);
  });
});

describe('isDiffTooLarge', () => {
  it('returns false when diff is within limit', () => {
    const diff = { files: [], totalAdditions: 100, totalDeletions: 50 };
    expect(isDiffTooLarge(diff, 200)).toBe(false);
  });

  it('returns true when diff exceeds limit', () => {
    const diff = { files: [], totalAdditions: 500, totalDeletions: 600 };
    expect(isDiffTooLarge(diff, 1000)).toBe(true);
  });

  it('returns false when diff exactly equals limit', () => {
    const diff = { files: [], totalAdditions: 50, totalDeletions: 50 };
    expect(isDiffTooLarge(diff, 100)).toBe(false);
  });

  it('returns true for empty max', () => {
    const diff = { files: [], totalAdditions: 1, totalDeletions: 0 };
    expect(isDiffTooLarge(diff, 0)).toBe(true);
  });
});
