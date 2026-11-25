import * as core from '@actions/core';
import { rmSync, writeFileSync } from 'fs';
import { join, posix } from 'path';
import { pathToFileURL } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { extractCurrentCodeWindow } from './code-window';
import { CONFIG_PATH, loadConfig, resolveModel, validateConfig } from './config';
import { addCodeContext, changeDigest, filterDiff, filterRawDiff, hideSeenNotes, ownChangeSince, parsePRDiff, reviewableDiff, tagFindingOrigins } from './diff';
import { citedLine } from './finding-fingerprint';
import { ApprovalHeld, brokenConfig, holdsApproval, buildRepoContext, cachedFileLines, capNotes, editedKeys, loadBaseConfig, openRepoFiles, plainCitedFiles, RepoFiles, roundApproval, skippedFiles, titleToSlug, UnreadFileError } from './github';
import { isParsedLockfile, LockfileDiff, lockfilesLast, MAX_LOCKFILE_BYTES, readLockfileChanges, withLockfiles } from './lockfile';
import { rateWarnings } from './importance';
import { recordCalls } from './providers';
import type { LLMCall, LLMClient, ProviderInputs } from './providers';
import type { PreviousFinding } from './recap';
import { carryBodyWarnings, citedPlaces, ReviewProgress, runReview } from './review';
import { buildLLMClient, buildReviewClients, warmUpClients } from './review-clients';
import { buildRoundContext } from './round-context';
import { makeScratchDir } from './tool-install';
import type { AnswerStore } from './stored-answers';
import { DISPROVED_TAG, SECURITY_TAG, threadWarns } from './types';
import type { ConfigSource, Doubt, Finding, FinderReplay, FindingSeverity, GradeCell, Importance, OpenThread, ParsedDiff, ReviewConfig, ReviewModels, ReviewResult, RoundContext, RoundOutcome, RulesMode } from './types';
import { closePaths, fetchWorkspace, gitEnv, runGit } from './workspace';


/** Config keys and their values, as a `.manki.yml` holds them. */
export type ConfigOverrides = Record<string, unknown>;

function isMapping(value: unknown): value is ConfigOverrides {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Returns `base` with `overrides` set on top. A mapping in both merges key by key, and any other value replaces. */
export function overlayConfig(base: ConfigOverrides, overrides: ConfigOverrides): ConfigOverrides {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] = isMapping(value) && isMapping(current) ? overlayConfig(current, value) : value;
  }
  return merged;
}

/** Throws when `config` sets a key the config does not know, which loading it only warns about. `subject` starts the error. */
function rejectUnknownKeys(config: ConfigOverrides, subject: string): void {
  const unknown = validateConfig(config).warnings.filter(warning => warning.startsWith('Unknown config key'));
  if (unknown.length > 0) throw new Error(`${subject} keys the config does not know: ${unknown.join('; ')}`);
}

/**
 * Loads `content` with `overrides` set on top. Throws when either makes the config invalid, or when an override names a
 * key the config does not know, so a variant never runs on the defaults or on the base setup by mistake.
 */
