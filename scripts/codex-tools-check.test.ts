import { compareTools, heldTools, heldToolsCall, offeredTools } from './codex-tools-check';

describe('offeredTools', () => {
  it('names the tools of the request and of an `additional_tools` item, a namespace\'s as `namespace.name`', () => {
    const body = {
      tools: [{ type: 'function', name: 'read_mcp_resource' }, { type: 'tool_search' }],
      input: [
        { type: 'additional_tools', tools: [
          { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }, { type: 'function', name: 'wait' }] },
          { type: 'namespace', name: 'clock', tools: [{ type: 'function', name: 'sleep' }] },
        ] },
        { type: 'message', role: 'user', content: [] },
      ],
    };
    expect(offeredTools(body)).toEqual(['clock.sleep', 'functions.exec', 'functions.wait', 'read_mcp_resource', 'tool_search']);
    expect(offeredTools({})).toEqual([]);
  });
});

describe('heldTools and heldToolsCall', () => {
  it('asks the script host for its tools and reads the list from its output', () => {
    expect(heldToolsCall(['functions.exec', 'tool_search'])).toMatchObject({ type: 'custom_tool_call', name: 'exec', namespace: 'functions' });
    const body = { input: [{ type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: '["read_file","apply_patch"]' }] }] };
    expect(heldTools(body)).toEqual(['apply_patch', 'read_file']);
  });

  it('asks `tool_search` when there is no script host, and reads the tools it returns', () => {
    expect(heldToolsCall(['apply_patch', 'tool_search'])).toMatchObject({ type: 'tool_search_call', execution: 'client' });
    const body = { input: [{ type: 'tool_search_output', tools: [{ type: 'namespace', name: 'mcp__manki', tools: [{ type: 'function', name: 'grep' }] }] }] };
    expect(heldTools(body)).toEqual(['mcp__manki.grep']);
  });

  it('asks nothing when Codex offers neither, and finds no list in a request without an output', () => {
    expect(heldToolsCall(['read_mcp_resource'])).toBeUndefined();
    expect(heldTools({ input: [{ type: 'message' }] })).toEqual([]);
  });
});

describe('compareTools', () => {
  const expected = { 'gpt-a': { offered: ['functions.exec'], held: ['apply_patch', 'mcp__manki__grep'] }, 'gpt-b': { offered: ['tool_search'], held: [] } };

  it('passes when every model is offered exactly the listed tools', () => {
    expect(compareTools(expected, expected)).toEqual([]);
  });

  it('reports a new tool, a tool no longer offered and a model not checked', () => {
    const actual = { 'gpt-a': { offered: ['functions.exec', 'collaboration.spawn_agent'], held: ['apply_patch'] } };
    expect(compareTools(expected, actual)).toEqual([
      'gpt-a: a new offered tool collaboration.spawn_agent',
      'gpt-a: no longer held mcp__manki__grep',
      'gpt-b: not checked',
    ]);
  });
});
