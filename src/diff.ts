import { createHash } from 'crypto';

import parseDiff from 'parse-diff';
import { minimatch } from 'minimatch';

import { DiffFile, DiffHunk, Finding, ParsedDiff, RoundDiffExcludedFile } from './types';

/**
 * Parse a unified diff string into structured data.
 */
export function parsePRDiff(rawDiff: string): ParsedDiff {
  if (!rawDiff.trim()) {
    return { files: [], totalAdditions: 0, totalDeletions: 0, binarySkipped: [] };
  }

  const parsed = parseDiff(rawDiff);
  let totalAdditions = 0;
  let totalDeletions = 0;
  const files: DiffFile[] = [];
  const binarySkipped: string[] = [];

  for (const file of parsed) {
    if (isBinaryFile(file)) {
      const binaryPath = file.to && file.to !== '/dev/null' ? file.to : file.from ?? '';
      if (binaryPath) binarySkipped.push(binaryPath);
      continue;
    }

    const path = file.to && file.to !== '/dev/null' ? file.to : file.from ?? '';
    const oldPath = file.from && file.from !== '/dev/null' ? file.from : undefined;
    const changeType = determineChangeType(file);

    const hunks: DiffHunk[] = file.chunks.map((chunk) => ({
      oldStart: chunk.oldStart,
      oldLines: chunk.oldLines,
      newStart: chunk.newStart,
      newLines: chunk.newLines,
      content: chunk.changes.map((c) => c.content).join('\n'),
    }));

    totalAdditions += file.additions;
    totalDeletions += file.deletions;

    files.push({
      path,
      ...(changeType === 'renamed' || changeType === 'deleted' ? { oldPath } : {}),
      changeType,
      hunks,
      additions: file.additions,
      deletions: file.deletions,
    });
  }

  return { files, totalAdditions, totalDeletions, binarySkipped };
}

function findExcludePattern(path: string, excludePaths: string[]): string | undefined {
  return excludePaths.find((pattern) => minimatch(path, pattern, { matchBase: true, dot: true }));
}

/**
 * Splits diff files by the exclude glob patterns. A file is included unless it
 * matches any pattern. Each excluded file records the first pattern it matched.
 */
export function filterFilesWithAttribution(
  files: DiffFile[],
  excludePaths: string[],
): { included: DiffFile[]; excluded: RoundDiffExcludedFile[] } {
  const included: DiffFile[] = [];
  const excluded: RoundDiffExcludedFile[] = [];
  for (const file of files) {
    const matchedPattern = findExcludePattern(file.path, excludePaths);
    if (matchedPattern) {
      excluded.push({ path: file.path, matchedPattern });
    } else {
      included.push(file);
    }
  }
  return { included, excluded };
}

export function rebuildRawDiff(diff: ParsedDiff): string {
  return diff.files.map((f) => {
    const oldPath = f.oldPath ?? f.path;
    const from = f.changeType === 'added' ? '/dev/null' : `a/${oldPath}`;
    const to = f.changeType === 'deleted' ? '/dev/null' : `b/${f.path}`;
    const header = `diff --git a/${oldPath} b/${f.path}\n--- ${from}\n+++ ${to}`;
    const hunks = f.hunks.map(h => {
      const hunkHeader = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
      return `${hunkHeader}\n${h.content}`;
    }).join('\n');
    return `${header}\n${hunks}`;
  }).join('\n');
}

/**
 * Drops files matching `excludePaths` from a parsed diff and recomputes its totals.
 */
export function filterDiff(
  diff: ParsedDiff,
  excludePaths: string[],
): { diff: ParsedDiff; excluded: RoundDiffExcludedFile[] } {
  const { included, excluded } = filterFilesWithAttribution(diff.files, excludePaths);
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of included) {
    totalAdditions += file.additions ?? 0;
    totalDeletions += file.deletions ?? 0;
  }
  return { diff: { ...diff, files: included, totalAdditions, totalDeletions }, excluded };
}

