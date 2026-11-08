import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { BOT_LOGIN, BotIdentity } from './github';
import type { PrState, RunMode, StateReport } from './types';
import { redactSecretsDeep, registerSecret } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;

const RATE_LIMIT_RETRIES = 2;

function onRateLimit(retryAfter: number, options: { method: string; url: string }, _octokit: unknown, retryCount: number): boolean {
  if (retryCount >= RATE_LIMIT_RETRIES) {
    core.warning(`GitHub rate limit on ${options.method} ${options.url}, giving up after ${RATE_LIMIT_RETRIES} retries`);
    return false;
  }
  core.warning(`GitHub rate limit on ${options.method} ${options.url}, retrying in ${retryAfter}s`);
  return true;
}

// Request options that route a request rather than carry its text.
const ROUTING_OPTIONS = new Set(['method', 'url', 'baseUrl', 'headers', 'request', 'mediaType']);

/** Octokit plugin that removes Manki's own secret values from every request, so nothing Manki posts can carry one. */
function redactRequests(octokit: Pick<Octokit, 'hook'>): void {
  octokit.hook.before('request', (options) => {
    for (const key of Object.keys(options)) {
      if (!ROUTING_OPTIONS.has(key)) options[key] = redactSecretsDeep(options[key]);
    }
  });
}

/** Octokit that retries 5xx responses, waits out primary and secondary rate limits and redacts Manki's secret values. */
function createOctokit(token: string): Octokit {
  return github.getOctokit(token, { throttle: { onRateLimit, onSecondaryRateLimit: onRateLimit } }, retry, throttling, redactRequests);
}

export interface AuthResult {
  octokit: Octokit;
  bot: BotIdentity;
}

export interface TokenResult {
  token: string;
}

/** The token service gave no token, so the run cannot post as Manki. */
export class TokenServiceError extends Error {
  constructor(reason: string) {
    super(`Could not get a token from the Manki token service (${reason}). Retry the run.`);
    this.name = 'TokenServiceError';
  }
}

const TOKEN_RETRY_DELAY_MS = 2000;

const OIDC_AUDIENCE = 'manki-api.dustinface.me';

interface TokenServiceResponse {
  ok: boolean;
  status: number;
  data?: unknown;
}

/** The token service's `/token` URL. Its other endpoints sit next to it. */
function tokenServiceUrl(): string {
  return core.getInput('manki_token_url') || 'https://manki-api.dustinface.me/token';
}

/**
 * Posts `body` to the token service at `url` with the workflow's OIDC token, and reads the JSON reply of a 2xx response.
 * The timeout covers the reply too. Returns `null` when the run has no OIDC token.
 */
