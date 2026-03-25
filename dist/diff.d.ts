import { DiffFile, ParsedDiff } from './types';
/**
 * Parse a unified diff string into structured data.
 */
export declare function parsePRDiff(rawDiff: string): ParsedDiff;
/**
 * Filter diff files based on include/exclude glob patterns.
 * A file is included if it matches ANY include pattern (or include is empty)
 * AND doesn't match ANY exclude pattern.
 */
export declare function filterFiles(files: DiffFile[], includePaths: string[], excludePaths: string[]): DiffFile[];
/**
 * Check if a line number is within the diff hunks for a file.
 * GitHub only allows inline comments on lines that are part of the diff.
 */
export declare function isLineInDiff(file: DiffFile, line: number): boolean;
/**
 * Find the closest valid diff line for a finding.
 * Returns the exact line if it's in a hunk, otherwise the nearest hunk line.
 * Returns null if the file has no hunks.
 */
export declare function findClosestDiffLine(file: DiffFile, line: number): number | null;
/**
 * Check if the total diff size exceeds the maximum line count.
 */
export declare function isDiffTooLarge(diff: ParsedDiff, maxLines: number): boolean;