/**
 * Removes files matching `excludePaths` from a raw unified diff.
 */
export function filterRawDiff(rawDiff: string, excludePaths: string[]): string {
  return rebuildRawDiff(filterDiff(parsePRDiff(rawDiff), excludePaths).diff);
}

/**
 * Returns a SHA-256 digest of the change `diff` makes once `excludePaths` are dropped.
 * Hunk positions and `index` lines are left out, so a diff moved by a rebase
 * keeps its digest.
 */
export function changeDigest(diff: ParsedDiff, excludePaths: string[]): string {
  const { files, binarySkipped } = filterDiff(diff, excludePaths).diff;
  return createHash('sha256').update(JSON.stringify([
    files.map(f => [f.changeType, f.oldPath, f.path, f.hunks.map(h => h.content)]),
    binarySkipped?.filter(path => !findExcludePattern(path, excludePaths)),
  ])).digest('hex');
}

/** Whether two raw diffs make the same change once `excludePaths` are dropped. */
export function isSameChange(a: string, b: string, excludePaths: string[]): boolean {
  return changeDigest(parsePRDiff(a), excludePaths) === changeDigest(parsePRDiff(b), excludePaths);
}

/** Returns the text of each line the diff adds to the file, keyed by its line number in the new file. */
export function addedLines(file: DiffFile): Map<number, string> {
  const added = new Map<number, string>();
  for (const hunk of file.hunks) {
    let line = hunk.newStart;
    for (const content of hunk.content.split('\n')) {
      if (content.startsWith('-') || content.startsWith('\\')) continue;
      if (content.startsWith('+')) added.set(line, content.slice(1));
      line++;
    }
  }
  return added;
}

/**
 * Check if a line number is within the diff hunks for a file.
 * GitHub only allows inline comments on lines that are part of the diff.
 */
export function isLineInDiff(file: DiffFile, line: number): boolean {
  return file.hunks.some(
    (hunk) => line >= hunk.newStart && line <= hunk.newStart + hunk.newLines - 1,
  );
}

/**
 * Sum additions and deletions across the given files. Files lacking
 * per-file counts contribute zero, matching the behavior of test fixtures
 * that omit them.
 */
export function countDiffLines(files: DiffFile[]): number {
  let total = 0;
  for (const file of files) {
    total += (file.additions ?? 0) + (file.deletions ?? 0);
  }
  return total;
}

/** Counts the added and removed lines in a file's hunks. */
export function countChangedLines(file: DiffFile): { additions: number; deletions: number } {
  const lines = file.hunks.flatMap(h => h.content.split('\n'));
  return { additions: lines.filter(l => l.startsWith('+')).length, deletions: lines.filter(l => l.startsWith('-')).length };
}

/**
 * Check if the diff size exceeds the maximum line count.
 */
export function isDiffTooLarge(diff: ParsedDiff, maxLines: number): boolean {
  return countDiffLines(diff.files) > maxLines;
}

// Lines around a new line that count as new code, as many as a diff hunk shows around a change.
const NEW_CODE_WINDOW = 3;

/** Returns the text of each line the diff removes, with the line in the new file where the removal sits. */
function removedLines(file: DiffFile): Array<[number, string]> {
  const removed: Array<[number, string]> = [];
  for (const hunk of file.hunks) {
    let line = hunk.newStart;
    for (const content of hunk.content.split('\n')) {
      if (content.startsWith('\\')) continue;
      if (content.startsWith('-')) removed.push([line, content.slice(1)]);
      else line++;
    }
  }
  return removed;
}

function countTexts(texts: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  return counts;
}

/** Takes one `text` from `counts`, and returns whether there was one to take. */
function takeText(counts: Map<string, number>, text: string): boolean {
  const left = counts.get(text) ?? 0;
  if (left > 0) counts.set(text, left - 1);
  return left > 0;
}

