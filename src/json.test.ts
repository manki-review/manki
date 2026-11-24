import { extractJSON, joinedJSON } from './json';

describe('extractJSON', () => {
  it('returns clean JSON as-is', () => {
    const json = '{"key": "value"}';
    expect(extractJSON(json)).toBe(json);
  });

  it('strips markdown json fences', () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(JSON.parse(extractJSON(input))).toEqual({ key: 'value' });
  });

  it('strips markdown fences without language tag', () => {
    const input = '```\n[1, 2, 3]\n```';
    expect(JSON.parse(extractJSON(input))).toEqual([1, 2, 3]);
  });

  it('extracts JSON object from surrounding text', () => {
    const input = 'Here is the result:\n\n{"verdict": "APPROVE", "findings": []}\n\nDone.';
    expect(JSON.parse(extractJSON(input))).toEqual({ verdict: 'APPROVE', findings: [] });
  });

  it('extracts JSON array from surrounding text', () => {
    const input = 'Found these issues:\n[{"title": "bug"}]\nEnd of review.';
    expect(JSON.parse(extractJSON(input))).toEqual([{ title: 'bug' }]);
  });

  it('prefers whichever JSON structure appears first in freeform text', () => {
    const input = 'Result: {"data": [1,2,3]}';
    const result = JSON.parse(extractJSON(input));
    expect(result).toEqual({ data: [1, 2, 3] });
  });

  it('prefers array when it appears before object', () => {
    const input = 'Found: [{"id": 1}] and also {"extra": true}';
    const result = JSON.parse(extractJSON(input));
    expect(result).toEqual([{ id: 1 }]);
  });

  it('returns original text when no JSON found', () => {
    const input = 'no json here';
    expect(extractJSON(input)).toBe('no json here');
  });

  it('handles whitespace around fences', () => {
    const input = '  ```json\n{"a": 1}\n```  ';
    expect(JSON.parse(extractJSON(input))).toEqual({ a: 1 });
  });

  it('extracts first balanced JSON object when multiple objects exist', () => {
    const input = '{"a":1} text {"b":2}';
    const result = JSON.parse(extractJSON(input));
    expect(result).toEqual({ a: 1 });
  });

  it('extracts first balanced JSON array when multiple arrays exist', () => {
    const input = 'prefix [1, 2] middle [3, 4] suffix';
    const result = JSON.parse(extractJSON(input));
    expect(result).toEqual([1, 2]);
  });

  it('handles nested braces correctly', () => {
    const input = 'Result: {"outer": {"inner": [1, 2]}} trailing text';
    const result = JSON.parse(extractJSON(input));
    expect(result).toEqual({ outer: { inner: [1, 2] } });
  });

  it('handles strings containing braces', () => {
    const input = 'preamble {"key": "value with { and } inside"} done';
    const result = JSON.parse(extractJSON(input));
    expect(result).toEqual({ key: 'value with { and } inside' });
  });

  it('handles escaped quotes in strings', () => {
    const input = 'preamble {"key": "value with \\"quotes\\""} done';
    const result = JSON.parse(extractJSON(input));
    expect(result).toEqual({ key: 'value with "quotes"' });
  });
  it('skips bracketed prose before the object when an object is expected', () => {
    const input = 'The diff touches [changeType] handling in two files.\n\n```json\n{"verdict": "READY", "blockers": []}\n```';
    expect(JSON.parse(extractJSON(input, 'object'))).toEqual({ verdict: 'READY', blockers: [] });
  });

  it('skips a leading object when an array is expected', () => {
    const input = 'Context {"note": "x"} then the findings: [{"title": "bug"}]';
    expect(JSON.parse(extractJSON(input, 'array'))).toEqual([{ title: 'bug' }]);
  });

  it('moves past a bracketed span that is not JSON', () => {
    const input = 'See [the docs] for details. {"a": 1}';
    expect(JSON.parse(extractJSON(input))).toEqual({ a: 1 });
  });

  it('returns the cleaned text when nothing of the expected shape parses', () => {
    expect(extractJSON('only [1, 2] here', 'object')).toBe('only [1, 2] here');
  });
});

describe('joinedJSON', () => {
  it('joins an answer cut at any place, and never one that starts over', () => {
    const whole = JSON.stringify({ summary: 'A "quoted" {brace} and [bracket] \\ path\n', findings: [{ id: 1, proof: ['a.ts:1', 'b.ts:2'], notes: {} }, { id: 2, proof: [] }], threads: [] }, null, 1);
    for (const text of [whole, JSON.stringify(JSON.parse(whole).findings)]) {
      const fenced = `\`\`\`json\n${text}\n\`\`\``;
      for (let at = 1; at < text.length; at++) {
        const head = text.slice(0, at);
        expect(joinedJSON(head, text.slice(at))).toBe(text);
        for (const restart of [text, fenced, `Again: ${fenced}`, `${fenced}\nDone.`]) expect(joinedJSON(head, restart)).toBeUndefined();
      }
    }
    expect([joinedJSON('', whole), joinedJSON(whole, ' done.'), joinedJSON('No', ' JSON.')]).toEqual([undefined, undefined, undefined]);
  });
});
