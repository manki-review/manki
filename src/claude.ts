import { execFile, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { promisify } from 'util';

import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';

const execFileAsync = promisify(execFile);

export interface ClaudeClientOptions {
  oauthToken?: string;
  apiKey?: string;
  model: string;
}

export interface ClaudeResponse {
  content: string;
}

export class ClaudeClient {
  private oauthToken?: string;
  private apiKey?: string;
  private anthropic?: Anthropic;
  private model: string;
  private cachedCLIPath?: string;

  constructor(options: ClaudeClientOptions) {
    this.oauthToken = options.oauthToken;
    this.apiKey = options.apiKey;
    this.model = options.model;

    if (!this.oauthToken && !this.apiKey) {
      throw new Error('Either claude_code_oauth_token or anthropic_api_key must be provided');
    }

    if (this.apiKey) {
      this.anthropic = new Anthropic({ apiKey: this.apiKey });
    }
  }

  async sendMessage(systemPrompt: string, userMessage: string): Promise<ClaudeResponse> {
    if (this.oauthToken) {
      return this.sendViaOAuth(systemPrompt, userMessage);
    }
    return this.sendViaAPI(systemPrompt, userMessage);
  }

  private async ensureCLI(): Promise<string> {
    if (this.cachedCLIPath) {
      return this.cachedCLIPath;
    }

    try {
      const { stdout } = await execFileAsync('which', ['claude']);
      this.cachedCLIPath = stdout.trim();
      return this.cachedCLIPath;
    } catch {
      core.info('Claude CLI not found, installing via npm...');
      await execFileAsync('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
        timeout: 120000,
      });

      try {
        const { stdout } = await execFileAsync('which', ['claude']);
        this.cachedCLIPath = stdout.trim();
        return this.cachedCLIPath;
      } catch {
        throw new Error('Failed to install Claude CLI');
      }
    }
  }

  private async sendViaOAuth(systemPrompt: string, userMessage: string): Promise<ClaudeResponse> {
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
    const cliPath = await this.ensureCLI();

    return new Promise((resolve, reject) => {
      // -p enables pipe mode — reads prompt from stdin when no argument follows
      const child = spawn(cliPath, [
        '-p',
        '--output-format', 'text',
        '--model', this.model,
      ], {
        env: {
          ...process.env,
          ...(this.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: this.oauthToken } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let outputExceeded = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let outputKillTimer: NodeJS.Timeout | undefined;
      // Only set in the catch block below; clearTimeout(undefined) is a no-op on the normal path
      let stdinKillTimer: NodeJS.Timeout | undefined;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
      }, 300000);

      const MAX_OUTPUT = 50 * 1024 * 1024; // 50 MB
      const killOnOutputExceeded = (): void => {
        if (outputExceeded) return;
        outputExceeded = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        outputKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
      };
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', (data: Buffer) => {
        if (outputExceeded || settled) return;
        stdout += stdoutDecoder.write(data);
        if (stdout.length + stderr.length > MAX_OUTPUT) killOnOutputExceeded();
      });
      child.stderr.on('data', (data: Buffer) => {
        if (outputExceeded || settled) return;
        stderr += stderrDecoder.write(data);
        if (stdout.length + stderr.length > MAX_OUTPUT) killOnOutputExceeded();
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (outputKillTimer) clearTimeout(outputKillTimer);
        if (stdinKillTimer) clearTimeout(stdinKillTimer);
        if (settled) return;
        settled = true;
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (timedOut) {
          reject(new Error('Claude CLI timed out after 300s'));
          return;
        }
        if (outputExceeded) {
          reject(new Error('Claude CLI output exceeded 50MB limit'));
          return;
        }
        if (code !== 0) {
          const msg = `exit ${code}${signal ? `, signal ${signal}` : ''}: ${stderr.slice(0, 500)}`;
          core.warning(`Claude CLI failed (${msg})`);
          reject(new Error(`Claude CLI invocation failed (${msg})`));
          return;
        }
        const content = stdout.trim();
        core.startGroup('Claude CLI response');
        core.info(content);
        core.endGroup();
        resolve({ content });
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (outputKillTimer) clearTimeout(outputKillTimer);
        if (stdinKillTimer) clearTimeout(stdinKillTimer);
        if (settled) return;
        settled = true;
        reject(new Error(`Claude CLI spawn failed: ${error.message}`));
      });

      child.stdin.on('error', (err) => {
        core.warning(`stdin write error: ${err.message}`);
      });

      // Node.js stream.write() buffers data internally — it never does partial writes.
      // When write() returns false, the data is still fully queued; it just means the
      // internal buffer exceeded highWaterMark. We wait for 'drain' before calling end()
      // to avoid unnecessary buffering pressure.
      try {
        const canWrite = child.stdin.write(fullPrompt);
        if (!canWrite) {
          // The drain handler stays registered until fired or GC. The `settled` guard
          // ensures it won't call end() after the process has already exited.
          child.stdin.once('drain', () => {
            if (!settled) {
              try { child.stdin.end(); } catch { /* stream already destroyed */ }
            }
          });
        } else {
          try { child.stdin.end(); } catch { /* stream may be destroyed */ }
        }
      } catch (err) {
        core.warning(`stdin write failed: ${(err as Error).message}`);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          if (outputKillTimer) clearTimeout(outputKillTimer);
          reject(new Error(`stdin write failed: ${(err as Error).message}`));
        }
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        stdinKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
      }
    });
  }

  private async sendViaAPI(systemPrompt: string, userMessage: string): Promise<ClaudeResponse> {
    if (!this.anthropic) throw new Error('Anthropic client not initialized');

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const content = textBlocks.map(b => b.text).join('\n');
    core.startGroup('Claude API response');
    core.info(content);
    core.endGroup();

    return { content };
  }
}
