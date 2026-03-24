import * as core from '@actions/core';

import { ClaudeClient } from './claude';
import { ReviewConfig, ReviewerAgent, Finding, ReviewResult, ReviewVerdict, ParsedDiff } from './types';

export async function runReview(
  client: ClaudeClient,
  config: ReviewConfig,
  _diff: ParsedDiff,
  rawDiff: string,
  repoContext: string,
): Promise<ReviewResult> {
  const reviewerNames = config.reviewers.map(r => r.name).join(', ');
  core.info(`Running ${config.reviewers.length} reviewer agents in parallel: ${reviewerNames}`);

  const agentResults = await Promise.allSettled(
    config.reviewers.map(reviewer =>
      runReviewerAgent(client, config, reviewer, rawDiff, repoContext)
    )
  );

  const allFindings: { reviewer: string; findings: Finding[] }[] = [];
  for (let i = 0; i < agentResults.length; i++) {
    const agentResult = agentResults[i];
    const reviewer = config.reviewers[i];
    if (agentResult.status === 'fulfilled') {
      const findings = agentResult.value;
      allFindings.push({ reviewer: reviewer.name, findings });

      core.startGroup(`${reviewer.name} (${findings.length} findings)`);
      for (const f of findings) {
        core.info(`[${f.severity ?? '?'}] ${f.title ?? 'untitled'} — ${f.file ?? '?'}:${f.line ?? '?'}`);
      }
      core.endGroup();
    } else {
      core.warning(`${reviewer.name} agent failed: ${agentResult.reason}`);
    }
  }

  core.info('');
  core.info('\u2501\u2501\u2501 Review Agent Results \u2501\u2501\u2501');
  for (const af of allFindings) {
    core.info(`  ${af.reviewer}: ${af.findings.length} findings`);
  }
  core.info('');

  if (allFindings.length === 0) {
    core.warning('All reviewer agents failed');
    return {
      verdict: 'COMMENT',
      summary: 'Review could not be completed — all reviewer agents failed.',
      findings: [],
      highlights: [],
    };
  }

  const totalFindings = allFindings.reduce((sum, af) => sum + af.findings.length, 0);
  core.info(`Running consolidation agent with ${totalFindings} total findings...`);
  const result = await runConsolidationAgent(client, config, allFindings, rawDiff);

  core.startGroup('Review Summary');
  core.info(`Verdict: ${result.verdict}`);
  core.info(`Findings: ${result.findings.length}`);
  if (result.findings.length > 0) {
    core.info('');
    for (const f of result.findings) {
      const icon = f.severity === 'blocking' ? '\u2717' : f.severity === 'suggestion' ? '\u25CB' : '?';
      core.info(`  ${icon} [${f.severity}] ${f.title}`);
      core.info(`    ${f.file}:${f.line}`);
    }
  }
  if (result.highlights.length > 0) {
    core.info('');
    core.info('Highlights:');
    for (const h of result.highlights) {
      core.info(`  + ${h}`);
    }
  }
  core.endGroup();

  return result;
}

async function runReviewerAgent(
  client: ClaudeClient,
  config: ReviewConfig,
  reviewer: ReviewerAgent,
  rawDiff: string,
  repoContext: string,
): Promise<Finding[]> {
  const systemPrompt = buildReviewerSystemPrompt(reviewer, config);
  const userMessage = buildReviewerUserMessage(rawDiff, repoContext);

  const response = await client.sendMessage(systemPrompt, userMessage);
  return parseFindings(response.content, reviewer.name);
}

export function buildReviewerSystemPrompt(reviewer: ReviewerAgent, config: ReviewConfig): string {
  let prompt = `You are a code reviewer specializing in: ${reviewer.focus}

Your role: ${reviewer.name}

Review the provided pull request diff carefully from your specialist perspective. Return your findings as a JSON array.

## Response Format

Respond with ONLY a JSON array (no markdown fences, no explanation). Each finding:

\`\`\`
[
  {
    "severity": "blocking" | "suggestion" | "question",
    "title": "Short descriptive title",
    "file": "path/to/file.ext",
    "line": <line number in the NEW file>,
    "description": "2-4 sentences: what the issue is, why it matters, potential impact, how to fix.",
    "suggestedFix": "Optional: code snippet showing the fix"
  }
]
\`\`\`

## Severity Guidelines

- **blocking**: Bugs, security vulnerabilities, data corruption risks, crashes, incorrect behavior. These MUST be fixed before merge.
- **suggestion**: Style improvements, minor optimizations, readability enhancements, naming nitpicks. Nice to have but not required.
- **question**: Code that needs clarification. You're not sure if it's wrong, but it looks suspicious or unclear.

## Rules

- ONLY review the changes shown in the diff. Don't comment on unchanged code.
- Be precise with line numbers — they must correspond to lines in the NEW version of the file.
- Don't flag intentional patterns (e.g., TODO comments, known workarounds mentioned in context).
- Keep descriptions concrete and actionable.
- If you find NO issues, respond with an empty array: []
- Be thorough but not pedantic. Quality over quantity.`;

  if (config.instructions) {
    prompt += `\n\n## Additional Instructions\n\n${config.instructions}`;
  }

  return prompt;
}

