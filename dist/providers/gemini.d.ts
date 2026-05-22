import { GeminiAuth, LLMClient, LLMResponse, SendMessageOptions } from './types';
export declare function resolveGeminiCredsDir(): string;
export declare function buildGeminiAuth(oauthToken: string, apiKey: string): GeminiAuth;
/** Map effort level to Gemini thinking budget. `low` disables thinking entirely. */
export declare function geminiThinkingBudget(effort: SendMessageOptions['effort']): number | undefined;
export declare function resetGeminiCLIInstallPromise(): void;
export interface GeminiClientOptions {
    auth: GeminiAuth;
    model: string;
}
export declare class GeminiClient implements LLMClient {
    private readonly auth;
    private genAI?;
    private readonly model;
    private cachedCLIPath?;
    constructor(options: GeminiClientOptions);
    sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<LLMResponse>;
    private ensureCLI;
    private sendViaOAuth;
    private sendViaAPI;
}
//# sourceMappingURL=gemini.d.ts.map