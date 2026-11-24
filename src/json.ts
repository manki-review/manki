type JsonShape = 'object' | 'array';

// Bounds the scan so a long reply full of unmatched brackets cannot turn extraction quadratic.
const MAX_CANDIDATES = 50;

function parsesAs(text: string, shape?: JsonShape): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (!shape) return true;
    if (shape === 'array') return Array.isArray(value);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** Returns the index of the bracket that closes the one at `start`, or -1 when it never closes. */
function matchingClose(text: string, start: number): number {
  const openChar = text[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;

    if (depth === 0) return i;
  }
  return -1;
}

// A bracket pair such as `[42 findings]` that cannot be an answer: it is not empty and holds no quote and no other bracket.
const PROSE_BRACKETS = /[{[]\s*[^\s"{}[\]][^"{}[\]]*[}\]]/g;

/**
 * Returns the JSON answer that starts in `head` and ends in `tail`, or undefined when another bracket around it could
 * belong to an answer too. Only a first bracket is tried, since a later one can open a part of the answer.
 */
export function joinedJSON(head: string, tail: string): string | undefined {
  const start = head.replace(PROSE_BRACKETS, m => ' '.repeat(m.length)).search(/[{[]/);
  if (start === -1) return undefined;
  const text = head + tail;
  const end = matchingClose(text, start);
  if (end < head.length) return undefined;
  if (/[{}[\]]/.test(text.slice(end + 1).replace(PROSE_BRACKETS, ''))) return undefined;
  const joined = text.slice(start, end + 1);
  return /^(?:\[\s*)?\{\s*"/.test(joined) && parsesAs(joined) ? joined : undefined;
}

/**
 * Extract a JSON object or array from LLM response text that may contain
 * markdown fences, preamble, or other non-JSON content. With `shape`, only a
 * value of that kind is accepted, so prose such as `[changeType]` before the
 * real object is skipped.
 */
export function extractJSON(text: string, shape?: JsonShape): string {
  let cleaned = text.trim();

  // Strip markdown fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
  }

  if (parsesAs(cleaned, shape)) return cleaned;

  const opens = shape === 'object' ? '{' : shape === 'array' ? '[' : '{[';
  let tried = 0;
  for (let i = 0; i < cleaned.length && tried < MAX_CANDIDATES; i++) {
    if (!opens.includes(cleaned[i])) continue;
    tried++;
    const end = matchingClose(cleaned, i);
    if (end === -1) continue;
    const candidate = cleaned.slice(i, end + 1);
    if (parsesAs(candidate, shape)) return candidate;
  }

  return cleaned;
}
