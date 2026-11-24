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

  it('reads past brackets in the prose and falls back when one could be an answer', () => {
    const whole = JSON.stringify({ findings: [{ id: 1, title: 'See [1], {x} and "[2]', proof: ['a.ts:1', 'b.ts:2'] }, { id: 2, proof: [] }], threads: [] }, null, 1);
    const answer = JSON.stringify(JSON.parse(whole).findings);
    for (const text of [whole, answer]) {
      for (const [before, after] of [
        ['Grades for [42 findings]:\n', ''], ['', '\nSee [1].'], ['Grades for [42 findings]:\n', '\nSee [1].'],
        ['- [x] `list[0]`, {id} and [a link](b)\n', '\nIt is "done" [2], [3].'], ['The "first" [1:\n2] and 3]\n', ''],
      ]) {
        for (const [open, close] of [['', ''], ['```json\n', '\n```']]) {
          for (let at = 1; at < text.length; at++) expect(joinedJSON(before + open + text.slice(0, at), text.slice(at) + close + after)).toBe(text);
        }
      }
      for (const [before, after] of [
        // The bracket can be a whole answer, an example of one, or cannot be told apart from the start or end of one.
        ['Example: {"id": 9}\n', ''], ['', '\nExample: {"id": 9}'], ['Proof is ["a.ts:1"].\n', ''], ['', '\nProof is ["a.ts:1"].'],
        ['Draft: []\n', ''], ['', '\nInstead: []'], ['Draft: {}\n', ''], ['', '\nInstead: {}'], ['Pairs [[1], [2]]\n', ''], ['', '\nPairs [[1], [2]]'],
        ['See [1:\n', ''], ['', '\nSee [1'], ['', '\nSee 1]'], ['Says ["x]:\n', ''], ['', ']}'],
      ]) {
        for (let at = 1; at < text.length; at++) expect(joinedJSON(before + text.slice(0, at), text.slice(at) + after)).toBeUndefined();
      }
    }
    // An entry or a proof list is never taken for the answer that holds it, whether that is left open or does not fit.
    for (const part of [JSON.stringify({ id: 1, proof: ['a.ts:1'] }), '["a.ts:1", "b.ts:2"]']) {
      for (const [open, close] of [['{"findings": [\n', ''], ['{"findings": [\n', ']'], ['[{"id": 0}\n', ']'], ['Grades for [42 findings]:\n[{"id": 0} x\n', ''], ['See [1:\n[{"id": 0},\n', '']]) {
        for (let at = 1; at < part.length; at++) expect(joinedJSON(open + part.slice(0, at), part.slice(at) + close)).toBeUndefined();
      }
    }
    // A value in the prose that the cut goes through is no answer.
    for (const tail of ['2].', `2].\n${whole}`, '2].\n[]']) expect(joinedJSON('See [1, ', tail)).toBeUndefined();
    for (const tail of ['}.', `}.\n${whole}`]) expect(joinedJSON('See {', tail)).toBeUndefined();
    expect(joinedJSON('Such as {"id": ', `9}.\n${whole}`)).toBeUndefined();
    expect(joinedJSON(`${whole}\nSuch as {"id": `, '9}.')).toBeUndefined();
  });
});
