import { ReviewConfig } from './types';
export declare const MAX_LOCK_TTL_SECONDS = 3600;
export declare const DEFAULT_CONFIG: ReviewConfig;
export declare function loadConfigFromContent(content: string): ReviewConfig;
export declare function loadConfigFromFile(filePath: string): ReviewConfig;
export declare function resolveModel(config: ReviewConfig, stage: 'planner' | 'reviewer' | 'judge' | 'dedup'): string;
/**
 * Resolves the model for a specific reviewer agent. Resolution order:
 * `models.agents[agentName]` → `models[stage]` → built-in default for `stage`.
 */
export declare function resolveAgentModel(config: ReviewConfig, agentName: string, stage: 'planner' | 'reviewer' | 'judge' | 'dedup'): string;
export declare function loadConfig(yamlContent: string | undefined): ReviewConfig;