async function postToTokenService(url: string, body: unknown): Promise<TokenServiceResponse | null> {
  let oidcToken: string;
  try {
    oidcToken = await core.getIDToken(OIDC_AUDIENCE);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${oidcToken}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response.ok ? { ok: true, status: response.status, data: await response.json() } : { ok: false, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

/** Posts `body` to the token service endpoint `path`, such as `state`, as `postToTokenService` does. */
export function callTokenService(path: string, body: unknown): Promise<TokenServiceResponse | null> {
  return postToTokenService(new URL(path, tokenServiceUrl()).href, body);
}

/**
 * Fetches the manki-review App's token for the repo from the token service. A timeout, network error or 5xx is tried
 * once more after a short wait. Throws `TokenServiceError` when no token comes back.
 */
export async function resolveGitHubToken(tokenUrl: string, owner: string, repo: string): Promise<TokenResult> {
  let response: Awaited<ReturnType<typeof postToTokenService>> | undefined;
  for (let attempt = 1; !response; attempt++) {
    let failure: string;
    try {
      const reply = await postToTokenService(tokenUrl, { owner, repo });
      if (!reply) throw new TokenServiceError('no OIDC token, so the workflow needs `id-token: write`');
      if (reply.ok || reply.status < 500) {
        response = reply;
        break;
      }
      failure = `HTTP ${reply.status}`;
    } catch (error) {
      if (error instanceof TokenServiceError) throw error;
      failure = String(error);
    }
    if (attempt === 2) throw new TokenServiceError(failure);
    core.info(`The token service failed (${failure}), trying again`);
    await new Promise((resolve) => setTimeout(resolve, TOKEN_RETRY_DELAY_MS));
  }
  if (!response.ok) throw new TokenServiceError(`HTTP ${response.status}`);
  const tokenData = response.data as { token?: unknown; expires_at?: unknown } | null;
  if (!tokenData || !tokenData.token || typeof tokenData.token !== 'string') throw new TokenServiceError('a reply without a token');

  core.info(`Using ${BOT_LOGIN} identity (token expires ${tokenData.expires_at})`);
  registerSecret(tokenData.token);
  return { token: tokenData.token };
}

const RUN_MODES: ReadonlySet<string> = new Set<RunMode>(['full', 'deeper', 'draft', 'force']);

function modesOf(items: unknown, keep: (item: Record<string, unknown>) => boolean): Set<RunMode> {
  const modes = new Set<RunMode>();
  if (!Array.isArray(items)) return modes;
  for (const item of items) {
    if (!item || typeof item !== 'object' || !keep(item) || !Array.isArray(item.modes)) continue;
    for (const mode of item.modes) if (typeof mode === 'string' && RUN_MODES.has(mode)) modes.add(mode as RunMode);
  }
  return modes;
}

/**
 * Reads the coordinator's state of PR `prNumber` from the token service, with the modes of run `runId`.
 * Returns `null` with a warning when the run has no OIDC token or the service gives no state.
 */
export async function fetchPrState(owner: string, repo: string, prNumber: number, runId: number): Promise<PrState | null> {
  try {
    const response = await callTokenService('state', { owner, repo, pr: prNumber });
    if (!response?.ok) {
      core.warning(`The token service gave no PR state for #${prNumber} (${response ? response.status : 'no OIDC token'}), reviewing as not paused`);
      return null;
    }
    const data = response.data as Record<string, unknown> | null;
    const settings = data?.settings as Record<string, unknown> | undefined;
    const reviewed = (data?.last_reviewed as Record<string, unknown> | null | undefined)?.commit;
    return {
      settings: { paused: settings?.paused === true },
      ...(typeof reviewed === 'string' && { lastReviewed: reviewed }),
      runModes: modesOf(data?.active, item => item.run_id === runId),
      queuedModes: modesOf(data?.queue, () => true),
    };
  } catch (error) {
    core.warning(`Could not read the PR state from the token service, reviewing as not paused: ${error}`);
    return null;
  }
}

/** The clients holding the token service's review token, which cannot resolve review threads itself. */
const serviceClients = new WeakSet<Octokit>();

/**
 * Resolves or reopens review thread `threadId` through the token service's `/resolve` when `octokit` holds the token
 * service's review token, since resolving needs `contents: write`, which only the service's one-call token holds.
 * Returns false for any other client, which changes the thread itself. Throws when the service does not change it.
 */
export async function changeThreadThroughService(octokit: Octokit, threadId: string, resolved: boolean, reason?: string): Promise<boolean> {
  if (!serviceClients.has(octokit)) return false;
  const { owner, repo } = github.context.repo;
  const body = { owner, repo, thread_id: threadId, resolved, ...(reason !== undefined && { reason }) };
  const response = await callTokenService('resolve', body);
  if (!response?.ok) {
    throw new Error(`The token service did not ${resolved ? 'resolve' : 'reopen'} the thread (${response ? response.status : 'no OIDC token'})`);
  }
  return true;
}

/** Sends what this run posted on PR `prNumber` to the PR coordinator. A failure only warns, since the review on GitHub stands. */
export async function reportPrState(owner: string, repo: string, prNumber: number, report: StateReport): Promise<void> {
  try {
    const response = await callTokenService('state/report', { owner, repo, pr: prNumber, ...report });
    if (!response?.ok) {
      core.warning(`The token service did not take the PR state of #${prNumber} (${response ? response.status : 'no OIDC token'})`);
    }
  } catch (error) {
    core.warning(`Could not report the PR state to the token service: ${error}`);
  }
}

/**
 * Create the client Manki reads and posts with: the custom App's when `github_app_id` and `github_app_private_key` are
 * set, else the manki-review App's from the token service. Throws `TokenServiceError` when the token service fails.
 */
export async function createAuthenticatedOctokit(): Promise<AuthResult> {
  const appId = core.getInput('github_app_id');
  const privateKey = core.getInput('github_app_private_key');

  if (appId && privateKey) {
    core.info('Using GitHub App authentication for custom bot identity');
    const { token, slug } = await getInstallationToken(appId, privateKey);
    return { octokit: createOctokit(token), bot: { logins: [`${slug}[bot]`] } };
  }

  const { owner, repo: repoName } = github.context.repo;
  const { token } = await resolveGitHubToken(tokenServiceUrl(), owner, repoName);

  const octokit = createOctokit(token);
  serviceClients.add(octokit);
  return { octokit, bot: { logins: [BOT_LOGIN] } };
}

async function getInstallationToken(
  appId: string,
  privateKey: string,
): Promise<{ token: string; slug: string }> {
  const appIdNum = parseInt(appId, 10);
  if (isNaN(appIdNum)) {
    throw new Error(`Invalid github_app_id: "${appId}" is not a number`);
  }

  const auth = createAppAuth({
    appId: appIdNum,
    privateKey,
  });

  const appAuth = await auth({ type: 'app' });
  registerSecret(appAuth.token);
  const appOctokit = createOctokit(appAuth.token);

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  try {
    const { data: app } = await appOctokit.rest.apps.getAuthenticated();
    if (!app?.slug) throw new Error('GET /app returned no slug');

    const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
      owner,
      repo,
    });

    // Without `repositoryNames` the token would cover every repo of the installation.
    const installationAuth = await auth({
      type: 'installation',
      installationId: installation.id,
      repositoryNames: [repo],
    });

    registerSecret(installationAuth.token);
    core.info(`Authenticated as GitHub App ${app.slug}[bot] (installation ${installation.id})`);
    return { token: installationAuth.token, slug: app.slug };
  } catch (error) {
    throw new Error(`GitHub App authentication failed: ${error}. Check that the app is installed on this repo and credentials are correct.`);
  }
}
