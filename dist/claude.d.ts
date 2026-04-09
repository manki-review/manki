export declare const STALE_TIMEOUT_MS = 90000;
/** Strip GitHub Actions workflow commands to prevent injection when logging CLI output. */
export declare function sanitizeLogOutput(text: string): string;
export declare function resetCLIInstallPromise(): void;
export interface ClaudeClientOptions {
    oauthToken?: string;
    apiKey?: string;
    model: string;
}
export interface ClaudeResponse {
    content: string;
}
export interface SendMessageOptions {
    effort?: 'low' | 'medium' | 'high' | 'max';
}
export declare class ClaudeClient {
    private oauthToken?;
    private apiKey?;
    private anthropic?;
    private model;
    private cachedCLIPath?;
    constructor(options: ClaudeClientOptions);
    sendMessage(systemPrompt: string, userMessage: string, options?: SendMessageOptions): Promise<ClaudeResponse>;
    private ensureCLI;
    private sendViaOAuth;
    private sendViaAPI;
}
