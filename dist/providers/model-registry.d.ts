import { ProviderName } from './types';
export interface ModelSpec {
    provider: ProviderName;
    model: string;
}
export declare function parseModelSpec(input: string): ModelSpec;
//# sourceMappingURL=model-registry.d.ts.map