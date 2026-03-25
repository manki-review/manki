import * as github from '@actions/github';
type Octokit = ReturnType<typeof github.getOctokit>;
/**
 * Create an authenticated Octokit client.
 * If GitHub App credentials are provided, generates an installation token
 * so reviews appear under the app's identity.
 * Otherwise falls back to the provided github_token.
 */
export declare function createAuthenticatedOctokit(): Promise<Octokit>;
/**
 * Returns a token suitable for memory repo operations.
 * Prefers memory_repo_token, falls back to github_token, returns null if neither is set.
 */
export declare function getMemoryToken(): string | null;
export {};
