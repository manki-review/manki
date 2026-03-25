import * as core from '@actions/core';

import { ClaudeClient } from './claude';
import { extractJSON } from './json';
import {
  filterLearningsForFinding,
  filterSuppressionsForFinding,
  sanitizeMemoryField,
  Learning,
  Suppression,
  RepoMemory,
} from './memory';
import { LinkedIssue } from './github';
import { validateSeverity } from './review';
import { DiffFile, Finding, FindingSeverity, ReviewConfig, ParsedDiff, PrContext } from './types';

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

const CONTEXT_LINES = 10;

export function buildJudgeSystemPrompt(config: ReviewConfig): string {
  let prompt = `You are a code review judge. You evaluate findings from multiple specialist reviewers for accuracy, actionability, and severity.

## Severity Scale

- **required**: Bugs, security vulnerabilities, data corruption, crashes, incorrect behavior. These MUST be fixed before merge. Be conservative — only real bugs and security issues qualify.
  - SQL injection via unsanitized user input in a database query
  - Null/undefined dereference in an error handling path that will crash at runtime
  - Off-by-one in array bounds causing data corruption or out-of-bounds access
- **suggestion**: Code clarity, readability, minor optimizations, design improvements. Worth doing but not blocking.
  - Error message lacks context (e.g., logging "failed" without the error reason)
  - Variable could be \`const\` instead of \`let\` since it is never reassigned
  - Function could be simplified by extracting a reusable helper
- **nit**: Typos, naming nitpicks, minor style issues. Entirely optional.
  - Variable name could be more descriptive (e.g., \`x\` → \`connectionCount\`)
  - Inconsistent import ordering compared to rest of file
  - Missing JSDoc on an exported function
- **ignore**: False positives, intentional patterns, reviewer misunderstandings. Will be dropped.
  - Intentional TODO with a tracking issue number
  - Known workaround documented in comments
  - Style preference that does not affect correctness (e.g., ternary vs if/else)

## Evaluation Criteria

For each finding, evaluate:

1. **Accuracy**: Is the finding technically correct given the code context?
2. **Actionability**: Can the developer fix this? Is the fix clear?
3. **Severity**: Based on actual impact, not the reviewer's original assessment.

## Guidelines

- Be conservative with \`required\` — only real bugs and security issues.
- Be liberal with \`ignore\` — actively filter noise and false positives.
- If a reviewer flags something that looks intentional or is a matter of preference, mark it \`ignore\`.
- If a finding is correct but overstated in severity, downgrade it.

## Output Format

Respond with ONLY a JSON array (no markdown fences, no explanation). Each element:

\`\`\`
[
  {
    "title": "Short title matching or close to the original finding title",
    "severity": "required" | "suggestion" | "nit" | "ignore",
    "reasoning": "1-2 sentences explaining your judgment",
    "confidence": "high" | "medium" | "low"
  }
]
\`\`\`

Return one element per finding, in the same order as presented.`;

  if (config.instructions) {
    prompt += `\n\n## Project Instructions\n\n${config.instructions}`;
  }

  return prompt;
}

export function buildJudgeUserMessage(
  findings: Finding[],
  codeContextMap: Map<string, string>,
  memoryContext: string,
  prContext?: PrContext,
  linkedIssues?: LinkedIssue[],
): string {
  const parts: string[] = [];

  if (prContext) {
    parts.push(`## Pull Request\n`);
    parts.push(`**Title**: ${prContext.title}`);
    parts.push(`**Base branch**: ${prContext.baseBranch}\n`);
  }

  if (linkedIssues && linkedIssues.length > 0) {
    parts.push(`## Linked Issues\n`);
    for (const issue of linkedIssues) {
      parts.push(`### Issue #${issue.number}: ${issue.title}\n`);
      if (issue.body) {
        parts.push(issue.body);
      }
      parts.push('');
    }
  }

  parts.push(`## Findings to Evaluate (${findings.length} total)\n`);

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const ctx = codeContextMap.get(findingKey(f)) || '';

    parts.push(`### Finding ${i + 1}: ${f.title}`);
    parts.push(`- **Original severity**: ${f.severity}`);
    parts.push(`- **File**: ${f.file}:${f.line}`);
    parts.push(`- **Reviewers**: ${f.reviewers.join(', ')}`);
    parts.push(`- **Description**: ${f.description}`);

    if (f.suggestedFix) {
      parts.push(`- **Suggested fix**: ${f.suggestedFix}`);
    }

    if (ctx) {
      parts.push(`\n**Code context**:\n\`\`\`\n${ctx}\n\`\`\``);
    }

    parts.push('');
  }

  if (memoryContext) {
    parts.push(`## Project Memory\n\n${memoryContext}`);
  }

  return parts.join('\n');
}

export function extractCodeContext(finding: Finding, diff: ParsedDiff): string {
  if (!finding.file || !finding.line) return '';

  const diffFile = diff.files.find(f => f.path === finding.file);
  if (!diffFile) return '';

  return extractHunkContext(diffFile, finding.line);
}

function extractHunkContext(diffFile: DiffFile, line: number): string {
  const hunk = diffFile.hunks.find(h =>
    line >= h.newStart && line <= h.newStart + h.newLines - 1,
  );
  if (!hunk) return '';

  const lines = hunk.content.split('\n');
  const offset = line - hunk.newStart;
  if (offset < 0 || offset >= lines.length) return '';
  const start = Math.max(0, offset - CONTEXT_LINES);
  const end = Math.min(lines.length, offset + CONTEXT_LINES + 1);

  const contextLines: string[] = [];
  for (let i = start; i < end; i++) {
    const lineNum = hunk.newStart + i;
    const marker = i === offset ? '>>>' : '   ';
    contextLines.push(`${marker} ${lineNum}: ${lines[i]}`);
  }

  return contextLines.join('\n');
}

