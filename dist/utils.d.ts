/**
 * Truncate a string to a maximum length, appending "..." if truncated.
 */
export declare function truncate(text: string, maxLength: number): string;
/**
 * Format a duration in milliseconds to a human-readable string.
 */
export declare function formatDuration(ms: number): string;
/**
 * Safely parse JSON, returning null on failure.
 */
export declare function safeJsonParse(text: string): unknown | null;
