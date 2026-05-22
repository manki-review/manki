import { LLMClient, LLMResponse, OpenAIAuth, SendMessageOptions } from './types';
export declare const STALE_TIMEOUT_MS = 90000;
export declare function resolveCodexHome(): string;
export declare const CODEX_CLI_VERSION = "0.129.0";
export declare function buildOpenAIAuth(oauthToken: string, apiKey: string): OpenAIAuth;
/** Strip GitHub Actions workflow commands to prevent injection when logging CLI output. */
export declare function sanitizeLogOutput(text: string): string;
/**
 * o-series reasoning models (o1, o3, o4, ...) accept the `reasoning_effort`
 * parameter on the chat completions API; GPT-family models (gpt-4o, gpt-4.1,
 * gpt-5, ...) do not and will reject the field.
 */
export declare function isReasoningModel(model: string): boolean;
/**
 * Map manki's effort tiers (`low|medium|high|max`) to the values the OpenAI
 * stack accepts. Both the chat completions API and the Codex CLI cap reasoning
 * effort at `'high'`, so manki's `'max'` collapses to `'high'` on both paths.
 */
export declare function resolveEffortTier(effort: 'low' | 'medium' | 'high' | 'max'): 'low' | 'medium' | 'high';
export declare function resetCLIInstallPromise(): void;
export interface OpenAIClientOptions {
    auth: OpenAIAuth;
    model: string;
}
export declare class OpenAIClient implements LLMClient {
    private readonly auth;
    private openai?;
    private readonly model;
    private cachedCLIPath?;
    constructor(options: OpenAIClientOptions);
    sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse>;
    private ensureCLI;
    private sendViaOAuth;
    private sendViaAPI;
}
//# sourceMappingURL=openai.d.ts.map