function loadOverlaidConfig(content: string | null, configPath: string, overrides: ConfigOverrides): { config: ReviewConfig; source: ConfigSource } {
  rejectUnknownKeys(overrides, 'The config overrides name');
  let parsed: unknown;
  try {
    parsed = content ? parseYaml(content) : null;
  } catch (error) {
    throw new Error(`Invalid YAML in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed !== null && parsed !== undefined && !isMapping(parsed)) throw new Error(`Invalid config in ${configPath}: the top level must be a mapping of keys to values`);
  const config = loadConfig(stringifyYaml(overlayConfig(parsed ?? {}, overrides)), Object.keys(overrides).length > 0 ? `${configPath} with the overrides` : configPath);
  return { config, source: config.review ? 'base' : 'builtin' };
}

/** A finding an earlier round posted, as the next round reads it back. */
export interface EarlierFinding {
  /** Names the finding's thread, so the round's thread evaluations can be told apart. */
  id: string;
  severity: FindingSeverity;
  title: string;
  file: string;
  line: number;
  gradeIfConfirmed?: FindingSeverity;
  /** The cell and the doubts behind `gradeIfConfirmed`, when the earlier round recorded them. */
  cell?: GradeCell;
  doubts?: Doubt[];
  /** The scores of a warning the earlier round rated. */
  importance?: Importance;
  description?: string;
  howToFix?: string;
  suggestedFix?: string;
  security?: boolean;
  /** The warning of a blocker every refuter disproved, whose thread only a fix or a maintainer clears. */
  disproved?: boolean;
  /** A pre-existing defect, whose thread never holds an approval. */
  preExisting?: boolean;
  /** The other files the finding cited, as a posted finding records them. A push to one counts as a push to its thread. */
  evidenceFiles?: string[];
  /**
   * How its review thread stands before the round: `fixed` when an earlier round resolved it as fixed, and `resolved`
   * when a person resolved it. Unset for a finding posted only in the review body.
   */
  thread?: 'open' | 'resolved' | 'fixed';
}

/** The round before the one under review: the commit it reviewed and what it posted. */
export interface EarlierRound {
  head: string;
  findings: EarlierFinding[];
}

/** What a local review reads. Nothing is read from or written to GitHub. */
export interface LocalReviewInput {
  /** Root of the git repository the commits are in. */
  repoRoot: string;
  /** The change runs from the merge base of `base` and `head` to `head`, as a pull request shows it. */
  base: string;
  head: string;
  /**
   * A patch reviewed in place of the commits. The config and instructions are then read at `head`, the config the
   * patch leaves is checked as a pull request's own copy is, and the repository tools read `head` with the patch applied.
   */
  patch?: string;
  /** Replaces the config the base commit holds. */
  config?: ReviewConfig;
  /** Set on top of the base commit's config before it is validated. Unused with `config`. */
  configOverrides?: ConfigOverrides;
  configPath?: string;
  /** Shown to the models as the pull request title. Defaults to the subject of `head`. */
  title?: string;
  /** Shown to the models as the pull request description. */
  body?: string;
  /** Makes the review a follow-up round of this earlier round, read as a pull request round reads it from GitHub. Unused with `patch`. */
  earlier?: EarlierRound;
  /** Reads the related repos as they were at this ISO 8601 time, for a change reviewed after it was made. Defaults to their newest commit. */
  relatedReposAsOf?: string;
  /** Keeps the planner's answer and the finder stage's findings of an earlier review in place of running them. */
  replay?: FinderReplay;
  /** Keeps the answers of the name translation, the dedup and the judge, or gives stored ones in place of making the calls. */
  answers?: AnswerStore;
  providerInputs: ProviderInputs;
  onProgress?: (progress: ReviewProgress) => void;
  signal?: AbortSignal;
}

export interface LocalReview {
  result: ReviewResult & { outcome: RoundOutcome };
  /** The round record a pull request round would post. */
  context: RoundContext;
  /** The commit the change starts from: the merge base, or `head` for a patch. */
  base: string;
  head: string;
  /** Set to `config` when the base config, or a head copy that differs from the base's, did not load, which holds a pull request round's approval. */
  approvalHeld: ApprovalHeld;
  /** The `review.rules` setting the round graded with. */
  rules?: RulesMode;
}

const MAX_SYMLINK_HOPS = 5;

/**
 * Reads the files of `commit` in the repository at `root`. A symlink reads as its target, while that stays in the tree,
 * or as no file when `read` is told not to follow symlinks.
 */
function gitRepoFiles(root: string, commit: string): RepoFiles {
  const read = async (path: string, follow: boolean, hops = 0): Promise<string | null> => {
    // Prints `<mode> <type> <object>\t<path>`, or nothing for a missing path.
    const [mode, type, object] = (await runGit(root, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', path])).split('\t')[0].split(' ');
    if (type !== 'blob') return null;
    if (mode === '120000' && !follow) throw new UnreadFileError(`${path} was not read: a symlink, whose target is never read`);
    const content = await runGit(root, ['cat-file', 'blob', object]);
    if (mode !== '120000') return content;
    const target = posix.normalize(posix.join(posix.dirname(path), content));
    return hops < MAX_SYMLINK_HOPS && !posix.isAbsolute(content) && !target.startsWith('../') ? read(target, follow, hops + 1) : null;
  };
  return {
    read: (path, followSymlinks = true) => read(path, followSymlinks),
    list: async () => (await runGit(root, ['ls-tree', '-r', '-z', '--name-only', commit])).split('\0').filter(Boolean),
  };
}

/**
 * Loads the config at `base` the way a pull request round does, and logs the keys `head` changes. A config at `head` that
 * does not load gives a warning and `brokenHead`, which says whether it differs from the copy at `base`. With `overrides`,
 * they are set on top, and a base config that does not load throws instead of falling back to the defaults. Without
 * them, a base config that cannot say which paths `closed_paths` closes throws too. `head` is a commit or a tree.
 */
async function loadLocalConfig(
  root: string, base: string, head: string, configPath: string, overrides?: ConfigOverrides,
): Promise<{ config: ReviewConfig; source: ConfigSource; brokenHead?: { changed: boolean } }> {
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let headContent: string | null | undefined;
  let headConfig: ReviewConfig | undefined;
  try {
    headContent = await gitRepoFiles(root, head).read(configPath);
    headConfig = loadConfig(headContent ?? undefined, configPath);
  } catch (error) {
    core.warning(`Could not load ${configPath} at the head, this review uses the base's settings: ${describe(error)}`);
  }
  const read = () => gitRepoFiles(root, base).read(configPath);
  const { closedUnknown, ...loaded }: Awaited<ReturnType<typeof loadBaseConfig>> = overrides
    ? loadOverlaidConfig(await read(), configPath, overrides)
    : await loadBaseConfig(read, configPath, describe);
  if (closedUnknown) throw new Error(closedUnknown);
  // A copy that cannot be read or compared counts as changed, so its approval is held.
  if (!headConfig) return { ...loaded, brokenHead: { changed: headContent === undefined || headContent !== await read().catch(() => undefined) } };
  // A key the overrides set differs from the head's whatever the change did, so it is left out.
  const changed = editedKeys(headConfig, loaded).filter(key => !(overrides && key in overrides));
  if (changed.length > 0) {
    core.info(`This change edits ${changed.map(key => `\`${key}\``).join(', ')} in ${configPath}, which applies after merge: this review uses the base's settings.`);
  }
  return loaded;
}

