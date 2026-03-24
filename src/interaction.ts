import * as core from '@actions/core';
import * as github from '@actions/github';

import { ClaudeClient } from './claude';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- claude-review -->';

/**
 * Handle a reply to one of our review comments.
 */
export async function handleReviewCommentReply(
  octokit: Octokit,
  client: ClaudeClient,
): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;

  if (!comment) return;

  // Don't reply to ourselves
  if (comment.user?.type === 'Bot' || comment.body?.includes(BOT_MARKER)) {
    core.info('Skipping bot comment');
    return;
  }

  // Check if this is a reply to one of our comments
  const inReplyTo = comment.in_reply_to_id;
  if (!inReplyTo) {
    core.info('Not a reply to an existing comment');
    return;
  }

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const prNumber = payload.pull_request?.number;

  if (!prNumber) return;

  try {
    const { data: parentComment } = await octokit.rest.pulls.getReviewComment({
      owner,
      repo,
      comment_id: inReplyTo,
    });

    if (!parentComment.body?.includes(BOT_MARKER) && !parentComment.body?.includes('claude-review:')) {
      core.info('Parent comment is not from claude-review');
      return;
    }

    const context = buildReplyContext(
      parentComment.body,
      comment.body,
      parentComment.path,
      parentComment.line,
    );

    const response = await client.sendMessage(
      'You are a helpful code review assistant. A developer is replying to one of your review comments. ' +
      'Provide a concise, helpful response. If they are asking for clarification, explain clearly. ' +
      'If they are disagreeing, acknowledge their point and either update your recommendation or explain why the original concern still stands.',
      context,
    );

    await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      comment_id: comment.id,
      body: `${BOT_MARKER}\n${response.content}`,
    });

    core.info('Posted reply to review comment');
  } catch (error) {
    core.warning(`Failed to handle review comment reply: ${error}`);
  }
}

/**
 * Handle @claude commands in PR comments.
 */
export async function handlePRComment(
  octokit: Octokit,
  client: ClaudeClient,
): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;

  if (!comment) return;

  // Don't reply to ourselves
  if (comment.user?.type === 'Bot' || comment.body?.includes(BOT_MARKER)) {
    return;
  }

  const body = comment.body ?? '';

  if (!body.toLowerCase().includes('@claude')) return;

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const prNumber = payload.issue?.number;

  if (!prNumber) return;

  const command = parseCommand(body);

  switch (command.type) {
    case 'explain':
      await handleExplain(octokit, client, owner, repo, prNumber, command.args);
      break;
    case 'dismiss':
      await handleDismiss(octokit, owner, repo, prNumber, command.args);
      break;
    case 'help':
      await handleHelp(octokit, owner, repo, prNumber);
      break;
    default:
      await handleGenericQuestion(octokit, client, owner, repo, prNumber, body);
  }
}

interface ParsedCommand {
  type: 'explain' | 'dismiss' | 'help' | 'generic';
  args: string;
}

function parseCommand(body: string): ParsedCommand {
  const lower = body.toLowerCase();
  const match = lower.match(/@claude\s+(explain|dismiss|help)(?:\s+(.*))?/);

  if (match) {
    return {
      type: match[1] as ParsedCommand['type'],
      args: match[2]?.trim() ?? '',
    };
  }

  return { type: 'generic', args: body };
}

async function handleExplain(
  octokit: Octokit,
  client: ClaudeClient,
  owner: string,
  repo: string,
  prNumber: number,
  topic: string,
): Promise<void> {
  const { data: diff } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });

  const response = await client.sendMessage(
    'You are a code review assistant. A developer is asking you to explain something about a pull request. Be concise and helpful.',
    `## PR Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n## Question\n\n${topic || 'Please explain the changes in this PR.'}`,
  );

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `${BOT_MARKER}\n${response.content}`,
  });
}

async function handleDismiss(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  findingRef: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `${BOT_MARKER}\nDismissed${findingRef ? `: ${findingRef}` : ''}. This will be remembered for future reviews once the memory system is enabled.`,
  });
}

async function handleHelp(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `${BOT_MARKER}\n**Claude Review Commands:**\n\n| Command | Description |\n|---------|-------------|\n| \`@claude review\` | Run a full multi-agent review |\n| \`@claude explain [topic]\` | Explain something about this PR |\n| \`@claude dismiss [finding]\` | Dismiss a review finding |\n| \`@claude help\` | Show this help message |\n\nYou can also reply to any review comment to start a conversation.`,
  });
}

async function handleGenericQuestion(
  octokit: Octokit,
  client: ClaudeClient,
  owner: string,
  repo: string,
  prNumber: number,
  question: string,
): Promise<void> {
  const response = await client.sendMessage(
    'You are a helpful code review assistant. A developer is asking you a question about a pull request. Be concise and helpful.',
    question,
  );

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `${BOT_MARKER}\n${response.content}`,
  });
}

function buildReplyContext(
  originalComment: string,
  replyBody: string,
  filePath?: string | null,
  line?: number | null,
): string {
  let context = '## Original Review Comment\n\n';
  context += originalComment.replace(BOT_MARKER, '').trim();

  if (filePath) {
    context += `\n\nFile: \`${filePath}\``;
    if (line) context += ` (line ${line})`;
  }

  context += `\n\n## Developer Reply\n\n${replyBody}`;

  return context;
}

export { parseCommand, buildReplyContext, ParsedCommand, BOT_MARKER };
