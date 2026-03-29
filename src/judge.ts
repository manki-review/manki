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
  agentCount: number;
}

export interface JudgedFinding {
  title: string;
  severity: FindingSeverity;
  reasoning: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface JudgeResult {
  summary: string;
  findings: JudgedFinding[];
}

const CONTEXT_LINES = 10;

export function buildJudgeSystemPrompt(config: ReviewConfig, agentCount: number): string {
  const majorityThreshold = Math.ceil(agentCount / 2);
  let prompt = `You are a code review judge. You evaluate findings from multiple specialist reviewers for accuracy, actionability, and severity.

## Severity Assessment

Evaluate each finding on two dimensions:

**Impact** — How bad is it if this issue manifests?
- Critical: data loss, security breach, crash, broken core functionality
- High: incorrect behavior, silent failures, missing error handling that loses information
- Medium: degraded experience, confusing behavior, inconsistency, tech debt
- Low: cosmetic, style, naming, minor readability

**Likelihood** — How likely is this issue to actually occur?
- Certain: will happen on every execution of the affected code path
- Probable: will happen under common conditions or normal usage
- Possible: could happen under specific edge cases or unusual input
- Unlikely: requires unusual circumstances or rare conditions

**Severity mapping:**
- **required**: Critical/High impact + Certain/Probable likelihood, OR any Critical impact, OR patterns flagged as important in project memory
- **suggestion**: High impact + Possible likelihood, Medium impact + Certain/Probable likelihood, or any finding worth addressing but not blocking
- **nit**: Low impact regardless of likelihood, or Medium impact + Unlikely likelihood
- **ignore**: False positives, intentional patterns, style preferences, reviewer misunderstandings

Include your impact and likelihood assessment in the reasoning field (e.g., "Impact: High (silent data loss), Likelihood: Probable (happens on every error path) → required").

Examples of **required** (high impact, certain/probable):
  - SQL injection or unsanitized user input passed to any external system
  - Null/undefined dereference that will crash at runtime
  - Missing error handling that silently swallows failures
  - Logic error that produces incorrect results under common conditions
  - Breaking API change without migration path

Examples of **suggestion** (medium impact or lower likelihood):
  - Error message lacks context (impact: medium, likelihood: certain)
  - Variable could be \`const\` instead of \`let\` (impact: low, likelihood: certain → actually a nit)
  - Function could be simplified by extracting a helper (impact: medium, likelihood: N/A)

Examples of **nit**:
  - Variable name could be more descriptive
  - Inconsistent import ordering
  - Missing JSDoc on an exported function

Examples of **ignore**:
  - Intentional TODO with a tracking issue number
  - Known workaround documented in comments
  - Style preference that does not affect correctness

## Evaluation Criteria

For each finding, evaluate:

1. **Accuracy**: Is the finding technically correct given the code context?
2. **Actionability**: Can the developer fix this? Is the fix clear?
3. **Severity**: Based on actual impact, not the reviewer's original assessment.

## Guidelines

- Respect the project's review memory when calibrating severity. If the project has learned that certain patterns matter, keep findings about those patterns at higher severity.
- Trust reviewer severity unless you have clear evidence it's overstated. The reviewers see the full code context.
- When multiple reviewers agree, give their consensus significant weight.
- Be liberal with \`ignore\` — actively filter noise and false positives.
- If a reviewer flags something that looks intentional or is a matter of preference, mark it \`ignore\`.
- When downgrading a finding that multiple reviewers flagged, explicitly explain why in your reasoning.

## Reviewer Consensus

This review used ${agentCount} specialist agents. When evaluating severity, consider the proportion of reviewers who independently flagged each finding:
- **Majority or more flagged it** (${majorityThreshold}+ of ${agentCount}) — strong signal. Default to keeping the reviewer's severity. Only downgrade if you're certain it's a false positive.
- **More than one flagged it** (2+ of ${agentCount}) — moderate signal. Trust the severity unless you have specific evidence to downgrade.
- **Only one flagged it** (1 of ${agentCount}) — use your independent judgment. May downgrade or ignore if not convincing.

Multiple independent reviewers reaching the same conclusion is strong evidence that the finding is real. Downgrading a consensus finding requires explicit justification in your reasoning.

## Acceptance Criteria

If the PR description or linked issues contain acceptance criteria (checkbox items like "- [ ] criterion"):
- Check if each criterion is addressed by the changes in this PR
- An unmet acceptance criterion that the PR claims to implement should be flagged as \`required\`
- A partially met criterion should be flagged as \`suggestion\` with details on what's missing
- Acceptance criteria from the issue that are clearly out of scope for this specific PR can be ignored

## Duplicate Detection

Multiple specialist reviewers may flag the same issue independently. When you see findings that describe the same underlying problem (even with different wording, slightly different line numbers, or different titles):

- Return only ONE entry for the merged finding
- Use the best/clearest title from the duplicates
- Use the most detailed description
- In your reasoning, note which findings you merged (e.g., "Merged findings 1 and 4 — same issue")

## Output Format

Respond with ONLY a JSON object (no markdown fences, no explanation):

\`\`\`
{
  "summary": "1-2 sentence review summary. Be conversational but professional. Focus on what matters: what was found, what's good, what needs attention. Never list agent names. Never mention agent count or review level. Never say 'after judge evaluation'. For clean PRs: acknowledge briefly. For PRs with findings: highlight the most important finding(s).",
  "findings": [
    {
      "title": "Short title matching or close to the original finding title",
      "severity": "required" | "suggestion" | "nit" | "ignore",
      "reasoning": "1-2 sentences explaining your judgment",
      "confidence": "high" | "medium" | "low"
    }
  ]
}
\`\`\`

The findings array may be shorter than the input when duplicates are merged. Preserve the order of first appearance.`;

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
  changedFiles?: DiffFile[],
): string {
  const parts: string[] = [];

  if (prContext) {
    parts.push(`## Pull Request\n`);
    parts.push(`**Title**: ${prContext.title}`);
    parts.push(`**Base branch**: ${prContext.baseBranch}\n`);
  }

  if (changedFiles && changedFiles.length > 0) {
    parts.push(`## Changed Files in This PR\n`);
    for (const file of changedFiles) {
      const additions = file.hunks.reduce((a, h) => a + h.newLines, 0);
      const deletions = file.hunks.reduce((a, h) => a + h.oldLines, 0);
      const stats = `+${additions}/-${deletions}`;
      const hunkContexts = file.hunks.map(h => {
        const firstLine = h.content.split('\n')[0]?.trim() || '';
        return `  - ${firstLine.slice(0, 80)}`;
      }).join('\n');
      parts.push(`### ${file.path} (${stats})\n${hunkContexts}\n`);
    }
  }

  if (linkedIssues && linkedIssues.length > 0) {
    parts.push(`## Linked Issues (user-provided context)\n`);
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

export function parseJudgeResponse(responseText: string): JudgeResult {
  const jsonText = extractJSON(responseText);

  try {
    const parsed = JSON.parse(jsonText);

    const parseFindings = (arr: unknown[]): JudgedFinding[] =>
      arr.map((item: unknown) => item as Record<string, unknown>).map((f) => ({
        title: String(f.title || 'Untitled'),
        severity: validateSeverity(f.severity),
        reasoning: String(f.reasoning || ''),
        confidence: validateConfidence(f.confidence),
      }));

    // New object format with summary + findings
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const findings = Array.isArray(parsed.findings) ? parseFindings(parsed.findings) : [];
      const summary = typeof parsed.summary === 'string' && parsed.summary
        ? parsed.summary
        : 'Review complete.';
      return { summary, findings };
    }

    // Backward compat: plain JSON array
    if (Array.isArray(parsed)) {
      return { summary: 'Review complete.', findings: parseFindings(parsed) };
    }

    core.warning(`Judge returned unexpected format: ${typeof parsed}`);
    return { summary: 'Review complete.', findings: [] };
  } catch (e) {
    core.warning(`Failed to parse judge response: ${e}`);
    return { summary: 'Review complete.', findings: [] };
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
): Promise<{ findings: Finding[]; summary: string }> {
  const { findings, diff, memory, prContext, linkedIssues, agentCount } = input;

  if (findings.length === 0) return { findings, summary: 'Review complete.' };

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

  const changedFiles = diff.files;

  const systemPrompt = buildJudgeSystemPrompt(config, agentCount);
  const userMessage = buildJudgeUserMessage(findings, codeContextMap, memoryContext, prContext, linkedIssues, changedFiles);

  const response = await client.sendMessage(systemPrompt, userMessage, { effort: 'high' });
  const judgeResult = parseJudgeResponse(response.content);

  if (judgeResult.findings.length === 0) {
    core.warning('Judge returned no findings — returning originals unchanged');
    return { findings, summary: judgeResult.summary };
  }

  return {
    findings: deduplicateFindings(mapJudgedToFindings(findings, judgeResult.findings)),
    summary: judgeResult.summary,
  };
}

export function mapJudgedToFindings(original: Finding[], judged: JudgedFinding[]): Finding[] {
  // When judge returns fewer results (due to merging duplicates), use fuzzy matching only
  if (judged.length < original.length) {
    return mapMergedFindings(original, judged);
  }

  // 1:1 mapping: match by position, fall back to fuzzy title match
  const result: Finding[] = [];

  for (let i = 0; i < original.length; i++) {
    const finding = { ...original[i] };

    let match: JudgedFinding | undefined;
    if (i < judged.length) {
      match = judged[i];
    }

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

function mapMergedFindings(original: Finding[], judged: JudgedFinding[]): Finding[] {
  const result: Finding[] = [];

  for (const j of judged) {
    // Find all original findings that match this judge result
    const matches = original.filter(o => titlesRelated(o.title, j.title));

    if (matches.length === 0) {
      // No match found — skip this judge result (should not happen in practice)
      continue;
    }

    // Use the first match as the base finding
    const merged: Finding = { ...matches[0] };
    merged.severity = j.severity;
    merged.judgeNotes = j.reasoning;
    merged.judgeConfidence = j.confidence;

    // Combine reviewers from all matched originals
    const allReviewers = new Set<string>();
    for (const m of matches) {
      for (const r of m.reviewers) {
        allReviewers.add(r);
      }
    }
    merged.reviewers = [...allReviewers];

    // Use the longest description among matches
    for (const m of matches) {
      if (m.description.length > merged.description.length) {
        merged.description = m.description;
      }
    }

    result.push(merged);
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

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    const key = `${f.title}::${f.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findingKey(f: Finding): string {
  return `${f.file}:${f.line}:${f.title}`;
}

