/** Keeps a path or other text from the PR on one line and out of a code span's backticks. */
export function shown(text: string): string {
  return text.replace(/[`\r\n\u2028\u2029]+/g, ' ');
}
