import * as core from '@actions/core';

import { ClaudeClient } from './claude';
import { runJudgeAgent, JudgeInput } from './judge';
import { RepoMemory } from './memory';
import { ReviewConfig, ReviewerAgent, Finding, ReviewResult, ReviewVerdict, ParsedDiff, TeamRoster } from './types';
import { extractJSON } from './json';

export const AGENT_POOL: readonly ReviewerAgent[] = Object.freeze([
  {
    name: 'Security & Safety',
    focus: 'Vulnerabilities, injection, auth, data leaks, memory safety, crypto correctness, key exposure, timing side-channels',
  },
  {
    name: 'Architecture & Design',
    focus: 'Design patterns, coupling, abstractions, API design, module boundaries, separation of concerns, SOLID principles',
  },
  {
    name: 'Correctness & Logic',
    focus: 'Edge cases, off-by-one errors, null/undefined handling, race conditions, data integrity, type safety, error propagation',
  },
  {
    name: 'Testing & Coverage',
    focus: 'Missing tests, test quality, edge case coverage, assertion strength, mock appropriateness, test maintainability',
  },
  {
    name: 'Performance & Efficiency',
    focus: 'Unnecessary allocations, N+1 queries, hot path optimization, caching opportunities, async/concurrency patterns, memory usage',
  },
  {
    name: 'Maintainability & Readability',
    focus: 'Naming clarity, code complexity, dead code, DRY violations, documentation gaps, cognitive load',
  },
  {
    name: 'Dependencies & Integration',
    focus: 'API contracts, breaking changes, dependency versions, compatibility, external service integration, error handling at boundaries',
  },
]);

const CORE_AGENTS: readonly number[] = Object.freeze([0, 1, 2]);

export function selectTeam(
  diff: ParsedDiff,
  config: ReviewConfig,
  customReviewers?: ReviewerAgent[],
): TeamRoster {
  const lineCount = diff.totalAdditions + diff.totalDeletions;

  let level: 'small' | 'medium' | 'large';
  const configLevel = config.review_level;
  if (configLevel === 'auto' || !['small', 'medium', 'large'].includes(configLevel)) {
    if (configLevel !== 'auto') {
      core.warning(`Unrecognized review_level "${configLevel}", using auto`);
    }
    const thresholds = config.review_thresholds || { small: 200, medium: 1000 };
    if (lineCount < thresholds.small) level = 'small';
    else if (lineCount < thresholds.medium) level = 'medium';
    else level = 'large';
  } else {
    level = configLevel as 'small' | 'medium' | 'large';
  }

  const teamSize = level === 'small' ? 3 : level === 'medium' ? 5 : 7;

  const pool = [...AGENT_POOL];
  for (const custom of (customReviewers || [])) {
    if (!pool.some(p => p.name === custom.name)) {
      pool.push(custom);
    }
  }

  // Core agents always included
  const selected: ReviewerAgent[] = CORE_AGENTS.map(i => pool[i]);

  // Custom reviewers always included (they were explicitly configured)
  for (const custom of (customReviewers || [])) {
    if (!selected.some(s => s.name === custom.name)) {
      selected.push(custom);
    }
  }

  // Custom reviewers may push count above teamSize (intentional — they were explicitly configured).
  // Only fill remaining slots if we haven't already reached teamSize.
  if (selected.length < teamSize) {
    const paths = diff.files.map(f => f.path.toLowerCase());
    const selectedNames = new Set(selected.map(s => s.name));

    const candidates = pool.filter(a => !selectedNames.has(a.name)).map(agent => {
      let score = 0;
      const focus = agent.focus.toLowerCase();

      if (focus.includes('test') && paths.some(p => p.includes('test'))) score += 3;

      if ((focus.includes('performance') || focus.includes('efficiency')) &&
        paths.some(p =>
          p === 'index.ts' || p === 'index.js' || p === 'main.ts' || p === 'main.rs' ||
          p.endsWith('/index.ts') || p.endsWith('/index.js') ||
          p.endsWith('/main.ts') || p.endsWith('/main.rs') ||
          p.includes('/server')
        )) score += 2;

      if (focus.includes('maintainab') && diff.files.length > 5) score += 2;

      if ((focus.includes('dependencies') || focus.includes('dependency')) && paths.some(p =>
        p.includes('package.json') || p.includes('cargo.toml') || p.includes('requirements')
      )) score += 3;

      const isCustom = !AGENT_POOL.some(p => p.name === agent.name);
      if (isCustom) score += 1;

      return { agent, score };
    });

    candidates.sort((a, b) => b.score - a.score);
    const additional = candidates.slice(0, teamSize - selected.length).map(c => c.agent);
    selected.push(...additional);
  }

  return { level, agents: selected, lineCount };
}

export interface ReviewClients {
  reviewer: ClaudeClient;
  judge: ClaudeClient;
}

