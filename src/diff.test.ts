import { Minimatch } from 'minimatch';

import {
  closeRawDiff,
  diffSections,
  findClosedPattern,
  addCodeContext,
  changeDigest,
  onlyCommitChanging,
  parsePRDiff,
  filterDiff,
  filterFilesWithAttribution,
  filterRawDiff,
  isLineInDiff,
  firstCommentableLine,
  changesNextTo,
  oldLineOf,
  replacementOf,
  sliceDiff,
  compareChanges,
  orderDiffSections,
  ownChangeSince,
  overlongChangedLines,
  MAX_LINE_CHARS,
  MAX_SLICE_CHARS,
  rebuildRawDiff,
  listedFilesDiff,
  reviewableDiff,
  tagFindingOrigins,
  hideSeenNotes,
} from './diff';
import { DEFAULT_CONFIG } from './config';
import { citedPlaces } from './review';
import { DiffFile, Finding, ParsedDiff, ReviewResult } from './types';

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

// A changed closed file, a file renamed out of the closed folder and a closed binary, each holding the marker, then two open files.
const CLOSED_DIFF = `diff --git a/holdout/case.yml b/holdout/case.yml
index 1111111..2222222 100644
--- a/holdout/case.yml
+++ b/holdout/case.yml
@@ -1 +1 @@
-old hold-out marker
+new hold-out marker
diff --git a/holdout/moved.ts b/src/moved.ts
similarity index 50%
rename from holdout/moved.ts
rename to src/moved.ts
index 3333333..4444444 100644
--- a/holdout/moved.ts
+++ b/src/moved.ts
@@ -1,2 +1,2 @@
-const x = 'hold-out marker';
+const x = 'open';
 export { x };
diff --git a/holdout/hold-out marker.bin b/holdout/hold-out marker.bin
index 5555555..6666666 100644
Binary files a/holdout/hold-out marker.bin and b/holdout/hold-out marker.bin differ
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

  it('records each binary-skipped path with the header that names its blobs', () => {
    const result = parsePRDiff(BINARY_FILE_DIFF);
    expect(result.binarySkipped).toEqual([{ path: 'assets/logo.png', header: '["/dev/null","assets/logo.png",["0000000..abcdef1"],null,"100644"]' }]);
    const chmod = parsePRDiff('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n');
    expect(chmod.binarySkipped).toEqual([{ path: 'run.sh', header: '["run.sh","run.sh",null,"100644","100755"]' }]);
    const deleted = parsePRDiff('diff --git a/app.jar b/app.jar\ndeleted file mode 100644\nindex abcdef1..0000000\nBinary files a/app.jar and /dev/null differ\n');
    expect(deleted.binarySkipped).toEqual([expect.objectContaining({ path: 'app.jar', deleted: true })]);
  });

  it('skips a Git LFS pointer and a submodule bump as unread, but never a text file that only looks like one', () => {
    const oid = (c: string) => `oid sha256:${c.repeat(64)}`;
    const lfs = [
      'diff --git a/model.bin b/model.bin', 'index 1111111..2222222 100644', '--- a/model.bin', '+++ b/model.bin', '@@ -1,3 +1,3 @@',
      ' version https://git-lfs.github.com/spec/v1', `-${oid('a')}`, '-size 10', `+${oid('b')}`, '+size 20',
    ].join('\n');
    const submodule = [
      'diff --git a/vendor/lib b/vendor/lib', 'index 3333333..4444444 160000', '--- a/vendor/lib', '+++ b/vendor/lib', '@@ -1 +1 @@',
      `-Subproject commit ${'c'.repeat(40)}`, `+Subproject commit ${'d'.repeat(40)}`,
    ].join('\n');
    const lookalike = [
      'diff --git a/notes.txt b/notes.txt', 'index 5555555..6666666 100644', '--- a/notes.txt', '+++ b/notes.txt', '@@ -1 +1,3 @@',
      ' size 10', `+${oid('e')}`, '+and a real line',
    ].join('\n');

    const converted = [
      'diff --git a/data.csv b/data.csv', 'index 7777777..8888888 100644', '--- a/data.csv', '+++ b/data.csv', '@@ -1,2 +1,3 @@',
      '-id,name', '-1,alice', '+version https://git-lfs.github.com/spec/v1', `+${oid('f')}`, '+size 30',
    ].join('\n');

    const result = parsePRDiff(`${lfs}\n${submodule}\n${lookalike}\n${converted}\n${SIMPLE_DIFF}`);

    // A text file turned into a pointer counts too, since only its new side is checked.
    expect(result.binarySkipped).toEqual([
      expect.objectContaining({ path: 'model.bin', kind: 'lfs' }),
      expect.objectContaining({ path: 'vendor/lib', kind: 'submodule' }),
      expect.objectContaining({ path: 'data.csv', kind: 'lfs' }),
    ]);
    expect(result.files.map(f => f.path)).toEqual(['notes.txt', ...parsePRDiff(SIMPLE_DIFF).files.map(f => f.path)]);
    // A PR of only such changes leaves no file a model reads.
    expect(parsePRDiff(`${lfs}\n${submodule}`).files).toEqual([]);
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

  it('excludes package lockfiles by name by default, and reads any other `.lock` file', () => {
    const lockfiles: DiffFile[] = ['Cargo.lock', 'api/poetry.lock', 'web/bun.lock', 'ios/Podfile.lock', 'deno.lock', 'Gopkg.lock', '.github/workflows/actions.lock', 'flake.lock']
      .map(path => ({ path, changeType: 'modified', hunks: [] }));
    const result = filterFilesWithAttribution(lockfiles, DEFAULT_CONFIG.exclude_paths);
    expect(result.included.map(f => f.path)).toEqual(['.github/workflows/actions.lock', 'flake.lock']);
    expect(result.excluded).toEqual([
      { path: 'Cargo.lock', matchedPattern: 'Cargo.lock' },
      { path: 'api/poetry.lock', matchedPattern: 'poetry.lock' },
      { path: 'web/bun.lock', matchedPattern: 'bun.lock' },
      { path: 'ios/Podfile.lock', matchedPattern: 'Podfile.lock' },
      { path: 'deno.lock', matchedPattern: 'deno.lock' },
      { path: 'Gopkg.lock', matchedPattern: 'Gopkg.lock' },
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

    const kept = filterDiff(parsePRDiff(GENERATED_FIRST_DIFF), DEFAULT_CONFIG.exclude_paths, new Set(['dist/index.js.map']));
    expect([kept.diff.files.map(f => f.path), kept.excluded]).toEqual([['dist/index.js.map', 'src/a.ts', 'src/b.ts'], []]);
  });
});

describe('reviewableDiff', () => {
  it('leaves every file the closed paths close out of the full diff too, lists each, and changes nothing without them', () => {
    const closed = { matchedPattern: 'holdout', closed: true };
    const { fullDiff, diff, excludedFiles, rawDiff } = reviewableDiff(CLOSED_DIFF, ['src/b.ts'], ['holdout']);
    expect(JSON.stringify([fullDiff, diff, rawDiff])).not.toContain('marker');
    expect([fullDiff.files.map(f => f.path), fullDiff.binarySkipped, diff.files.map(f => f.path)]).toEqual([['src/a.ts', 'src/b.ts'], [], ['src/a.ts']]);
    expect([diff.totalAdditions, diff.totalDeletions]).toEqual([1, 0]);
    expect(excludedFiles).toEqual([
      { path: 'holdout/case.yml', ...closed },
      { path: 'src/moved.ts', ...closed },
      { path: 'holdout/hold-out marker.bin', ...closed },
      { path: 'src/b.ts', matchedPattern: 'src/b.ts' },
    ]);
    // A file renamed out of a closed path holds the closed file's text at the head, so its head path is closed too, and only that path.
    const { closedPaths } = reviewableDiff(CLOSED_DIFF, ['src/b.ts'], ['holdout']);
    expect(closedPaths).toEqual(['holdout', '/src/moved.ts']);
    expect(['src/moved.ts', 'src/moved.tsx', 'lib/src/moved.ts'].map(path => findClosedPattern(path, closedPaths))).toEqual(['/src/moved.ts', undefined, undefined]);
    const oddName = 'diff --git a/holdout/a[1]*.ts b/src/a[1]*.ts\nsimilarity index 100%\nrename from holdout/a[1]*.ts\nrename to src/a[1]*.ts\n';
    const odd = reviewableDiff(oddName, [], ['holdout']).closedPaths;
    expect(odd).toEqual(['holdout', '/src/a\\[1\\]\\*.ts']);
    expect(['src/a[1]*.ts', 'src/a1x.ts'].map(path => findClosedPattern(path, odd))).toEqual([odd[1], undefined]);
    // Braces stay literal, and a backslash in a name matches as the `/` `findClosedPattern` reads it as.
    const braces = 'diff --git a/holdout/x.ts b/src/{a,b}.ts\nsimilarity index 100%\nrename from holdout/x.ts\nrename to src/{a,b}.ts\n';
    const slash = 'diff --git a/holdout/y.ts "b/src/c\\\\d.ts"\nsimilarity index 100%\nrename from holdout/y.ts\nrename to "src/c\\\\d.ts"\n';
    const moved = reviewableDiff(`${braces}${slash}`, [], ['holdout']).closedPaths;
    expect(['src/{a,b}.ts', 'src/a.ts', 'src/c\\d.ts'].map(path => !!findClosedPattern(path, moved))).toEqual([true, false, true]);
    // A file renamed into a closed path held the closed file's text at the base, so its old path is closed too, binaries included.
    const movedIn = 'diff --git a/src/case.yml b/holdout/case.yml\nsimilarity index 100%\nrename from src/case.yml\nrename to holdout/case.yml\n';
    const binaryIn = 'diff --git a/assets/a.bin b/holdout/a.bin\nsimilarity index 90%\nrename from assets/a.bin\nrename to holdout/a.bin\nindex 1111111..2222222 100644\nBinary files a/assets/a.bin and b/holdout/a.bin differ\n';
    expect(reviewableDiff(`${movedIn}${binaryIn}`, [], ['holdout']).closedPaths).toEqual(['holdout', '/src/case.yml', '/assets/a.bin']);
    // Only the closed files make up the change, as when every file is excluded.
    expect(reviewableDiff(CLOSED_DIFF.replace(MULTI_FILE_DIFF, ''), [], ['holdout/**']).fullDiff.files).toEqual([]);
    expect(reviewableDiff(CLOSED_DIFF, ['src/b.ts'], [])).toEqual(reviewableDiff(CLOSED_DIFF, ['src/b.ts']));
    expect(reviewableDiff(CLOSED_DIFF, [], []).rawDiff).toContain('new hold-out marker');
    // The `/dev/null` side of an added or deleted binary is no path, so it closes nothing.
    const deletedBinary = 'diff --git a/app.jar b/app.jar\ndeleted file mode 100644\nindex abcdef1..0000000\nBinary files a/app.jar and /dev/null differ\n';
    const binaries = reviewableDiff(`${BINARY_FILE_DIFF}${deletedBinary}${CLOSED_DIFF}`, [], ['holdout']);
    expect(binaries.fullDiff.binarySkipped?.map(b => b.path)).toEqual(['assets/logo.png', 'app.jar']);
    expect(binaries.excludedFiles.map(f => f.path)).toEqual(['holdout/case.yml', 'src/moved.ts', 'holdout/hold-out marker.bin']);
  });

  it('reads each path git quoted as the real name, so a closed pattern with a non-ASCII character closes the file', () => {
    // As `git diff` writes them: a name with a non-ASCII byte, a quote or a backslash is quoted, with C escapes.
    const quoted = [
      'diff --git "a/h\\303\\266ldout/caf\\303\\251.md" "b/h\\303\\266ldout/caf\\303\\251.md"',
      'index b3c6b97..1f5f959 100644',
      '--- "a/h\\303\\266ldout/caf\\303\\251.md"',
      '+++ "b/h\\303\\266ldout/caf\\303\\251.md"',
      '@@ -1 +1 @@',
      '-secret one',
      '+secret one changed',
      'diff --git "a/h\\303\\266ldout/t\\"q.md" "b/docs/t\\"q.md"',
      'similarity index 50%',
      'rename from "h\\303\\266ldout/t\\"q.md"',
      'rename to "docs/t\\"q.md"',
      'index 1111111..2222222 100644',
      '--- "a/h\\303\\266ldout/t\\"q.md"',
      '+++ "b/docs/t\\"q.md"',
      '@@ -1,2 +1,2 @@',
      ' secret two',
      '-line',
      '+line changed',
      'diff --git "a/h\\303\\266ldout/bin.dat" "b/docs/b\\303\\257n.dat"',
      'similarity index 100%',
      'rename from "h\\303\\266ldout/bin.dat"',
      'rename to "docs/b\\303\\257n.dat"',
      'diff --git "a/docs/na\\303\\257ve\\ta\\\\b.md" "b/docs/na\\303\\257ve\\ta\\\\b.md"',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ "b/docs/na\\303\\257ve\\ta\\\\b.md"',
      '@@ -0,0 +1 @@',
      '+open text',
      '',
    ].join('\n');

    const parsed = parsePRDiff(quoted);
    expect(parsed.files.map(f => [f.path, f.oldPath])).toEqual([
      ['höldout/café.md', undefined], ['docs/t"q.md', 'höldout/t"q.md'], ['docs/naïve\ta\\b.md', undefined],
    ]);
    expect(parsed.binarySkipped?.map(b => [b.path, JSON.parse(b.header).slice(0, 2)])).toEqual([['docs/bïn.dat', ['höldout/bin.dat', 'docs/bïn.dat']]]);
    // A rebuilt diff quotes the names again, and reads back as the same paths.
    expect(parsePRDiff(rebuildRawDiff(parsed)).files.map(f => [f.path, f.oldPath])).toEqual(parsed.files.map(f => [f.path, f.oldPath]));

    const { fullDiff, excludedFiles, rawDiff, closedPaths } = reviewableDiff(quoted, [], ['höldout/**']);
    expect(JSON.stringify([fullDiff, rawDiff])).not.toContain('secret');
    expect([fullDiff.files.map(f => f.path), fullDiff.binarySkipped]).toEqual([['docs/naïve\ta\\b.md'], []]);
    expect(excludedFiles.map(f => f.path)).toEqual(['höldout/café.md', 'docs/t"q.md', 'docs/bïn.dat']);
    expect(['docs/t"q.md', 'docs/bïn.dat', 'docs/naïve\ta\\b.md'].map(path => !!findClosedPattern(path, closedPaths))).toEqual([true, true, false]);
    expect(closeRawDiff(quoted, ['höldout/**'])).not.toContain('secret');
  });

  it.each([['a carriage return', '\r'], ['a line separator', '\u2028'], ['a paragraph separator', '\u2029']])('starts no file at %s before `diff --git` inside a changed line', (_label, separator) => {
    const raw = [
      'diff --git a/holdout/case.md b/holdout/case.md',
      'index 1111111..2222222 100644',
      '--- a/holdout/case.md',
      '+++ b/holdout/case.md',
      '@@ -1,1 +1,2 @@',
      ' first',
      `+line${separator}diff --git a/src/open.ts b/src/open.ts`,
      '@@ -9,1 +10,2 @@',
      ' ninth',
      '+secret',
      'diff --git a/src/a.ts b/src/a.ts',
      'index 3333333..4444444 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    expect(diffSections(raw).map(text => text.split('\n', 1)[0])).toEqual(['diff --git a/holdout/case.md b/holdout/case.md', 'diff --git a/src/a.ts b/src/a.ts']);
    const parsed = parsePRDiff(raw);
    expect(parsed.files.map(f => [f.path, f.hunks.length])).toEqual([['holdout/case.md', 2], ['src/a.ts', 1]]);
    expect(orderDiffSections(raw).map(section => section.path)).toEqual(['holdout/case.md', 'src/a.ts']);
    const { fullDiff, rawDiff } = reviewableDiff(raw, [], ['holdout']);
    expect(JSON.stringify([fullDiff, rawDiff])).not.toContain('secret');
    expect(fullDiff.files.map(f => f.path)).toEqual(['src/a.ts']);
    expect(closeRawDiff(raw, ['holdout'])).not.toContain('secret');
  });

  it('reads a name with a quote mark or a date in it as it is, so a file moved to it out of a closed path stays closed', () => {
    // As `git diff` writes them: these names are not quoted, and a `+++` path with a space ends in a tab.
    const raw = [
      'diff --git a/holdout/case.md b/docs/case\'',
      'similarity index 65%',
      'rename from holdout/case.md',
      'rename to docs/case\'',
      'index 81976dd..e449626 100644',
      '--- a/holdout/case.md',
      '+++ b/docs/case\'',
      '@@ -3,2 +3,2 @@ a',
      ' secret',
      '-e',
      '+e changed',
      'diff --git a/holdout/it\'s.md b/docs/it\'s.md',
      'similarity index 100%',
      'rename from holdout/it\'s.md',
      'rename to docs/it\'s.md',
      'diff --git a/holdout/b.dat b/docs/b\'',
      'similarity index 100%',
      'rename from holdout/b.dat',
      'rename to docs/b\'',
      'diff --git a/docs/note 2024-01-02 10:11:12 +0100\' b/docs/note 2024-01-02 10:11:12 +0100\'',
      'new file mode 100644',
      'index 0000000..3e75765',
      '--- /dev/null',
      '+++ b/docs/note 2024-01-02 10:11:12 +0100\'\t',
      '@@ -0,0 +1 @@',
      '+open text',
      'diff --git a/docs/mode\' b/docs/mode\'',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');

    const parsed = parsePRDiff(raw);
    expect(parsed.files.map(f => [f.path, f.oldPath])).toEqual([['docs/case\'', 'holdout/case.md'], ['docs/note 2024-01-02 10:11:12 +0100\'', undefined]]);
    expect(parsed.binarySkipped?.map(b => [b.path, JSON.parse(b.header).slice(0, 2)])).toEqual([
      ['docs/it\'s.md', ['holdout/it\'s.md', 'docs/it\'s.md']], ['docs/b\'', ['holdout/b.dat', 'docs/b\'']], ['docs/mode\'', ['docs/mode\'', 'docs/mode\'']],
    ]);
    expect(parsePRDiff(rebuildRawDiff(parsed)).files.map(f => [f.path, f.oldPath])).toEqual(parsed.files.map(f => [f.path, f.oldPath]));

    const { fullDiff, excludedFiles, closedPaths } = reviewableDiff(raw, [], ['holdout']);
    expect(JSON.stringify(fullDiff)).not.toContain('secret');
    expect(excludedFiles.map(f => f.path)).toEqual(['docs/case\'', 'docs/it\'s.md', 'docs/b\'']);
    expect(['docs/case\'', 'docs/case', 'docs/it\'s.md', 'docs/b\'', 'docs/mode\''].map(path => !!findClosedPattern(path, closedPaths))).toEqual([true, false, true, true, false]);
  });
});

describe('findClosedPattern', () => {
  it('compiles each pattern once, however many paths, folders and patterns it checks', () => {
    const make = jest.spyOn(Minimatch.prototype, 'make');
    try {
      // More patterns than `minimatch` keeps compiled in its own cache, as a PR that moves many files out of a closed path gives.
      const closed = [...Array.from({ length: 300 }, (_, i) => `/moved/compiled-once-${i}.ts`), 'compiled-once/**'];
      for (let i = 0; i < 20; i++) expect(findClosedPattern(`src/deep/dir${i}/file${i}.ts`, closed)).toBeUndefined();
      expect(findClosedPattern('compiled-once/a.ts', closed)).toBe('compiled-once/**');
      expect(make).toHaveBeenCalledTimes(closed.length);
    } finally {
      make.mockRestore();
    }
  });

  it('matches a path however it is spelled, and closes one that leaves the repository', () => {
    const closed = ['secret/**', 'notes'];
    for (const path of ['secret/x.md', './secret/x.md', 'secret//x.md', 'src/../secret/x.md', 'secret\\x.md', '.\\secret\\x.md', 'secret/./x.md', 'secret/sub/']) {
      expect([path, findClosedPattern(path, closed)]).toEqual([path, 'secret/**']);
    }
    expect(findClosedPattern('./docs//notes/a.md', closed)).toBe('notes');
    for (const path of ['../x.md', '..', 'src/../../x.md', '/etc/x', '\\x.md']) {
      expect([path, findClosedPattern(path, closed)]).toEqual([path, 'secret/**']);
    }
    for (const path of ['src/x.md', './src/x.md', 'src/secret.md', 'secrets/x.md']) {
      expect([path, findClosedPattern(path, closed)]).toEqual([path, undefined]);
    }
    expect(findClosedPattern('../x.md', [])).toBeUndefined();
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

  it('removes a closed file even when it is kept from the exclusions', () => {
    const result = filterRawDiff(CLOSED_DIFF, [], new Set(['holdout/case.yml']), ['holdout/**']);
    expect(result).not.toContain('marker');
    expect(result).toBe(filterRawDiff(MULTI_FILE_DIFF, []));
    // `closeRawDiff` drops only the sections of closed files and keeps the others as they came, binaries included.
    expect(closeRawDiff(CLOSED_DIFF, ['holdout/**'])).toBe(MULTI_FILE_DIFF);
    expect(closeRawDiff(`${BINARY_FILE_DIFF}${CLOSED_DIFF}`, ['holdout/**'])).toBe(`${BINARY_FILE_DIFF}${MULTI_FILE_DIFF}`);
    expect(closeRawDiff(CLOSED_DIFF, [])).toBe(CLOSED_DIFF);
  });
});

describe('compareChanges', () => {
  const isSameChange = (a: string, b: string) => compareChanges(a, b).same;

  it('ignores hunk positions and index lines', () => {
    const rebased = MULTI_FILE_DIFF
      .replace('index 1111111..2222222', 'index 5555555..6666666')
      .replace('@@ -5,3 +5,4 @@ export function b() {', '@@ -42,3 +57,4 @@ export function moved() {');
    expect(isSameChange(MULTI_FILE_DIFF, rebased)).toBe(true);
    expect(isSameChange(GENERATED_FIRST_DIFF, GENERATED_FIRST_DIFF.replace('index 1111111..2222222', 'index 3333333..2222222'))).toBe(true);
  });

  it('detects a changed line, an added file, a changed context line or a change to an excluded file', () => {
    expect(isSameChange(MULTI_FILE_DIFF, MULTI_FILE_DIFF.replace('+added line', '+edited line'))).toBe(false);
    expect(isSameChange(MULTI_FILE_DIFF, `${MULTI_FILE_DIFF}${ADDED_FILE_DIFF}`)).toBe(false);
    expect(isSameChange(MULTI_FILE_DIFF, MULTI_FILE_DIFF.replace(' line2', ' line2 from base'))).toBe(false);
    expect(isSameChange(MULTI_FILE_DIFF, GENERATED_FIRST_DIFF)).toBe(false);
    expect(isSameChange(GENERATED_FIRST_DIFF, GENERATED_FIRST_DIFF.replace('"mappings"', '"names"'))).toBe(false);
    const chmod = MULTI_FILE_DIFF.replace('index 1111111..2222222 100644', 'old mode 100644\nnew mode 100755\nindex 1111111..2222222');
    expect(parsePRDiff(chmod).files.find(f => f.modeChange)).toEqual(expect.objectContaining({ modeChange: '100644 100755' }));
    expect(isSameChange(MULTI_FILE_DIFF, chmod)).toBe(false);
    const script = ADDED_FILE_DIFF.replace('new file mode 100644', 'new file mode 100755');
    expect(parsePRDiff(script).files[0].modeChange).toBe('100755');
    expect(parsePRDiff(ADDED_FILE_DIFF).files[0].modeChange).toBeUndefined();
    expect(isSameChange(ADDED_FILE_DIFF, script)).toBe(false);
  });

  it('returns the binaries of the second diff, which only their full blob shas can prove unchanged', () => {
    const withBinary = `${BINARY_FILE_DIFF}${MULTI_FILE_DIFF}`;
    expect(compareChanges(withBinary, withBinary)).toEqual({ same: true, binaries: [expect.objectContaining({ path: 'assets/logo.png' })] });
    expect(compareChanges(MULTI_FILE_DIFF, withBinary).same).toBe(false);
    expect(compareChanges(MULTI_FILE_DIFF, MULTI_FILE_DIFF)).toEqual({ same: true, binaries: [] });
  });

  it('gives a binary whose blob changes a new digest', () => {
    const swapped = BINARY_FILE_DIFF.replace('0000000..abcdef1', '0000000..1234567');
    expect(changeDigest(parsePRDiff(swapped))).not.toBe(changeDigest(parsePRDiff(BINARY_FILE_DIFF)));
    expect(changeDigest(parsePRDiff(BINARY_FILE_DIFF))).toBe(changeDigest(parsePRDiff(BINARY_FILE_DIFF)));
  });
});

describe('ownChangeSince', () => {
  const change = (path: string, start: number, lines: string[], oldPath?: string): string =>
    `diff --git a/${oldPath ?? path} b/${path}\n--- a/${oldPath ?? path}\n+++ b/${path}\n@@ -${start},1 +${start},${lines.length + 1} @@\n ctx\n${lines.map(l => `+${l}`).join('\n')}\n`;
  // The PR changes `src/a.ts` and `src/b.ts`, and the base branch gains `src/main.ts` and a change above the PR's lines.
  const before = parsePRDiff(`${change('src/a.ts', 10, ['guard'])}${change('src/b.ts', 1, ['helper'])}`);
  const fromMain = change('src/main.ts', 1, ['from main']);

  it('is empty for a push that only rebases onto the base branch', () => {
    const after = parsePRDiff(`${change('src/a.ts', 30, ['guard'])}${change('src/b.ts', 5, ['helper'])}`);
    expect(ownChangeSince(`${fromMain}${change('src/a.ts', 3, ['main above the PR'])}`, before, after)).toBe('');
  });

  it('keeps only the file the PR changed when a rebase comes with a one-line fix', () => {
    const after = parsePRDiff(`${change('src/a.ts', 30, ['guard', 'fixed'])}${change('src/b.ts', 5, ['helper'])}`);
    const fix = change('src/a.ts', 31, ['fixed']);
    expect(ownChangeSince(`${fromMain}${fix}${change('src/b.ts', 1, ['main near b'])}`, before, after)).toBe(rebuildRawDiff(parsePRDiff(fix)));
  });

  it('keeps a file the PR stopped changing and a file it renamed', () => {
    const after = parsePRDiff(`${change('src/a.ts', 10, ['guard'])}${change('src/c.ts', 1, ['helper'], 'src/b.ts')}`);
    const renamed = change('src/c.ts', 1, ['moved'], 'src/b.ts');
    expect(ownChangeSince(`${fromMain}${renamed}`, before, after)).toBe(rebuildRawDiff(parsePRDiff(renamed)));
    const reverted = change('src/b.ts', 1, ['reverted']);
    expect(ownChangeSince(`${fromMain}${reverted}`, before, parsePRDiff(change('src/a.ts', 10, ['guard'])))).toBe(rebuildRawDiff(parsePRDiff(reverted)));
  });
});

describe('tagFindingOrigins', () => {
  const change = (path: string, start: number, lines: string[], oldPath?: string): string =>
    `diff --git a/${oldPath ?? path} b/${path}\n--- a/${oldPath ?? path}\n+++ b/${path}\n@@ -${start},1 +${start},${lines.length + 1} @@\n ctx\n${lines.map(l => `+${l}`).join('\n')}\n`;
  const finding = (file: string, line: number): Finding => ({ severity: 'note', title: 't', file, line, description: 'd', reviewers: [] });
  const tag = (findings: Finding[], current: string, prior?: string) => {
    tagFindingOrigins(findings, parsePRDiff(current), prior === undefined ? undefined : parsePRDiff(prior), undefined, citedPlaces);
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
    // A finding that restates one an earlier review body listed is from that round, on new code too and without a prior change.
    const restated = { ...finding('src/a.ts', 13), raisedIn: 1 };
    expect(tag([restated, { ...finding('src/a.ts', 18), raisedIn: 2 }], current, prior)).toEqual(['earlier', 'earlier']);
    expect(tag([restated], current)).toEqual(['earlier']);
    // A finding linked to an earlier thread's finding was not missed by the round that raised it, so it never reads as
    // reviewed code. A variant of a thread is another failure and is tagged by its code.
    const linked = [{ ...finding('src/a.ts', 18), sameAs: 'src/a.ts:18:18:old' }, { ...finding('src/a.ts', 18), threadId: 'T1' }, { ...finding('src/a.ts', 18), threadId: 'T1', variantOf: 'T1' }];
    expect(tag(linked, current, prior)).toEqual(['new', 'new', 'reviewed']);
    // A push that changes a line the finding cites can make its untouched line wrong, so the finding is new. It cites
    // `fresh` in its proof, in an evidence check or in a refuter's premise check. Cited lines the push left alone keep it reviewed.
    const refuted = (proof: string[]): Finding['refutation'] => ({ outcome: 'confirmed', reason: 'r', files: [], codeDigest: 'd', premises: [{ premise: 'p', outcome: 'confirmed', reason: 'r', proof }] });
    expect(tag([
      { ...finding('src/a.ts', 30), evidence: { checks: [], proof: ['src/a.ts:13'] } },
      { ...finding('src/new.ts', 2), evidence: { checks: ['src/a.ts:12-13 adds a second lookup'], proof: [] } },
      { ...finding('src/new.ts', 2), refutation: { outcome: 'confirmed', reason: 'r', files: [], codeDigest: 'd' }, pairRefutation: refuted(['src/a.ts:13']) },
      { ...finding('src/new.ts', 2), evidence: { checks: ['src/a.ts:30 reads it'], proof: ['src/new.ts:1', 'src/a.ts:18'] }, refutation: refuted(['src/a.ts:40']) },
    ], current, prior)).toEqual(['new', 'new', 'new', 'reviewed']);
  });

  it('tags a finding new near code removed or restored since: a base line the PR removed or put back, or a line it added before and dropped or moved', () => {
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
    tagFindingOrigins(findings, parsePRDiff(droppedOwnLine), parsePRDiff(prior), parsePRDiff(interRound), citedPlaces);
    expect(findings[0].origin).toBe('new');
    expect(tag([finding('src/a.ts', 11)], droppedOwnLine, prior)).toEqual(['reviewed']);

    // The PR puts back a base line it removed before, so `src/b.ts` drops out of its change.
    const priorRemoval = removal('src/b.ts', 10, 'if (!user) return;', ['use(user);']);
    const restored = change('src/b.ts', 10, ['if (!user) return;']);
    const restoredFindings = [finding('src/b.ts', 11), finding('src/b.ts', 30)];
    tagFindingOrigins(restoredFindings, parsePRDiff(change('src/a.ts', 10, ['x'])), parsePRDiff(priorRemoval), parsePRDiff(restored), citedPlaces);
    expect(restoredFindings.map(f => f.origin)).toEqual(['new', 'reviewed']);

    // The PR moved its own `guard` line below `body`. The current change adds the same text, so only the diff between the commits shows it.
    const moved = change('src/a.ts', 10, ['body', 'guard']);
    const movedInterRound = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,3 @@\n ctx\n-guard\n body\n+guard\n`;
    const movedFindings = [finding('src/a.ts', 12), finding('src/a.ts', 20)];
    tagFindingOrigins(movedFindings, parsePRDiff(moved), parsePRDiff(prior), parsePRDiff(movedInterRound), citedPlaces);
    expect(movedFindings.map(f => f.origin)).toEqual(['new', 'reviewed']);

    // A rebase brings in a base line `}` that the PR also adds elsewhere. It sits on a line the PR does not add, so it stays reviewed.
    const rebaseInterRound = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n ctx\n+}\n`;
    const rebaseFindings = [finding('src/a.ts', 2)];
    tagFindingOrigins(rebaseFindings, parsePRDiff(change('src/a.ts', 10, ['guard', 'body', '}'])), parsePRDiff(change('src/a.ts', 10, ['guard', 'body', '}'])), parsePRDiff(rebaseInterRound), citedPlaces);
    expect(rebaseFindings[0].origin).toBe('reviewed');
  });

  it('hides a note on reviewed code, but not one the PR fixes elsewhere, since that fix can be newer than the review, nor one the other finder\'s vote or the score lowered', () => {
    const current = parsePRDiff(change('src/a.ts', 10, ['x']));
    const fixed = { fixedElsewhere: 'src/a.ts:11' };
    const voted = { gradePath: [{ from: 'warning' as const, to: 'note' as const, by: 'other_finder' as const }] };
    const scored = { gradePath: [{ from: 'warning' as const, to: 'note' as const, by: 'importance' as const }] };
    const result = { findings: [finding('src/a.ts', 30), { ...finding('src/a.ts', 31), ...fixed }, { ...finding('src/a.ts', 32), ...fixed, raisedIn: 1 }, { ...finding('src/a.ts', 33), ...voted }, { ...finding('src/a.ts', 34), ...scored }] } as ReviewResult;
    tagFindingOrigins(result.findings, current, current, undefined, citedPlaces);
    hideSeenNotes(result, current);
    expect([result.findings.map(f => f.line), result.unposted?.map(f => [f.line, f.unpostedReason])]).toEqual([[31, 33, 34], [[30, 'reviewed_code'], [32, 'listed_earlier']]]);
    expect(result.findings[1].origin).toBe('reviewed');
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
    // Read back without file mode lines, each file keeps its kind.
    expect(parsePRDiff(raw).files.map(f => [f.path, f.changeType])).toEqual([['src/new-file.ts', 'added'], ['src/old-file.ts', 'deleted'], ['src/new-name.ts', 'renamed']]);
  });
});

describe('orderDiffSections', () => {
  const fileDiff = (path: string): string => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
  const binary = 'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n';
  const raw = [fileDiff('src/a.ts'), binary, fileDiff('src/b.ts'), fileDiff('Cargo.lock'), fileDiff('src/z.ts').trimEnd()].join('');

  it('moves the files in `first` to the front in its order and keeps the rest in order', () => {
    const paths = (first: string[]) => orderDiffSections(raw, first).map(s => s.path);
    expect(paths([])).toEqual(['src/a.ts', 'img.png', 'src/b.ts', 'Cargo.lock', 'src/z.ts']);
    expect(paths(['src/z.ts', 'gone.ts', 'src/b.ts', 'src/z.ts'])).toEqual(['src/z.ts', 'src/b.ts', 'src/a.ts', 'img.png', 'Cargo.lock']);
    // Each section keeps its text, and a last section without a line break gets one so a reordered diff stays valid.
    const ordered = orderDiffSections(raw, ['src/z.ts']);
    expect(ordered.map(s => s.text)).toEqual([fileDiff('src/z.ts'), fileDiff('src/a.ts'), binary, fileDiff('src/b.ts'), fileDiff('Cargo.lock')]);
    expect(orderDiffSections('')).toEqual([]);
  });

  it('moves a renamed file to the front by its old or its new path, once', () => {
    const renamed = 'diff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const withRename = `${fileDiff('src/a.ts')}${renamed}`;
    expect(orderDiffSections(withRename).map(s => [s.path, s.oldPath])).toEqual([['src/a.ts', undefined], ['src/new.ts', 'src/old.ts']]);
    expect(orderDiffSections(withRename, ['src/old.ts']).map(s => s.path)).toEqual(['src/new.ts', 'src/a.ts']);
    expect(orderDiffSections(withRename, ['src/new.ts', 'src/old.ts']).map(s => s.text)).toEqual([renamed, fileDiff('src/a.ts')]);
  });
});

describe('listedFilesDiff', () => {
  // A name that would start a header line of its own if it were written into the diff as it is.
  const forged = 'x.bin\ndeleted file mode 100644';
  const quoted = (side: 'a' | 'b') => `"${side}/x.bin\\ndeleted file mode 100644"`;
  const patch = '@@ -1 +1 @@\n-old\n+new';

  it.each([
    ['an added file', { filename: forged, status: 'added' }, ['diff --git', '+++'], 'added'],
    ['a removed file', { filename: forged, status: 'removed', deletions: 0 }, ['diff --git', '---'], 'deleted'],
    ['a modified file with a patch', { filename: forged, status: 'modified', patch }, ['diff --git', '---', '+++'], 'modified'],
    ['a renamed file', { filename: 'safe.bin', previous_filename: forged, status: 'renamed' }, ['diff --git', '---'], 'renamed'],
  ] as const)('quotes a name with a line break in each header line of %s, so the name adds no line', (_label, file, lines, changeType) => {
    const raw = listedFilesDiff([file, { filename: 'src/next.ts', status: 'modified', patch }]);

    for (const kind of lines) expect(raw.split('\n').find(l => l.startsWith(kind))).toContain(kind === '+++' ? quoted('b') : quoted('a'));
    expect(raw.split('\n').filter(l => l === 'deleted file mode 100644')).toHaveLength(changeType === 'deleted' ? 1 : 0);
    const diff = parsePRDiff(raw);
    expect([...diff.files.map(f => f.changeType), ...(diff.binarySkipped ?? []).map(f => (f.deleted ? 'deleted' : 'unread'))].sort())
      .toEqual([file.status === 'modified' ? changeType : changeType === 'deleted' ? 'deleted' : 'unread', 'modified'].sort());
    expect(diff.files.map(f => f.path)).toContain('src/next.ts');
  });

  // GitHub's own diff of a PR, which finds renames but not copies and lists no unchanged file, decides each row.
  it.each([
    ['a copied file with a patch as a new file, never a rename of its source', { filename: 'b.ts', previous_filename: 'a.ts', status: 'copied', patch }, { files: [['b.ts', 'added', undefined]], skipped: [] }],
    ['a copied file without a patch as an unread new file', { filename: 'b.bin', previous_filename: 'a.bin', status: 'copied' }, { files: [], skipped: [['b.bin', undefined]] }],
    ['a removed file without a patch that had no lines as deleted', { filename: 'a.bin', status: 'removed', deletions: 0 }, { files: [], skipped: [['a.bin', true]] }],
    ['a removed file without a patch that had lines as unread', { filename: 'big.sql', status: 'removed', deletions: 50_000 }, { files: [], skipped: [['big.sql', undefined]] }],
    ['a removed file whose patch is left out as unread', { filename: 'a.ts', status: 'removed', deletions: 2, patch: '@@ -1,2 +0,0 @@\n-a' }, { files: [], skipped: [['a.ts', undefined]] }],
    ['an unchanged file not at all', { filename: 'same.ts', status: 'unchanged' }, { files: [], skipped: [] }],
  ] as const)('writes %s', (_label, file, expected) => {
    const raw = listedFilesDiff([file]);
    const diff = parsePRDiff(raw);

    expect({
      files: diff.files.map(f => [f.path, f.changeType, f.oldPath]),
      skipped: (diff.binarySkipped ?? []).map(f => [f.path, f.deleted]),
    }).toEqual(expected);
    if ('previous_filename' in file) expect(raw).not.toContain(file.previous_filename);
  });

  it('quotes a name as git does, escaping the characters git escapes, and reads each name back as it was', () => {
    const names = ['t\tq"b\\c\u0001', 'dir/a "b".ts', 'dir/a\\tb.ts', 'dir/café.ts', 'dir/plain name.ts'];
    const raw = listedFilesDiff(names.map(filename => ({ filename, status: 'modified' })));
    expect(raw.split('\n').filter(l => l.startsWith('diff --git'))).toEqual([
      'diff --git "a/t\\tq\\"b\\\\c\\001" "b/t\\tq\\"b\\\\c\\001"',
      'diff --git "a/dir/a \\"b\\".ts" "b/dir/a \\"b\\".ts"',
      'diff --git "a/dir/a\\\\tb.ts" "b/dir/a\\\\tb.ts"',
      'diff --git a/dir/café.ts b/dir/café.ts',
      'diff --git a/dir/plain name.ts b/dir/plain name.ts',
    ]);
    expect(parsePRDiff(raw).binarySkipped?.map(b => b.path)).toEqual(names);
  });

  it.each([
    ['a line past the counted ones', '@@ -1 +1 @@\n-old\n+new\ndiff --git a/evil b/evil\ndeleted file mode 100644'],
    ['fewer lines than counted', '@@ -1,2 +1,2 @@\n-old\n+new'],
    ['a line without a diff prefix', '@@ -1,2 +1,2 @@\n-old\n\n+new'],
  ])('leaves out a patch with %s, so it cannot start a file and the file stays unread', (_label, bad) => {
    const diff = parsePRDiff(listedFilesDiff([{ filename: 'src/a.ts', status: 'modified', patch: bad }, { filename: 'src/next.ts', status: 'modified', patch }]));

    expect(diff.files.map(f => [f.path, f.hunks.map(h => h.content)])).toEqual([['src/next.ts', ['-old\n+new']]]);
    expect(diff.binarySkipped?.map(f => f.path)).toEqual(['src/a.ts']);
  });

  it('keeps a patch of several hunks with a missing newline at the end, and writes only a hex blob id', () => {
    const several = '@@ -1,2 +1,2 @@\n same\n-old\n+new\n@@ -9 +9 @@\n-end\n+end\n\\ No newline at end of file';
    const raw = listedFilesDiff([{ filename: 'src/a.ts', status: 'modified', sha: 'abc123', patch: several }, { filename: 'b.bin', status: 'modified', sha: 'x\n+++ b/evil' }]);

    expect(parsePRDiff(raw).files[0].hunks).toHaveLength(2);
    expect(raw).toContain('index 0000000..abc123');
    expect(raw).not.toContain('evil');
  });
});

describe('addCodeContext', () => {
  it('sets the hunk lines around a finding, counting only lines of the new file, and skips a line outside every hunk', () => {
    const removed = Array.from({ length: 10 }, (_, i) => `-old ${i}`);
    const kept = Array.from({ length: 20 }, (_, i) => ` new ${i + 1}`);
    const diff: ParsedDiff = {
      files: [{ path: 'src/a.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 30, newStart: 1, newLines: 20, content: [...removed, ...kept].join('\n') }] }],
      totalAdditions: 0, totalDeletions: 10,
    };
    const below = { file: 'src/a.ts', line: 1 } as Finding;
    const outside = { file: 'src/a.ts', line: 25 } as Finding;
    addCodeContext([below, outside], diff);
    // Line 1 sits after ten removed lines, so the window is centred on ` new 1`, not on the first removed line.
    expect(below.codeContext).toBe([...removed.slice(5), ...kept.slice(0, 10)].join('\n'));
    expect(outside.codeContext).toBeUndefined();
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

  it('returns true for a range that overlaps or encloses a hunk, and false for one between hunks', () => {
    expect(isLineInDiff(file, 1, 5)).toBe(true);
    expect(isLineInDiff(file, 8, 30)).toBe(true);
    expect(isLineInDiff(file, 1, 40)).toBe(true);
    expect(isLineInDiff(file, 9, 20)).toBe(false);
  });

  it('names the first added line as the one a file-level thread goes on, else the first line a hunk shows, else none', () => {
    const edited: DiffFile = { ...file, hunks: [{ oldStart: 5, oldLines: 3, newStart: 5, newLines: 3, content: ' a\n-b\n+c\n d' }, { oldStart: 20, oldLines: 1, newStart: 20, newLines: 2, content: '+e\n f' }] };
    expect(firstCommentableLine(edited)).toBe(6);
    expect(isLineInDiff(edited, firstCommentableLine(edited)!)).toBe(true);
    expect(firstCommentableLine(file)).toBe(5);
    expect(firstCommentableLine({ ...file, hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, content: '-a\n-b' }] })).toBeUndefined();
    expect(firstCommentableLine({ ...file, changeType: 'renamed', hunks: [] })).toBeUndefined();
    // More added lines than a call can take as arguments.
    const added = 500_000;
    expect(firstCommentableLine({ ...file, hunks: [{ oldStart: 0, oldLines: 0, newStart: 3, newLines: added, content: '+x\n'.repeat(added) }] })).toBe(3);
  });
});

describe('oldLineOf, replacementOf and changesNextTo', () => {
  // Line 2 is replaced by two lines, and line 10 is removed.
  const file = parsePRDiff([
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@', ' one', '-two', '+two a', '+two b', ' three',
    '@@ -9,3 +10,2 @@', ' nine', '-ten', ' eleven',
  ].join('\n')).files[0];

  it('maps a line of the new file to the line it was, through the hunks before it', () => {
    expect([1, 2, 3, 4, 5, 10, 11, 12, 20].map(line => oldLineOf(file, line))).toEqual([1, undefined, undefined, 3, 4, 9, 11, 12, 20]);
    // The other way, a line of the old file maps to the line it became, and a removed line to none.
    expect([1, 2, 3, 4, 9, 10, 11, 20].map(line => oldLineOf(file, line, 'old'))).toEqual([1, undefined, 4, 5, 10, undefined, 11, 20]);
  });

  it('maps a line past a hunk that only adds or only removes lines', () => {
    const only = (hunk: string) => parsePRDiff(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', hunk].join('\n')).files[0];
    // Two lines added after line 5, and lines 1 to 3 removed.
    expect([5, 6, 7, 8].map(line => oldLineOf(only('@@ -5,0 +6,2 @@\n+a\n+b'), line))).toEqual([5, undefined, undefined, 6]);
    expect([1, 2].map(line => oldLineOf(only('@@ -1,3 +0,0 @@\n-a\n-b\n-c'), line))).toEqual([4, 5]);
    expect([3, 4].map(line => oldLineOf(only('@@ -4,2 +3,0 @@\n-a\n-b'), line))).toEqual([3, 6]);
    expect([5, 6].map(line => oldLineOf(only('@@ -5,0 +6,2 @@\n+a\n+b'), line, 'old'))).toEqual([5, 8]);
    expect([1, 3, 4].map(line => oldLineOf(only('@@ -1,3 +0,0 @@\n-a\n-b\n-c'), line, 'old'))).toEqual([undefined, undefined, 1]);
    expect([3, 4, 6].map(line => oldLineOf(only('@@ -4,2 +3,0 @@\n-a\n-b'), line, 'old'))).toEqual([3, undefined, 4]);
  });

  it('returns the new lines that replace a removed old line, and none for a line the diff keeps', () => {
    expect([2, 10, 1, 3].map(line => replacementOf(file, line))).toEqual([[2, 3], [11, 10], undefined, undefined]);
  });

  it('tells a line right before or after a run of changed lines from the changed line and a line further away', () => {
    expect([1, 2, 3, 4, 8, 9, 10, 11, 12].map(line => changesNextTo(file, line))).toEqual([true, false, true, false, false, true, false, true, false]);
    // Two lines added after line 5, with no line of context.
    const added = parsePRDiff(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -5,0 +6,2 @@\n+a\n+b'].join('\n')).files[0];
    expect([4, 5, 6, 7].map(line => changesNextTo(added, line))).toEqual([false, true, true, false]);
  });
});

describe('onlyCommitChanging', () => {
  const hunk = (start: number) => ({ oldStart: start, oldLines: 1, newStart: start, newLines: 1, content: '-a\n+b' });
  const commit = (sha: string, ...files: DiffFile[]) => ({ sha, diff: { files, totalAdditions: 0, totalDeletions: 0 } });
  const edit = (path: string, changeType: DiffFile['changeType'] = 'modified', oldPath?: string): DiffFile => ({ path, changeType, hunks: [hunk(3)], ...(oldPath && { oldPath }) });

  it('names the only commit that edited the thread\'s file in place, and no commit in any other case', () => {
    const fix = commit('c1', edit('src/retry.ts'));
    const elsewhere = commit('c2', edit('src/other.ts'));
    expect(onlyCommitChanging([fix, elsewhere], 'src/retry.ts')).toBe('c1');
    // Two commits changed the file, or none did.
    expect(onlyCommitChanging([fix, commit('c3', edit('src/retry.ts'))], 'src/retry.ts')).toBeUndefined();
    expect(onlyCommitChanging([elsewhere], 'src/retry.ts')).toBeUndefined();
    // A commit that renamed, added or deleted the file leaves the fix open, the thread's old path included.
    expect(onlyCommitChanging([commit('r1', edit('src/new.ts', 'renamed', 'src/retry.ts'))], 'src/retry.ts')).toBeUndefined();
    expect(onlyCommitChanging([commit('a1', edit('src/retry.ts', 'added'))], 'src/retry.ts')).toBeUndefined();
    expect(onlyCommitChanging([commit('d1', edit('src/retry.ts', 'deleted', 'src/retry.ts'))], 'src/retry.ts')).toBeUndefined();
    // So does a change without lines to read, such as a pure rename, which lands among the skipped files.
    const pureRename = { sha: 'p1', diff: { files: [], totalAdditions: 0, totalDeletions: 0, binarySkipped: [{ path: 'src/new.ts', header: JSON.stringify(['src/retry.ts', 'src/new.ts', null, null, null]) }] } };
    expect(onlyCommitChanging([pureRename], 'src/retry.ts')).toBeUndefined();
    expect(onlyCommitChanging([fix, pureRename], 'src/retry.ts')).toBeUndefined();
  });
});

describe('sliceDiff', () => {
  const file = (path: string, additions: number): DiffFile => ({ path, changeType: 'modified', hunks: [], additions, deletions: 0 });
  const diffOf = (...files: DiffFile[]) => ({ files, totalAdditions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0), totalDeletions: 0 });
  const paths = (slices: ReturnType<typeof sliceDiff>) => slices.map(s => s.files.map(f => f.path));

  it('keeps a diff within the slice size whole', () => {
    const diff = diffOf(file('src/a.ts', 700), file('lib/b.ts', 800));
    expect(sliceDiff(diff, 1500)).toEqual([diff]);
  });

  it('keeps a file with its test and one folder together, and fills each slice up to the size', () => {
    const slices = sliceDiff(diffOf(
      file('src/auth/login.ts', 600),
      file('docs/guide.md', 400),
      file('src/auth/__tests__/login.test.ts', 500),
      file('src/auth/token.ts', 300),
      file('src/db/query.go', 700),
      file('src/db/query_test.go', 600),
      file('tests/test_cli.py', 200),
      file('cli.py', 100),
    ), 1500);

    expect(paths(slices)).toEqual([
      ['tests/test_cli.py', 'cli.py', 'docs/guide.md'],
      ['src/auth/login.ts', 'src/auth/__tests__/login.test.ts', 'src/auth/token.ts'],
      ['src/db/query.go', 'src/db/query_test.go'],
    ]);
    expect(slices.map(s => s.totalAdditions)).toEqual([700, 1400, 1300]);
    expect(slices.flatMap(s => s.files)).toHaveLength(8);
  });

  it('gives a unit over the slice size a slice of its own', () => {
    expect(paths(sliceDiff(diffOf(file('a.ts', 100), file('b.ts', 2000), file('c.ts', 100)), 1500))).toEqual([['a.ts'], ['b.ts'], ['c.ts']]);
  });

  const added = (path: string, lines: string[]) =>
    `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`;

  it('splits a file over the character budget within its hunk, keeping every line and its line number', () => {
    const lines = Array.from({ length: Math.ceil(2.5 * MAX_SLICE_CHARS / 60) }, (_, i) => `const line${i} = '${'x'.repeat(40)}';`);
    const slices = sliceDiff(parsePRDiff(added('src/big.ts', lines)), 100_000);

    expect(slices.length).toBeGreaterThan(1);
    for (const slice of slices) expect(rebuildRawDiff(slice).length).toBeLessThanOrEqual(MAX_SLICE_CHARS);
    const shown = slices.flatMap(s => s.files.flatMap(f => f.hunks.flatMap(h => h.content.split('\n').map((l, i) => [h.newStart + i, l.slice(1)]))));
    expect(shown).toEqual(lines.map((l, i) => [i + 1, l]));
    expect(slices.reduce((sum, s) => sum + s.totalAdditions, 0)).toBe(lines.length);
  });

  it('splits at hunk boundaries and packs small files next to a split one', () => {
    // Each hunk takes over a third of a slice, so two fit in one.
    const side = (mark: string) => Array.from({ length: 4 }, () => `${mark}${'x'.repeat(MAX_SLICE_CHARS / 22)}`).join('\n');
    const hunk = (start: number) => `@@ -${start},4 +${start},4 @@\n${side('-')}\n${side('+')}`;
    const big = `diff --git a/big.ts b/big.ts\nindex 1111111..2222222 100644\n--- a/big.ts\n+++ b/big.ts\n${[1, 10, 20, 30].map(hunk).join('\n')}\n`;
    const slices = sliceDiff(parsePRDiff(`${big}${added('small.ts', ['x'])}`), 1500);

    expect(paths(slices)).toEqual([['big.ts'], ['big.ts', 'small.ts']]);
    expect(slices.flatMap(s => s.files.filter(f => f.path === 'big.ts').flatMap(f => f.hunks.map(h => h.newStart)))).toEqual([1, 10, 20, 30]);
  });

  it('shortens a line over the line limit, so the slice still fits', () => {
    const long = 'z'.repeat(MAX_LINE_CHARS + 5000);
    const [slice] = sliceDiff(parsePRDiff(added('min.js', [long])), 1500);
    expect(slice.files[0].hunks[0].content).toBe(`+${'z'.repeat(MAX_LINE_CHARS)} ... (5000 more characters of this line cut)`);
  });
});

describe('overlongChangedLines', () => {
  it('names each added line over the limit by its new line number, and leaves out removed and context lines', () => {
    const long = 'q'.repeat(MAX_LINE_CHARS + 1);
    const raw = `diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -5,4 +5,4 @@\n ${long}\n-${long}\n+short\n+${long}\n ${'q'.repeat(MAX_LINE_CHARS)}\n`;
    expect(overlongChangedLines(parsePRDiff(raw))).toEqual([{ file: 'a.ts', line: 7, length: MAX_LINE_CHARS + 1 }]);
    const deleted = `diff --git a/vendor/app.min.js b/vendor/app.min.js\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/vendor/app.min.js\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-${long}\n`;
    expect(overlongChangedLines(parsePRDiff(deleted))).toEqual([]);
    expect(overlongChangedLines(parsePRDiff(MULTI_FILE_DIFF))).toEqual([]);
  });
});
