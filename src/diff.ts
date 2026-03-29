import parseDiff from 'parse-diff';
import { minimatch } from 'minimatch';

import { DiffFile, DiffHunk, ParsedDiff } from './types';

/**
 * Parse a unified diff string into structured data.
 */
export function parsePRDiff(rawDiff: string): ParsedDiff {
  if (!rawDiff.trim()) {
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  }

  const parsed = parseDiff(rawDiff);
  let totalAdditions = 0;
  let totalDeletions = 0;
  const files: DiffFile[] = [];

  for (const file of parsed) {
    // Skip binary files (they have no meaningful chunks)
    if (isBinaryFile(file)) {
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
    });
  }

  return { files, totalAdditions, totalDeletions };
}

/**
 * Filter diff files based on exclude glob patterns.
 * A file is included unless it matches ANY exclude pattern.
 */
export function filterFiles(
  files: DiffFile[],
  excludePaths: string[],
): DiffFile[] {
  return files.filter((file) => {
    const matchOpts = { matchBase: true, dot: true };

    const excluded = excludePaths.some((pattern) =>
      minimatch(file.path, pattern, matchOpts),
    );

    return !excluded;
  });
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
 * Find the closest valid diff line for a finding.
 * Returns the exact line if it's in a hunk, otherwise the nearest hunk line.
 * Returns null if the file has no hunks.
 */
export function findClosestDiffLine(file: DiffFile, line: number): number | null {
  if (file.hunks.length === 0) return null;

  if (isLineInDiff(file, line)) return line;

  let closest: number | null = null;
  let minDistance = Infinity;

  for (const hunk of file.hunks) {
    const hunkEnd = hunk.newStart + hunk.newLines - 1;

    // Check distance to hunk start
    const distStart = Math.abs(line - hunk.newStart);
    if (distStart < minDistance) {
      minDistance = distStart;
      closest = hunk.newStart;
    }

    // Check distance to hunk end
    const distEnd = Math.abs(line - hunkEnd);
    if (distEnd < minDistance) {
      minDistance = distEnd;
      closest = hunkEnd;
    }
  }

  return closest;
}

/**
 * Check if the total diff size exceeds the maximum line count.
 */
export function isDiffTooLarge(diff: ParsedDiff, maxLines: number): boolean {
  return diff.totalAdditions + diff.totalDeletions > maxLines;
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
