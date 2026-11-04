import * as core from '@actions/core';
import { minimatch } from 'minimatch';

import { TRIVIAL_VERIFIER_AGENT, buildAgentPool } from './agents';
import { addUsage, LLMClient, LLMUsage, wrapClientForUsage, ZERO_USAGE, sanitizeLogOutput } from './providers';
import { runJudgeAgent, JudgeInput, computeProvenanceMap } from './judge';
import { RepoMemory, applySuppressions, buildMemoryContext } from './memory';
import { LinkedIssue, titleToSlug } from './github';
import { collectInPrSuppressions, collectResolvedThreadIds, deduplicateFindings, llmDeduplicateFindings, PreviousFinding } from './recap';
import { ReviewConfig, ReviewerAgent, Finding, FindingFingerprint, FindingFingerprintEntry, NoiseLevel, OpenThread, ReviewResult, ReviewVerdict, VerdictReason, ParsedDiff, TeamRoster, PrContext, PlannerResult, RoundContext, RoundDedupDuplicateMatch, RoundPlannerSource, EffortLevel, AgentPick, ThreadEvaluation, VerdictTrace, VerdictTraceEntry, MAX_AGENT_RETRIES, VALID_PR_TYPES, ValidPrType } from './types';
import { rebuildRawDiff } from './diff';
import { extractJSON } from './json';
import { indexThreadEvaluations, isPriorAddressedByJudge } from './finding-fingerprint';

const DISMISSED_LINE_TOLERANCE = 5;

export const PLANNER_TIMEOUT_MS = 60_000;

class PlannerTimeoutError extends Error {
  constructor() {
    super('Planner timed out');
    this.name = 'PlannerTimeoutError';
  }
}

const SUSPICIOUS_FAST_THRESHOLD_MS = 15_000;

function accumulateAgentUsage(map: Map<string, LLMUsage>, name: string, usage: LLMUsage): void {
  map.set(name, addUsage(map.get(name) ?? { ...ZERO_USAGE }, usage));
}

function accumulateAgentDuration(map: Map<string, number>, name: string, durationMs: number): void {
  map.set(name, (map.get(name) ?? 0) + durationMs);
}

// Fixed fallback roster used when the planner LLM is unavailable. Indexes into
// `AGENT_POOL`: Security & Safety, Architecture & Design, Correctness & Logic.
// The planner is trusted to pick agents on the success path; these three are
// only a conservative default when no planner judgment is available.
const FALLBACK_AGENTS: readonly number[] = Object.freeze([0, 1, 2]);

// Path segment prefixes that indicate security-sensitive files. Used as a code-level
// backstop: if the planner omits Security & Safety but the diff touches one of
// these paths, the agent is force-added regardless of planner output. This
// guard is narrow by design: it only targets the Security agent and only fires
// when a sensitive path is detected, so it cannot be silenced by prompt
// injection in the PR content.
const SECURITY_SENSITIVE_PREFIXES: readonly string[] = Object.freeze([
  'auth', 'oauth', 'token', 'secret', 'credential', 'password', 'passwd',
  'crypto', 'cipher', 'encrypt', 'decrypt', 'hmac', 'sign',
  'jwt', 'session', 'cookie', 'permission', 'acl', 'rbac', 'privilege',
  'key', 'cert', 'tls', 'ssl', 'https',
]);

function hasSensitivePaths(diff: ParsedDiff): boolean {
  return diff.files.some(f =>
    f.path.toLowerCase().split('/').some(segment => {
      const base = segment.replace(/\.[^.]+$/, '');
      return SECURITY_SENSITIVE_PREFIXES.some(prefix => base.startsWith(prefix));
    }),
  );
}