export async function runReview(
  clients: ReviewClients,
  config: ReviewConfig,
  diff: ParsedDiff,
  rawDiff: string,
  repoContext: string,
  memory?: RepoMemory | null,
): Promise<ReviewResult> {
  const team = selectTeam(diff, config, config.reviewers);
  core.info(`Review team (${team.level}): ${team.agents.map(a => a.name).join(', ')}`);

  core.info(`Running ${team.agents.length} reviewer agents in parallel...`);
  const agentResults = await Promise.allSettled(
    team.agents.map(agent =>
      runReviewerAgent(clients.reviewer, config, agent, rawDiff, repoContext)
    )
  );

  const allFindings: Finding[] = [];
  for (let i = 0; i < agentResults.length; i++) {
    const result = agentResults[i];
    if (result.status === 'fulfilled') {
      allFindings.push(...result.value);
      core.info(`${team.agents[i].name}: ${result.value.length} findings`);
    } else {
      core.warning(`${team.agents[i].name} failed: ${result.reason}`);
    }
  }

  if (allFindings.length === 0 && agentResults.every(r => r.status === 'rejected')) {
    return {
      verdict: 'COMMENT',
      summary: 'Review could not be completed — all reviewer agents failed.',
      findings: [],
      highlights: [],
      reviewComplete: false,
    };
  }

  let finalFindings: Finding[];
  if (allFindings.length === 0) {
    finalFindings = [];
  } else {
    try {
      core.info(`Running judge on ${allFindings.length} findings...`);
      const judgeInput: JudgeInput = {
        findings: allFindings,
        diff,
        rawDiff,
        memory: memory ?? undefined,
        repoContext,
      };
      const judged = await runJudgeAgent(clients.judge, config, judgeInput);
      finalFindings = judged.filter(f => f.severity !== 'ignore');
      core.info(`Judge complete: ${finalFindings.length} findings survived (${judged.length - finalFindings.length} ignored)`);
    } catch (error) {
      core.warning(`Judge failed: ${error}. Returning reviewer findings without judge evaluation.`);
      finalFindings = allFindings;
    }
  }

  const verdict = determineVerdict(finalFindings);

  const teamNames = team.agents.map(a => a.name).join(', ');
  const summary = `Reviewed by ${team.agents.length} agents (${team.level}): ${teamNames}. ${finalFindings.length} findings after judge evaluation.`;

  core.startGroup('Review Summary');
  core.info(`Team: ${teamNames}`);
  core.info(`Level: ${team.level} (${team.lineCount} lines changed)`);
  core.info(`Verdict: ${verdict}`);
  core.info(`Findings: ${finalFindings.length}`);
  for (const f of finalFindings) {
    const icon = f.severity === 'required' ? '\u2717' : f.severity === 'suggestion' ? '\u25CB' : f.severity === 'nit' ? '\u00B7' : '\u2205';
    core.info(`  ${icon} [${f.severity}] ${f.title}`);
    core.info(`    ${f.file}:${f.line}`);
  }
  core.endGroup();

  return {
    verdict,
    summary,
    findings: finalFindings,
    highlights: [],
    reviewComplete: true,
  };
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
    "severity": "required" | "suggestion" | "nit" | "ignore",
    "title": "Short descriptive title",
    "file": "path/to/file.ext",
    "line": <line number in the NEW file>,
    "description": "2-4 sentences: what the issue is, why it matters, potential impact, how to fix.",
    "suggestedFix": "Optional: code snippet showing the fix"
  }
]
\`\`\`

## Severity Guidelines

- **required**: Bugs, security vulnerabilities, data corruption risks, crashes, incorrect behavior. These MUST be fixed before merge.
- **suggestion**: Style improvements, minor optimizations, readability enhancements. Nice to have but not required.
- **nit**: Trivial nitpicks — naming, formatting, minor style preferences. Collected separately for triage.
- **ignore**: Not a real issue — false positive or intentional pattern. Use this to explicitly dismiss a potential finding.

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

  message += `## Pull Request Diff\n\n\`\`\`diff\n${truncateDiff(rawDiff)}\n\`\`\``;

  return message;
}

export function parseFindings(responseText: string, reviewerName: string): Finding[] {
  const jsonText = extractJSON(responseText);

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
  if (severity === 'required' || severity === 'suggestion' || severity === 'nit' || severity === 'ignore') {
    return severity;
  }
  return 'suggestion';
}

export function determineVerdict(findings: Finding[]): ReviewVerdict {
  const hasRequired = findings.some(f => f.severity === 'required');
  return hasRequired ? 'REQUEST_CHANGES' : 'APPROVE';
}

export function truncateDiff(rawDiff: string, maxLength: number = 50000): string {
  if (rawDiff.length <= maxLength) return rawDiff;
  const cutoff = rawDiff.lastIndexOf('\n', maxLength);
  return rawDiff.slice(0, cutoff > 0 ? cutoff : maxLength) + '\n... (truncated)';
}

// Intentionally loose substring matching for dedup. The 10-char minimum guards
// against trivially short titles ("Bug", "Fix") matching everything. Beyond that,
// we prefer false-positive dedup (merging two similar findings) over false-negative
// dedup (reporting the same issue twice from different reviewers).
export function titlesMatch(a: string, b: string): boolean {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return true;

  if (aLower.length < 10 || bLower.length < 10) return false;

  const shorter = aLower.length <= bLower.length ? aLower : bLower;
  const longer = aLower.length > bLower.length ? aLower : bLower;

  return longer.includes(shorter);
}
