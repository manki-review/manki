import * as core from '@actions/core';

import { ClaudeClient } from './claude';
import { runJudgeAgent, JudgeInput } from './judge';
import { RepoMemory, applySuppressions, buildMemoryContext } from './memory';
import { LinkedIssue } from './github';
import { ReviewConfig, ReviewerAgent, Finding, ReviewResult, ReviewVerdict, ParsedDiff, DiffFile, TeamRoster, PrContext } from './types';
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

export function shuffleDiffFiles(diff: ParsedDiff): ParsedDiff {
  const shuffled = [...diff.files];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { ...diff, files: shuffled };
}

export function rebuildRawDiff(diff: ParsedDiff): string {
  return diff.files.map((f: DiffFile) => {
    const header = `diff --git a/${f.path} b/${f.path}`;
    const hunks = f.hunks.map(h => {
      const hunkHeader = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
      return `${hunkHeader}\n${h.content}`;
    }).join('\n');
    return `${header}\n${hunks}`;
  }).join('\n');
}

export function findingsMatch(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (Math.abs(a.line - b.line) > 3) return false;
  return titlesMatch(a.title, b.title);
}

export function intersectFindings(passes: Finding[][], threshold: number): Finding[] {
  // Collect all unique findings across all passes (using fuzzy match for dedup)
  const allCandidates: Finding[] = [];

  for (const pass of passes) {
    for (const f of pass) {
      if (!allCandidates.some(c => findingsMatch(c, f))) {
        allCandidates.push(f);
      }
    }
  }

  // Keep candidates that appear in >= threshold passes
  return allCandidates.filter(candidate => {
    let count = 0;
    for (const pass of passes) {
      if (pass.some(f => findingsMatch(candidate, f))) {
        count++;
      }
    }
    return count >= threshold;
  });
}

export interface ReviewClients {
  reviewer: ClaudeClient;
  judge: ClaudeClient;
}

export interface ReviewProgress {
  phase: 'reviewed';
  rawFindingCount: number;
}

export async function runReview(
  clients: ReviewClients,
  config: ReviewConfig,
  diff: ParsedDiff,
  rawDiff: string,
  repoContext: string,
  memory?: RepoMemory | null,
  fileContents?: Map<string, string>,
  prContext?: PrContext,
  linkedIssues?: LinkedIssue[],
  onProgress?: (progress: ReviewProgress) => void,
): Promise<ReviewResult> {
  const team = selectTeam(diff, config, config.reviewers);
  core.info(`Review team (${team.level}): ${team.agents.map(a => a.name).join(', ')}`);

  const memoryContext = memory ? buildMemoryContext(memory) : '';

  const passes = config.review_passes ?? 1;
  const multiPass = passes > 1;

  const allFindings: Finding[] = [];
  let allAgentsFailed = true;

  if (multiPass) {
    core.info(`Running ${team.agents.length} reviewer agents with ${passes} passes each (multi-pass mode)...`);
    for (const agent of team.agents) {
      const passResults = await Promise.allSettled(
        Array.from({ length: passes }, () => {
          const shuffledDiff = shuffleDiffFiles(diff);
          const shuffledRawDiff = rebuildRawDiff(shuffledDiff);
          return runReviewerAgent(clients.reviewer, config, agent, shuffledRawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues);
        })
      );

      const passFindings: Finding[][] = [];
      for (const result of passResults) {
        if (result.status === 'fulfilled') {
          passFindings.push(result.value);
        } else {
          core.warning(`${agent.name} pass failed: ${result.reason}`);
        }
      }

      if (passFindings.length > 0) {
        allAgentsFailed = false;
        const threshold = Math.ceil(passFindings.length / 2);
        const consistent = intersectFindings(passFindings, threshold);
        const totalRaw = passFindings.reduce((sum, p) => sum + p.length, 0);
        core.info(`Multi-pass: ${agent.name} — ${passFindings.length} passes, ${consistent.length} consistent findings (from ${totalRaw} raw)`);
        allFindings.push(...consistent);
      } else {
        core.warning(`${agent.name}: all passes failed`);
      }
    }
  } else {
    core.info(`Running ${team.agents.length} reviewer agents in parallel...`);
    const agentResults = await Promise.allSettled(
      team.agents.map(agent =>
        runReviewerAgent(clients.reviewer, config, agent, rawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues)
      )
    );

    for (let i = 0; i < agentResults.length; i++) {
      const result = agentResults[i];
      if (result.status === 'fulfilled') {
        allAgentsFailed = false;
        allFindings.push(...result.value);
        core.info(`${team.agents[i].name}: ${result.value.length} findings`);
      } else {
        core.warning(`${team.agents[i].name} failed: ${result.reason}`);
      }
    }
  }

  if (allFindings.length === 0 && allAgentsFailed) {
    return {
      verdict: 'COMMENT',
      summary: 'Review could not be completed — all reviewer agents failed.',
      findings: [],
      highlights: [],
      reviewComplete: false,
    };
  }

  if (onProgress) {
    onProgress({ phase: 'reviewed', rawFindingCount: allFindings.length });
  }

  let findingsForJudge = allFindings;
  if (memory?.suppressions && memory.suppressions.length > 0) {
    const { kept, suppressed } = applySuppressions(allFindings, memory.suppressions);
    if (suppressed.length > 0) {
      core.info(`Suppressed ${suppressed.length} findings before judge evaluation`);
    }
    findingsForJudge = kept;
  }

  let finalFindings: Finding[];
  let allJudgedFindings: Finding[] | undefined;
  let judgeSummary = 'Review complete.';
  if (findingsForJudge.length === 0) {
    finalFindings = [];
  } else {
    try {
      core.info(`Running judge on ${findingsForJudge.length} findings...`);
      const judgeInput: JudgeInput = {
        findings: findingsForJudge,
        diff,
        rawDiff,
        memory: memory ?? undefined,
        repoContext,
        prContext,
        linkedIssues,
        agentCount: team.agents.length,
      };
      const judgeResult = await runJudgeAgent(clients.judge, config, judgeInput);
      judgeSummary = judgeResult.summary;
      allJudgedFindings = judgeResult.findings;
      finalFindings = judgeResult.findings.filter(f => f.severity !== 'ignore');
      core.info(`Judge complete: ${finalFindings.length} findings survived (${judgeResult.findings.length - finalFindings.length} ignored)`);
    } catch (error) {
      core.warning(`Judge failed: ${error}. Returning reviewer findings without judge evaluation.`);
      finalFindings = allFindings;
    }
  }

  const verdict = determineVerdict(finalFindings);

  const summary = judgeSummary;

  core.startGroup('Review Summary');
  core.info(`Team: ${team.agents.map(a => a.name).join(', ')}`);
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
    rawFindingCount: allFindings.length,
    agentNames: team.agents.map(a => a.name),
    allJudgedFindings,
  };
}

