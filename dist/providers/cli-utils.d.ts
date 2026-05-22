export declare const STALE_TIMEOUT_MS = 90000;
/** Strip GitHub Actions workflow commands to prevent injection when logging CLI output. */
export declare function sanitizeLogOutput(text: string): string;
/**
 * Extract a useful snippet from CLI stderr for error messages. CLIs (Codex,
 * Gemini, Claude) frequently emit a final `ERROR: {...}` line with a JSON
 * payload that contains the actionable `message` field. Returning that line
 * whole is more useful than a fixed head slice, which routinely cuts the JSON
 * mid-string. When no `ERROR:` line is present, falls back to the first
 * `maxFallbackChars` characters. Always applies `sanitizeLogOutput`.
 * `maxErrorLineLen` caps the returned ERROR line to avoid embedding
 * pathologically large strings in annotations and error objects.
 */
export declare function extractCliErrorSnippet(stderrText: string, maxFallbackChars?: number, maxErrorLineLen?: number): string;
/** Build diagnostic snippets for timeout/stale error messages. */
export declare function buildTimeoutDiagnostics(lastStdoutChunk: string, stderrText: string): string;
export interface ExitDiagnosticsInput {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    lastStdoutChunk: string;
    model: string;
    effort?: string;
    promptChars: number;
    elapsedMs: number;
    /**
     * The full parsed terminal `result` event from a stream-json CLI (currently
     * only Claude). When provided, the diagnostic appends a compact summary of
     * `is_error`, `subtype`, and the first 300 chars of the result/message text.
     *
     * - Omit this field entirely to suppress the result section from the output
     *   (appropriate for providers whose CLIs do not emit a terminal result event).
     * - Pass `null` explicitly to show `<no result event>`, signalling that the
     *   CLI exited before flushing a terminal event (used by the Claude path when
     *   `lastResultEvent` was never set during streaming).
     * - Pass the parsed event object to render `is_error`, `subtype`, etc.
     */
    resultEvent?: unknown;
}
/**
 * Build a single descriptive string for the non-zero-exit branch of a CLI
 * invocation. Captures runtime context (model, effort, prompt size, elapsed
 * time, byte counts) and a 500-char stdout tail so empty-stderr failures are
 * still actionable. The caller interpolates this inside its own
 * `"<provider> CLI failed (...)"` framing.
 */
export declare function buildExitDiagnostics(input: ExitDiagnosticsInput): string;
export interface SeedAuthFileOptions {
    /** Base64-encoded JSON blob from a GitHub secret. */
    secret: string;
    /** Action input name, used in error messages. */
    inputName: string;
    /** Absolute path the CLI reads on disk. */
    targetPath: string;
    /**
     * Dotted JSON paths the decoded blob must contain (e.g. `tokens.access_token`).
     * Used to fail fast on malformed secrets and to reject the legacy single-token shape.
     */
    requiredFields: string[];
    /** Bootstrap command shown to the user when validation fails. */
    bootstrapHint: string;
}
/**
 * Decode a base64-encoded auth file from a GitHub secret and write it to disk
 * with mode 0600, only when the target file is absent. Preserving an existing
 * file lets CLIs that refresh tokens in place keep their refreshed credentials
 * across invocations on persistent runners.
 */
export declare function seedAuthFile(opts: SeedAuthFileOptions): void;
//# sourceMappingURL=cli-utils.d.ts.map