/**
 * Returns, per file, the lines of the new file where the PR changed its code since `prior`: a line `current`
 * adds or removes that `prior` did not, a line `prior` added or removed that `current` no longer does, and a
 * line of the PR that moved. Lines are compared by text, so a rebase or a shift in line numbers does not turn
 * reviewed code into new code. `interRound`, the diff between the two commits, says where a moved line, or a
 * line `current` no longer touches, sits. A line there counts as moved only where `current` adds it, so a
 * base branch line a rebase brings in never does.
 */
function changedSincePrior(current: ParsedDiff, prior: ParsedDiff, interRound: ParsedDiff | undefined): Map<string, number[]> {
  const fresh = new Map<string, number[]>();
  const paths = new Set([...current.files, ...(interRound?.files ?? [])].map(f => f.path));
  for (const path of paths) {
    const file = current.files.find(f => f.path === path);
    const priorFile = prior.files.find(f => f.path === path || f.path === file?.oldPath);
    const priorAdded = countTexts(priorFile ? addedLines(priorFile).values() : []);
    const priorRemoved = countTexts(priorFile ? removedLines(priorFile).map(([, text]) => text) : []);
    const added = file ? addedLines(file) : new Map<number, string>();
    const lines: number[] = [];
    for (const [line, text] of added) {
      if (!takeText(priorAdded, text)) lines.push(line);
    }
    for (const [line, text] of file ? removedLines(file) : []) {
      if (!takeText(priorRemoved, text)) lines.push(line);
    }
    const interRoundFile = interRound?.files.find(f => f.path === path);
    if (interRoundFile) {
      for (const [line, text] of removedLines(interRoundFile)) {
        if (takeText(priorAdded, text)) lines.push(line);
      }
      for (const [line, text] of addedLines(interRoundFile)) {
        if (takeText(priorRemoved, text) || added.get(line) === text) lines.push(line);
      }
    }
    if (lines.length > 0) fresh.set(path, lines);
  }
  return fresh;
}

/**
 * Sets each finding's `origin`: `new` when it sits within a few lines of code the PR changed since
 * the change `prior` recorded, `reviewed` otherwise. Without `prior`, every finding is new.
 */
export function tagFindingOrigins(findings: Finding[], diff: ParsedDiff, prior: ParsedDiff | undefined, interRound?: ParsedDiff): void {
  const fresh = prior && changedSincePrior(diff, prior, interRound);
  for (const finding of findings) {
    const lines = fresh?.get(finding.file) ?? [];
    const isNew = !fresh || !finding.file
      || (finding.line > 0 ? lines.some(line => Math.abs(line - finding.line) <= NEW_CODE_WINDOW) : lines.length > 0);
    finding.origin = isNew ? 'new' : 'reviewed';
  }
}

/** Sets each finding's `codeContext` to the hunk lines around its line, when that line is in the diff. */
export function addCodeContext(findings: Finding[], diff: ParsedDiff): void {
  for (const finding of findings) {
    if (finding.file && finding.line) {
      const diffFile = diff.files.find(f => f.path === finding.file);
      if (diffFile) {
        const hunk = diffFile.hunks.find(h =>
          finding.line >= h.newStart && finding.line <= h.newStart + h.newLines - 1,
        );
        if (hunk) {
          const lines = hunk.content.split('\n');
          const findingOffset = finding.line - hunk.newStart;
          const start = Math.max(0, findingOffset - 5);
          const end = Math.min(lines.length, findingOffset + 10);
          finding.codeContext = lines.slice(start, end).join('\n');
        }
      }
    }
  }
}

function isBinaryFile(file: parseDiff.File): boolean {
  // Binary files typically have no chunks and the diff header indicates binary
  if (file.chunks.length === 0 && file.additions === 0 && file.deletions === 0) {
    return true;
  }
  return false;
}

function determineChangeType(file: parseDiff.File): DiffFile['changeType'] {
  if (file.new) return 'added';
  if (file.deleted) return 'deleted';

  const from = file.from ?? '';
  const to = file.to ?? '';
  if (from !== to && from !== '/dev/null' && to !== '/dev/null') {
    return 'renamed';
  }

  return 'modified';
}
