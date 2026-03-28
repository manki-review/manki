import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';

type Octokit = ReturnType<typeof github.getOctokit>;

export interface TokenResult {
  token: string;
  identity: 'app' | 'actions';
}

/**
 * Auto-detect manki-labs GitHub App installation and fetch an app token
 * from the token service. Falls back to the provided github_token on any failure.
 */
export async function resolveGitHubToken(
  githubToken: string,
  tokenUrl: string,
  owner: string,
  repo: string,
): Promise<TokenResult> {
  try {
    const ghController = new AbortController();
    const ghTimeout = setTimeout(() => ghController.abort(), 10000);
    let response: Response;
    try {
      response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/installation`,
        {
          headers: {
            Authorization: `token ${githubToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'manki',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: ghController.signal,
        },
      );
    } finally {
      clearTimeout(ghTimeout);
    }

    if (!response.ok) {
      core.info('Manki app not installed — using github-actions[bot] identity');
      return { token: githubToken, identity: 'actions' };
    }

    const installation = await response.json() as { id: number; app_slug: string };

    if (installation.app_slug !== 'manki-labs') {
      core.info('Manki app not installed — using github-actions[bot] identity');
      return { token: githubToken, identity: 'actions' };
    }

    core.info(`Found manki-labs installation: ${installation.id}`);

    // The token service has no authentication. This is a known limitation —
    // installation IDs are public and the generated tokens are short-lived with
    // limited permissions, but a shared-secret auth header would add defense in depth.
    const tokenController = new AbortController();
    const tokenTimeout = setTimeout(() => tokenController.abort(), 10000);
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installation_id: installation.id }),
        signal: tokenController.signal,
      });
    } finally {
      clearTimeout(tokenTimeout);
    }

    if (!tokenResponse.ok) {
      core.warning(`Token service error (${tokenResponse.status}) — falling back to github-actions[bot]`);
      return { token: githubToken, identity: 'actions' };
    }

    const tokenData = await tokenResponse.json() as { token: string; expires_at: string };

    if (!tokenData.token || typeof tokenData.token !== 'string') {
      core.warning('Token service returned invalid response — falling back to github-actions[bot]');
      return { token: githubToken, identity: 'actions' };
    }

    core.info(`Using manki-labs[bot] identity (token expires ${tokenData.expires_at})`);
    core.setSecret(tokenData.token);
    return { token: tokenData.token, identity: 'app' };
  } catch (error) {
    core.warning(`App token resolution failed: ${error} — falling back to github-actions[bot]`);
    return { token: githubToken, identity: 'actions' };
  }
}

/**
 * Create an authenticated Octokit client.
 * Priority: explicit App credentials > auto-detect manki-labs app > github_token.
 */
export async function createAuthenticatedOctokit(): Promise<Octokit> {
  const appId = core.getInput('github_app_id');
  const privateKey = core.getInput('github_app_private_key');
  const githubToken = core.getInput('github_token');

  if (appId && privateKey) {
    core.info('Using GitHub App authentication for custom bot identity');
    const token = await getInstallationToken(appId, privateKey);
    return github.getOctokit(token);
  }

  if (!githubToken) {
    throw new Error('No authentication configured. Provide either github_token or both github_app_id and github_app_private_key.');
  }

  const tokenUrl = core.getInput('manki_token_url') || 'https://manki.dustinface.me/token';
  const { owner, repo: repoName } = github.context.repo;
  const { token } = await resolveGitHubToken(githubToken, tokenUrl, owner, repoName);

  return github.getOctokit(token);
}

/**
 * Returns a token suitable for memory repo operations.
 * Prefers memory_repo_token, falls back to github_token, returns null if neither is set.
 */
export function getMemoryToken(): string | null {
  const memoryToken = core.getInput('memory_repo_token');
  if (memoryToken) return memoryToken;

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
