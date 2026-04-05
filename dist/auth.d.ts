import * as github from '@actions/github';
type Octokit = ReturnType<typeof github.getOctokit>;
export interface AuthResult {
    octokit: Octokit;
    resolvedToken: string;
}
export interface TokenResult {
    token: string;
    identity: 'app' | 'actions';
}
/**
 * Auto-detect manki-review GitHub App installation and fetch an app token
 * from the token service. Falls back to the provided github_token on any failure.
 */
export declare function resolveGitHubToken(githubToken: string, tokenUrl: string, owner: string, repo: string): Promise<TokenResult>;
/**
 * Create an authenticated Octokit client.
 * Priority: explicit App credentials > auto-detect manki-review app > github_token.
 */
export declare function createAuthenticatedOctokit(): Promise<AuthResult>;
/**
 * Returns a token suitable for memory repo operations.
 * Prefers memory_repo_token, falls back to github_token, returns null if neither is set.
 */
export declare function getMemoryToken(resolvedToken: string | null): string | null;
export {};
