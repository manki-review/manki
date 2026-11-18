/** A TOML table as `parseTomlSubset` returns it. Scalars other than strings stay as their text, such as `true` or `1.5`. */
export interface TomlTable {
  [key: string]: TomlValue;
}
type TomlValue = string | TomlTable | TomlValue[];

/** Thrown for TOML that `parseTomlSubset` does not read with certainty. */
class UncertainToml extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
const BARE_SCALAR = /[A-Za-z0-9_:.+-]/;

const isTable = (value: TomlValue | undefined): value is TomlTable => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses the part of TOML that manifests use: tables, arrays of tables, dotted keys, inline tables, arrays, and
 * strings. Throws `UncertainToml` for anything else, such as an unknown escape, an unclosed string, a key defined twice
 * or a line it does not recognise, so a caller never reads a guess. Scalars other than strings are not checked.
 */
export function parseTomlSubset(text: string): TomlTable {
  const root: TomlTable = {};
  const defined = new Set<TomlValue>();
  let at = 0;
  const fail = (what: string): never => {
    throw new UncertainToml(`${what} on line ${text.slice(0, at).split('\n').length}`);
  };
  const skipSpaces = () => {
    while (text[at] === ' ' || text[at] === '\t') at++;
  };
  const skipComment = () => {
    if (text[at] === '#') while (at < text.length && text[at] !== '\n') at++;
  };
  // Inside an array, newlines and comments may sit between values.
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (text[at] === '\n' || text[at] === '\r') at++;
      else return;
    }
  };
  const endOfLine = () => {
    skipSpaces();
    skipComment();
    if (text[at] === '\r') at++;
    if (at < text.length && text[at] !== '\n') fail('unexpected text');
  };
  // Reads a string, a multi-line one too where `multiline` allows it, as a value does and a key does not.
  const quoted = (multiline = false): string => {
    const quote = text[at];
    const fence = quote.repeat(3);
    const triple = multiline && text.startsWith(fence, at);
    at += triple ? 3 : 1;
    // A newline right after the opening quotes is not part of a multi-line string.
    if (triple) at += text.startsWith('\r\n', at) ? 2 : text[at] === '\n' ? 1 : 0;
    let value = '';
    for (;;) {
      if (triple && text.startsWith(fence, at)) {
        // Up to two quotes before the closing three belong to the string.
        let end = at + 3;
        while (text[end] === quote && end - at < 5) end++;
        value += quote.repeat(end - at - 3);
        at = end;
        return value;
      }
      const c = text[at++];
      if (c === undefined || (c === '\n' && !triple)) fail('an unclosed string');
      if (!triple && c === quote) return value;
      if (c !== '\\' || quote === "'") {
        value += c;
        continue;
      }
      if (triple && /[ \t\r\n]/.test(text[at] ?? '')) {
        // A backslash at the end of a line joins the next one, without the whitespace between.
        let newline = false;
        while (/[ \t\r\n]/.test(text[at] ?? '')) newline = text[at++] === '\n' || newline;
        if (!newline) fail('an escape it does not read');
        continue;
      }
      const escape = text[at++];
      const digits = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
      if (digits > 0) {
        const hex = text.slice(at, at + digits);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== digits) fail('an escape it does not read');
        value += String.fromCodePoint(parseInt(hex, 16));
        at += digits;
      } else if (Object.hasOwn(ESCAPES, escape)) {
        value += ESCAPES[escape];
      } else {
        fail('an escape it does not read');
      }
    }
  };
  const key = (): string[] => {
    const path: string[] = [];
    for (;;) {
      skipSpaces();
      if (text[at] === '"' || text[at] === "'") path.push(quoted());
      else {
        const start = at;
        while (at < text.length && BARE_KEY.test(text[at])) at++;
        if (at === start) fail('a key it does not read');
        path.push(text.slice(start, at));
      }
      skipSpaces();
      if (text[at] !== '.') return path;
      at++;
    }
  };
  // Returns the table at `path` under `table`, creating the tables on the way. An array of tables yields its last one.
  const descend = (table: TomlTable, path: string[]): TomlTable => {
    let current = table;
    for (const part of path) {
      const next = current[part] ?? (current[part] = {});
      const last = Array.isArray(next) ? next.at(-1) : next;
      if (!isTable(last)) fail(`the key ${path.join('.')} set twice`);
      current = last as TomlTable;
    }
    return current;
  };
  const assign = (table: TomlTable, path: string[], value: TomlValue) => {
    const parent = descend(table, path.slice(0, -1));
    const last = path.at(-1)!;
    if (Object.hasOwn(parent, last)) fail(`the key ${path.join('.')} set twice`);
    parent[last] = value;
  };
  const value = (): TomlValue => {
    skipSpaces();
    const c = text[at];
    if (c === '"' || c === "'") return quoted(true);
    if (c === '[') {
      at++;
      const items: TomlValue[] = [];
      for (;;) {
        skipBlank();
        if (text[at] === ']') break;
        items.push(value());
        skipBlank();
        if (text[at] === ',') at++;
        else if (text[at] !== ']') fail('an array it does not read');
      }
      at++;
      return items;
    }
    if (c === '{') {
      at++;
      const table: TomlTable = {};
      skipSpaces();
      if (text[at] === '}') {
        at++;
        return table;
      }
      for (;;) {
        const path = key();
        if (text[at] !== '=') fail('an inline table it does not read');
        at++;
        assign(table, path, value());
        skipSpaces();
        if (text[at] === '}') break;
        if (text[at] !== ',') fail('an inline table it does not read');
        at++;
      }
      at++;
      return table;
    }
    const start = at;
    while (at < text.length && BARE_SCALAR.test(text[at])) at++;
    if (at === start) fail('a value it does not read');
    return text.slice(start, at);
  };

  let table = root;
  for (;;) {
    skipBlank();
    if (at >= text.length) return root;
    if (text[at] === '[') {
      const many = text[at + 1] === '[';
      at += many ? 2 : 1;
      const path = key();
      if (text.slice(at, at + (many ? 2 : 1)) !== (many ? ']]' : ']')) fail('a table header it does not read');
      at += many ? 2 : 1;
      endOfLine();
      if (many) {
        const parent = descend(root, path.slice(0, -1));
        const last = path.at(-1)!;
        const list = parent[last] ?? (parent[last] = []);
        if (!Array.isArray(list)) fail(`the table ${path.join('.')} set twice`);
        table = {};
        (list as TomlValue[]).push(table);
      } else {
        table = descend(root, path);
        if (defined.has(table)) fail(`the table ${path.join('.')} set twice`);
      }
      defined.add(table);
      continue;
    }
    const path = key();
    if (text[at] !== '=') fail('a line it does not read');
    at++;
    assign(table, path, value());
    endOfLine();
  }
}

/** Returns `value` as a table, or an empty one. */
export function tableOf(value: TomlValue | undefined): TomlTable {
  return isTable(value) ? value : {};
}