export function selectTeam(
  diff: ParsedDiff,
  config: ReviewConfig,
  customReviewers?: ReviewerAgent[],
  teamSizeOverride?: 1 | 2 | 3 | 4 | 5 | 6 | 7,
  agentPicks?: AgentPick[],
  silent?: boolean,
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

  const pool = buildAgentPool(customReviewers);

  // Planner-driven agent selection: resolve each picked name from the pool
  if (agentPicks && agentPicks.length > 0 && teamSizeOverride) {
    const poolMap = new Map(pool.map(a => [a.name, a]));
    const resolved: ReviewerAgent[] = [];
    for (const pick of agentPicks) {
      const agent = poolMap.get(pick.name);
      if (agent && !resolved.some(r => r.name === agent.name)) {
        resolved.push(agent);
      }
    }

    if (resolved.length > 0) {
      // Code-level security backstop: if the planner omitted Security & Safety
      // but the diff touches security-sensitive paths, force it in. The planner
      // receives untrusted PR content and prompt injection in diff comments or
      // string literals could suppress the security specialist on a sensitive
      // change. This guard is path-based, not prompt-based, so it cannot be
      // bypassed by injected instructions. It takes the place of the planner's
      // last pick so the team keeps the size the planner chose.
      const coreAgentInjections: string[] = [];
      const securityAgent = pool.find(a => a.name === 'Security & Safety');
      if (securityAgent && !resolved.some(a => a.name === securityAgent.name) && hasSensitivePaths(diff)) {
        const replaced = resolved.length >= teamSizeOverride ? resolved.pop() : undefined;
        if (!silent) {
          const detail = replaced ? `, replacing "${replaced.name}"` : '';
          core.info(`Security & Safety force-added${detail}: planner omitted it but diff touches security-sensitive paths`);
        }
        resolved.push(securityAgent);
        coreAgentInjections.push(securityAgent.name);
      }

      let level: 'trivial' | 'small' | 'medium' | 'large';
      if (resolved.length <= 3) level = 'small';
      else if (resolved.length <= 5) level = 'medium';
      else level = 'large';
      return { level, agents: resolved, lineCount, coreAgentInjections };
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

  // Heuristic / fallback roster: start from the fixed fallback specialists,
  // then add explicitly configured custom reviewers. Any remaining slots up to
  // `teamSize` are filled from the pool in declared order. No path-keyword
  // scoring lives here: the planner is the only place where PR context drives
  // agent selection. When the planner is unavailable, the fallback stays
  // conservative and predictable.
  const selected: ReviewerAgent[] = FALLBACK_AGENTS.map(i => pool[i]);

  for (const custom of (customReviewers || [])) {
    if (!selected.some(s => s.name === custom.name)) {
      selected.push(custom);
    }
  }

  if (selected.length < teamSize) {
    for (const agent of pool) {
      if (selected.length >= teamSize) break;
      if (!selected.some(s => s.name === agent.name)) {
        selected.push(agent);
      }
    }
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
  reviewer: LLMClient;
  judge: LLMClient;
  planner?: LLMClient;
  dedup?: LLMClient;
  /**
   * Optional resolver returning the reviewer client for a specific agent. When
   * present, it takes precedence over `reviewer`. Used to apply per-agent
   * model overrides from `models.agents`.
   */
  reviewerForAgent?: (agentName: string) => LLMClient;
}

function pickReviewerClient(clients: ReviewClients, agentName: string): LLMClient {
  return clients.reviewerForAgent?.(agentName) ?? clients.reviewer;
}

export interface ReviewProgress {
  phase: 'planning' | 'agent-complete' | 'reviewed' | 'judging';
  agentName?: string;
  agentFindingCount?: number;
  agentDurationMs?: number;
  agentStatus?: 'success' | 'failure' | 'retrying';
  rawFindingCount?: number;
  judgeInputCount?: number;
  completedAgents?: number;
  totalAgents?: number;
  plannerResult?: PlannerResult;
  plannerDurationMs?: number;
  retryCount?: number;
  /** Names of agents resolved for this review. Emitted with a `planning` event on the heuristic-fallback path so the dashboard can seed per-agent entries even though no `plannerResult` is available. */
  teamAgentNames?: string[];
  /** True when team selection fell back to the heuristic because the planner failed or timed out. */
  heuristicFallback?: boolean;
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

export function buildPlannerSystemPrompt(
  agents: Array<{ name: string; focus: string }>,
): string {
  const agentList = agents.map(a => `  - "${a.name}" — ${a.focus}`).join('\n');

  return `You are a code review planning assistant. Analyze this PR and decide how to review it.

Decide:
1. teamSize: 1, 2 or 3 reviewer agents.
   Judge the nature of the change, never its size and never the number of specialists available. A 500-line deletion or rename needs fewer eyes than a 20-line change to locking or auth, so line counts are no guide.
   - 1: the whole diff is of a kind where a defect could not hide: deleted code whose remaining callers keep their behavior, renames or moved code, comments or documentation, tests or test data, configuration, build files or CI workflows with no new logic.
   - 2: ordinary code changes: new or changed logic, conditions, error paths, features and fixes that touch none of the areas listed under 3.
   - 3: the change touches concurrency or async ordering, security, authentication or authorization, persistence or stored data, a protocol, wire or file format, or public API surface.
   When you are not sure between two sizes, pick the larger one.
2. agents: pick exactly teamSize agents from the pool below, most important first, each with an effort level ("low", "medium", or "high"):
${agentList}
   Include "Security & Safety" whenever the change could plausibly affect a security surface (authentication, authorization, parsers, deserialization, network handlers, file or process operations, permission checks, token or secret handling, cryptography). Judge the change, not the filename: a small auth tweak warrants Security even when the diff is tiny.
   Effort controls thinking depth and cost. low = fast pass, no extended reasoning. medium = moderate reasoning (~5K thinking tokens). high = deep analysis (~10K thinking tokens).
   - medium: the default for every agent
   - high: only on a team of 3, for the agents whose specialty covers the area that made it a team of 3
   - low: the agent's specialty barely applies to this PR
3. judgeEffort: "low", "medium", or "high" — how much effort the judge should spend evaluating findings.
   - low: few expected findings, straightforward changes
   - medium: moderate findings expected
   - high: many findings expected, nuanced severity decisions
4. prType: one Conventional Commits type that best fits the PR. Pick from:
   - "build": build system, packaging, or dependency changes
   - "chore": maintenance with no user-visible behavior change
   - "ci": CI/CD configuration changes
   - "docs": documentation-only changes
   - "feat": new user-visible functionality or capability
   - "fix": bug fix correcting broken behavior
   - "perf": performance improvement with no other observable change
   - "refactor": restructuring code with no behavior change (renames go here)
   - "revert": reverting a prior commit
   - "style": formatting or whitespace with no structural change
   - "test": adding or updating tests only
   Pick the dominant intent. Prefer "feat" over "chore" when the change adds capability, "fix" over "refactor" when it corrects broken behavior, "build" over "ci" when it touches packaging or deps rather than workflow YAML, "refactor" over "style" when structure changes, not just formatting.
5. language: the primary programming language of the changed code (e.g., "typescript", "rust", "python"). Omit if unclear.
6. context: a short phrase describing the project domain (e.g., "blockchain consensus library", "REST API server"). Omit if unclear.

Respond with ONLY a JSON object (no markdown fences):
{
  "teamSize": 2,
  "judgeEffort": "medium",
  "prType": "feat",
  "language": "typescript",
  "context": "GitHub Actions bot",
  "agents": [
    { "name": "Correctness & Logic", "effort": "medium" },
    { "name": "Testing & Coverage", "effort": "medium" }
  ]
}`;
}

const VALID_TEAM_SIZES = new Set([1, 2, 3]);
const VALID_EFFORTS = new Set(['low', 'medium', 'high']);

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

/**
 * Optional sink that captures the short tag describing why the planner fell
 * back, when it did. Mutated in place by `runPlanner` on the failure paths so
 * callers can record it on `RoundPlanner.fallbackReason` without changing the
 * public return type. Values: `'timeout'`, `'truncated'`, `'invalid_teamSize'`,
 * `'invalid_judgeEffort'`, `'agents_teamSize_mismatch'`, `'exception'`.
 */
export interface PlannerOutcomeSink {
  fallbackReason?: string;
}

export async function runPlanner(
  client: LLMClient,
  diff: ParsedDiff,
  prContext?: PrContext,
  customReviewers?: ReviewerAgent[],
  outcome?: PlannerOutcomeSink,
): Promise<PlannerResult | null> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new PlannerTimeoutError()), PLANNER_TIMEOUT_MS);
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

    if (response.truncated) {
      core.warning('Planner response was truncated at the output token limit, falling back to heuristic');
      if (outcome) outcome.fallbackReason = 'truncated';
      return null;
    }

    const jsonText = extractJSON(response.content);
    const parsed = JSON.parse(jsonText);

    const teamSize = parsed.teamSize;
    if (!VALID_TEAM_SIZES.has(teamSize)) {
      core.warning(`Planner returned invalid teamSize ${teamSize} — falling back to heuristic`);
      if (outcome) outcome.fallbackReason = 'invalid_teamSize';
      return null;
    }

    const judgeEffort = parsed.judgeEffort;
    if (!VALID_EFFORTS.has(judgeEffort)) {
      core.warning('Planner returned invalid judgeEffort — falling back to heuristic');
      if (outcome) outcome.fallbackReason = 'invalid_judgeEffort';
      return null;
    }

    // Parse reviewerEffort as fallback (backward compat)
    const reviewerEffortRaw = parsed.reviewerEffort;
    const reviewerEffort: EffortLevel = VALID_EFFORTS.has(reviewerEffortRaw)
      ? (reviewerEffortRaw as EffortLevel)
      : 'medium';

    const prTypeRaw = typeof parsed.prType === 'string' ? parsed.prType : 'unknown';
    const prType: ValidPrType | 'unknown' = VALID_PR_TYPES.has(prTypeRaw) ? (prTypeRaw as ValidPrType) : 'unknown';

    // Parse agent picks
    const agents = parseAgentPicks(parsed.agents, availableNames);
    if (agents) {
      if (agents.length !== teamSize) {
        core.warning(`Planner agents.length (${agents.length}) differs from teamSize (${teamSize}) — falling back to heuristic`);
        if (outcome) outcome.fallbackReason = 'agents_teamSize_mismatch';
        return null;
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
    if (error instanceof PlannerTimeoutError) {
      core.warning(
        'Planner timed out, falling back to heuristic team selection. If your workflow does not pre-install the Claude Code CLI, see the "spawn claude ENOENT" row in SETUP.md.',
      );
      if (outcome) outcome.fallbackReason = 'timeout';
      return null;
    }
    core.warning(`Planner failed: ${error} — falling back to heuristic team selection`);
    if (outcome) outcome.fallbackReason = 'exception';
    return null;
  }
}

function heuristicFallback(
  diff: ParsedDiff,
  config: ReviewConfig,
  /**
   * When `true`, ignore `review_level` and force the conservative fixed roster
   * of {Security, Architecture, Correctness}. Used when the planner is
   * unavailable so failures stay predictable. When `false`, honor the
   * configured `review_level` (the user explicitly opted out of the planner).
   */
  forceFixedRoster: boolean,
): TeamRoster {
  const team = forceFixedRoster
    ? selectTeam(diff, config, undefined, FALLBACK_AGENTS.length as 1 | 2 | 3 | 4 | 5 | 6 | 7)
    : selectTeam(diff, config, config.reviewers);
  core.info(`Review team (${team.level}): ${team.agents.map(a => a.name).join(', ')}`);
  return team;
}

function emitHeuristicFallbackPlanning(
  onProgress: (progress: ReviewProgress) => void,
  team: TeamRoster,
  plannerDurationMs?: number,
): void {
  onProgress({
    phase: 'planning',
    teamAgentNames: team.agents.map(a => a.name),
    heuristicFallback: true,
    ...(plannerDurationMs !== undefined ? { plannerDurationMs } : {}),
  });
}

export function buildProvenanceFields(
  plannerSource: RoundPlannerSource,
  plannerFallbackReason: string | undefined,
  team: TeamRoster,
  agentMultiPassConsistency: Map<string, { consistent: number; totalRaw: number }>,
  agentRunEffort: Map<string, EffortLevel>,
): Pick<ReviewResult, 'plannerSource' | 'plannerFallbackReason' | 'coreAgentInjections' | 'agentMultiPassConsistency' | 'agentEffortMap'> {
  return {
    plannerSource,
    ...(plannerFallbackReason && { plannerFallbackReason }),
    coreAgentInjections: team.coreAgentInjections ?? [],
    ...(agentMultiPassConsistency.size > 0 && { agentMultiPassConsistency }),
    agentEffortMap: agentRunEffort,
  };
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
  openThreads?: OpenThread[] | null,
  previousFindings?: PreviousFinding[],
  priorRounds?: RoundContext[],
  prAuthorLogin?: string,
  interRoundDiff?: string,
): Promise<ReviewResult> {
  const provenanceMap = computeProvenanceMap(priorRounds, rawDiff);
  let team: TeamRoster;
  let plannerResult: PlannerResult | null = null;
  let plannerUsage: LLMUsage | undefined;
  let plannerDurationMs: number | undefined;
  let plannerSource: RoundPlannerSource;
  let plannerFallbackReason: string | undefined;

  if (clients.planner && config.review_level === 'auto') {
    if (onProgress) {
      onProgress({ phase: 'planning' });
    }
    const plannerStart = Date.now();
    const plannerWrap = wrapClientForUsage(clients.planner);
    const outcome: PlannerOutcomeSink = {};
    plannerResult = await runPlanner(plannerWrap.client, diff, prContext, config.reviewers, outcome);
    plannerUsage = plannerWrap.getTotals().usage;
    plannerDurationMs = Date.now() - plannerStart;
    if (plannerResult) {
      team = selectTeam(diff, config, config.reviewers, plannerResult.teamSize, plannerResult.agents);
      plannerSource = 'planner';
      core.info(`Planner: ${plannerResult.teamSize} agents, reviewer: ${plannerResult.reviewerEffort}, judge: ${plannerResult.judgeEffort} (${plannerResult.prType})`);
      if (plannerResult.teamSize === 1) {
        const totalLines = diff.totalAdditions + diff.totalDeletions;
        core.info(`teamSize=1 decision: prType=${plannerResult.prType}, lines=${totalLines}, files=${diff.files.length}`);
      }
      if (onProgress) {
        onProgress({ phase: 'planning', plannerResult, plannerDurationMs });
      }
    } else {
      // Planner was attempted and failed. Force the fixed three-core roster.
      team = heuristicFallback(diff, config, true);
      plannerSource = 'heuristic_fallback';
      plannerFallbackReason = outcome.fallbackReason;
      if (onProgress) {
        emitHeuristicFallbackPlanning(onProgress, team, plannerDurationMs);
      }
    }
  } else {
    // Planner is disabled (either no client or user pinned `review_level`).
    // Honor the configured `review_level` so explicit user choice is preserved.
    team = heuristicFallback(diff, config, false);
    plannerSource = clients.planner ? 'heuristic' : 'disabled';
    if (onProgress) {
      emitHeuristicFallbackPlanning(onProgress, team);
    }
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

  // Record the effort each agent actually runs with: the planner pick when
  // present, otherwise the planner's reviewerEffort default,
  // otherwise `'medium'` (matching `runReviewerAgent`'s implicit default when
  // `effort` is `undefined` in the reviewer prompt).
  const agentRunEffort = new Map<string, EffortLevel>();
  for (const agent of team.agents) {
    agentRunEffort.set(agent.name, agentEffortMap.get(agent.name) ?? defaultReviewerEffort ?? 'medium');
  }

  const passes = config.review_passes ?? 1;
  const multiPass = passes > 1;

  const allFindings: Finding[] = [];
  const failedAgents: string[] = [];
  const agentResponseLengths = new Map<string, number>();
  const agentUsage = new Map<string, LLMUsage>();
  const agentDurationMs = new Map<string, number>();
  const agentRetryCount = new Map<string, number>();
  const agentFailureReasons = new Map<string, string>();
  const agentMultiPassConsistency = new Map<string, { consistent: number; totalRaw: number }>();

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
          return runReviewerAgent(pickReviewerClient(clients, agent.name), config, agent, shuffledRawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues, { effort: agentEffort, language: plannerResult?.language, context: plannerResult?.context });
        })
      );

      const passFindings: Finding[][] = [];
      let totalResponseLength = 0;
      let lastPassError: unknown;
      for (const result of passResults) {
        if (result.status === 'fulfilled') {
          passFindings.push(result.value.findings);
          totalResponseLength += result.value.responseLength;
          accumulateAgentUsage(agentUsage, agent.name, result.value.usage);
          accumulateAgentDuration(agentDurationMs, agent.name, result.value.latencyMs);
        } else {
          lastPassError = result.reason;
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
        agentMultiPassConsistency.set(agent.name, { consistent: consistent.length, totalRaw });
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
        agentFailureReasons.set(agent.name, sanitizeLogOutput(String(((lastPassError as Error)?.message ?? lastPassError) || 'unknown failure')).slice(0, 500));
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
        agentRetryCount.set(agent.name, retryCountMap[agent.name]);

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
            return runReviewerAgent(pickReviewerClient(clients, agent.name), config, agent, shuffledRawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues, { effort: retryEffort, language: plannerResult?.language, context: plannerResult?.context });
          })
        );

        const retryPassFindings: Finding[][] = [];
        let retryTotalResponseLength = 0;
        let retryLastError: unknown;
        for (const result of retryPassResults) {
          if (result.status === 'fulfilled') {
            retryPassFindings.push(result.value.findings);
            retryTotalResponseLength += result.value.responseLength;
            accumulateAgentUsage(agentUsage, agent.name, result.value.usage);
            accumulateAgentDuration(agentDurationMs, agent.name, result.value.latencyMs);
          } else {
            retryLastError = result.reason;
            core.warning(`${agent.name} retry pass failed: ${result.reason}`);
          }
        }

        if (retryPassFindings.length > 0) {
          const threshold = Math.ceil(passes / 2);
          const consistent = intersectFindings(retryPassFindings, threshold);
          const retryTotalRaw = retryPassFindings.reduce((sum, p) => sum + p.length, 0);
          core.info(`Multi-pass retry: ${agent.name} — ${retryPassFindings.length} passes, ${consistent.length} consistent findings`);
          agentMultiPassConsistency.set(agent.name, { consistent: consistent.length, totalRaw: retryTotalRaw });
          allFindings.push(...consistent);
          agentResponseLengths.set(agent.name, retryTotalResponseLength);
          agentFailureReasons.delete(agent.name);
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
          agentFailureReasons.set(agent.name, sanitizeLogOutput(String(((retryLastError as Error)?.message ?? retryLastError) || 'unknown failure')).slice(0, 500));
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
      return runReviewerAgent(pickReviewerClient(clients, agent.name), config, agent, rawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues, { effort: agentEffort, language: plannerResult?.language, context: plannerResult?.context })
        .then(agentResult => {
          completedCount++;
          agentResponseLengths.set(agent.name, agentResult.responseLength);
          accumulateAgentUsage(agentUsage, agent.name, agentResult.usage);
          accumulateAgentDuration(agentDurationMs, agent.name, agentResult.latencyMs);
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
        agentFailureReasons.set(team.agents[i].name, sanitizeLogOutput(String(((result.reason as Error)?.message ?? result.reason) || 'unknown failure')).slice(0, 500));
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
        agentRetryCount.set(agent.name, retryCount[agent.name]);
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
        return runReviewerAgent(pickReviewerClient(clients, agent.name), config, agent, rawDiff, repoContext, fileContents, prContext, memoryContext, linkedIssues, { effort: retryEffort, language: plannerResult?.language, context: plannerResult?.context })
          .then(agentResult => ({ agent, agentResult, durationMs: Date.now() - startTime, error: null as unknown }))
          .catch(error => ({ agent, agentResult: null as AgentResult | null, durationMs: Date.now() - startTime, error: error as unknown }));
      });

      const retryResults = await Promise.allSettled(retryPromises);

      const stillFailed: string[] = [];
      for (const settled of retryResults) {
        const { agent, agentResult, durationMs, error } = (settled as PromiseFulfilledResult<{ agent: ReviewerAgent; agentResult: AgentResult | null; durationMs: number; error: unknown }>).value;
        if (agentResult !== null) {
          // Remove from failed list, add findings
          allFindings.push(...agentResult.findings);
          agentResponseLengths.set(agent.name, agentResult.responseLength);
          accumulateAgentUsage(agentUsage, agent.name, agentResult.usage);
          accumulateAgentDuration(agentDurationMs, agent.name, agentResult.latencyMs);
          agentFailureReasons.delete(agent.name);
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
          agentFailureReasons.set(agent.name, sanitizeLogOutput(String(((error as Error)?.message ?? error) || 'unknown failure')).slice(0, 500));
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
        agentNames: team.agents.map(a => a.name),
        failedAgents,
        ...(agentFailureReasons.size > 0 && { agentFailureReasons: Object.fromEntries(agentFailureReasons) }),
        ...buildProvenanceFields(plannerSource, plannerFallbackReason, team, agentMultiPassConsistency, agentRunEffort),
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
  let dedupUsage: LLMUsage | undefined;
  let dedupDurationMs: number | undefined;
  const duplicateMatches: RoundDedupDuplicateMatch[] = [];
  if (previousFindings && previousFindings.length > 0 && findingsForJudge.length > 0) {
    const { unique, duplicates } = deduplicateFindings(findingsForJudge, previousFindings, memory?.suppressions);
    if (duplicates.length > 0) {
      core.info(`Static dedup removed ${duplicates.length} findings matching dismissed ones before judge`);
    }
    findingsForJudge = unique;
    staticDedupCount = duplicates.length;
    for (const d of duplicates) {
      duplicateMatches.push({ droppedTitle: d.finding.title, matchedTitle: d.matchedTitle, matchType: d.matchType });
    }

    if (clients.dedup && findingsForJudge.length > 0) {
      const dedupStart = Date.now();
      const dedupWrap = wrapClientForUsage(clients.dedup);
      const llmResult = await llmDeduplicateFindings(findingsForJudge, previousFindings, dedupWrap.client);
      if (llmResult.duplicates.length > 0) {
        core.info(`LLM dedup removed ${llmResult.duplicates.length} findings matching dismissed ones before judge`);
      }
      findingsForJudge = llmResult.unique;
      llmDedupCount = llmResult.duplicates.length;
      for (const d of llmResult.duplicates) {
        duplicateMatches.push({ droppedTitle: d.finding.title, matchedTitle: d.matchedTitle, matchType: d.matchType });
      }
      dedupUsage = dedupWrap.getTotals().usage;
      dedupDurationMs = Date.now() - dedupStart;
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

  const inPrSuppressions = previousFindings && previousFindings.length > 0
    ? collectInPrSuppressions(previousFindings, prAuthorLogin)
    : [];
  if (inPrSuppressions.length > 0) {
    core.info(`In-PR suppressions: ${inPrSuppressions.length} fingerprints (resolved or author-agreed)`);
  }

  // Derive the set of currently-resolved thread IDs from the recap state. Used
  // by `applyCrossRoundSuppression` (mechanism C) to ratchet down findings
  // matching prior-round threads that have since been resolved.
  const resolvedThreadIds = collectResolvedThreadIds(previousFindings);
  const suppressResolvedThreads = config.convergence?.suppress_resolved_threads !== false;

  let finalFindings: Finding[];
  let allJudgedFindings: Finding[] | undefined;
  let judgeSummary = 'Review complete.';
  let judgeThreadEvaluations: ThreadEvaluation[] | undefined;
  let judgeCrossRoundSuppressed: number | undefined;
  let judgeCrossRoundDemoted: number | undefined;
  let judgeInterRoundDiffEmptyOverride: { applied: boolean; affectedThreadCount: number } | undefined;
  let inPrSuppressedCount = 0;
  let judgeUsage: LLMUsage | undefined;
  let judgeDurationMs: number | undefined;
  let judgeRetryCount = 0;
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
      openThreads: openThreads ?? undefined,
      priorRounds,
      inPrSuppressions,
      effort: judgeEffort as 'low' | 'medium' | 'high',
      provenanceMap,
      interRoundDiff,
      resolvedThreadIds,
      suppressResolvedThreads,
    };
    const judgeStart = Date.now();
    const judgeWrap = wrapClientForUsage(clients.judge);
    const judgeResult = await runJudgeAgent(judgeWrap.client, config, judgeInput);
    judgeDurationMs = Date.now() - judgeStart;
    const judgeTotals = judgeWrap.getTotals();
    judgeUsage = judgeTotals.usage;
    judgeRetryCount = Math.max(0, judgeTotals.calls - 1);
    judgeSummary = judgeResult.summary;
    allJudgedFindings = judgeResult.findings;
    judgeThreadEvaluations = judgeResult.threadEvaluations;
    judgeCrossRoundSuppressed = judgeResult.crossRoundSuppressed;
    judgeCrossRoundDemoted = judgeResult.crossRoundDemoted;
    judgeInterRoundDiffEmptyOverride = judgeResult.interRoundDiffEmptyOverride;
    inPrSuppressedCount = judgeResult.inPrSuppressedCount ?? 0;
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
      agentNames: team.agents.map(a => a.name),
      ...buildProvenanceFields(plannerSource, plannerFallbackReason, team, agentMultiPassConsistency, agentRunEffort),
    };
  }

  // Mechanism B: drop low-severity findings on test files starting at round 2.
  // Test scaffolding nits are the most common runaway-feedback driver in late
  // rounds. The filter runs post-judge so that any nit the judge escalates to
  // warning/blocker is correctly preserved; only suggestion/nitpick are dropped.
  let testNitSuppressedCount = 0;
  const roundNumber = (priorRounds?.length ?? 0) + 1;
  if (roundNumber >= 2) {
    const patterns = config.convergence?.test_path_patterns ?? [];
    if (patterns.length > 0) {
      const before = finalFindings.length;
      finalFindings = finalFindings.filter(f => {
        if (f.severity !== 'suggestion' && f.severity !== 'nitpick') return true;
        const onTestFile = patterns.some(p => minimatch(f.file, p));
        if (onTestFile) {
          core.info(`Test-nit suppression: dropping ${f.severity} "${f.title}" on ${f.file}:${f.line}`);
        }
        return !onTestFile;
      });
      testNitSuppressedCount = before - finalFindings.length;
    }
  }
  const sortedPriorRounds = [...(priorRounds ?? [])].sort((a, b) => a.meta.round - b.meta.round);
  const priorFindingsFlat: FindingFingerprintEntry[] = sortedPriorRounds.flatMap(r => r.findings.entries);
  const priorRoundLookup = buildPriorRoundLookup(sortedPriorRounds);
  const changedFiles = new Set(diff.files.map(f => f.path));
  const { verdict, verdictReason, verdictTrace } = determineVerdict(finalFindings, priorFindingsFlat, openThreads, resolvedThreadIds, judgeThreadEvaluations, priorRoundLookup, changedFiles);

  const summary = judgeSummary;

  core.startGroup('Review Summary');
  core.info(`Team: ${team.agents.map(a => a.name).join(', ')}`);
  core.info(`Level: ${team.level} (${team.lineCount} lines changed)`);
  core.info(`Verdict: ${verdict}`);
  core.info(`Findings: ${finalFindings.length}`);
  for (const f of finalFindings) {
    const icon = f.severity === 'blocker' ? '\u2717' : f.severity === 'warning' ? '\u26A0' : f.severity === 'suggestion' ? '\u25CB' : f.severity === 'nitpick' ? '\u00B7' : '\u2205';
    core.info(`  ${icon} [${f.severity}] ${f.title}`);
    core.info(`    ${f.file}:${f.line}`);
  }
  core.endGroup();

  return {
    verdict,
    verdictReason,
    verdictTrace,
    summary,
    findings: finalFindings,
    highlights: [],
    reviewComplete: true,
    rawFindingCount: allFindings.length,
    agentNames: team.agents.map(a => a.name),
    allJudgedFindings,
    rawFindings: allFindings,
    threadEvaluations: judgeThreadEvaluations,
    plannerResult: plannerResult ?? undefined,
    failedAgents: failedAgents.length > 0 ? failedAgents : undefined,
    partialReview: partialReview || undefined,
    partialNote,
    staticDedupCount,
    llmDedupCount,
    ...(duplicateMatches.length > 0 && { duplicateMatches }),
    suppressionCount,
    ...(inPrSuppressedCount > 0 && { inPrSuppressedCount }),
    agentResponseLengths,
    agentUsage,
    agentDurationMs,
    agentRetryCount,
    ...(agentFailureReasons.size > 0 && { agentFailureReasons: Object.fromEntries(agentFailureReasons) }),
    ...(plannerUsage && { plannerUsage }),
    ...(plannerDurationMs != null && { plannerDurationMs }),
    ...(judgeUsage && { judgeUsage }),
    ...(judgeDurationMs != null && { judgeDurationMs }),
    judgeRetryCount,
    ...(dedupUsage && { dedupUsage }),
    ...(dedupDurationMs != null && { dedupDurationMs }),
    crossRoundSuppressed: judgeCrossRoundSuppressed,
    crossRoundDemoted: judgeCrossRoundDemoted,
    ...(judgeInterRoundDiffEmptyOverride && { interRoundDiffEmptyOverride: judgeInterRoundDiffEmptyOverride }),
    ...(testNitSuppressedCount > 0 && { testNitSuppressedCount }),
    ...buildProvenanceFields(plannerSource, plannerFallbackReason, team, agentMultiPassConsistency, agentRunEffort),
  };
}

interface AgentResult {
  findings: Finding[];
  responseLength: number;
  usage: LLMUsage;
  latencyMs: number;
}

export interface BuildReviewerUserMessageOptions {
  fileContents?: Map<string, string>;
  prContext?: PrContext;
  memoryContext?: string;
  linkedIssues?: LinkedIssue[];
}

interface RunReviewerAgentOptions {
  effort?: EffortLevel;
  language?: string;
  context?: string;
}

async function runReviewerAgent(
  client: LLMClient,
  config: ReviewConfig,
  reviewer: ReviewerAgent,
  rawDiff: string,
  repoContext: string,
  fileContents?: Map<string, string>,
  prContext?: PrContext,
  memoryContext?: string,
  linkedIssues?: LinkedIssue[],
  options: RunReviewerAgentOptions = {},
): Promise<AgentResult> {
  const { effort, language, context } = options;
  const systemPrompt = buildReviewerSystemPrompt(reviewer, config, language, context, config.noise_level);
  const userMessage = buildReviewerUserMessage(rawDiff, repoContext, { fileContents, prContext, memoryContext, linkedIssues });

  const sendOptions = effort ? { effort } : undefined;
  const response = await client.sendMessage(systemPrompt, userMessage, sendOptions);
  if (response.truncated) {
    throw new Error(`response truncated at the output token limit (length ${response.content.length})`);
  }
  const findings = parseFindings(response.content, reviewer.name);
  return {
    findings,
    responseLength: response.content.length,
    usage: response.usage ?? { ...ZERO_USAGE },
    latencyMs: response.latencyMs ?? 0,
  };
}

export function buildReviewerSystemPrompt(
  reviewer: ReviewerAgent,
  config: ReviewConfig,
  language?: string,
  context?: string,
  noiseLevel: NoiseLevel = 'low',
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
    "severity": "blocker" | "warning" | "suggestion" | "nitpick" | "ignore",
    "title": "Short descriptive title",
    "file": "path/to/file.ext",
    "line": <line number in the NEW file>,
    "description": "2-4 sentences: what the issue is, why it matters, potential impact, how to fix.",
    "suggestedFix": "Optional: code snippet showing the fix"
  }
]
\`\`\`

When you include a \`suggestedFix\`, list any known caveats of the proposed shape in the same finding's \`description\` — for example, missing bounds checks, untested edge cases, or follow-up work. This prevents a later round from flagging those caveats as new findings.

## Severity Guidelines

- **blocker**: Correctness bug, data loss risk, or security issue. Must be fixed before merge.
  - SQL injection via unsanitized user input in a database query
  - Null/undefined dereference in an error handling path that will crash at runtime
  - Off-by-one in array bounds causing data corruption or out-of-bounds access
- **warning**: Real behavioral concern — an edge case that will fail, misuse of an API that produces wrong output, a race condition. Not catastrophic but shouldn't ship.
  - Missing timeout on a network request that could hang indefinitely
  - Race condition on shared state without synchronization
  - Error message lacks context that would help debugging a real failure
- **suggestion**: Improvement open to discussion — refactoring, deduplication, API clarity, code style. Works today but could be cleaner.
  - Variable could be \`const\` instead of \`let\` since it is never reassigned
  - Function could be simplified by extracting a reusable helper
  - Duplicate logic that could be deduplicated
- **nitpick**: Minor cosmetic — wording, formatting, tiny naming tweaks. Purely optional.
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

  if (noiseLevel === 'low') {
    prompt += `