export function buildReviewerUserMessage(rawDiff: string, repoContext: string): string {
  let message = '';

  if (repoContext) {
    message += `## Repository Context\n\n${repoContext}\n\n`;
  }

  message += `## Pull Request Diff\n\n\`\`\`diff\n${rawDiff}\n\`\`\``;

  return message;
}

export function parseFindings(responseText: string, reviewerName: string): Finding[] {
  let jsonText = responseText.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      core.warning(`${reviewerName} did not return an array, got: ${typeof parsed}`);
      return [];
    }

    return parsed.map((f: Record<string, unknown>) => ({
      severity: validateSeverity(f.severity),
      title: String(f.title || 'Untitled finding'),
      file: String(f.file || ''),
      line: Number(f.line) || 0,
      description: String(f.description || ''),
      suggestedFix: f.suggestedFix ? String(f.suggestedFix) : undefined,
      reviewers: [reviewerName],
    }));
  } catch (e) {
    core.warning(`Failed to parse findings from ${reviewerName}: ${e}`);
    return [];
  }
}

export function validateSeverity(severity: unknown): Finding['severity'] {
  if (severity === 'blocking' || severity === 'suggestion' || severity === 'question') {
    return severity;
  }
  return 'suggestion';
}

async function runConsolidationAgent(
  client: ClaudeClient,
  _config: ReviewConfig,
  agentFindings: { reviewer: string; findings: Finding[] }[],
  rawDiff: string,
): Promise<ReviewResult> {
  const systemPrompt = `You are a code review consolidation agent. Multiple specialist reviewers have analyzed a pull request. Your job is to:

1. De-duplicate findings — if multiple reviewers flagged the same issue, merge them into one finding (list all reviewers in the "reviewers" array)
2. Resolve conflicts — if reviewers disagree, use your judgment
3. Validate — reject false positives or findings that are clearly wrong
4. Categorize — ensure each finding has the correct severity (blocking/suggestion/question)
5. Rank — order findings by importance (blocking first, then suggestions, then questions)

## Response Format

Respond with ONLY a JSON object (no markdown fences):

{
  "verdict": "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
  "summary": "2-3 sentence review summary",
  "findings": [
    {
      "severity": "blocking" | "suggestion" | "question",
      "title": "Short title",
      "file": "path/to/file",
      "line": <number>,
      "description": "2-4 sentences",
      "suggestedFix": "optional fix",
      "reviewers": ["Reviewer A", "Reviewer B"]
    }
  ],
  "highlights": ["1-2 positive highlights about the code, if any"]
}

## Verdict Rules

- **REQUEST_CHANGES**: If ANY finding is "blocking"
- **COMMENT**: If there are only "suggestion" or "question" findings
- **APPROVE**: If there are NO findings at all

## Rules

- Be ruthless about false positives — when in doubt, remove the finding
- Merge duplicates: keep the best description, combine reviewers lists
- Don't add new findings — only consolidate what the reviewers found
- Validate that file paths and line numbers from findings actually exist in the diff`;

  const userMessage = `## Reviewer Findings

${agentFindings.map(af =>
    `### ${af.reviewer}\n\n${af.findings.length === 0 ? 'No findings.' : JSON.stringify(af.findings, null, 2)}`
  ).join('\n\n')}

## Original Diff

\`\`\`diff
${rawDiff}
\`\`\``;

  const response = await client.sendMessage(systemPrompt, userMessage);
  return parseConsolidatedReview(response.content);
}

export function parseConsolidatedReview(responseText: string): ReviewResult {
  let jsonText = responseText.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(jsonText);

    const findings: Finding[] = (parsed.findings || []).map((f: Record<string, unknown>) => ({
      severity: validateSeverity(f.severity),
      title: String(f.title || 'Untitled'),
      file: String(f.file || ''),
      line: Number(f.line) || 0,
      description: String(f.description || ''),
      suggestedFix: f.suggestedFix ? String(f.suggestedFix) : undefined,
      reviewers: Array.isArray(f.reviewers) ? f.reviewers.map(String) : [],
    }));

    const verdict = determineVerdict(parsed.verdict, findings);

    return {
      verdict,
      summary: String(parsed.summary || ''),
      findings,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : [],
    };
  } catch (e) {
    core.warning(`Failed to parse consolidated review: ${e}`);
    return {
      verdict: 'COMMENT',
      summary: 'Review consolidation failed — raw findings from individual reviewers may be incomplete.',
      findings: [],
      highlights: [],
    };
  }
}

export function determineVerdict(claimed: unknown, findings: Finding[]): ReviewVerdict {
  const hasBlocking = findings.some(f => f.severity === 'blocking');
  const hasFindings = findings.length > 0;

  if (hasBlocking) return 'REQUEST_CHANGES';
  if (hasFindings) return 'COMMENT';
  return 'APPROVE';
}
