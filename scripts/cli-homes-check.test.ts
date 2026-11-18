import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { CLAUDE_SETUP, CLOUD_CREDENTIALS, GEMINI_SETUP, GEMINI_TEMP_DOTENV, plantClaudeSetup, plantCloudCredentials, plantGeminiSetup } from './cli-homes-check';
import { controlProblems, newRun, plantedProblems, StandInRun } from './stand-in';

describe('the planted Claude and Gemini setups', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'manki-runner-home-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const read = (file: string): string => readFileSync(join(home, file), 'utf8');

  it('plants a Claude setup whose settings point at the stand-in and whose commands create their flags', () => {
    plantClaudeSetup(home, { command: '/usr/bin/node', args: ['server.js'] }, 'http://127.0.0.1:9', '/flags');
    const settings = JSON.parse(read('.claude/settings.json'));
    expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/runner-settings/' });
    expect(settings.enabledPlugins).toEqual({ 'runner-plugin@runner-market': true });
    expect(read(settings.apiKeyHelper.slice(home.length + 1))).toContain("touch '/flags/key-helper'");
    expect(read(settings.hooks.SessionStart[0].hooks[0].command.slice(home.length + 1))).toContain("touch '/flags/hook'");
    expect(JSON.parse(read('.claude.json')).mcpServers).toEqual({ runner_mcp_server: { type: 'stdio', command: '/usr/bin/node', args: ['server.js'] } });
    for (const file of ['CLAUDE.md', 'rules/runner.md', 'skills/runner-claude-skill/SKILL.md', 'commands/runner-command.md', 'agents/runner-agent.md', 'plugins/installed_plugins.json']) {
      expect(existsSync(join(home, '.claude', file))).toBe(true);
    }
  });

  it('plants a Gemini setup whose `.env` files and telemetry point at the stand-in, with a login of its own', () => {
    plantGeminiSetup(home, join(home, 'temp'), 'http://127.0.0.1:9', '/flags');
    expect(read('.gemini/.env')).toBe('CODE_ASSIST_ENDPOINT=http://127.0.0.1:9/runner-dotenv\n');
    expect(read('temp/.env')).toBe('CODE_ASSIST_ENDPOINT=http://127.0.0.1:9/runner-temp-dotenv\n');
    expect(JSON.parse(read('.gemini/oauth_creds.json')).access_token).toBe('runner-oauth-token');
    const settings = JSON.parse(read('.gemini/settings.json'));
    expect(settings.telemetry.otlpEndpoint).toBe('http://127.0.0.1:9/runner-otel');
    expect(settings.mcpServers.runner_mcp_server.args.join(' ')).toContain('/flags/mcp-server');
    expect(JSON.parse(read('.gemini/extensions/runner-extension/gemini-extension.json')).contextFileName).toBe('RUNNER.md');
    for (const file of ['.gemini/GEMINI.md', '.gemini/skills/runner-gemini-skill/SKILL.md', '.agents/skills/runner-agents-skill/SKILL.md']) {
      expect(existsSync(join(home, file))).toBe(true);
    }
  });

  it('plants the runner\'s Bedrock profile, SSO login and Vertex login, and turns the setup for each on', () => {
    expect(plantCloudCredentials(home, 'sso', 'http://127.0.0.1:9')).toEqual(expect.objectContaining({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'runner' }));
    expect(read('.aws/config')).toContain('sso_session = runner\n');
    // The AWS SDK looks for the token under the SHA-1 of the session name.
    expect(JSON.parse(read(`.aws/sso/cache/${createHash('sha1').update('runner').digest('hex')}.json`)).accessToken).toBe('runner-sso-token');
    expect(plantCloudCredentials(home, 'bedrock', 'http://127.0.0.1:9')).toEqual(expect.objectContaining({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: 'http://127.0.0.1:9', AWS_PROFILE: 'runner' }));
    expect(read('.aws/credentials')).toContain('[runner]\naws_access_key_id = AKIARUNNERPROFILE\n');
    expect(read('.aws/config')).toBe('[profile runner]\nregion = us-east-1\n');
    expect(plantCloudCredentials(home, 'vertex', 'http://127.0.0.1:9')).toEqual(expect.objectContaining({ CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_BASE_URL: 'http://127.0.0.1:9' }));
    expect(JSON.parse(read('.config/gcloud/application_default_credentials.json'))).toEqual(expect.objectContaining({ type: 'authorized_user', refresh_token: 'runner-adc-refresh' }));
  });
});