## Noise Level: low

Frame every potential finding through this lens: would a senior engineer mention this in a review where their time is the bottleneck? If the answer is no, do not include it.

### Categories that are NEVER findings at this noise level

Do not flag any of the following, regardless of severity:

- Whitespace, indentation, blank-line placement, line length
- Import ordering, grouping, or sort order
- Trailing commas, semicolons, quote style, brace placement
- Comment formatting, doc-comment presence or absence on individual symbols
- Naming conventions already covered by the project's style guide (casing, prefixes, suffixes)
- Anything a formatter (Prettier, gofmt, rustfmt, black, etc.) or default-config linter (ESLint recommended, clippy default, etc.) would catch automatically
- Restating type information that a reader can see from the signature

If a potential finding falls into any of these categories, omit it from your response entirely. Do not downgrade it to \`nitpick\` or \`ignore\`. Just drop it.`;
  }
  // 'medium' intentionally adds no extra section so the prompt matches the pre-noise_level body verbatim.
  if (noiseLevel === 'high') {
    prompt += `

## Noise Level: high

Surface marginal suggestions: in addition to substantive findings, actively include borderline observations that you would normally consider too minor to mention. Wording polish, micro-refactors, stylistic alternatives, and speculative improvements are all welcome at this level. Use \`suggestion\` or \`nitpick\` severity for these. The goal is breadth: prefer including a marginal observation over omitting it.`;
  }

  if (config.instructions) {
    prompt += `\n\n## Additional Instructions\n\n${config.instructions}`;
  }

  return prompt;
}

