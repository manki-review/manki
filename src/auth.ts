import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { ACTIONS_BOT_LOGIN, BOT_LOGIN, BotIdentity } from './github';
import type { PrState, RunMode } from './types';
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

/** Review memory access through a GitHub App. */
export interface AppMemory {
  /** Returns a token that writes `memoryRepo`, or `null` when the App cannot write it. */
  tokenFor(memoryRepo: string): Promise<string | null>;
}

type AppAuth = ReturnType<typeof createAppAuth>;

export interface AuthResult {
  octokit: Octokit;
  appMemory?: AppMemory;
  identity: 'app' | 'actions';
  bot: BotIdentity;
}

// Without custom App credentials a run posts as `manki-review[bot]`, or as `github-actions[bot]` when the App token
// is unavailable, or as the token's user for a personal access token. Earlier rounds can carry any of these logins.
const MANKI_BOT: BotIdentity = { logins: [BOT_LOGIN, ACTIONS_BOT_LOGIN] };

// Installation tokens, including the workflow's `GITHUB_TOKEN`, carry this prefix. Any other token belongs to a user.
const INSTALLATION_TOKEN_PREFIX = 'ghs_';

/** Adds the token's user to `MANKI_BOT` for a personal access token, since a run then posts as that user. */
async function resolveTokenUserBot(octokit: Octokit, token: string): Promise<BotIdentity> {
  if (token.startsWith(INSTALLATION_TOKEN_PREFIX)) return MANKI_BOT;
  try {
    const { data: user } = await octokit.rest.users.getAuthenticated();
    if (!user?.login) throw new Error('GET /user returned no login');
    core.info(`Using personal access token identity ${user.login}`);
    return { logins: [...MANKI_BOT.logins, user.login] };
  } catch (error) {
    core.warning(`Could not resolve the token's user, so comments posted as that user are not recognised: ${error}`);
    return MANKI_BOT;
  }
}

export interface TokenResult {
  token: string;
  /** The token service's `memory_token`, which writes only the owner's `review-memory`. */
  memoryToken?: string;
  identity: 'app' | 'actions';
}

const OIDC_AUDIENCE = 'manki-api.dustinface.me';

/** The token service's `/token` URL. Its other endpoints sit next to it. */
function tokenServiceUrl(): string {
  return core.getInput('manki_token_url') || 'https://manki-api.dustinface.me/token';
}

/**
 * Posts `body` to the token service at `url` with the workflow's OIDC token, and reads the JSON reply of a 2xx response.
 * The timeout covers the reply too. Returns `null` when the run has no OIDC token.
 */
async function postToTokenService(url: string, body: unknown): Promise<{ ok: boolean; status: number; data?: unknown } | null> {
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

/**
 * Auto-detect manki-review GitHub App installation and fetch an app token
 * from the token service. Falls back to the provided github_token on any failure.
 */
export async function resolveGitHubToken(
  githubToken: string,
  tokenUrl: string,
  owner: string,
  repo: string,
): Promise<TokenResult> {
  try {
    const tokenResponse = await postToTokenService(tokenUrl, { owner, repo, memory: true });
    if (!tokenResponse) {
      core.info('OIDC token not available — using github-actions[bot] identity');
      return { token: githubToken, identity: 'actions' };
    }

    if (!tokenResponse.ok) {
      core.info(`Manki app not available for ${owner}/${repo} — using github-actions[bot] identity`);
      return { token: githubToken, identity: 'actions' };
    }

    const tokenData = tokenResponse.data as { token?: unknown; expires_at?: unknown; memory_token?: unknown } | null;

    if (!tokenData || !tokenData.token || typeof tokenData.token !== 'string') {
      core.warning('Token service returned invalid response — falling back to github-actions[bot]');
      return { token: githubToken, identity: 'actions' };
    }

    core.info(`Using ${BOT_LOGIN} identity (token expires ${tokenData.expires_at})`);
    registerSecret(tokenData.token);
    if (typeof tokenData.memory_token !== 'string' || !tokenData.memory_token) {
      return { token: tokenData.token, identity: 'app' };
    }
    registerSecret(tokenData.memory_token);
    return { token: tokenData.token, memoryToken: tokenData.memory_token, identity: 'app' };
  } catch (error) {
    core.info(`App token resolution failed: ${error} — using github-actions[bot] identity`);
    return { token: githubToken, identity: 'actions' };
  }
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
    const response = await postToTokenService(new URL('state', tokenServiceUrl()).href, { owner, repo, pr: prNumber });
    if (!response?.ok) {
      core.warning(`The token service gave no PR state for #${prNumber} (${response ? response.status : 'no OIDC token'}), reviewing as not paused`);
      return null;
    }
    const data = response.data as Record<string, unknown> | null;
    const settings = data?.settings as Record<string, unknown> | undefined;
    return {
      settings: { paused: settings?.paused === true },
      runModes: modesOf(data?.active, item => item.run_id === runId),
      queuedModes: modesOf(data?.queue, () => true),
    };
  } catch (error) {
    core.warning(`Could not read the PR state from the token service, reviewing as not paused: ${error}`);
    return null;
  }
}

