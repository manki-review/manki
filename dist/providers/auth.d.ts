import { ProviderAuth, ProviderName } from './types';
export interface ProviderInputs {
    anthropicOauthToken: string;
    anthropicApiKey: string;
    openaiOauthToken: string;
    openaiApiKey: string;
    geminiOauthToken: string;
    geminiApiKey: string;
}
export declare function buildAuthForProvider(provider: ProviderName, inputs: ProviderInputs): ProviderAuth;
export declare function hasAnyProviderCredentials(inputs: ProviderInputs): boolean;
//# sourceMappingURL=auth.d.ts.map