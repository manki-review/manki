import * as core from '@actions/core';

import { ClaudeClient } from './claude';
import { runJudgeAgent, JudgeInput, ResolveThread } from './judge';
import { RepoMemory, applySuppressions, buildMemoryContext } from './memory';
import { LinkedIssue } from './github';
import { deduplicateFindings, llmDeduplicateFindings, PreviousFinding } from './recap';
import { ReviewConfig, ReviewerAgent, Finding, ReviewResult, ReviewVerdict, ParsedDiff, DiffFile, TeamRoster, PrContext, PlannerResult, EffortLevel, AgentPick, MAX_AGENT_RETRIES } from './types';
import { extractJSON } from './json';

export const HIGH_CONF_SUGGESTION_THRESHOLD = 1;

export const PLANNER_TIMEOUT_MS = 30_000;

const SUSPICIOUS_FAST_THRESHOLD_MS = 15_000;

// Standard reviewer pool used for teamSize >= 3. TRIVIAL_VERIFIER_AGENT is
// intentionally excluded — it is only active for the teamSize=1 path and does
// not participate in scoring, focusAreas validation, or planner prompts.
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

export const TRIVIAL_VERIFIER_AGENT: ReviewerAgent = Object.freeze({
  name: 'Trivial Change Verifier',
  focus: 'Review this trivial change on two fronts: (1) check the actual content for issues appropriate to the change type — typos, stale references, broken markdown/links, incomplete renames; (2) verify the change is actually trivial as classified and flag any hidden behavior change, security implication, broken invariant, or missing test that would contradict that assessment.',
});

export function buildAgentPool(customReviewers?: ReviewerAgent[]): ReviewerAgent[] {
  const pool = [...AGENT_POOL];
  for (const custom of (customReviewers ?? [])) {
    if (!pool.some(p => p.name === custom.name)) pool.push(custom);
  }
  return pool;
}

export function selectTeam(
  diff: ParsedDiff,
  config: ReviewConfig,
  customReviewers?: ReviewerAgent[],
  teamSizeOverride?: 1 | 3 | 5 | 7,
  agentPicks?: AgentPick[],
): TeamRoster {
  const lineCount = diff.totalAdditions + diff.totalDeletions;

  let teamSize: number;
  let level: 'small' | 'medium' | 'large';

  if (teamSizeOverride === 1) {
    if (customReviewers && customReviewers.length > 0) {
      core.info(`teamSize=1: skipping custom reviewers [${customReviewers.map(r => r.name).join(', ')}]`);
    }
    return { level: 'trivial', agents: [TRIVIAL_VERIFIER_AGENT], lineCount };
  }

  // Planner-driven agent selection: resolve each picked name from the pool
  if (agentPicks && agentPicks.length > 0 && teamSizeOverride) {
    const pool = buildAgentPool(customReviewers);
    const poolMap = new Map(pool.map(a => [a.name, a]));
    const resolved: ReviewerAgent[] = [];
    for (const pick of agentPicks) {
      const agent = poolMap.get(pick.name);
      if (agent && !resolved.some(r => r.name === agent.name)) {
        resolved.push(agent);
      }
    }

    if (resolved.length > 0) {
      let level: 'small' | 'medium' | 'large';
      if (resolved.length <= 3) level = 'small';
      else if (resolved.length <= 5) level = 'medium';
      else level = 'large';
      return { level, agents: resolved, lineCount };
    }
    // If resolution failed entirely, fall through to heuristic
  }

  if (teamSizeOverride) {
    teamSize = teamSizeOverride;
    if (teamSize <= 3) level = 'small';
    else if (teamSize <= 5) level = 'medium';
    else level = 'large';
  } else {
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
    teamSize = level === 'small' ? 3 : level === 'medium' ? 5 : 7;
  }

  const pool = buildAgentPool(customReviewers);

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
  planner?: ClaudeClient;
  dedup?: ClaudeClient;
}