/**
 * Create an authenticated Octokit client.
 * Priority: explicit App credentials > auto-detect manki-review app > github_token.
 */
export async function createAuthenticatedOctokit(): Promise<AuthResult> {
  const appId = core.getInput('github_app_id');
  const privateKey = core.getInput('github_app_private_key');
  const githubToken = core.getInput('github_token');

  if (appId && privateKey) {
    core.info('Using GitHub App authentication for custom bot identity');
    const { token, slug, appMemory } = await getInstallationToken(appId, privateKey);
    return { octokit: createOctokit(token), appMemory, identity: 'app', bot: { logins: [`${slug}[bot]`] } };
  }

  if (!githubToken) {
    throw new Error('No authentication configured. Provide either github_token or both github_app_id and github_app_private_key.');
  }

  const tokenUrl = tokenServiceUrl();
  const { owner, repo: repoName } = github.context.repo;
  const { token, memoryToken, identity } = await resolveGitHubToken(githubToken, tokenUrl, owner, repoName);

  const octokit = createOctokit(token);
  const bot = identity === 'actions' ? await resolveTokenUserBot(octokit, token) : MANKI_BOT;
  const serviceMemoryRepo = `${owner}/review-memory`.toLowerCase();
  const appMemory: AppMemory | undefined = memoryToken
    ? { tokenFor: async (memoryRepo) => (memoryRepo.toLowerCase() === serviceMemoryRepo ? memoryToken : null) }
    : undefined;
  return { octokit, appMemory, identity, bot };
}

/**
 * Returns the token for `memoryRepo`: `memory_repo_token`, else the App's memory token when it covers `memoryRepo`,
 * else `null` with a warning. The review token is never used, since it covers only the reviewed repo.
 */
export async function getMemoryToken(appMemory: AppMemory | undefined, memoryRepo: string): Promise<string | null> {
  const memoryRepoToken = core.getInput('memory_repo_token');
  if (memoryRepoToken) return memoryRepoToken;
  let appToken: string | null | undefined;
  try {
    appToken = await appMemory?.tokenFor(memoryRepo);
  } catch (error) {
    core.warning(`Could not get a token for the review memory repo \`${memoryRepo}\`, so memory is skipped: ${error}`);
    return null;
  }
  if (appToken) return appToken;
  core.warning(
    `No token for the review memory repo \`${memoryRepo}\`, so memory is skipped. Set \`memory_repo_token\`, or use a `
    + 'memory repo the App can write. The manki-review App writes only `<owner>/review-memory`, and a token service '
    + 'that predates memory tokens issues none. A custom App writes only repos of the reviewed owner that it is installed on.',
  );
  return null;
}

/**
 * Mints a token that writes only the contents of `memoryRepo`, which must belong to `owner`'s installation.
 * Returns `null` when GitHub refuses the mint, and throws any other error, such as a 5xx or a network failure.
 */
async function mintMemoryToken(auth: AppAuth, installationId: number, owner: string, memoryRepo: string): Promise<string | null> {
  const [memoryOwner, name] = memoryRepo.split('/');
  if (memoryOwner.toLowerCase() !== owner.toLowerCase() || !name) {
    core.info(`The App installation on \`${owner}\` cannot write \`${memoryRepo}\``);
    return null;
  }
  try {
    const { token } = await auth({ type: 'installation', installationId, repositoryNames: [name], permissions: { contents: 'write' } });
    registerSecret(token);
    return token;
  } catch (error) {
    if (![403, 404, 422].includes((error as { status?: number }).status ?? 0)) throw error;
    core.info(`GitHub refused a memory token for \`${memoryRepo}\`: ${error}`);
    return null;
  }
}

async function getInstallationToken(
  appId: string,
  privateKey: string,
): Promise<{ token: string; slug: string; appMemory: AppMemory }> {
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
    const appMemory: AppMemory = { tokenFor: (memoryRepo) => mintMemoryToken(auth, installation.id, owner, memoryRepo) };
    return { token: installationAuth.token, slug: app.slug, appMemory };
  } catch (error) {
    throw new Error(`GitHub App authentication failed: ${error}. Check that the app is installed on this repo and credentials are correct.`);
  }
}
