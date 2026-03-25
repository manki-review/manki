import * as core from '@actions/core';

import { ClaudeClient } from './claude';
import { ReviewConfig, ReviewerAgent, Finding, FindingSeverity, ReviewResult, ReviewVerdict, ParsedDiff, AgentVote, TeamRoster } from './types';
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

export async function runReview(
  client: ClaudeClient,
  config: ReviewConfig,
  diff: ParsedDiff,
  rawDiff: string,
  repoContext: string,
): Promise<ReviewResult> {
  const team = selectTeam(diff, config, config.reviewers);
  core.info(`Review team (${team.level}): ${team.agents.map(a => a.name).join(', ')}`);

  core.info(`Running ${team.agents.length} reviewer agents in parallel...`);
  const agentResults = await Promise.allSettled(
    team.agents.map(agent =>
      runReviewerAgent(client, config, agent, rawDiff, repoContext)
    )
  );

  const allFindings: { reviewer: string; findings: Finding[] }[] = [];
  for (let i = 0; i < agentResults.length; i++) {
    const result = agentResults[i];
    if (result.status === 'fulfilled') {
      allFindings.push({ reviewer: team.agents[i].name, findings: result.value });
      core.info(`${team.agents[i].name}: ${result.value.length} findings`);
    } else {
      core.warning(`${team.agents[i].name} failed: ${result.reason}`);
    }
  }

  if (allFindings.length === 0) {
    return {
      verdict: 'COMMENT',
      summary: 'Review could not be completed — all reviewer agents failed.',
      findings: [],
      highlights: [],
      reviewComplete: false,
    };
  }

  let finalFindings: Finding[];
  try {
    core.info('Running deliberation round...');
    finalFindings = await runDeliberation(client, config, team, allFindings, rawDiff);
    core.info(`Deliberation complete: ${finalFindings.length} findings survived`);
  } catch (error) {
    core.warning(`Deliberation failed: ${error}. Falling back to merged findings.`);
    finalFindings = mergeIndividualFindings(allFindings).findings;
  }

  const hasRequired = finalFindings.some(f => f.severity === 'required');
  const verdict = hasRequired ? 'REQUEST_CHANGES' : 'APPROVE';

  const teamNames = team.agents.map(a => a.name).join(', ');
  const summary = `Reviewed by ${team.agents.length} agents (${team.level}): ${teamNames}. ${finalFindings.length} findings after deliberation.`;

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

async function runDeliberation(
  client: ClaudeClient,
  config: ReviewConfig,
  team: TeamRoster,
  allFindings: { reviewer: string; findings: Finding[] }[],
  rawDiff: string,
): Promise<Finding[]> {
  const rawFindings: Array<Finding & { originalReviewer: string }> = [];
  for (const af of allFindings) {
    for (const f of af.findings) {
      rawFindings.push({ ...f, originalReviewer: af.reviewer });
    }
  }

  if (rawFindings.length === 0) return [];

  // Deduplicate findings before deliberation
  const deduped: Array<Finding & { originalReviewer: string }> = [];
  for (const f of rawFindings) {
    const existing = deduped.find(d =>
      d.file === f.file &&
      Math.abs(d.line - f.line) <= 3 &&
      titlesMatch(d.title, f.title)
    );
    if (existing) {
      const severityOrder: Record<FindingSeverity, number> = { required: 3, suggestion: 2, nit: 1, ignore: 0 };
      if ((severityOrder[f.severity] || 0) > (severityOrder[existing.severity] || 0)) {
        existing.severity = f.severity;
      }
      if (!existing.reviewers.includes(f.originalReviewer)) {
        existing.reviewers = [...existing.reviewers, f.originalReviewer];
      }
    } else {
      deduped.push(f);
    }
  }

  const flatFindings = deduped.map((f, i) => ({ ...f, index: i }));

  const findingsSummary = flatFindings.map((f, i) =>
    `[${i}] [${f.severity}] "${f.title}" at ${f.file}:${f.line} (by ${f.originalReviewer})\n    ${f.description}`
  ).join('\n\n');

  const voteResults = await Promise.allSettled(
    team.agents.map(agent => runAgentVote(client, config, agent, findingsSummary, rawDiff, flatFindings.length))
  );

  const allVotes: AgentVote[] = [];
  for (let i = 0; i < voteResults.length; i++) {
    const result = voteResults[i];
    if (result.status === 'fulfilled') {
      // Deduplicate: only keep the first vote from each agent per finding
      const seen = new Set<number>();
      for (const vote of result.value) {
        if (!seen.has(vote.findingIndex)) {
          seen.add(vote.findingIndex);
          allVotes.push(vote);
        }
      }
    } else {
      core.warning(`${team.agents[i].name} deliberation failed: ${result.reason}`);
    }
  }

  return tallyVotes(flatFindings, allVotes, team.agents.length);
}

async function runAgentVote(
  client: ClaudeClient,
  config: ReviewConfig,
  agent: ReviewerAgent,
  findingsSummary: string,
  rawDiff: string,
  totalFindings: number,
): Promise<AgentVote[]> {
  let systemPrompt = `You are ${agent.name}, a code review specialist focusing on: ${agent.focus}

Other reviewers have found issues in a pull request. You must vote on each finding.

For each finding, respond with a JSON array:
[
  { "index": 0, "vote": "agree", "reason": "This is a real issue because..." },
  { "index": 1, "vote": "disagree", "reason": "This is not an issue because..." },
  ...
]

Vote options:
- "agree" — the finding is valid and should be reported
- "disagree" — the finding is a false positive or not worth flagging
- "escalate" — the finding is more serious than the original severity suggests

Be concise. One sentence per reason. Vote on EVERY finding.`;

  if (config.instructions) {
    systemPrompt += `\n\n## Additional Instructions\n\n${config.instructions}`;
  }

  const userMessage = `## Findings to vote on\n\n${findingsSummary}\n\n## PR Diff (for context)\n\n\`\`\`diff\n${truncateDiff(rawDiff)}\n\`\`\``;

  const response = await client.sendMessage(systemPrompt, userMessage);
  const jsonText = extractJSON(response.content);

  try {
    const validVotes = ['agree', 'disagree', 'escalate'];
    const votes = JSON.parse(jsonText) as Array<{ index: number; vote: string; reason: string }>;
    return votes
      .filter(v => v.index >= 0 && v.index < totalFindings && validVotes.includes(v.vote))
      .map(v => ({
        agentName: agent.name,
        findingIndex: v.index,
        vote: v.vote as AgentVote['vote'],
        reason: v.reason || '',
      }));
  } catch {
    core.warning(`Failed to parse votes from ${agent.name}`);
    return [];
  }
}

export function tallyVotes(
  findings: Array<Finding & { index: number; originalReviewer: string }>,
  votes: AgentVote[],
  teamSize: number,
): Finding[] {
  if (teamSize <= 0) return findings.map(f => ({ ...f }));

  const results: Finding[] = [];
  const majority = Math.ceil(teamSize / 2);

  for (const finding of findings) {
    // Deduplicate: only count the first vote from each agent per finding
    const seenAgents = new Set<string>();
    const findingVotes = votes.filter(v => {
      if (v.findingIndex !== finding.index) return false;
      const key = v.agentName;
      if (seenAgents.has(key)) return false;
      seenAgents.add(key);
      return true;
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { index, originalReviewer, ...cleanFinding } = finding;

    const agreeCount = findingVotes.filter(v => v.vote === 'agree' || v.vote === 'escalate').length;
    const disagreeCount = findingVotes.filter(v => v.vote === 'disagree').length;
    const escalateCount = findingVotes.filter(v => v.vote === 'escalate').length;

    if (findingVotes.length === 0) {
      results.push(cleanFinding);
      continue;
    }

    if (disagreeCount >= majority) {
      core.info(`Dropped: "${finding.title}" (${disagreeCount}/${findingVotes.length} disagree)`);
      continue;
    }

    if (agreeCount >= majority) {
      let severity = finding.severity;

      // Uses teamSize (not voter count) so that true unanimity is required.
      // If some agents failed to vote, we don't escalate — partial consensus
      // shouldn't be treated as full agreement.
      if (agreeCount === teamSize && finding.severity === 'suggestion') {
        severity = 'required';
      } else if (escalateCount >= 2 && agreeCount >= majority && finding.severity === 'suggestion') {
        severity = 'required';
      }

      const agreeVoters = findingVotes
        .filter(v => v.vote === 'agree' || v.vote === 'escalate')
        .map(v => v.agentName);

      results.push({
        ...cleanFinding,
        severity,
        reviewers: agreeVoters,
      });
      continue;
    }

    results.push({
      ...cleanFinding,
      severity: 'suggestion',
      reviewers: findingVotes.filter(v => v.vote !== 'disagree').map(v => v.agentName),
    });
  }

  return results;
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

export function parseConsolidatedReview(responseText: string): ReviewResult {
  const jsonText = extractJSON(responseText);

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
      reviewComplete: true,
    };
  } catch (e) {
    throw new Error(`Failed to parse consolidated review: ${e}`);
  }
}

export function determineVerdict(claimed: unknown, findings: Finding[]): ReviewVerdict {
  const hasRequired = findings.some(f => f.severity === 'required');
  if (hasRequired) return 'REQUEST_CHANGES';
  return 'APPROVE';
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

/**
 * Merge individual reviewer findings when deliberation fails.
 * De-duplicates by title similarity + file + line proximity.
 */
export function mergeIndividualFindings(
  agentFindings: { reviewer: string; findings: Finding[] }[],
): ReviewResult {
  const allFindings: Finding[] = [];

  for (const af of agentFindings) {
    for (const f of af.findings) {
      const existing = allFindings.find(e =>
        e.file === f.file &&
        Math.abs(e.line - f.line) <= 3 &&
        titlesMatch(e.title, f.title)
      );

      if (existing) {
        if (!existing.reviewers.includes(af.reviewer)) {
          existing.reviewers = [...existing.reviewers, af.reviewer];
        }
      } else {
        allFindings.push({ ...f, reviewers: [af.reviewer] });
      }
    }
  }

  const hasRequired = allFindings.some(f => f.severity === 'required');

  return {
    verdict: hasRequired ? 'REQUEST_CHANGES' : 'APPROVE',
    summary: `Review completed (consolidation skipped). ${allFindings.length} findings from ${agentFindings.length} reviewers.`,
    findings: allFindings,
    highlights: [],
    reviewComplete: true,
  };
}
