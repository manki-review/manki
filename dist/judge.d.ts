import { ClaudeClient } from './claude';
import { RepoMemory } from './memory';
import { LinkedIssue } from './github';
import { Finding, FindingSeverity, ReviewConfig, ParsedDiff, PrContext } from './types';
export interface JudgeInput {
    findings: Finding[];
    diff: ParsedDiff;
    rawDiff: string;
    memory?: RepoMemory;
    repoContext: string;
    prContext?: PrContext;
    linkedIssues?: LinkedIssue[];
}
export interface JudgedFinding {
    title: string;
    severity: FindingSeverity;
    reasoning: string;
    confidence: 'high' | 'medium' | 'low';
}
export declare function buildJudgeSystemPrompt(config: ReviewConfig): string;
export declare function buildJudgeUserMessage(findings: Finding[], codeContextMap: Map<string, string>, memoryContext: string, prContext?: PrContext, linkedIssues?: LinkedIssue[]): string;
export declare function extractCodeContext(finding: Finding, diff: ParsedDiff): string;
export declare function filterMemoryForFindings(findings: Finding[], memory: RepoMemory): string;
export declare function parseJudgeResponse(responseText: string): JudgedFinding[];
export declare function runJudgeAgent(client: ClaudeClient, config: ReviewConfig, input: JudgeInput): Promise<Finding[]>;
export declare function mapJudgedToFindings(original: Finding[], judged: JudgedFinding[]): Finding[];