export function filterMemoryForFindings(
  findings: Finding[],
  memory: RepoMemory,
): string {
  const relevantLearnings = filterLearningsForFindings(memory.learnings, findings);
  const relevantSuppressions = filterSuppressionsForFindings(memory.suppressions, findings);

  if (relevantLearnings.length === 0 && relevantSuppressions.length === 0) {
    return '';
  }

  const parts: string[] = [];

  if (relevantLearnings.length > 0) {
    parts.push('### Relevant Learnings\n');
    for (const l of relevantLearnings) {
      parts.push(`- ${sanitizeMemoryField(l.content)}`);
    }
  }

  if (relevantSuppressions.length > 0) {
    parts.push('\n### Relevant Suppressions\n');
    for (const s of relevantSuppressions) {
      const scope = s.file_glob ? ` (files: ${s.file_glob})` : '';
      parts.push(`- "${sanitizeMemoryField(s.pattern)}"${scope}: ${sanitizeMemoryField(s.reason)}`);
    }
  }

  return parts.join('\n');
}

function filterLearningsForFindings(learnings: Learning[], findings: Finding[]): Learning[] {
  const seen = new Set<string>();
  const result: Learning[] = [];
  for (const f of findings) {
    for (const l of filterLearningsForFinding(learnings, f)) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        result.push(l);
      }
    }
  }
  return result;
}

function filterSuppressionsForFindings(suppressions: Suppression[], findings: Finding[]): Suppression[] {
  const seen = new Set<string>();
  const result: Suppression[] = [];
  for (const f of findings) {
    for (const s of filterSuppressionsForFinding(suppressions, f)) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        result.push(s);
      }
    }
  }
  return result;
}

export function parseJudgeResponse(responseText: string): JudgedFinding[] {
  const jsonText = extractJSON(responseText);

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      core.warning(`Judge did not return an array, got: ${typeof parsed}`);
      return [];
    }

    return parsed.map((f: Record<string, unknown>) => ({
      title: String(f.title || 'Untitled'),
      severity: validateSeverity(f.severity),
      reasoning: String(f.reasoning || ''),
      confidence: validateConfidence(f.confidence),
    }));
  } catch (e) {
    core.warning(`Failed to parse judge response: ${e}`);
    return [];
  }
}

function validateConfidence(value: unknown): 'high' | 'medium' | 'low' {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return 'medium';
}

export async function runJudgeAgent(
  client: ClaudeClient,
  config: ReviewConfig,
  input: JudgeInput,
): Promise<Finding[]> {
  const { findings, diff, memory, prContext, linkedIssues } = input;

  if (findings.length === 0) return [];

  const codeContextMap = new Map<string, string>();
  for (const f of findings) {
    const ctx = extractCodeContext(f, diff);
    if (ctx) {
      codeContextMap.set(findingKey(f), ctx);
    }
  }

  const memoryContext = memory
    ? filterMemoryForFindings(findings, memory)
    : '';

  const systemPrompt = buildJudgeSystemPrompt(config);
  const userMessage = buildJudgeUserMessage(findings, codeContextMap, memoryContext, prContext, linkedIssues);

  const response = await client.sendMessage(systemPrompt, userMessage, { effort: 'high' });
  const judged = parseJudgeResponse(response.content);

  if (judged.length === 0) {
    core.warning('Judge returned no findings — returning originals unchanged');
    return findings;
  }

  return mapJudgedToFindings(findings, judged);
}

function mapJudgedToFindings(original: Finding[], judged: JudgedFinding[]): Finding[] {
  const result: Finding[] = [];

  for (let i = 0; i < original.length; i++) {
    const finding = { ...original[i] };

    // Match by position first (judge returns findings in same order)
    let match: JudgedFinding | undefined;
    if (i < judged.length) {
      match = judged[i];
    }

    // Fall back to fuzzy title match if position doesn't seem right
    if (match && !titlesRelated(finding.title, match.title)) {
      const titleMatch = judged.find(j => titlesRelated(finding.title, j.title));
      if (titleMatch) {
        match = titleMatch;
      }
    }

    if (match) {
      finding.severity = match.severity;
      finding.judgeNotes = match.reasoning;
      finding.judgeConfidence = match.confidence;
    }

    result.push(finding);
  }

  return result;
}

function titlesRelated(a: string, b: string): boolean {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return true;

  const shorter = aLower.length <= bLower.length ? aLower : bLower;
  const longer = aLower.length > bLower.length ? aLower : bLower;

  if (shorter.length >= 5 && longer.includes(shorter)) return true;

  // Check word overlap
  const aWords = new Set(aLower.split(/\s+/).filter(w => w.length >= 3));
  const bWords = new Set(bLower.split(/\s+/).filter(w => w.length >= 3));
  if (aWords.size === 0 || bWords.size === 0) return false;

  let overlap = 0;
  for (const w of aWords) {
    if (bWords.has(w)) overlap++;
  }

  const minSize = Math.min(aWords.size, bWords.size);
  return overlap >= minSize * 0.5;
}

function findingKey(f: Finding): string {
  return `${f.file}:${f.line}:${f.title}`;
}