export function buildReviewerUserMessage(
  rawDiff: string,
  repoContext: string,
  options: BuildReviewerUserMessageOptions = {},
): string {
  const { fileContents, prContext, memoryContext, linkedIssues } = options;
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
    throw new Error('empty response, expected a JSON array');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSON(responseText));
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    throw new Error(`malformed response (length ${responseText.length}): ${errorMsg.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`response is not a JSON array, got ${parsed === null ? 'null' : typeof parsed} (length ${responseText.length})`);
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
}

export function validateSeverity(severity: unknown): Finding['severity'] {
  if (severity === 'blocker' || severity === 'warning' || severity === 'suggestion' || severity === 'nitpick' || severity === 'ignore') {
    return severity;
  }
  return 'suggestion';
}

/**
 * Check whether a current finding matches a prior-round fingerprint entry.
 * Uses file + title-slug with a line-window tolerance so small drift between
 * rounds does not break the match. Thread-resolved status is not consulted
 * here, only the cached author-reply class.
 */
function matchesDismissedPrior(finding: Finding, prior: FindingFingerprintEntry): boolean {
  if (finding.line === 0) return false;
  if (finding.file !== prior.fingerprint.file) return false;
  if (titleToSlug(finding.title) !== prior.fingerprint.slug) return false;
  const line = finding.line;
  const lo = prior.fingerprint.lineStart - DISMISSED_LINE_TOLERANCE;
  const hi = prior.fingerprint.lineEnd + DISMISSED_LINE_TOLERANCE;
  return line >= lo && line <= hi;
}

function wasDismissedInPriorRound(finding: Finding, priorRounds: FindingFingerprintEntry[]): boolean {
  return priorRounds.some(p => p.authorReplyClass === 'agree' && matchesDismissedPrior(finding, p));
}

/**
 * Collapse multi-round prior findings to one entry per logical issue, keeping
 * the most recent round's view. Identity is the fingerprint tuple, which is
 * always present and stable across rounds. `threadId` is intentionally not
 * used as the key because older handover rounds may have recorded the same
 * finding without a `threadId` (the field was added later), and a mixed
 * presence across rounds would otherwise split one logical finding into two
 * surviving entries. Callers must pass `priorRounds` in chronological order
 * (round 1 first, latest last). A finding raised in round 1 with
 * `authorReply: 'none'` and re-raised in round 2 with `authorReply: 'agree'`
 * collapses to the round 2 entry, so the agreement is honored rather than the
 * stale round 1 state.
 */
function isPriorLikelyUnresolved(
  p: FindingFingerprintEntry,
  openThreadIds: Set<string>,
  openThreadsUnknown: boolean,
  resolvedThreadIds: Set<string> | undefined,
  threadEvaluationsByThreadId: Map<string, ThreadEvaluation>,
  changedFiles: ReadonlySet<string> | undefined,
): boolean {
  if (p.severity !== 'warning' && p.severity !== 'blocker') return false;
  if (p.authorReplyClass === 'agree') return false;
  // Order matters. `openThreadsUnknown` must short-circuit before
  // `resolvedThreadIds` because both signals come from the same recap scan,
  // so a failed live fetch cannot fall back to cached "resolved" state.
  // Judge-addressed acts as an override for warning priors when the GitHub
  // thread is still open: the author landed the fix in the inter-round diff
  // without explicitly resolving the thread. The judge's `addressed` verdict
  // is accepted because `buildJudgeUserMessage` sanitizes untrusted PR/issue
  // prose before it reaches the judge, and the adversarial fixture corpus
  // (05_injection_attempt_unfixed) gates regressions in the judge's resistance
  // to injected text. Blocker priors are never retired by LLM signal alone;
  // they require GitHub thread resolution or explicit author agreement.
  if (p.threadId && openThreadIds.has(p.threadId)) {
    if (p.severity !== 'blocker' && isPriorAddressedByJudge(p, threadEvaluationsByThreadId)) return false;
    return true;
  }
  if (openThreadsUnknown) return true;
  if (p.threadId && resolvedThreadIds?.has(p.threadId)) return false;
  // A prior still without a `threadId` matched no Manki thread, so it was
  // posted in the review body and nobody can resolve it. Only a blocker on a
  // file the PR still changes keeps blocking.
  if (!p.threadId) return p.severity === 'blocker' && (!changedFiles || changedFiles.has(p.fingerprint.file));
  return false;
}

function dedupePriorFindings(priorRounds: FindingFingerprintEntry[]): FindingFingerprintEntry[] {
  const byKey = new Map<string, FindingFingerprintEntry>();
  for (const p of priorRounds) {
    const key = `f:${p.fingerprint.file}:${p.fingerprint.lineStart}:${p.fingerprint.lineEnd}:${p.fingerprint.slug}`;
    byKey.set(key, p);
  }
  return Array.from(byKey.values());
}

/** Build a fingerprint-string → round-number lookup from a sorted array of prior rounds. */
export function buildPriorRoundLookup(sortedPriorRounds: RoundContext[]): Map<string, number> {
  const lookup = new Map<string, number>();
  for (const r of sortedPriorRounds) {
    for (const e of (r.findings.entries ?? [])) {
      lookup.set(stringifyFindingFingerprint(e.fingerprint), r.meta.round);
    }
  }
  return lookup;
}

/**
 * Pick a verdict plus a machine-readable reason.
 *
 * Decision order:
 *   1. any surviving `blocker` finding → REQUEST_CHANGES / required_present
 *   2. any `warning` that is NOT a prior-round dismissed match → REQUEST_CHANGES / novel_suggestion
 *   3. any prior-round `warning`/`blocker` still unresolved → REQUEST_CHANGES / prior_unaddressed
 *   4. otherwise (only suggestions/nitpicks / previously-dismissed warnings / empty) → APPROVE / only_nit_or_suggestion
 *
 * A prior `warning`/`blocker` is "unresolved" when the author has not agreed to
 * dismiss it (`authorReply !== 'agree'`) and the underlying GitHub thread is
 * still in `openThreads`. A prior without a `threadId` was posted in the review
 * body. It blocks only when it is a `blocker` on a file in `changedFiles`, or
 * on any file when `changedFiles` is omitted.
 *
 * The judge's `threadEvaluations.status === 'addressed'` resolves a prior
 * thread. `uncertain` and missing entries collapse to "not addressed" so the
 * default outcome stays conservative when the judge could not produce a
 * confident verdict. Defense-in-depth against prompt injection lives at three
 * other layers: (a) `buildJudgeUserMessage` routes untrusted PR/issue prose
 * through `sanitizeForPromptEmbed` and tags each section as evidence-not-
 * directive; (b) the adversarial `05_injection_attempt_unfixed` fixture in
 * the corpus gates regressions in the judge's resistance to injected text;
 * (c) `applyCrossRoundSuppression` only lets `addressed` ratchet prior
 * `suggestion`/`nitpick` findings, never `blocker`/`warning`, so a flipped
 * judge verdict on a higher-severity prior still requires GitHub thread
 * resolution or an explicit `authorReply: 'agree'` to retire.
 *
 * Multi-round priors are collapsed to one entry per fingerprint, keeping the
 * most recent round's `authorReply` and `threadId`. Callers must pass
 * `priorRounds` in chronological order. Without this dedup, a stale round 1
 * `authorReply: 'none'` would still match `.some(...)` even if round 2
 * captured an `agree` for the same thread.
 *
 * Contract for `openThreads`: three states with distinct meaning.
 *   - `null` / omitted → "unknown": caller did not (or could not) fetch open
 *     threads. Treated conservatively: any prior `warning`/`blocker` with a
 *     non-`agree` `authorReply` blocks APPROVE with `prior_unaddressed`,
 *     unconditionally. `resolvedThreadIds` is NOT honored in this branch,
 *     since both signals come from the same recap scan and could be stale
 *     together. Use the unknown state when the GitHub fetch failed, or at
 *     call sites that intentionally bypass the open-thread check, so
 *     unresolved priors can never be silently approved.
 *   - `[]` → "fetched, none open": GitHub confirmed no review threads are
 *     open on the PR. Prior findings with a `threadId` that does not appear
 *     here are treated as resolved.
 *   - `OpenThread[]` (non-empty) → "fetched, here they are": only priors
 *     whose `threadId` appears in the set are treated as still open.
 *
 * `resolvedThreadIds` is an explicit allowlist of thread ids that GitHub
 * reports as `isResolved: true` (derived from `previousFindings[i].status ===
 * 'resolved'`). It is consulted only when `openThreads` is a fetched array
 * (empty or non-empty) and the thread is not present in it. The precedence
 * is: live `openThreads` > unknown-fallback (conservative block) >
 * `resolvedThreadIds` (cached "resolved via fix") > implicit resolution
 * (absent from both, with a `threadId`). This covers the common "author
 * pushed a fix and clicked Resolve conversation" case, where the thread is
 * no longer open on GitHub but the prior's `authorReplyClass` stays `none`,
 * while still blocking when the live state cannot be trusted.
 *
 * Nitpicks and suggestions are non-blocking, and prior-round dismissed warnings
 * have already been acknowledged by the author. All these cases approve the PR.
 */
export function determineVerdict(
  findings: Finding[],
  priorRounds?: FindingFingerprintEntry[],
  openThreads?: OpenThread[] | null,
  resolvedThreadIds?: Set<string>,
  threadEvaluations?: ThreadEvaluation[],
  priorRoundLookup?: Map<string, number>,
  changedFiles?: ReadonlySet<string>,
): { verdict: ReviewVerdict; verdictReason: VerdictReason; verdictTrace: VerdictTrace } {
  const emptyTrace = (): VerdictTrace => ({
    survivingBlockers: [],
    novelWarnings: [],
    unresolvedPriors: [],
  });

  const blockers = findings.filter(f => f.severity === 'blocker');
  if (blockers.length > 0) {
    const trace = emptyTrace();
    trace.survivingBlockers = blockers.map(findingToTraceEntry);
    return { verdict: 'REQUEST_CHANGES', verdictReason: 'required_present', verdictTrace: trace };
  }

  const prior = dedupePriorFindings(priorRounds ?? []);
  const novelWarnings = findings.filter(
    f => f.severity === 'warning' && !wasDismissedInPriorRound(f, prior),
  );
  if (novelWarnings.length > 0) {
    const trace = emptyTrace();
    trace.novelWarnings = novelWarnings.map(findingToTraceEntry);
    return { verdict: 'REQUEST_CHANGES', verdictReason: 'novel_suggestion', verdictTrace: trace };
  }

  const openThreadsUnknown = openThreads == null;
  const openThreadIds = new Set((openThreads ?? []).map(t => t.threadId));
  const threadEvaluationsByThreadId = indexThreadEvaluations(threadEvaluations);
  const unresolvedPriors = prior.filter(p =>
    isPriorLikelyUnresolved(p, openThreadIds, openThreadsUnknown, resolvedThreadIds, threadEvaluationsByThreadId, changedFiles),
  );
  if (unresolvedPriors.length > 0) {
    const trace = emptyTrace();
    const openThreadIndex = new Map((openThreads ?? []).map(t => [t.threadId, t]));
    trace.unresolvedPriors = unresolvedPriors.map(p => priorToTraceEntry(p, priorRoundLookup, openThreadIndex));
    return { verdict: 'REQUEST_CHANGES', verdictReason: 'prior_unaddressed', verdictTrace: trace };
  }

  return { verdict: 'APPROVE', verdictReason: 'only_nit_or_suggestion', verdictTrace: emptyTrace() };
}

function findingToTraceEntry(f: Finding): VerdictTraceEntry {
  return {
    file: f.file,
    title: f.title,
    fingerprint: stringifyFindingFingerprint({
      file: f.file,
      lineStart: f.line,
      lineEnd: f.line,
      slug: titleToSlug(f.title),
    }),
  };
}

function priorToTraceEntry(
  p: FindingFingerprintEntry,
  priorRoundLookup: Map<string, number> | undefined,
  openThreadIndex?: Map<string, OpenThread>,
): VerdictTraceEntry {
  const round = priorRoundLookup?.get(stringifyFindingFingerprint(p.fingerprint));
  const openThread = p.threadId ? openThreadIndex?.get(p.threadId) : undefined;
  const line = openThread?.line ?? p.fingerprint.lineStart;
  const severity = p.originalSeverity ?? p.severity;
  const threadUrl = openThread?.threadUrl;
  return {
    file: p.fingerprint.file,
    title: p.title ?? '',
    fingerprint: stringifyFindingFingerprint(p.fingerprint),
    ...(p.threadId && { threadId: p.threadId }),
    ...(round != null && { round }),
    ...(line != null && { line }),
    ...(severity && { severity }),
    ...(threadUrl && { threadUrl }),
  };
}

/** Stable composite-string identity matching the `dedupePriorFindings` key format. */
export function stringifyFindingFingerprint(fp: FindingFingerprint): string {
  return `${fp.file}:${fp.lineStart}:${fp.lineEnd}:${fp.slug}`;
}

/**
 * Shortens a diff to about `maxLength` characters by giving each file a fair share.
 * Files under their share stay whole and pass the unused budget to larger files.
 * Each cut file keeps its header lines through the first hunk header. The total can
 * exceed `maxLength` only when those lines alone are longer than a file's share.
 */
export function truncateDiff(rawDiff: string, maxLength: number = 50000): string {
  if (rawDiff.length <= maxLength) return rawDiff;
  const sections = rawDiff.split(/(?=^diff --git )/m);
  const order = sections.map((_, i) => i).sort((a, b) => sections[a].length - sections[b].length || a - b);
  const budgets: number[] = [];
  let remaining = maxLength;
  order.forEach((index, rank) => {
    const share = Math.floor(remaining / (sections.length - rank));
    budgets[index] = Math.min(sections[index].length, share);
    remaining -= budgets[index];
  });
  return sections.map((section, i) => truncateDiffSection(section, budgets[i])).join('');
}

function truncateDiffSection(section: string, budget: number): string {
  if (section.length <= budget) return section;
  const lines = section.replace(/\n$/, '').split('\n');
  const marker = (dropped: number) => `... (${dropped} more lines in this file truncated)\n`;
  const reserve = marker(lines.length).length;
  const firstHunk = lines.findIndex(line => line.startsWith('@@'));
  let kept = Math.max(1, firstHunk + 1);
  let used = lines.slice(0, kept).join('\n').length + 1;
  while (kept < lines.length && used + lines[kept].length + 1 + reserve <= budget) {
    used += lines[kept].length + 1;
    kept++;
  }
  if (kept >= lines.length) return section;
  return `${lines.slice(0, kept).join('\n')}\n${marker(lines.length - kept)}`;
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