async function runReviewerAgent(
  client: ClaudeClient,
  config: ReviewConfig,
  reviewer: ReviewerAgent,
  rawDiff: string,
  repoContext: string,
  fileContents?: Map<string, string>,
  prContext?: PrContext,
  memoryContext?: string,
  linkedIssues?: LinkedIssue[],
): Promise<Finding[]> {
  const systemPrompt = buildReviewerSystemPrompt(reviewer, config);
  const userMessage = buildReviewerUserMessage(rawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues);

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
  - SQL injection via unsanitized user input in a database query
  - Null/undefined dereference in an error handling path that will crash at runtime
  - Off-by-one in array bounds causing data corruption or out-of-bounds access
- **suggestion**: Style improvements, minor optimizations, readability enhancements. Nice to have but not required.
  - Error message lacks context (e.g., logging "failed" without the error reason)
  - Variable could be \`const\` instead of \`let\` since it is never reassigned
  - Function could be simplified by extracting a reusable helper
- **nit**: Trivial nitpicks — naming, formatting, minor style preferences. Collected separately for triage.
  - Variable name could be more descriptive (e.g., \`x\` → \`connectionCount\`)
  - Inconsistent import ordering compared to rest of file
  - Missing JSDoc on an exported function
- **ignore**: Not a real issue — false positive or intentional pattern. Use this to explicitly dismiss a potential finding.

## Rules

- ONLY review the changes shown in the diff. Don't comment on unchanged code.
- Be precise with line numbers — they must correspond to lines in the NEW version of the file.
- Don't flag intentional patterns (e.g., TODO comments, known workarounds mentioned in context).
- Keep descriptions concrete and actionable.
- If you find NO issues, respond with an empty array: []
- Be thorough but not pedantic. Quality over quantity.
- When full file contents are provided, use them to understand context (variable definitions, imports, surrounding logic) but only flag issues in the changed code.
- When review memory is provided, respect its learnings and suppressions. Do not flag patterns that are listed as intentionally suppressed.
- If you notice changes in the diff that appear unrelated to the PR's stated purpose (title and description), flag them as a "suggestion" severity finding titled "Unrelated change: [brief description]". Recommend splitting into a separate PR. Only flag changes that are clearly out of scope — don't flag shared config, imports, or test files that naturally accompany the main changes.`;

  if (config.instructions) {
    prompt += `\n\n## Additional Instructions\n\n${config.instructions}`;
  }

  return prompt;
}

export function buildReviewerUserMessage(
  rawDiff: string,
  repoContext: string,
  fileContents?: Map<string, string>,
  prContext?: PrContext,
  memoryContext?: string,
  linkedIssues?: LinkedIssue[],
): string {
  let message = '';

  if (prContext) {
    message += `## Pull Request\n\n`;
    message += `**Title**: ${prContext.title}\n`;
    message += `**Base branch**: ${prContext.baseBranch}\n`;
    if (prContext.body) {
      const body = prContext.body.length > 2000
        ? prContext.body.slice(0, 2000) + '\n... (truncated)'
        : prContext.body;
      message += `\n${body}\n`;
    }
    message += '\n';
  }

  if (linkedIssues && linkedIssues.length > 0) {
    message += `## Linked Issues (user-provided context)\n\n`;
    for (const issue of linkedIssues) {
      message += `### Issue #${issue.number}: ${issue.title}\n\n`;
      if (issue.body) {
        message += `${issue.body}\n\n`;
      }
    }
  }

  if (repoContext) {
    message += `## Repository Context\n\n${repoContext}\n\n`;
  }

  if (memoryContext) {
    message += `## Review Memory\n\n${memoryContext}\n\n`;
  }

  if (fileContents && fileContents.size > 0) {
    message += `## Changed Files\n\n`;
    message += `The full content of changed files is provided below for context. Focus your review on the diff, but use these files to understand the surrounding code.\n\n`;
    for (const [path, content] of fileContents) {
      const ext = path.split('.').pop() || '';
      message += `### File: ${path}\n\n\`\`\`${ext}\n${content}\n\`\`\`\n\n`;
    }
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
