/**
 * Extract a JSON object or array from LLM response text that may contain
 * markdown fences, preamble, or other non-JSON content.
 */
export declare function extractJSON(text: string): string;
