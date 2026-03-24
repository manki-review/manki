import * as github from '@actions/github';
type Octokit = ReturnType<typeof github.getOctokit>;
/**
 * Create an authenticated Octokit client.
 * If GitHub App credentials are provided, generates an installation token
 * so reviews appear under the app's identity.
 * Otherwise falls back to the provided github_token.
 */
export declare function createAuthenticatedOctokit(): Promise<Octokit>;
export {};
