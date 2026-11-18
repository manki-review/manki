import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { compareTools, controlProblems, heldTools, heldToolsCall, offeredTools, plantRunnerSetup, runProblems, searchSources } from './codex-tools-check';
import { StandInRun } from './stand-in';

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

describe('searchSources', () => {
  it('names each source of held-back tools in the `tool_search` description, whatever its tools are called', () => {
    const description = '# Tool discovery\n\nSearches over deferred tool metadata.\n\nYou have access to tools from the following sources:\n'
      + '- Multi-agent tools: Spawn and manage sub-agents.\n- manki\nSome of the tools may not have been provided to you upfront.';
    expect(searchSources({ tools: [{ type: 'function', name: 'apply_patch' }, { type: 'tool_search', description }] })).toEqual(['Multi-agent tools', 'manki']);
    expect(searchSources({ tools: [{ type: 'tool_search', description: 'Searches tools.' }] })).toEqual([]);
    expect(searchSources({})).toEqual([]);
  });
});

describe('compareTools', () => {
  const expected = {
    'gpt-a': { offered: ['functions.exec'], held: ['apply_patch', 'mcp__manki__grep'], sources: [] },
    'gpt-b': { offered: ['tool_search'], held: ['mcp__manki.grep'], sources: ['manki'] },
  };

  it('passes when every model is offered exactly the listed tools', () => {
    expect(compareTools(expected, expected)).toEqual([]);
  });

  it('reports a new tool, a tool no longer offered and a model not checked', () => {
    const actual = { 'gpt-a': { offered: ['functions.exec', 'collaboration.spawn_agent'], held: ['apply_patch'], sources: [] } };
    expect(compareTools(expected, actual)).toEqual([
      'gpt-a: new in offered: collaboration.spawn_agent',
      'gpt-a: gone from held: mcp__manki__grep',
      'gpt-b: not checked',
    ]);
  });

  it('reports a new source of held-back tools that the search did not return', () => {
    const actual = { ...expected, 'gpt-b': { offered: ['tool_search'], held: ['mcp__manki.grep'], sources: ['Calendar', 'manki'] } };
    expect(compareTools(expected, actual)).toEqual(['gpt-b: new in sources: Calendar']);
  });
});

describe('runProblems and controlProblems', () => {
  const message = (role: string, ...texts: string[]) => ({ type: 'message', role, content: texts.map(text => ({ type: 'input_text', text })) });
  const run = (over: Partial<StandInRun> = {}): StandInRun => ({ bodies: [], hosts: [], paths: ['/v1/responses'], keys: ['Bearer stand-in'], ran: [], ...over });

  it('passes a run whose requests carry no skill text and that tried no other host', () => {
    const body = { input: [message('developer', 'Review the diff.', '<permissions instructions>\nRead-only.'), message('user', 'Mentions <skill> and $imagegen in passing.')] };
    expect(runProblems('gpt-a', run({ bodies: [body, body] }))).toEqual([]);
  });

  it('reports the skill catalog, a skill added in full, and each host once, except the hosts it may reach', () => {
    const catalog = { input: [message('developer', 'Review the diff.', '<skills_instructions>\n## Skills')] };
    const skill = { input: [message('user', '<skill>\n<name>imagegen</name>')] };
    const problems = ['gpt-a: a request carries Codex\'s skill text', 'gpt-a: tried to reach ab.chatgpt.com:443'];
    expect(runProblems('gpt-a', run({ bodies: [{}, catalog], hosts: ['ab.chatgpt.com:443', 'ab.chatgpt.com:443'] }))).toEqual(problems);
    expect(runProblems('gpt-a', run({ bodies: [skill], hosts: ['ab.chatgpt.com:443', 'chatgpt.com:443'] }), ['chatgpt.com:443'])).toEqual(problems);
  });

  it('reports each part of the runner\'s planted setup that reached Codex, and a control run that misses one', () => {
    const home = mkdtempSync(join(tmpdir(), 'manki-runner-home-'));
    try {
      plantRunnerSetup(home, { command: '/usr/bin/node', args: ['server.js'] }, 'http://127.0.0.1:9', join(home, 'hook-ran'));
      const files = ['.codex/skills/runner-codex-skill/SKILL.md', '.agents/skills/runner-agents-skill/SKILL.md', '.codex/AGENTS.md', '.codex/.env', '.codex/config.toml'];
      const [codexSkill, agentsSkill, agentsMd, dotenv, config] = files.map(file => readFileSync(join(home, file), 'utf8'));
      expect(dotenv).toBe('OPENAI_API_KEY=runner-dotenv-key\n');
      expect(config).toContain('[mcp_servers.runner_mcp_server]\ncommand = "/usr/bin/node"\nargs = ["server.js"]\n');
      expect(config).toContain('base_url = "http://127.0.0.1:9/runner-provider/v1"');
      expect(config).toMatch(/\[hooks\.state\."[^"]+\/\.codex\/hooks\.json:session_start:0:0"\]\ntrusted_hash = "sha256:[0-9a-f]{64}"/);
      const body = {
        tools: [{ type: 'namespace', name: 'mcp__runner_mcp_server', tools: [] }],
        input: [message('developer', codexSkill, agentsSkill), message('user', agentsMd)],
      };
      const reached = run({ bodies: [{}, body], keys: ['Bearer runner-dotenv-key'], hosts: ['runner-otel.invalid:4318'], ran: ['hook'] });
      expect(runProblems('gpt-a', reached)).toEqual([
        'gpt-a: the runner\'s skill in ~/.codex/skills reached Codex',
        'gpt-a: the runner\'s skill in ~/.agents/skills reached Codex',
        'gpt-a: the runner\'s MCP server in ~/.codex/config.toml reached Codex',
        'gpt-a: the runner\'s AGENTS.md in ~/.codex reached Codex',
        'gpt-a: the runner\'s OPENAI_API_KEY in ~/.codex/.env reached Codex',
        'gpt-a: the runner\'s otel exporter in ~/.codex/config.toml reached Codex',
        'gpt-a: the runner\'s trusted hook in ~/.codex/hooks.json reached Codex',
        'gpt-a: tried to reach runner-otel.invalid:4318',
      ]);
      expect(controlProblems('control', reached, false)).toEqual([]);
      expect(controlProblems('control', run({ bodies: [body] }), false)).toEqual([
        'control: the runner\'s OPENAI_API_KEY in ~/.codex/.env no longer reaches Codex in this control run, so the check cannot see it',
        'control: the runner\'s otel exporter in ~/.codex/config.toml no longer reaches Codex in this control run, so the check cannot see it',
        'control: the runner\'s trusted hook in ~/.codex/hooks.json no longer reaches Codex in this control run, so the check cannot see it',
      ]);

      const redirected = run({ paths: ['/runner-chatgpt/api/codex/accounts/check', '/runner-provider/v1/responses'], hosts: ['chatgpt.com:443'] });
      expect(runProblems('login', redirected, ['chatgpt.com:443'])).toEqual(['login: the runner\'s model_provider and chatgpt_base_url in ~/.codex/config.toml reached Codex']);
      expect(controlProblems('login control', redirected, true)).toEqual([]);
      expect(controlProblems('login control', run(), true)).toEqual([
        'login control: the runner\'s model_provider and chatgpt_base_url in ~/.codex/config.toml no longer reaches Codex in this control run, so the check cannot see it',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
