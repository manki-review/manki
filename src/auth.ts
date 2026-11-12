import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { assertWritesAllowed } from './abort';
import { offerQueuedCheck, QueuedCheck } from './check-run';
import { BOT_LOGIN, BotIdentity } from './github';
import type { PrState, RunMode, StateReport, TokenServiceCall } from './types';
import { redactSecretsDeep, registerSecret } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;

const RATE_LIMIT_RETRIES = 2;

function onRateLimit(retryAfter: number, options: { method: string; url: string; request?: { signal?: AbortSignal } }, _octokit: unknown, retryCount: number): boolean {
  // A request with a deadline of its own fails at once, since a wait would outlast that deadline and keep the run open.
  if (options.request?.signal) {
    core.warning(`GitHub rate limit on ${options.method} ${options.url}, not waiting for a request with its own deadline`);
    return false;
  }
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

/**
 * Octokit that retries 5xx responses, waits out primary and secondary rate limits and redacts Manki's secret values.
 * With `deadline`, every request of the client carries that signal, a 5xx is retried once and no rate limit is waited
 * out. `paginate` drops a signal passed to it, so a deadline for its pages has to come this way.
 */
export function createOctokit(token: string, deadline?: AbortSignal): Octokit {
  const plugins = { throttle: { onRateLimit, onSecondaryRateLimit: onRateLimit }, ...(deadline && { retry: { retries: 1 } }) };
  const octokit = github.getOctokit(token, plugins, retry, throttling, redactRequests);
  if (deadline) octokit.hook.before('request', (options) => { options.request.signal ??= deadline; });
  return octokit;
}

export interface AuthResult {
  octokit: Octokit;
  bot: BotIdentity;
}

export interface TokenResult {
  token: string;
  /** The queued `Manki` check the service created for this run's review, when it created one. */
  queuedCheck?: QueuedCheck;
}

/** A token service call that the run cannot go on without failed. `action` says what the call does, by default getting the token. */
export class TokenServiceError extends Error {
  constructor(reason: string, action = 'get a token from') {
    super(`Could not ${action} the Manki token service (${reason}). Retry the run.`);
    this.name = 'TokenServiceError';
  }
}

const RETRY_DELAY_MS = 2000;

const OIDC_AUDIENCE = 'manki-api.dustinface.me';

interface TokenServiceResponse {
  ok: boolean;
  status: number;
  /** Whether a failed reply leaves the answer unknown, as `leavesAnswerUnknown` decides. Never set on a 2xx. */
  unknown?: boolean;
  data?: unknown;
}

/** The token service's `/token` URL. Its other endpoints sit next to it. */
function tokenServiceUrl(): string {
  return core.getInput('manki_token_url') || 'https://manki-api.dustinface.me/token';
}

const MAX_CALL_ERROR_CHARS = 200;

/** Every call this run made to the token service, in order, for the round and reply records. */
const serviceCalls: TokenServiceCall[] = [];

/** Returns the token service calls this run has made so far. */
export function tokenServiceCalls(): TokenServiceCall[] {
  return [...serviceCalls];
}

/** Reads the service's `{ error, request_id }` from a refused call, which names the Worker's log line. */
async function refusalOf(response: Response): Promise<Pick<TokenServiceCall, 'error' | 'requestId'>> {
  const body = await response.json().catch(() => null) as { error?: unknown; request_id?: unknown } | null;
  return {
    ...(typeof body?.error === 'string' && { error: body.error.slice(0, MAX_CALL_ERROR_CHARS) }),
    ...(typeof body?.request_id === 'string' && { requestId: body.request_id.slice(0, MAX_CALL_ERROR_CHARS) }),
  };
}

/**
 * The statuses with which the service says that it has nothing for the run, on every endpoint: a workflow or run it
 * does not accept (403), and a repository without the App, or a path or thread the service does not know (404).
 */
export const NOTHING_FOR_RUN: readonly number[] = [403, 404];

/**
 * Whether a failed reply leaves the answer unknown. Only a status the caller names in `refusals`, sent with the
 * service's JSON body that names the `error`, is a refusal the service would give again. Every other failed reply is
 * unknown: any other status, such as a 5xx or a throttled call (429), and a reply without that body, which Cloudflare
 * or a proxy in front of the service sent. A caller must never read an unknown answer as a refusal.
 */
function leavesAnswerUnknown(status: number, error: string | undefined, refusals: readonly number[]): boolean {
  return error === undefined || !refusals.includes(status);
}

/**
 * Posts `body` to the token service at `url` with the workflow's OIDC token, and reads the JSON reply of a 2xx response.
 * The timeout covers the reply too. Returns `null` when the run has no OIDC token. A failed reply is unknown unless its
 * status is one of `refusals`, as `leavesAnswerUnknown` decides. Each call is logged under `endpoint` in
 * `tokenServiceCalls`.
 */
async function postToTokenService(url: string, body: unknown, endpoint: string, refusals: readonly number[]): Promise<TokenServiceResponse | null> {
  const start = Date.now();
  const logCall = (outcome: Omit<TokenServiceCall, 'endpoint' | 'durationMs'>) => serviceCalls.push({ endpoint, ...outcome, durationMs: Date.now() - start });
  let oidcToken: string;
  try {
    oidcToken = await core.getIDToken(OIDC_AUDIENCE);
  } catch {
    logCall({ error: 'no OIDC token' });
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
    if (!response.ok) {
      const refusal = await refusalOf(response);
      logCall({ status: response.status, ...refusal });
      return { ok: false, status: response.status, unknown: leavesAnswerUnknown(response.status, refusal.error, refusals) };
    }
    const data: unknown = await response.json();
    logCall({ status: response.status });
    return { ok: true, status: response.status, data };
  } catch (error) {
    logCall({ error: String(error).slice(0, MAX_CALL_ERROR_CHARS) });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Posts as `postToTokenService` does, and tries a call that got no reply or an unknown answer once more after a short
 * wait. Returns the reply of the last try, or throws its error. Only for a call the service may safely get twice.
 * `beforeRetry` runs after the wait and stops the second try by throwing.
 */
async function postWithRetry(
  url: string, body: unknown, endpoint: string, refusals: readonly number[], beforeRetry?: () => void,
): Promise<TokenServiceResponse | null> {
  let failure: string;
  try {
    const reply = await postToTokenService(url, body, endpoint, refusals);
    // The service throttles an account per minute, so a throttled call would get the same answer after the short wait.
    if (!reply?.unknown || reply.status === 429) return reply;
    failure = `HTTP ${reply.status}`;
  } catch (error) {
    failure = String(error);
  }
  core.info(`The token service failed on \`${endpoint}\` (${failure}), trying again`);
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  beforeRetry?.();
  return postToTokenService(url, body, endpoint, refusals);
}

/**
 * Posts `body` to the token service endpoint `path`, such as `state`, as `postToTokenService` does. `refusals` names
 * the statuses with which the service refuses this endpoint for good. With `retry` a failed call is tried once more,
 * as `postWithRetry` does. A function as `retry` runs right before that second try and stops it by throwing.
 */
export function callTokenService(
  path: string, body: unknown, refusals: readonly number[], retry: boolean | (() => void) = false,
): Promise<TokenServiceResponse | null> {
  const url = new URL(path, tokenServiceUrl()).href;
  if (!retry) return postToTokenService(url, body, path, refusals);
  return postWithRetry(url, body, path, refusals, retry === true ? undefined : retry);
}

/**
 * Fetches the manki-review App's token for the repo from the token service. A failed call is tried once more, as
 * `postWithRetry` does. Throws `TokenServiceError` when no token comes back.
 */
export async function resolveGitHubToken(tokenUrl: string, owner: string, repo: string): Promise<TokenResult> {
  // `takes_over_check` tells the service that this run takes over the queued check the reply names.
  const response = await postWithRetry(tokenUrl, { owner, repo, takes_over_check: true }, 'token', NOTHING_FOR_RUN).catch((error: unknown) => {
    throw new TokenServiceError(String(error));
  });
  if (!response) throw new TokenServiceError('no OIDC token, so the workflow needs `id-token: write`');
  if (!response.ok) throw new TokenServiceError(`HTTP ${response.status}`);
  const tokenData = response.data as { token?: unknown; expires_at?: unknown; check_run?: { id?: unknown; head_sha?: unknown } | null } | null;
  if (!tokenData || !tokenData.token || typeof tokenData.token !== 'string') throw new TokenServiceError('a reply without a token');

  core.info(`Using ${BOT_LOGIN} identity (token expires ${tokenData.expires_at})`);
  registerSecret(tokenData.token);
  const { id, head_sha: headSha } = tokenData.check_run ?? {};
  const queued = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && typeof headSha === 'string';
  return { token: tokenData.token, ...(queued && { queuedCheck: { id, headSha } }) };
}

const RUN_MODES: ReadonlySet<string> = new Set<RunMode>(['again', 'deeper', 'draft']);

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
 * Reads the coordinator's state of PR `prNumber` from the token service, with the modes of run `runId`. A failed read
 * is tried once more, as `postWithRetry` does. Throws `TokenServiceError` when the answer stays unknown, since the
 * run's modes are unknown then. Returns `null` with a warning when the run has no OIDC token or the service itself
 * answers with one of `NOTHING_FOR_RUN`, since it holds no state for such a run.
 */
export async function fetchPrState(owner: string, repo: string, prNumber: number, runId: number): Promise<PrState | null> {
  const failed = (reason: string) => new TokenServiceError(reason, 'read the PR state from');
  const response = await callTokenService('state', { owner, repo, pr: prNumber }, NOTHING_FOR_RUN, true).catch((error: unknown) => {
    throw failed(String(error));
  });
  if (response?.unknown) throw failed(`HTTP ${response.status}`);
  if (!response?.ok) {
    core.warning(`The token service gave no PR state for #${prNumber} (${response ? response.status : 'no OIDC token'}), reviewing as not paused`);
    return null;
  }
  const data = response.data as Record<string, unknown> | null;
  const settings = data?.settings as Record<string, unknown> | undefined;
  const reviewed = (data?.last_reviewed as Record<string, unknown> | null | undefined)?.commit;
  return {
    settings: { paused: settings?.paused === true },
    ...(typeof reviewed === 'string' && /^[0-9a-f]+$/.test(reviewed) && { lastReviewed: reviewed }),
    runModes: modesOf(data?.active, item => item.run_id === runId),
    queuedModes: modesOf(data?.queue, () => true),
  };
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
  // Resolving or reopening twice leaves the thread as one call does, so a failed call is tried once more. The second
  // try comes after a wait, in which the run can be cancelled, so the write stop is checked again before it.
  const response = await callTokenService('resolve', body, NOTHING_FOR_RUN, assertWritesAllowed);
  if (!response?.ok) {
    throw new Error(`The token service did not ${resolved ? 'resolve' : 'reopen'} the thread (${response ? response.status : 'no OIDC token'})`);
  }
  return true;
}

/**
 * Sends what this run posted on PR `prNumber` to the PR coordinator. The coordinator stores a report it already holds
 * as no change, so a failed call is tried once more. A failure only warns, since the review on GitHub stands.
 */
export async function reportPrState(owner: string, repo: string, prNumber: number, report: StateReport): Promise<void> {
  try {
    const response = await callTokenService('state/report', { owner, repo, pr: prNumber, ...report }, NOTHING_FOR_RUN, true);
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
  const { token, queuedCheck } = await resolveGitHubToken(tokenServiceUrl(), owner, repoName);

  const octokit = createOctokit(token);
  serviceClients.add(octokit);
  if (queuedCheck) offerQueuedCheck(octokit, queuedCheck);
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
