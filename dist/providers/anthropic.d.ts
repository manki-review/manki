import { sanitizeLogOutput, STALE_TIMEOUT_MS } from './cli-utils';
import { AnthropicAuth, LLMClient, LLMResponse, SendMessageOptions } from './types';
export { sanitizeLogOutput, STALE_TIMEOUT_MS };
export declare function buildAnthropicAuth(oauthToken: string, apiKey: string): AnthropicAuth;
export declare function resetCLIInstallPromise(): void;
export interface AnthropicClientOptions {
    auth: AnthropicAuth;
    model: string;
}
export declare class AnthropicClient implements LLMClient {
    private readonly auth;
    private anthropic?;
    private readonly model;
    private cachedCLIPath?;
    constructor(options: AnthropicClientOptions);
    sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse>;
    warmupCLI(): Promise<void>;
    private ensureCLI;
    private sendViaOAuth;
    private sendViaAPI;
}
//# sourceMappingURL=anthropic.d.ts.map