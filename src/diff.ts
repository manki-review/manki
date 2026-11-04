import parseDiff from 'parse-diff';
import { minimatch } from 'minimatch';

import { DiffFile, DiffHunk, ParsedDiff, RoundDiffExcludedFile } from './types';

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

/**
 * Splits diff files by the exclude glob patterns. A file is included unless it
 * matches any pattern. Each excluded file records the first pattern it matched.
 */
export function filterFilesWithAttribution(
  files: DiffFile[],
  excludePaths: string[],
): { included: DiffFile[]; excluded: RoundDiffExcludedFile[] } {
  const matchOpts = { matchBase: true, dot: true };
  const included: DiffFile[] = [];
  const excluded: RoundDiffExcludedFile[] = [];
  for (const file of files) {
    const matchedPattern = excludePaths.find((pattern) =>
      minimatch(file.path, pattern, matchOpts),
    );
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

/**
 * Check if the diff size exceeds the maximum line count.
 */
export function isDiffTooLarge(diff: ParsedDiff, maxLines: number): boolean {
  return countDiffLines(diff.files) > maxLines;
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
