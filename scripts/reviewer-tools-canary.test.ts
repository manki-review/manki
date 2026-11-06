import { findProblems, readStream, ToolCall } from './reviewer-tools-canary';

function stream(...events: unknown[]): string {
  return events.map(e => JSON.stringify(e)).join('\n');
}

describe('readStream', () => {
  it('pairs each tool call with its result and keeps the final reply', () => {
    const out = stream(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/proc/self/environ' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'outside the working directories', is_error: true }] } },
      'not json',
      { type: 'result', result: 'done' },
    );
    expect(readStream(out)).toEqual({
      calls: [{ name: 'Read', input: '{"file_path":"/proc/self/environ"}', result: 'outside the working directories', isError: true }],
      reply: 'done',
    });
  });
});

describe('findProblems', () => {
  const refused = (path: string): ToolCall => ({ name: 'Read', input: path, result: 'refused', isError: true });
  const outside = ['/proc/', '/tmp/scratch'];
  const tries = ['/proc/self/environ', '/proc/9/environ', '/tmp/scratch/a', '/tmp/scratch/b', '/tmp/scratch/c', '/tmp/scratch/d'].map(refused);
  const inside: ToolCall = { name: 'Read', input: '/repo/inside.txt', result: '1\tmarker', isError: false };
  const insideRelated: ToolCall = { name: 'mcp__manki__read_file', input: '{"repo":"o/r","path":"a.txt"}', result: '1\trelated', isError: false };

  it('passes when every outside call is refused and each inside file was read', () => {
    expect(findProblems({ calls: [...tries, inside, insideRelated], reply: 'ok' }, ['s3cret'], outside, ['marker', 'related'])).toEqual([]);
  });

  it('reports an outside call that succeeded, a leaked secret, too few attempts and a missing inside read', () => {
    const leaked: ToolCall = { name: 'Grep', input: '/tmp/scratch', result: 's3cret', isError: false };
    expect(findProblems({ calls: [tries[0], leaked, inside], reply: '' }, ['s3cret'], outside, ['marker', 'related'])).toEqual([
      'a secret was read: s3cr…',
      'Grep /tmp/scratch succeeded',
      'only 2 tool calls tried an outside path',
      'the inside file holding related was never read',
    ]);
  });
});