describe('the problems of a planted part', () => {
  const run = (over: Partial<StandInRun>): StandInRun => ({ ...newRun(), ...over });

  it('reports each part of the Claude setup a run shows, and a control run that misses one', () => {
    const reached = run({
      bodies: [{ system: 'runner-claude-md runner-claude-rule', tools: ['runner-claude-skill runner-claude-command runner-claude-agent runner-plugin-skill mcp__runner_mcp_server__grep'] }],
      paths: ['/runner-settings/v1/messages'],
      keys: ['Bearer runner-helper-key'],
      ran: ['hook'],
    });
    expect(plantedProblems('claude', 'Claude', CLAUDE_SETUP, reached)).toHaveLength(CLAUDE_SETUP.length);
    expect(controlProblems('control', 'Claude', CLAUDE_SETUP, reached)).toEqual([]);
    const clean = run({ bodies: [{ system: 'Reply with OK.' }], paths: ['/v1/messages'], keys: ['Bearer manki'] });
    expect(plantedProblems('claude', 'Claude', CLAUDE_SETUP, clean)).toEqual([]);
    expect(controlProblems('control', 'Claude', CLAUDE_SETUP, run({ ...reached, ran: [], keys: [] }))).toEqual([
      'control: the runner\'s hook in ~/.claude/settings.json no longer reaches Claude in this control run, so the check cannot see it',
      'control: the runner\'s apiKeyHelper in ~/.claude/settings.json no longer reaches Claude in this control run, so the check cannot see it',
    ]);
  });

  it('reports each part of the Gemini setup a run shows, the runner\'s login by the token sent', () => {
    const reached = run({
      bodies: [{ request: 'runner-gemini-md runner-gemini-skill runner-agents-skill runner-extension-context' }],
      paths: ['/runner-dotenv/v1internal:loadCodeAssist', '/runner-otel/v1/logs'],
      keys: ['Bearer runner-oauth-token'],
      ran: ['mcp-server', 'hook'],
    });
    expect(plantedProblems('gemini', 'Gemini', GEMINI_SETUP, reached)).toHaveLength(GEMINI_SETUP.length);
    const clean = run({ bodies: [{ request: 'Reply with OK.' }], paths: ['https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'], keys: ['Bearer manki'] });
    expect(plantedProblems('gemini', 'Gemini', GEMINI_SETUP, clean)).toEqual([]);
    expect(plantedProblems('gemini', 'Gemini', GEMINI_SETUP, run({ ran: ['extension-mcp-server'] }))).toEqual(['gemini: the runner\'s extension in ~/.gemini/extensions reached Gemini']);
    expect(plantedProblems('gemini', 'Gemini', [GEMINI_TEMP_DOTENV], run({ paths: ['/runner-temp-dotenv/v1internal:loadCodeAssist'] })))
      .toEqual(['gemini: the runner\'s .env in the temp folder above the working folder reached Gemini']);
    expect(controlProblems('control', 'Gemini', [GEMINI_TEMP_DOTENV], clean)).toHaveLength(1);
  });

  it('sees the runner\'s Bedrock profile by the key a request is signed with, and its Vertex login by the token it refreshes with', () => {
    const signed = run({ keys: ['AWS4-HMAC-SHA256 Credential=AKIARUNNERPROFILE/20261118/us-east-1/bedrock/aws4_request, SignedHeaders=host, Signature=0'] });
    expect(controlProblems('claude on bedrock', 'Claude', [CLOUD_CREDENTIALS.bedrock], signed)).toEqual([]);
    expect(controlProblems('claude on bedrock', 'Claude', [CLOUD_CREDENTIALS.bedrock], run({ keys: ['Bearer manki'] }))).toEqual([
      'claude on bedrock: the runner\'s Bedrock profile in ~/.aws no longer reaches Claude in this control run, so the check cannot see it',
    ]);
    expect(CLOUD_CREDENTIALS.sso.found(run({ keys: ['AWS4-HMAC-SHA256 Credential=ASIARUNNERSSO/20261118/us-east-1/bedrock/aws4_request'] }))).toBe(true);
    expect(CLOUD_CREDENTIALS.sso.found(signed)).toBe(false);
    expect(CLOUD_CREDENTIALS.vertex.found(run({ ran: ['adc-refresh'] }))).toBe(true);
    expect(CLOUD_CREDENTIALS.vertex.found(run({ keys: ['Bearer stand-in'] }))).toBe(false);
  });
});