/**
 * Loads the config at `base` in `repoRoot` with `overrides` set on top, as a review with them does. `own`, if given, is
 * read in place of the file the repository holds, and may name no key the config does not know. Throws when the config
 * does not load.
 */
export async function loadConfigWithOverrides(repoRoot: string, base: string, overrides: ConfigOverrides, own?: ConfigOverrides, configPath = CONFIG_PATH): Promise<ReviewConfig> {
  if (own) rejectUnknownKeys(own, 'The config given names');
  const content = own ? stringifyYaml(own) : await gitRepoFiles(repoRoot, base).read(configPath);
  return loadOverlaidConfig(content, own ? 'the config given' : configPath, overrides).config;
}

/**
 * Applies `patch` to the checkout at `dir` and its index, or with `index` to that index file alone. Throws when it does
 * not apply.
 */
async function applyPatch(dir: string, patch: string, head: string, index?: string): Promise<void> {
  const file = index ? `${index}.patch` : join(dir, '.git', 'manki-review.patch');
  // `git apply` reads a patch without its final newline as corrupt.
  writeFileSync(file, patch.endsWith('\n') ? patch : `${patch}\n`);
  const env = index ? { ...gitEnv(), GIT_INDEX_FILE: index } : gitEnv();
  // A symlink the patch adds is written as a plain file holding its target, as `fetchWorkspace` checks one out.
  await runGit(dir, ['-c', 'core.symlinks=false', 'apply', index ? '--cached' : '--index', '--whitespace=nowarn', file], env).catch((error: Error) => {
    throw new Error(`The patch does not apply to ${head.slice(0, 7)}: ${error.message}`);
  }).finally(() => rmSync(file, { force: true }));
}

