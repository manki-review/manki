import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';
import { BOT_LOGIN } from './github';

type Octokit = ReturnType<typeof github.getOctokit>;

export interface AuthResult {
  octokit: Octokit;
  resolvedToken: string;
  identity: 'app' | 'actions';
}

export interface TokenResult {
  token: string;
  identity: 'app' | 'actions';
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
    // Request OIDC token from GitHub Actions
    let oidcToken: string;
    try {
      oidcToken = await core.getIDToken('manki-api.dustinface.me');
    } catch {
      core.info('OIDC token not available — using github-actions[bot] identity');
      return { token: githubToken, identity: 'actions' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${oidcToken}`,
      },
      body: JSON.stringify({ owner, repo }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!tokenResponse.ok) {
      core.info(`Manki app not available for ${owner}/${repo} — using github-actions[bot] identity`);
      return { token: githubToken, identity: 'actions' };
    }

    const tokenData = await tokenResponse.json() as { token: string; expires_at: string };

    if (!tokenData.token || typeof tokenData.token !== 'string') {
      core.warning('Token service returned invalid response — falling back to github-actions[bot]');
      return { token: githubToken, identity: 'actions' };
    }

    core.info(`Using ${BOT_LOGIN} identity (token expires ${tokenData.expires_at})`);
    core.setSecret(tokenData.token);
    return { token: tokenData.token, identity: 'app' };
  } catch (error) {
    core.info(`App token resolution failed: ${error} — using github-actions[bot] identity`);
    return { token: githubToken, identity: 'actions' };
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
    const token = await getInstallationToken(appId, privateKey);
    return { octokit: github.getOctokit(token), resolvedToken: token, identity: 'app' };
  }

  if (!githubToken) {
    throw new Error('No authentication configured. Provide either github_token or both github_app_id and github_app_private_key.');
  }

  const tokenUrl = core.getInput('manki_token_url') || 'https://manki-api.dustinface.me/token';
  const { owner, repo: repoName } = github.context.repo;
  const { token, identity } = await resolveGitHubToken(githubToken, tokenUrl, owner, repoName);

  return { octokit: github.getOctokit(token), resolvedToken: token, identity };
}

/**
 * Returns a token suitable for memory repo operations.
 * Prefers memory_repo_token, falls back to github_token, returns null if neither is set.
 */
export function getMemoryToken(resolvedToken: string | null): string | null {
  // Explicit memory_repo_token takes priority
  const memoryToken = core.getInput('memory_repo_token');
  if (memoryToken) return memoryToken;

  // Use the resolved app token (cross-repo access if app is installed on memory repo)
  if (resolvedToken) return resolvedToken;

  // Fall back to raw github_token
  const githubToken = core.getInput('github_token');
  if (githubToken) return githubToken;

  return null;
}

async function getInstallationToken(
  appId: string,
  privateKey: string,
): Promise<string> {
  const appIdNum = parseInt(appId, 10);
  if (isNaN(appIdNum)) {
    throw new Error(`Invalid github_app_id: "${appId}" is not a number`);
  }

  const auth = createAppAuth({
    appId: appIdNum,
    privateKey,
  });

  const appAuth = await auth({ type: 'app' });
  core.setSecret(appAuth.token);
  const appOctokit = github.getOctokit(appAuth.token);

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  try {
    const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
      owner,
      repo,
    });

    const installationAuth = await auth({
      type: 'installation',
      installationId: installation.id,
    });

    core.setSecret(installationAuth.token);
    core.info(`Authenticated as GitHub App (installation ${installation.id})`);
    return installationAuth.token;
  } catch (error) {
    throw new Error(`GitHub App authentication failed: ${error}. Check that the app is installed on this repo and credentials are correct.`);
  }
}
