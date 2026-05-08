export const STALE_TIMEOUT_MS = 90_000;

/** Strip GitHub Actions workflow commands to prevent injection when logging CLI output. */
export function sanitizeLogOutput(text: string): string {
  // Matches any line segment starting with :: followed by a letter — covers all workflow commands
  // regardless of parameter format (e.g. ::error file=foo.ts,line=5::message)
  return text.replace(/::[a-z].*$/gim, '[redacted-workflow-cmd]');
}