/** Returns the tree of `head` with `patch` applied. A scratch index builds it, so the checkout and its index stay as they are. */
async function patchedTree(root: string, head: string, patch: string): Promise<string> {
  const scratch = makeScratchDir('index');
  const index = join(scratch, 'index');
  const env = { ...gitEnv(), GIT_INDEX_FILE: index };
  try {
    await runGit(root, ['read-tree', head], env);
    await applyPatch(root, patch, head, index);
    return (await runGit(root, ['write-tree'], env)).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Reads the changed lockfiles Manki parses from `rev`, which holds their `side` of `fullDiff`. One git cannot show, or past `MAX_LOCKFILE_BYTES`, stays unread. */
async function readLocalLockfiles(repoRoot: string, rev: string, fullDiff: ParsedDiff, side: 'head' | 'base'): Promise<LockfileDiff[]> {
  const contents = new Map<string, string>();
  for (const file of fullDiff.files.filter(f => isParsedLockfile(f.path))) {
    const path = side === 'head' ? file.path : file.oldPath ?? file.path;
    const content = await runGit(repoRoot, ['show', `${rev}:${path}`]).catch(() => undefined);
    if (content !== undefined && content.length <= MAX_LOCKFILE_BYTES) contents.set(path, content);
  }
  return readLockfileChanges(fullDiff, contents, side);
}

/** What a follow-up pull request round reads from GitHub about the rounds before it. */
interface FollowUpInputs {
  previousFindings: PreviousFinding[];
  openThreads: OpenThread[];
  priorRounds: RoundContext[];
  /** The change at the earlier round's commit, from its merge base with the base. */
  priorChange: ParsedDiff;
  interRoundDiff: string;
}

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

/**
 * Builds from `earlier` what a pull request round reads from GitHub: the earlier threads, with the code now at each open
 * one, the earlier round record, and the diff since that round, without what a rebase brought in. The record holds the
 * posted findings, which is what a later round reads of it.
 */
async function followUpInputs(
  repoRoot: string, base: string, head: string, earlier: EarlierRound, config: ReviewConfig, models: ReviewModels, reviewed: ParsedDiff, lockfiles: LockfileDiff[],
): Promise<FollowUpInputs> {
  const earlierHead = (await runGit(repoRoot, ['rev-parse', '--verify', `${earlier.head}^{commit}`])).trim();
  const earlierBase = (await runGit(repoRoot, ['merge-base', base, earlierHead])).trim();
  const lockfilePaths = new Set(lockfiles.map(l => l.path));
  const priorChange = filterDiff(parsePRDiff(await runGit(repoRoot, [...DIFF_ARGS, earlierBase, earlierHead])), config.exclude_paths, lockfilePaths, config.closed_paths).diff;
  const sinceEarlier = filterRawDiff(await runGit(repoRoot, [...DIFF_ARGS, earlierHead, head]), config.exclude_paths, lockfilePaths, config.closed_paths);
  const interRoundDiff = lockfilesLast(ownChangeSince(sinceEarlier, priorChange, reviewed), lockfiles);

  const threads = earlier.findings.filter(f => f.thread);
  // Cleaned as a pull request round reads them back, so a case file cannot cite the thread's own file or a path outside the repository.
  const cited = (f: EarlierFinding) => {
    const evidenceFiles = plainCitedFiles(f.evidenceFiles ?? [], f.file);
    return evidenceFiles.length > 0 ? { evidenceFiles } : {};
  };
  const guard = (f: EarlierFinding) => ({ ...(f.security && { isSecurity: true }), ...(f.disproved && { disprovedBlocker: true }) });
  const previousFindings: PreviousFinding[] = threads.map(f => ({
    title: f.title, file: f.file, line: f.line, severity: f.severity, status: f.thread === 'open' ? 'open' : 'resolved', ...(f.thread === 'fixed' && { fixed: true }), threadId: f.id,
    markerSlug: titleToSlug(f.title), description: f.description, suggestedFix: f.suggestedFix, howToFix: f.howToFix, ...guard(f),
    ...cited(f),
  }));
  const open = threads.filter(f => f.thread === 'open');
  const headFiles = gitRepoFiles(repoRoot, head);
  const files = openRepoFiles(headFiles, config.closed_paths ?? []);
  const contents = new Map<string, string>();
  for (const path of new Set(open.map(f => f.file))) {
    const content = await files.read(path);
    if (content !== null) contents.set(path, content);
  }
  // A file at the head that was not read, as a closed file or a symlink while paths are closed, is unread, not removed.
  const atHead = new Set(await headFiles.list());
  const openThreads: OpenThread[] = open.map(f => ({
    threadId: f.id, title: f.title, file: f.file, line: f.line, severity: f.severity, description: f.description, suggestedFix: f.suggestedFix, howToFix: f.howToFix,
    ...cited(f), ...guard(f), currentCode: extractCurrentCodeWindow(contents, f.file, f.line), ...(atHead.has(f.file) && !contents.has(f.file) && { codeUnread: true }),
  }));

  const posted: Finding[] = earlier.findings.map(f => ({
    severity: f.severity, title: f.title, file: f.file, line: f.line, description: f.description ?? '', reviewers: [],
    ...(f.howToFix && { howToFix: f.howToFix }), ...(f.suggestedFix && { suggestedFix: f.suggestedFix }), ...(f.gradeIfConfirmed && { gradeIfConfirmed: f.gradeIfConfirmed }),
    ...(f.cell && { cell: f.cell }), ...(f.doubts && { doubts: f.doubts }), ...(f.importance && { importance: f.importance }), ...((f.security || f.disproved) && { tags: [...(f.security ? [SECURITY_TAG] : []), ...(f.disproved ? [DISPROVED_TAG] : [])] }), ...(f.thread && { threadId: f.id }),
  }));
  const blocks = posted.some(f => f.severity === 'blocker');
  // A pull request round reads a thread as fixed from the earlier judge's `addressed` evaluation.
  const threadEvaluations = threads.filter(f => f.thread === 'fixed').map(f => ({ threadId: f.id, status: 'addressed' as const, reason: 'Fixed by an earlier push.' }));
  const result: ReviewResult = {
    verdict: blocks ? 'REQUEST_CHANGES' : 'APPROVE', outcome: blocks ? 'ADDRESS_FIRST' : 'READY', summary: '', findings: posted, highlights: [], reviewComplete: true, agentNames: [],
    ...(threadEvaluations.length > 0 && { threadEvaluations }),
  };
  const record = buildRoundContext({
    prNumber: 0, commitSha: earlierHead, trigger: { event: 'local', sender: 'local' }, options: {}, config, reviewSource: 'base', models,
    recap: { previousFindings: [], priorRounds: [] }, priorRoundCount: 0, maxAutoRounds: 0, diff: priorChange, changeDigest: changeDigest(priorChange), excludedFiles: [],
    openThreads: [], memoryLoadStatus: 'disabled',
  }, result, { judgeDurationMs: 0 });
  // A pull request round records the line of a warning it lists only in the review body, which a later round compares.
  const earlierLines = cachedFileLines(openRepoFiles(gitRepoFiles(repoRoot, earlierHead), config.closed_paths ?? [], true), 'so its earlier warnings are carried without their line');
  const entries = await Promise.all(record.findings.entries.map(async (entry, i) => {
    const { thread, severity, file, line, description } = earlier.findings[i];
    if (thread || severity !== 'warning') return entry;
    const lines = file && line > 0 ? await earlierLines(file) : undefined;
    const cited = lines && citedLine(lines, line);
    const unread = !!file && line > 0 && !lines;
    return { ...entry, posted: 'body' as const, ...(cited && { citedLine: cited }), ...(unread && { unread: true as const }), ...((cited || unread) && description && { description }) };
  }));
  return { previousFindings, openThreads, priorRounds: [{ ...record, findings: { ...record.findings, entries } }], priorChange, interRoundDiff };
}

/** Rates `findings` of the change from `base` to `head` in one call on the judge's model, as a round rates its warnings. No other step of a review runs. */
export async function rateLocal({ repoRoot, base, head, config, configOverrides, providerInputs }: LocalReviewInput, findings: readonly Finding[], client?: LLMClient): Promise<{ scores: Map<Finding, Importance>; calls: LLMCall[] }> {
  const mergeBase = (await runGit(repoRoot, ['merge-base', base, head])).trim();
  const loaded = config ?? (await loadLocalConfig(repoRoot, mergeBase, head, CONFIG_PATH, configOverrides)).config;
  const { fullDiff, diff, closedPaths } = reviewableDiff(await runGit(repoRoot, [...DIFF_ARGS, mergeBase, head]), loaded.exclude_paths, loaded.closed_paths);
  const lockfiles = await readLocalLockfiles(repoRoot, head, fullDiff, 'head');
  const calls: LLMCall[] = [];
  const judge = client ?? buildLLMClient(resolveModel(loaded, 'judge'), providerInputs);
  await judge.warmupCLI?.();
  const workspace = await fetchWorkspace(pathToFileURL(repoRoot).href, head, undefined, [], { sha: mergeBase, excludePaths: loaded.exclude_paths });
  try {
    await closePaths(workspace, closedPaths ?? []);
    return { scores: await rateWarnings(findings, { workspace, diff: withLockfiles(diff, lockfiles), client: recordCalls(judge, { stage: 'rating' }, calls) }), calls };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Runs the review pipeline a pull request round runs on a local change, and returns the result with the round record.
 * Memory, linked issues and static signals stay off, since they all come from GitHub. Prior rounds come only from `earlier`.
 */
export async function reviewLocal(input: LocalReviewInput): Promise<LocalReview> {
  const { repoRoot, patch, providerInputs, signal } = input;
  const configPath = input.configPath ?? CONFIG_PATH;
  const head = (await runGit(repoRoot, ['rev-parse', '--verify', `${input.head}^{commit}`])).trim();
  const base = patch === undefined ? (await runGit(repoRoot, ['merge-base', input.base, head])).trim() : head;
  // The head's copy of the config is the one the change leaves: the commit's, or the patched one.
  const loaded: Awaited<ReturnType<typeof loadLocalConfig>> = input.config ? { config: input.config, source: 'base' }
    : await loadLocalConfig(repoRoot, base, patch === undefined ? head : await patchedTree(repoRoot, head, patch), configPath, input.configOverrides);
  const raw = patch ?? await runGit(repoRoot, [...DIFF_ARGS, base, head]);
  const { fullDiff, diff, excludedFiles, rawDiff, closedPaths } = reviewableDiff(raw, loaded.config.exclude_paths, loaded.config.closed_paths);
  // Every later read, the tools' checkout included, keeps out the open path of a rename into or out of a closed path too.
  const config = { ...loaded.config, closed_paths: closedPaths };
  // A patch applies to `head`, so its lockfiles are read before the change, and a commit range's after it.
  const lockfiles = await readLocalLockfiles(repoRoot, head, fullDiff, patch === undefined ? 'head' : 'base');
  if (diff.files.length === 0 && lockfiles.length === 0) throw new Error('Nothing to review: the change has no reviewable files');

  const { clients, models } = buildReviewClients(config, providerInputs);
  await warmUpClients(clients);
  signal?.throwIfAborted();
  const repoContext = await buildRepoContext(openRepoFiles(gitRepoFiles(repoRoot, base), config.closed_paths ?? []), diff.files.map(f => f.path));
  const title = input.title ?? (await runGit(repoRoot, ['log', '-1', '--format=%s', head])).trim();
  const hasTools = [clients.reviewer, clients.judge, ...(clients.reviewerByModel?.values() ?? [])].some(c => c.repoTools);
  const followUp = input.earlier && patch === undefined
    ? await followUpInputs(repoRoot, base, head, input.earlier, config, models, withLockfiles(diff, lockfiles), lockfiles)
    : undefined;

  const startTime = Date.now();
  let plannerDurationMs: number | undefined;
  let reviewEndTime = startTime;
  let workspace: string | undefined;
  try {
    if (hasTools) {
      // A fresh repo holding only the tracked files of `head` and its history, so the tools read no untracked file and
      // no later commit of the checkout.
      workspace = await fetchWorkspace(pathToFileURL(repoRoot).href, head, undefined, [], { sha: base, excludePaths: config.exclude_paths });
      if (patch !== undefined) await applyPatch(workspace, patch, head);
      // Closed after the patch, which can add or change a closed file.
      await closePaths(workspace, config.closed_paths ?? []);
    }
    signal?.throwIfAborted();
    const result = await runReview(clients, {
      config,
      diff,
      rawDiff,
      repoContext: repoContext.text,
      instructionFiles: repoContext.files,
      prContext: { title, body: input.body ?? '', baseBranch: input.base },
      workspace,
      headSha: head,
      excludedPaths: excludedFiles.map(f => f.path),
      fullDiff,
      lockfiles,
      changeDigest: changeDigest(fullDiff),
      signal,
      ...(input.relatedReposAsOf && { relatedReposAsOf: input.relatedReposAsOf }),
      ...(input.replay && { replay: input.replay }),
      ...(input.answers && { answers: input.answers }),
      // A local review without an earlier round has no thread, so a round with nothing to judge skips the judge.
      openThreads: followUp?.openThreads ?? [],
      ...(followUp && {
        isFollowUp: followUp.previousFindings.length > 0, previousFindings: followUp.previousFindings,
        priorRounds: followUp.priorRounds, interRoundDiff: followUp.interRoundDiff,
      }),
      onProgress: (event) => {
        if (event.plannerDurationMs !== undefined) plannerDurationMs = event.plannerDurationMs;
        if (event.phase === 'reviewed') reviewEndTime = Date.now();
        input.onProgress?.(event);
      },
    });
    if (result.reviewComplete) {
      addCodeContext(result.findings, withLockfiles(diff, lockfiles));
      tagFindingOrigins(result.findings, withLockfiles(diff, lockfiles), followUp?.priorChange, followUp?.interRoundDiff ? parsePRDiff(followUp.interRoundDiff) : undefined, citedPlaces);
      hideSeenNotes(result, followUp && withLockfiles(diff, lockfiles));
      capNotes(result, followUp?.previousFindings ?? [], config.review?.notes);
      if (followUp) await carryBodyWarnings(result, followUp.priorRounds, openRepoFiles(gitRepoFiles(repoRoot, head), config.closed_paths ?? [], true));
    }
    const context = buildRoundContext({
      prNumber: 0, commitSha: head, trigger: { event: 'local', sender: 'local' }, options: {}, config, reviewSource: loaded.source,
      models, recap: { previousFindings: followUp?.previousFindings ?? [], priorRounds: followUp?.priorRounds ?? [] },
      priorRoundCount: followUp?.priorRounds.length ?? 0, maxAutoRounds: 0, diff, changeDigest: changeDigest(fullDiff), excludedFiles,
      openThreads: followUp?.openThreads ?? [], interRoundDiff: followUp?.interRoundDiff, memoryLoadStatus: 'disabled', instructions: repoContext,
    }, result, { plannerDurationMs, judgeDurationMs: Date.now() - reviewEndTime, wallClockMs: Date.now() - startTime });
    // An earlier warning thread holds as in a pull request round, unless this round found it fixed or graded it lower.
    // No reply is known here, so an open one holds. A resolve counts as one by a person with `author_clear_role`, so of
    // the resolved ones only a guarded one that no round found fixed holds.
    const evaluationOf = (threadId?: string) => result.threadEvaluations?.find(e => e.threadId === threadId);
    const preExisting = new Set(input.earlier?.findings.filter(f => f.preExisting).map(f => f.id));
    const threadHolds = (followUp?.previousFindings ?? []).filter(p => !preExisting.has(p.threadId ?? '')).some(p => {
      const evaluation = evaluationOf(p.threadId);
      const warns = threadWarns({ severity: p.severity, ...(evaluation?.grade && { recordedGrade: evaluation.grade }), isSecurity: p.isSecurity, disprovedBlocker: p.disprovedBlocker });
      return warns && evaluation?.status !== 'addressed' && (p.status === 'open' || ((!!p.isSecurity || !!p.disprovedBlocker) && !p.fixed));
    });
    const unread = skippedFiles(excludedFiles, lockfiles, diff);
    // As in a pull request round, only a round that would approve has its approval held.
    const approves = result.verdict === 'APPROVE';
    const warningsHeld = approves && (threadHolds || result.findings.some(holdsApproval));
    const approvalHeld = !approves ? false
      : brokenConfig(loaded.source, loaded.brokenHead?.changed ?? false) ? 'config'
      : unread.excluded.length + unread.binary.length > 0 ? 'unread'
      : warningsHeld ? 'warnings' : false;
    const record = approves ? { ...context, approval: roundApproval(approvalHeld, warningsHeld) } : context;
    return { result, context: record, base, head, approvalHeld, rules: config.review?.rules };
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }
}
