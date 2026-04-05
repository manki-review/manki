import { ReviewConfig } from './types';
export declare const DEFAULT_CONFIG: ReviewConfig;
export declare function loadConfigFromContent(content: string): ReviewConfig;
export declare function loadConfigFromFile(filePath: string): ReviewConfig;
export declare function resolveModel(config: ReviewConfig, stage: 'planner' | 'reviewer' | 'judge' | 'dedup'): string;
export declare function loadConfig(yamlContent: string | undefined): ReviewConfig;
