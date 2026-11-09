import * as core from '@actions/core';
import { rmSync } from 'fs';

import { changedKeys, loadConfig } from './config';
import { addCodeContext, changeDigest, reviewableDiff, tagFindingOrigins } from './diff';
import { buildRepoContext, RepoFiles } from './github';
import type { ProviderInputs } from './providers';
import { ReviewProgress, runReview } from './review';
import { buildReviewClients, warmUpClients } from './review-clients';
import { buildRoundContext } from './round-context';
import type { ReviewConfig, ReviewResult, RoundContext, RoundOutcome } from './types';
import { fetchWorkspace, runGit } from './workspace';

const DEFAULT_CONFIG_PATH = '.manki.yml';

/** What a local review reads. Nothing is read from or written to GitHub. */
export interface LocalReviewInput {
  /** Root of the git repository the commits are in. */
  repoRoot: string;
  /** The change runs from the merge base of `base` and `head` to `head`, as a pull request shows it. */
  base: string;
  head: string;
  /**
   * A patch reviewed in place of the commits. The config and instructions are then read at `head`, and the
   * repository tools read the checkout as it is.
   */
  patch?: string;
  /** Replaces the config the base commit holds. */
  config?: ReviewConfig;
  configPath?: string;
  /** Shown to the models as the pull request title. Defaults to the subject of `head`. */
  title?: string;
  /** Shown to the models as the pull request description. */
  body?: string;
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
}

/** Reads the files of `commit` in the repository at `root`. */
function gitRepoFiles(root: string, commit: string): RepoFiles {
  return {
    // `cat-file blob` fails for a missing path and for a directory, so both read as no file.
    read: path => runGit(root, ['cat-file', 'blob', `${commit}:${path}`]).catch(() => null),
    list: async () => (await runGit(root, ['ls-tree', '-r', '-z', '--name-only', commit])).split('\0').filter(Boolean),
  };
}

/** Loads the config at `base` the way a pull request round does, and logs the keys `head` changes. */
async function loadLocalConfig(root: string, base: string, head: string, configPath: string): Promise<{ config: ReviewConfig; source: 'base' | 'builtin' }> {
  const baseContent = await gitRepoFiles(root, base).read(configPath);
  const headConfig = loadConfig(await gitRepoFiles(root, head).read(configPath) ?? undefined, configPath);
  const config = loadConfig(baseContent ?? undefined, configPath);
  const changed = changedKeys(headConfig, config);
  if (changed.length > 0) {
    core.info(`This change edits ${changed.map(key => `\`${key}\``).join(', ')} in ${configPath}, which applies after merge: this review uses the base's settings.`);
  }
  return { config, source: baseContent === null ? 'builtin' : 'base' };
}

/**
 * Runs the review pipeline a pull request round runs on a local change, and returns the result with the round record.
 * Memory, prior rounds, linked issues and static signals stay off, since they all come from GitHub.
 */
export async function reviewLocal(input: LocalReviewInput): Promise<LocalReview> {
  const { repoRoot, patch, providerInputs, signal } = input;
  const configPath = input.configPath ?? DEFAULT_CONFIG_PATH;
  const head = (await runGit(repoRoot, ['rev-parse', '--verify', `${input.head}^{commit}`])).trim();
  const base = patch === undefined ? (await runGit(repoRoot, ['merge-base', input.base, head])).trim() : head;
  const loaded = input.config ? { config: input.config, source: 'base' as const } : await loadLocalConfig(repoRoot, base, head, configPath);
  const { config } = loaded;
  const raw = patch ?? await runGit(repoRoot, ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base, head]);
  const { fullDiff, diff, excludedFiles, rawDiff } = reviewableDiff(raw, config.exclude_paths);
  if (diff.files.length === 0) throw new Error('Nothing to review: the change has no reviewable files');

  const { clients, models } = buildReviewClients(config, providerInputs);
  await warmUpClients(clients);
  const repoContext = await buildRepoContext(gitRepoFiles(repoRoot, base), diff.files.map(f => f.path));
  const title = input.title ?? (await runGit(repoRoot, ['log', '-1', '--format=%s', head])).trim();
  const hasTools = [clients.reviewer, clients.judge, ...(clients.reviewerByModel?.values() ?? [])].some(c => c.repoTools);
  // A fresh repo holding only `head` and its history, so the tools cannot read later commits of the checkout.
  const fetched = hasTools && patch === undefined ? await fetchWorkspace(`file://${repoRoot}`, head) : undefined;
  const workspace = hasTools ? fetched ?? repoRoot : undefined;

  const startTime = Date.now();
  let plannerDurationMs: number | undefined;
  let reviewEndTime = startTime;
  try {
    const result = await runReview(clients, {
      config,
      diff,
      rawDiff,
      repoContext,
      prContext: { title, body: input.body ?? '', baseBranch: input.base },
      workspace,
      headSha: head,
      excludedPaths: excludedFiles.map(f => f.path),
      signal,
      onProgress: (event) => {
        if (event.plannerDurationMs !== undefined) plannerDurationMs = event.plannerDurationMs;
        if (event.phase === 'reviewed') reviewEndTime = Date.now();
        input.onProgress?.(event);
      },
    });
    if (result.reviewComplete) {
      addCodeContext(result.findings, diff);
      tagFindingOrigins(result.findings, diff, undefined);
    }
    const context = buildRoundContext({
      prNumber: 0, commitSha: head, trigger: { event: 'local', sender: 'local' }, options: {}, config, reviewSource: loaded.source,
      models, plannerEnabled: !!clients.planner, recap: { previousFindings: [], priorRounds: [] }, priorRoundCount: 0, maxAutoRounds: 0,
      diff, changeDigest: changeDigest(fullDiff), excludedFiles, openThreads: [], memoryLoadStatus: 'disabled',
    }, result, { plannerDurationMs, judgeDurationMs: Date.now() - reviewEndTime, wallClockMs: Date.now() - startTime });
    return { result, context, base, head };
  } finally {
    if (fetched) rmSync(fetched, { recursive: true, force: true });
  }
}