export interface ReviewProgress {
  phase: 'planning' | 'agent-complete' | 'reviewed' | 'judging';
  agentName?: string;
  agentFindingCount?: number;
  agentDurationMs?: number;
  agentStatus?: 'success' | 'failure' | 'retrying';
  rawFindingCount: number;
  judgeInputCount?: number;
  completedAgents?: number;
  totalAgents?: number;
  plannerResult?: PlannerResult;
  plannerDurationMs?: number;
  retryCount?: number;
}

function buildPlannerSummary(diff: ParsedDiff, prContext?: PrContext): string {
  let summary = '';

  if (prContext) {
    summary += `PR: ${prContext.title}`;
    if (prContext.baseBranch) summary += ` (${prContext.baseBranch})`;
    summary += '\n';
  }

  summary += `\nFiles changed (${diff.totalAdditions}+ ${diff.totalDeletions}-):\n`;

  for (let i = 0; i < diff.files.length; i++) {
    const file = diff.files[i];
    const additions = file.hunks.reduce((sum, h) => sum + h.content.split('\n').filter(l => l.startsWith('+')).length, 0);
    const deletions = file.hunks.reduce((sum, h) => sum + h.content.split('\n').filter(l => l.startsWith('-')).length, 0);
    summary += `- ${file.path} (${file.changeType}, +${additions} -${deletions})\n`;

    if (summary.length > 1800) {
      summary += `... and ${diff.files.length - i - 1} more files\n`;
      break;
    }
  }

  return summary.slice(0, 2000);
}

export function buildPlannerSystemPrompt(agents: Array<{ name: string; focus: string }>): string {
  const agentList = agents.map(a => `  - "${a.name}" — ${a.focus}`).join('\n');

  return `You are a code review planning assistant. Analyze this PR and decide how to review it.

Decide:
1. teamSize: 1, 3, 5, or 7 reviewer agents (odd numbers for majority voting).
   Default to 3. Scale to 5 when the PR touches core infrastructure, spans multiple subsystems, or has security implications. 7 is rare — reserve it for changes where missing a specialist would be dangerous. Diff size alone doesn't determine team size — a 50-line auth change needs more eyes than a 500-line rename.
   - 1: changes where a bug is unrealistic (docs, comments, renames)
   - 3: most PRs — bug fixes, features, refactors
   - 5: PRs that span multiple concerns or subsystems
   - 7: security/crypto-critical, architectural overhauls
2. agents: pick exactly teamSize agents from the pool below, each with an effort level ("low", "medium", or "high"):
${agentList}
   Effort controls thinking depth and cost. low = fast pass, no extended reasoning. medium = moderate reasoning (~5K thinking tokens). high = deep analysis (~10K thinking tokens). Higher effort catches subtle bugs but costs more. Match effort to the risk level of each agent's assignment — security on auth code needs high, maintainability on a rename needs low.
   - low: the agent's specialty is not very relevant to this PR
   - medium: standard relevance
   - high: the agent's specialty is critical for this PR
3. judgeEffort: "low", "medium", or "high" — how much effort the judge should spend evaluating findings.
   - low: few expected findings, straightforward changes
   - medium: moderate findings expected
   - high: many findings expected, nuanced severity decisions
4. prType: one of "feature", "bugfix", "refactor", "docs", "test", "chore", "rename"
5. language: the primary programming language of the changed code (e.g., "typescript", "rust", "python"). Omit if unclear.
6. context: a short phrase describing the project domain (e.g., "blockchain consensus library", "REST API server"). Omit if unclear.

Respond with ONLY a JSON object (no markdown fences):
{
  "teamSize": 3,
  "judgeEffort": "medium",
  "prType": "feature",
  "language": "typescript",
  "context": "GitHub Actions bot",
  "agents": [
    { "name": "Security & Safety", "effort": "medium" },
    { "name": "Correctness & Logic", "effort": "high" },
    { "name": "Architecture & Design", "effort": "medium" }
  ]
}`;
}

const VALID_TEAM_SIZES = new Set([1, 3, 5, 7]);
const VALID_EFFORTS = new Set(['low', 'medium', 'high']);
const VALID_PR_TYPES = new Set(['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore', 'rename']);

/**
 * Sanitize a free-text field from the planner LLM to prevent prompt injection.
 * Strips markdown fences, instruction-like patterns, and limits to safe characters.
 */
