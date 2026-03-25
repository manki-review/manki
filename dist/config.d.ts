import { ReviewConfig } from './types';
export declare const DEFAULT_CONFIG: ReviewConfig;
export declare function loadConfigFromContent(content: string): ReviewConfig;
export declare function loadConfigFromFile(filePath: string): ReviewConfig;
export declare function resolveModel(config: ReviewConfig, stage: 'reviewer' | 'judge'): string;
export declare function loadConfig(yamlContent: string | undefined): ReviewConfig;
