import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Create an authenticated Octokit client.
 * If GitHub App credentials are provided, generates an installation token
 * so reviews appear under the app's identity.
 * Otherwise falls back to the provided github_token.
 */
export async function createAuthenticatedOctokit(): Promise<Octokit> {
  const appId = core.getInput('github_app_id');
  const privateKey = core.getInput('github_app_private_key');
  const githubToken = core.getInput('github_token', { required: true });

  if (appId && privateKey) {
    core.info('Using GitHub App authentication for custom bot identity');
    const token = await getInstallationToken(appId, privateKey);
    return github.getOctokit(token);
  }

  core.info('Using GITHUB_TOKEN (reviews will appear as github-actions[bot])');
  return github.getOctokit(githubToken);
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
