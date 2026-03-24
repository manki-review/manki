export interface ClaudeClientOptions {
    oauthToken?: string;
    apiKey?: string;
    model: string;
}
export interface ClaudeResponse {
    content: string;
}
export declare class ClaudeClient {
    private oauthToken?;
    private apiKey?;
    private anthropic?;
    private model;
    private cachedCLIPath?;
    constructor(options: ClaudeClientOptions);
    sendMessage(systemPrompt: string, userMessage: string): Promise<ClaudeResponse>;
    private ensureCLI;
    private sendViaOAuth;
    private sendViaAPI;
}