export function sanitizePlannerField(raw: string, maxLength: number): string {
  let s = raw.trim();
  // Strip markdown code fences
  s = s.replace(/```[\s\S]*?```/g, '');
  // Strip inline code
  s = s.replace(/`[^`]*`/g, '');
  // Strip markdown headings
  s = s.replace(/^#{1,6}\s+/gm, '');
  // Strip instruction-like patterns (e.g., "You are...", "Ignore previous...", "System:")
  s = s.replace(/\b(you are|ignore|forget|disregard|override)\b.*$/gim, '');
  s = s.replace(/\b(system|assistant|user)\s*:.*$/gim, '');
  // Only keep alphanumeric, spaces, and basic punctuation
  s = s.replace(/[^a-zA-Z0-9 .,;:!?'"/+#&()-]/g, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, maxLength);
}

export function parseAgentPicks(
  raw: unknown,
  availableNames: Set<string>,
): AgentPick[] | null {
  if (!Array.isArray(raw)) return null;

  const picks: AgentPick[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const effort = typeof entry.effort === 'string' ? entry.effort : '';
    if (!availableNames.has(name) || !VALID_EFFORTS.has(effort)) return null;
    picks.push({ name, effort: effort as EffortLevel });
  }

  if (picks.length === 0) return null;

  return picks;
}

export async function runPlanner(
  client: ClaudeClient,
  diff: ParsedDiff,
  prContext?: PrContext,
  customReviewers?: ReviewerAgent[],
): Promise<PlannerResult | null> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Planner timed out')), PLANNER_TIMEOUT_MS);
  });

  try {
    const pool = buildAgentPool(customReviewers);
    const availableNames = new Set(pool.map(a => a.name));
    const systemPrompt = buildPlannerSystemPrompt(pool);

    const userMessage = buildPlannerSummary(diff, prContext);
    const response = await Promise.race([
      client.sendMessage(systemPrompt, userMessage, { effort: 'high' }),
      timeoutPromise,
    ]);
    clearTimeout(timeoutId!);

    const jsonText = extractJSON(response.content);
    const parsed = JSON.parse(jsonText);

    let teamSize = parsed.teamSize;
    if (!VALID_TEAM_SIZES.has(teamSize)) {
      core.warning(`Planner returned invalid teamSize ${teamSize} — falling back to heuristic`);
      return null;
    }

    const judgeEffort = parsed.judgeEffort;
    if (!VALID_EFFORTS.has(judgeEffort)) {
      core.warning('Planner returned invalid judgeEffort — falling back to heuristic');
      return null;
    }

    // Parse reviewerEffort as fallback (backward compat)
    const reviewerEffortRaw = parsed.reviewerEffort;
    const reviewerEffort: EffortLevel = VALID_EFFORTS.has(reviewerEffortRaw)
      ? (reviewerEffortRaw as EffortLevel)
      : 'medium';

    const prTypeRaw = typeof parsed.prType === 'string' ? parsed.prType : 'unknown';
    const prType = VALID_PR_TYPES.has(prTypeRaw) ? prTypeRaw : 'unknown';

    // Parse agent picks
    const agents = parseAgentPicks(parsed.agents, availableNames);
    if (agents) {
      // Trust agents array length over teamSize when they differ.
      // Exclude 1 from correction candidates — teamSize=1 is only valid when the
      // planner explicitly requests it, not as a side-effect of rounding down.
      const validSizes = [3, 5, 7];
      const closestValid = validSizes.reduce((prev, curr) =>
        Math.abs(curr - agents.length) < Math.abs(prev - agents.length) ? curr : prev,
      );
      if (agents.length !== teamSize) {
        core.info(`Planner agents.length (${agents.length}) differs from teamSize (${teamSize}), using closest valid size ${closestValid}`);
        teamSize = closestValid;
      }
    }

    // Parse and sanitize language and context to prevent prompt injection
    const rawLang = typeof parsed.language === 'string' ? sanitizePlannerField(parsed.language, 100) : '';
    const language = rawLang ? rawLang.toLowerCase() : undefined;
    const rawCtx = typeof parsed.context === 'string' ? sanitizePlannerField(parsed.context, 200) : '';
    const context = rawCtx || undefined;

    return { teamSize, reviewerEffort, judgeEffort, prType, agents: agents ?? undefined, language, context };
  } catch (error) {
    clearTimeout(timeoutId!);
    core.warning(`Planner failed: ${error} — falling back to heuristic team selection`);
    return null;
  }
}

function heuristicFallback(diff: ParsedDiff, config: ReviewConfig): TeamRoster {
  const team = selectTeam(diff, config, config.reviewers);
  core.info(`Review team (${team.level}): ${team.agents.map(a => a.name).join(', ')}`);
  return team;
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
  isFollowUp?: boolean,
  openThreads?: Array<{ threadId: string; title: string; file: string; line: number; severity: string }>,
  previousFindings?: PreviousFinding[],
): Promise<ReviewResult> {
  let team: TeamRoster;
  let plannerResult: PlannerResult | null = null;

  if (clients.planner && config.review_level === 'auto') {
    if (onProgress) {
      onProgress({ phase: 'planning', rawFindingCount: 0 });
    }
    const plannerStart = Date.now();
    plannerResult = await runPlanner(clients.planner, diff, prContext, config.reviewers);
    const plannerDurationMs = Date.now() - plannerStart;
    if (plannerResult) {
      team = selectTeam(diff, config, config.reviewers, plannerResult.teamSize, plannerResult.agents);
      core.info(`Planner: ${plannerResult.teamSize} agents, reviewer: ${plannerResult.reviewerEffort}, judge: ${plannerResult.judgeEffort} (${plannerResult.prType})`);
      if (plannerResult.teamSize === 1) {
        const totalLines = diff.totalAdditions + diff.totalDeletions;
        core.info(`teamSize=1 decision: prType=${plannerResult.prType}, lines=${totalLines}, files=${diff.files.length}`);
      }
      if (onProgress) {
        onProgress({ phase: 'planning', rawFindingCount: 0, plannerResult, plannerDurationMs });
      }
    } else {
      team = heuristicFallback(diff, config);
    }
  } else {
    team = heuristicFallback(diff, config);
  }

  const memoryContext = memory ? buildMemoryContext(memory) : '';
  const agentEffortMap = new Map<string, EffortLevel>();
  if (plannerResult?.agents) {
    for (const pick of plannerResult.agents) {
      agentEffortMap.set(pick.name, pick.effort);
    }
  }
  const defaultReviewerEffort = plannerResult?.reviewerEffort;
  const judgeEffort = plannerResult?.judgeEffort ?? 'high';

  const passes = config.review_passes ?? 1;
  const multiPass = passes > 1;

  const allFindings: Finding[] = [];
  const failedAgents: string[] = [];
  const agentResponseLengths = new Map<string, number>();

  let completedCount = 0;
  let progressFindingCount = 0;

  if (multiPass) {
    core.info(`Running ${team.agents.length} reviewer agents with ${passes} passes each (multi-pass mode)...`);
    for (const agent of team.agents) {
      const startTime = Date.now();
      const agentEffort = agentEffortMap.get(agent.name) ?? defaultReviewerEffort;
      const passResults = await Promise.allSettled(
        Array.from({ length: passes }, () => {
          const shuffledDiff = shuffleDiffFiles(diff);
          const shuffledRawDiff = rebuildRawDiff(shuffledDiff);
          return runReviewerAgent(clients.reviewer, config, agent, shuffledRawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues, agentEffort, plannerResult?.language, plannerResult?.context);
        })
      );

      const passFindings: Finding[][] = [];
      let totalResponseLength = 0;
      for (const result of passResults) {
        if (result.status === 'fulfilled') {
          passFindings.push(result.value.findings);
          totalResponseLength += result.value.responseLength;
        } else {
          core.warning(`${agent.name} pass failed: ${result.reason}`);
        }
      }

      agentResponseLengths.set(agent.name, totalResponseLength);
      completedCount++;

      if (passFindings.length > 0) {
        const threshold = Math.ceil(passFindings.length / 2);
        const consistent = intersectFindings(passFindings, threshold);
        const totalRaw = passFindings.reduce((sum, p) => sum + p.length, 0);
        core.info(`Multi-pass: ${agent.name} — ${passFindings.length} passes, ${consistent.length} consistent findings (from ${totalRaw} raw)`);
        allFindings.push(...consistent);

        const durationMs = Date.now() - startTime;
        if (consistent.length === 0 && durationMs < SUSPICIOUS_FAST_THRESHOLD_MS) {
          core.warning(`${agent.name}: 0 findings in ${(durationMs / 1000).toFixed(1)}s — suspiciously fast`);
        }

        if (onProgress) {
          onProgress({
            phase: 'agent-complete',
            agentName: agent.name,
            agentFindingCount: consistent.length,
            agentDurationMs: durationMs,
            agentStatus: 'success',
            rawFindingCount: allFindings.length,
            completedAgents: completedCount,
            totalAgents: team.agents.length,
          });
        }
      } else {
        failedAgents.push(agent.name);
        core.warning(`${agent.name}: all passes failed`);

        if (onProgress) {
          onProgress({
            phase: 'agent-complete',
            agentName: agent.name,
            agentFindingCount: 0,
            agentDurationMs: Date.now() - startTime,
            agentStatus: 'failure',
            rawFindingCount: allFindings.length,
            completedAgents: completedCount,
            totalAgents: team.agents.length,
          });
        }
      }
    }

    // Retry failed agents up to MAX_AGENT_RETRIES times (multi-pass)
    const retryCountMap: Record<string, number> = {};
    for (let retry = 1; retry <= MAX_AGENT_RETRIES && failedAgents.length > 0; retry++) {
      const agentsToRetry = failedAgents.map(name => team.agents.find(a => a.name === name)!);
      core.info(`Retry ${retry}/${MAX_AGENT_RETRIES} (multi-pass): retrying ${agentsToRetry.map(a => a.name).join(', ')}...`);

      const stillFailed: string[] = [];
      for (const agent of agentsToRetry) {
        retryCountMap[agent.name] = (retryCountMap[agent.name] ?? 0) + 1;

        if (onProgress) {
          onProgress({
            phase: 'agent-complete',
            agentName: agent.name,
            agentFindingCount: 0,
            agentStatus: 'retrying',
            rawFindingCount: allFindings.length,
            completedAgents: completedCount,
            totalAgents: team.agents.length,
            retryCount: retryCountMap[agent.name],
          });
        }

        const retryStartTime = Date.now();
        const retryPassResults = await Promise.allSettled(
          Array.from({ length: passes }, () => {
            const shuffledDiff = shuffleDiffFiles(diff);
            const shuffledRawDiff = rebuildRawDiff(shuffledDiff);
            const retryEffort = agentEffortMap.get(agent.name) ?? defaultReviewerEffort;
            return runReviewerAgent(clients.reviewer, config, agent, shuffledRawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues, retryEffort, plannerResult?.language, plannerResult?.context);
          })
        );

        const retryPassFindings: Finding[][] = [];
        let retryTotalResponseLength = 0;
        for (const result of retryPassResults) {
          if (result.status === 'fulfilled') {
            retryPassFindings.push(result.value.findings);
            retryTotalResponseLength += result.value.responseLength;
          } else {
            core.warning(`${agent.name} retry pass failed: ${result.reason}`);
          }
        }

        if (retryPassFindings.length > 0) {
          const threshold = Math.ceil(passes / 2);
          const consistent = intersectFindings(retryPassFindings, threshold);
          core.info(`Multi-pass retry: ${agent.name} — ${retryPassFindings.length} passes, ${consistent.length} consistent findings`);
          allFindings.push(...consistent);
          agentResponseLengths.set(agent.name, retryTotalResponseLength);
          completedCount++;

          if (onProgress) {
            onProgress({
              phase: 'agent-complete',
              agentName: agent.name,
              agentFindingCount: consistent.length,
              agentDurationMs: Date.now() - retryStartTime,
              agentStatus: 'success',
              rawFindingCount: allFindings.length,
              completedAgents: completedCount,
              totalAgents: team.agents.length,
            });
          }
        } else {
          stillFailed.push(agent.name);
          core.warning(`${agent.name}: retry ${retryCountMap[agent.name]} failed (all passes)`);
          if (onProgress) {
            onProgress({
              phase: 'agent-complete',
              agentName: agent.name,
              agentFindingCount: 0,
              agentDurationMs: Date.now() - retryStartTime,
              agentStatus: 'failure',
              rawFindingCount: allFindings.length,
              completedAgents: completedCount,
              totalAgents: team.agents.length,
              retryCount: retryCountMap[agent.name],
            });
          }
        }
      }

      failedAgents.length = 0;
      failedAgents.push(...stillFailed);
    }
  } else {
    core.info(`Running ${team.agents.length} reviewer agents in parallel...`);
    const agentPromises = team.agents.map(agent => {
      const startTime = Date.now();
      const agentEffort = agentEffortMap.get(agent.name) ?? defaultReviewerEffort;
      return runReviewerAgent(clients.reviewer, config, agent, rawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues, agentEffort, plannerResult?.language, plannerResult?.context)
        .then(agentResult => {
          completedCount++;
          agentResponseLengths.set(agent.name, agentResult.responseLength);
          progressFindingCount += agentResult.findings.length;
          const durationMs = Date.now() - startTime;

          if (agentResult.findings.length === 0 && durationMs < SUSPICIOUS_FAST_THRESHOLD_MS) {
            core.warning(`${agent.name}: 0 findings in ${(durationMs / 1000).toFixed(1)}s — suspiciously fast`);
          }

          if (onProgress) {
            onProgress({
              phase: 'agent-complete',
              agentName: agent.name,
              agentFindingCount: agentResult.findings.length,
              agentDurationMs: durationMs,
              agentStatus: 'success',
              rawFindingCount: progressFindingCount,
              completedAgents: completedCount,
              totalAgents: team.agents.length,
            });
          }
          return agentResult.findings;
        })
        .catch(error => {
          completedCount++;
          if (onProgress) {
            onProgress({
              phase: 'agent-complete',
              agentName: agent.name,
              agentFindingCount: 0,
              agentDurationMs: Date.now() - startTime,
              agentStatus: 'failure',
              rawFindingCount: progressFindingCount,
              completedAgents: completedCount,
              totalAgents: team.agents.length,
            });
          }
          throw error;
        });
    });

    const agentResults = await Promise.allSettled(agentPromises);

    for (let i = 0; i < agentResults.length; i++) {
      const result = agentResults[i];
      if (result.status === 'fulfilled') {
        allFindings.push(...result.value);
        core.info(`${team.agents[i].name}: ${result.value.length} findings`);
      } else {
        failedAgents.push(team.agents[i].name);
        core.warning(`${team.agents[i].name} failed: ${result.reason}`);
      }
    }

    // Retry failed agents up to MAX_AGENT_RETRIES times
    const retryCount: Record<string, number> = {};
    for (let retry = 1; retry <= MAX_AGENT_RETRIES && failedAgents.length > 0; retry++) {
      const agentsToRetry = failedAgents.map(name => team.agents.find(a => a.name === name)!);
      core.info(`Retry ${retry}/${MAX_AGENT_RETRIES}: retrying ${agentsToRetry.map(a => a.name).join(', ')}...`);

      for (const agent of agentsToRetry) {
        retryCount[agent.name] = (retryCount[agent.name] ?? 0) + 1;
        if (onProgress) {
          onProgress({
            phase: 'agent-complete',
            agentName: agent.name,
            agentFindingCount: 0,
            agentStatus: 'retrying',
            rawFindingCount: progressFindingCount,
            completedAgents: completedCount,
            totalAgents: team.agents.length,
            retryCount: retryCount[agent.name],
          });
        }
      }

      const retryPromises = agentsToRetry.map(agent => {
        const startTime = Date.now();
        const retryEffort = agentEffortMap.get(agent.name) ?? defaultReviewerEffort;
        return runReviewerAgent(clients.reviewer, config, agent, rawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues, retryEffort, plannerResult?.language, plannerResult?.context)
          .then(agentResult => ({ agent, agentResult, durationMs: Date.now() - startTime }))
          .catch(() => ({ agent, agentResult: null as AgentResult | null, durationMs: Date.now() - startTime }));
      });

      const retryResults = await Promise.allSettled(retryPromises);

      const stillFailed: string[] = [];
      for (const settled of retryResults) {
        const { agent, agentResult, durationMs } = (settled as PromiseFulfilledResult<{ agent: ReviewerAgent; agentResult: AgentResult | null; durationMs: number }>).value;
        if (agentResult !== null) {
          // Remove from failed list, add findings
          allFindings.push(...agentResult.findings);
          agentResponseLengths.set(agent.name, agentResult.responseLength);
          progressFindingCount += agentResult.findings.length;
          completedCount++;
          core.info(`${agent.name}: retry ${retryCount[agent.name]} succeeded — ${agentResult.findings.length} findings`);
          if (onProgress) {
            onProgress({
              phase: 'agent-complete',
              agentName: agent.name,
              agentFindingCount: agentResult.findings.length,
              agentDurationMs: durationMs,
              agentStatus: 'success',
              rawFindingCount: progressFindingCount,
              completedAgents: completedCount,
              totalAgents: team.agents.length,
            });
          }
        } else {
          stillFailed.push(agent.name);
          core.warning(`${agent.name}: retry ${retryCount[agent.name]} failed`);
          if (onProgress) {
            onProgress({
              phase: 'agent-complete',
              agentName: agent.name,
              agentFindingCount: 0,
              agentDurationMs: durationMs,
              agentStatus: 'failure',
              rawFindingCount: progressFindingCount,
              completedAgents: completedCount,
              totalAgents: team.agents.length,
              retryCount: retryCount[agent.name],
            });
          }
        }
      }

      failedAgents.length = 0;
      failedAgents.push(...stillFailed);
    }
  }

  let partialReview = false;
  let partialNote: string | undefined;

  if (failedAgents.length > 0) {
    const quorum = Math.ceil(team.agents.length / 2);
    const succeededCount = team.agents.length - failedAgents.length;

    if (succeededCount < quorum) {
      const summary = failedAgents.length === team.agents.length
        ? 'Review could not be completed — all reviewer agents failed.'
        : `Review incomplete — ${failedAgents.join(', ')} failed after retries. Retry with @manki review.`;
      return {
        verdict: 'COMMENT',
        summary,
        findings: [],
        highlights: [],
        reviewComplete: false,
        failedAgents,
      };
    }

    partialReview = true;
    partialNote = `${succeededCount} of ${team.agents.length} agents completed (${failedAgents.join(', ')} failed after ${MAX_AGENT_RETRIES + 1} attempts)`;
    core.info(`Quorum met: ${partialNote}`);
  }

  if (onProgress) {
    onProgress({ phase: 'reviewed', rawFindingCount: allFindings.length });
  }

  let findingsForJudge = allFindings;
  let suppressionCount = 0;
  if (memory?.suppressions && memory.suppressions.length > 0) {
    const { kept, suppressed } = applySuppressions(allFindings, memory.suppressions);
    if (suppressed.length > 0) {
      core.info(`Suppressed ${suppressed.length} findings before judge evaluation`);
    }
    findingsForJudge = kept;
    suppressionCount = suppressed.length;
  }

  let staticDedupCount = 0;
  let llmDedupCount = 0;
  if (previousFindings && previousFindings.length > 0 && findingsForJudge.length > 0) {
    const { unique, duplicates } = deduplicateFindings(findingsForJudge, previousFindings, memory?.suppressions);
    if (duplicates.length > 0) {
      core.info(`Static dedup removed ${duplicates.length} findings matching dismissed ones before judge`);
    }
    findingsForJudge = unique;
    staticDedupCount = duplicates.length;

    if (clients.dedup && findingsForJudge.length > 0) {
      const llmResult = await llmDeduplicateFindings(findingsForJudge, previousFindings, clients.dedup);
      if (llmResult.duplicates.length > 0) {
        core.info(`LLM dedup removed ${llmResult.duplicates.length} findings matching dismissed ones before judge`);
      }
      findingsForJudge = llmResult.unique;
      llmDedupCount = llmResult.duplicates.length;
    }
  }

  if (onProgress) {
    onProgress({
      phase: 'judging',
      rawFindingCount: allFindings.length,
      judgeInputCount: findingsForJudge.length,
      totalAgents: team.agents.length,
      completedAgents: team.agents.length,
    });
  }

  let finalFindings: Finding[];
  let allJudgedFindings: Finding[] | undefined;
  let judgeSummary = 'Review complete.';
  let judgeResolveThreads: ResolveThread[] | undefined;
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
      isFollowUp,
      openThreads,
      effort: judgeEffort as 'low' | 'medium' | 'high',
    };
    const judgeResult = await runJudgeAgent(clients.judge, config, judgeInput);
    judgeSummary = judgeResult.summary;
    allJudgedFindings = judgeResult.findings;
    judgeResolveThreads = judgeResult.resolveThreads;
    finalFindings = judgeResult.findings.filter(f => f.severity !== 'ignore');
    core.info(`Judge complete: ${finalFindings.length} findings survived (${judgeResult.findings.length - finalFindings.length} ignored)`);
  } catch (error) {
    core.warning(`Judge failed: ${error}`);
    return {
      verdict: 'COMMENT' as ReviewVerdict,
      summary: 'Review incomplete — judge failed. Retry with @manki review.',
      findings: [],
      highlights: [],
      reviewComplete: false,
    };
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
    rawFindings: allFindings,
    resolveThreads: judgeResolveThreads,
    plannerResult: plannerResult ?? undefined,
    failedAgents: failedAgents.length > 0 ? failedAgents : undefined,
    partialReview: partialReview || undefined,
    partialNote,
    staticDedupCount,
    llmDedupCount,
    suppressionCount,
    agentResponseLengths,
  };
}

interface AgentResult {
  findings: Finding[];
  responseLength: number;
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
  effort?: EffortLevel,
  language?: string,
  context?: string,
): Promise<AgentResult> {
  const systemPrompt = buildReviewerSystemPrompt(reviewer, config, language, context);
  const userMessage = buildReviewerUserMessage(rawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues);

  const options = effort ? { effort } : undefined;
  const response = await client.sendMessage(systemPrompt, userMessage, options);
  const findings = parseFindings(response.content, reviewer.name);
  return { findings, responseLength: response.content.length };
}

export function buildReviewerSystemPrompt(
  reviewer: ReviewerAgent,
  config: ReviewConfig,
  language?: string,
  context?: string,
): string {
  let prompt = `You are a code reviewer specializing in: ${reviewer.focus}

Your role: ${reviewer.name}`;

  if (language || context) {
    if (language) {
      prompt += `\n\nThis PR is primarily ${language} code`;
      if (context) prompt += ` in a ${context} project`;
    } else {
      prompt += `\n\nThis PR is in a ${context} project`;
    }
    prompt += '.';
  }

  prompt += `

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
- **suggestion**: Meaningful improvements — missing error context, suboptimal patterns, incomplete handling. Worth addressing for code quality.
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
  core.debug(`${reviewerName} response length: ${responseText.length}`);

  if (responseText.trim().length === 0) {
    return [];
  }

  const jsonText = extractJSON(responseText);

  try {
    const parsed = JSON.parse(jsonText);
    if (parsed === null) {
      core.warning(`${reviewerName} returned null instead of an array (length ${responseText.length})`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      core.warning(`${reviewerName} did not return an array, got ${typeof parsed} (length ${responseText.length})`);
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
    const errorMsg = e instanceof Error ? e.message : String(e);
    core.warning(`${reviewerName}: malformed response (length: ${responseText.length}, error: ${errorMsg.slice(0, 200)})`);
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
  if (hasRequired) return 'REQUEST_CHANGES';

  const highConfSuggestions = findings.filter(
    f => f.severity === 'suggestion' && f.judgeConfidence === 'high',
  );
  if (highConfSuggestions.length >= HIGH_CONF_SUGGESTION_THRESHOLD) return 'REQUEST_CHANGES';

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
