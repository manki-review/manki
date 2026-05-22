/**
 * Truncate a string to a maximum length, appending "..." if truncated.
 */
export declare function truncate(text: string, maxLength: number): string;
/**
 * Truncate a string to `maxLen` code units, backing off one position if the
 * boundary would land inside a UTF-16 surrogate pair, then appending "...".
 */
export declare function safeTruncate(text: string, maxLen: number): string;
/**
 * Format a duration in milliseconds to a human-readable string.
 */
export declare function formatDuration(ms: number): string;
/**
 * Safely parse JSON, returning null on failure.
 */
export declare function safeJsonParse(text: string): unknown | null;
