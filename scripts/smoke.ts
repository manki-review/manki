/* eslint-disable no-console */
/**
 * Provider smoke harness. Reuses the production `createLLMClient` + auth
 * resolution path. Reads credentials from environment variables matching the
 * action's secret names.
 *
 * Usage:
 *   npm run smoke -- --model <id> [--effort low|medium|high|max] [--prompt <text>]
 *
 * Exit codes:
 *   0  parseable response received
 *   1  transport / API error / bad arguments
 *   2  missing credentials for the chosen model's provider
 */

import {
  buildAuthForProvider,
  createLLMClient,
  parseModelSpec,
  type ProviderInputs,
  type SendMessageOptions,
} from '../src/providers';
import { sanitizeLogOutput } from '../src/providers/cli-utils';

interface SmokeArgs {
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  prompt: string;
}

const DEFAULT_PROMPT = 'Reply with the single word: OK';
const SYSTEM_PROMPT = 'You are a smoke-test agent. Reply succinctly.';

function printHelp(): void {
  console.log(`Usage: npm run smoke -- --model <id> [--effort low|medium|high|max] [--prompt <text>]

Arguments:
  --model    Required. Any model ID recognised by parseModelSpec.
             Examples: claude-haiku-4-5, gpt-4o-mini, o4-mini, gemini-2.5-flash.
             Or use provider/model syntax: anthropic/claude-..., openai/gpt-..., gemini/gemini-...
  --effort   Optional. low | medium | high | max. Provider behaviour varies.
  --prompt   Optional. Override the default test prompt.
  --help     Print this message.

Environment:
  ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
  OPENAI_API_KEY, OPENAI_OAUTH_TOKEN
  GEMINI_API_KEY, GEMINI_OAUTH_TOKEN

Exit codes:
  0  parseable response received
  1  transport / API error / bad arguments
  2  missing credentials for the chosen model's provider
`);
}

export function parseArgs(argv: string[] = process.argv.slice(2)): SmokeArgs {
  let model: string | undefined;
  let effort: SmokeArgs['effort'];
  let prompt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model') {
      model = argv[++i];
      if (!model) throw new Error('--model requires a value.');
    } else if (arg === '--effort') {
      const val = argv[++i];
      if (!val) throw new Error('--effort requires a value.');
      if (val !== 'low' && val !== 'medium' && val !== 'high' && val !== 'max') {
        throw new Error(`Invalid --effort "${val}". Use: low | medium | high | max.`);
      }
      effort = val;
    } else if (arg === '--prompt') {
      const val = argv[++i];
      if (!val) throw new Error('--prompt requires a non-empty value.');
      prompt = val;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!model) {
    throw new Error('--model is required. Run with --help for usage.');
  }
  return { model, effort, prompt: prompt ?? DEFAULT_PROMPT };
}

export function readProviderInputsFromEnv(): ProviderInputs {
  return {
    anthropicOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    openaiOauthToken: process.env.OPENAI_OAUTH_TOKEN ?? '',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    geminiOauthToken: process.env.GEMINI_OAUTH_TOKEN ?? '',
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  };
}

async function main(): Promise<number> {
  let args: SmokeArgs;
  try {
    args = parseArgs();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  let spec: ReturnType<typeof parseModelSpec>;
  try {
    spec = parseModelSpec(args.model);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const inputs = readProviderInputsFromEnv();
  let auth;
  try {
    auth = buildAuthForProvider(spec.provider, inputs);
  } catch (err) {
    console.error(`No credentials found for provider "${spec.provider}": ${(err as Error).message}`);
    return 2;
  }

  const client = createLLMClient(spec.provider, spec.model, auth);
  const opts: SendMessageOptions = args.effort ? { effort: args.effort } : {};

  console.log(`provider=${spec.provider} model=${spec.model} effort=${args.effort ?? 'default'}`);
  console.log(`prompt=${JSON.stringify(args.prompt)}`);

  const TIMEOUT_MS = 60_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
  );

  const t0 = Date.now();
  let response;
  try {
    response = await Promise.race([
      client.sendMessage(SYSTEM_PROMPT, args.prompt, opts),
      timeoutPromise,
    ]);
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`transport error after ${ms}ms: ${(err as Error).message}`);
    return 1;
  }
  const ms = Date.now() - t0;

  if (typeof response.content !== 'string' || response.content.length === 0) {
    console.error(`response shape unexpected after ${ms}ms: content=${JSON.stringify(response.content).slice(0, 200)}`);
    return 1;
  }

  console.log(`ok latency_ms=${ms} response_chars=${response.content.length}`);
  console.log('---');
  console.log(sanitizeLogOutput(response.content));
  console.log('---');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
