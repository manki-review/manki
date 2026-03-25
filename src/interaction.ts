import * as core from '@actions/core';
import * as github from '@actions/github';

import { ClaudeClient } from './claude';
import { writeSuppression, writeLearning, batchUpdatePatternDecisions, sanitizeMemoryField } from './memory';
import { reactToIssueComment, reactToReviewComment } from './github';
import { checkAndAutoApprove, fetchBotReviewThreads } from './state';
import { ReviewConfig } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

interface MemoryConfig {
  enabled: boolean;
  repo: string;
}

const BOT_MARKER = '<!-- manki -->';

/**
 * Handle a reply to one of our review comments.
 */
export async function handleReviewCommentReply(
  octokit: Octokit,
  client: ClaudeClient,
  memoryConfig?: MemoryConfig,
  memoryToken?: string,
): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;

  if (!comment) return;

  // Don't reply to ourselves
  if (comment.user?.type === 'Bot' || isBotComment(comment.body ?? '')) {
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

    if (!isBotComment(parentComment.body ?? '')) {
      core.info('Parent comment is not from Manki');
      return;
    }

    // Acknowledge the reply
    await reactToReviewComment(octokit, owner, repo, comment.id, 'eyes');

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

    if (memoryConfig?.enabled && memoryToken) {
      const replyBody = comment.body?.trim() ?? '';
      const simpleAcks = ['ok', 'done', 'fixed', 'thanks', 'will do', 'got it'];
      const isSubstantive = replyBody.length > 50 && !simpleAcks.includes(replyBody.toLowerCase());

      const authorAssociation = comment.author_association;
      const isTrusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation ?? '');

      if (isSubstantive && isTrusted) {
        try {
          const memoryOctokit = github.getOctokit(memoryToken);
          const memoryRepo = memoryConfig.repo || `${owner}/review-memory`;
          const sanitized = sanitizeMemoryField(replyBody.slice(0, 500));

          await writeLearning(memoryOctokit, memoryRepo, repo, {
            id: `learn-${Date.now()}`,
            content: `User context on "${parentComment.path}": ${sanitized}`,
            scope: 'repo',
            source: `${owner}/${repo}#${prNumber}`,
            created_at: new Date().toISOString().split('T')[0],
          });
          core.info('Stored user context as learning');
        } catch (error) {
          core.debug(`Failed to write learning: ${error}`);
        }
      }
    }
  } catch (error) {
    core.warning(`Failed to handle review comment reply: ${error}`);
  }
}

/**
 * Handle @manki commands in PR comments.
 */
export async function handlePRComment(
  octokit: Octokit,
  client: ClaudeClient | null,
  owner: string,
  repo: string,
  issueNumber: number,
  memoryConfig?: MemoryConfig,
  memoryToken?: string,
  config?: ReviewConfig,
): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;

  if (!comment) return;

  // Don't reply to ourselves
  if (comment.user?.type === 'Bot' || isBotComment(comment.body ?? '')) {
    return;
  }

  const body = comment.body ?? '';

  if (!hasBotMention(body)) return;

  const command = parseCommand(body);
  const commentId = comment.id as number;

  const prOnlyCommands = new Set(['check', 'explain', 'review']);
  if (prOnlyCommands.has(command.type) && !github.context.payload.issue?.pull_request) {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: issueNumber,
      body: `${BOT_MARKER}\nThe \`${command.type}\` command only works on pull requests.`,
    });
    return;
  }

  switch (command.type) {
    case 'explain':
      if (!client) { core.warning('Claude client required for explain command'); return; }
      await reactToIssueComment(octokit, owner, repo, commentId, 'eyes');
      await handleExplain(octokit, client, owner, repo, issueNumber, command.args);
      break;
    case 'dismiss':
      await handleDismiss(octokit, owner, repo, issueNumber, command.args, memoryConfig, memoryToken);
      await reactToIssueComment(octokit, owner, repo, commentId, '+1');
      break;
    case 'remember':
      await reactToIssueComment(octokit, owner, repo, commentId, 'eyes');
      await handleRemember(octokit, owner, repo, issueNumber, command.args, memoryConfig, memoryToken);
      break;
    case 'forget':
      await octokit.rest.issues.createComment({
        owner, repo,
        issue_number: issueNumber,
        body: `${BOT_MARKER}\nThe \`forget\` command is not yet implemented. You can manually remove learnings from the memory repo.`,
      });
      break;
    case 'check':
      await reactToIssueComment(octokit, owner, repo, commentId, 'eyes');
      await handleCheck(octokit, owner, repo, issueNumber, config);
      break;
    case 'triage':
      await reactToIssueComment(octokit, owner, repo, commentId, 'eyes');
      await handleTriage(octokit, owner, repo, issueNumber, memoryConfig, memoryToken);
      break;
    case 'help':
      await reactToIssueComment(octokit, owner, repo, commentId, '+1');
      await handleHelp(octokit, owner, repo, issueNumber);
      break;
    default:
      if (!client) { core.warning('Claude client required for generic questions'); return; }
      await reactToIssueComment(octokit, owner, repo, commentId, 'eyes');
      await handleGenericQuestion(octokit, client, owner, repo, issueNumber, body);
  }
}

interface ParsedCommand {
  type: 'explain' | 'dismiss' | 'help' | 'remember' | 'forget' | 'check' | 'triage' | 'generic';
  args: string;
}

function parseCommand(body: string): ParsedCommand {
  const lower = body.toLowerCase();
  const match = lower.match(/@manki\s+(explain|dismiss|help|remember|forget|check|triage)(?:\s+(.*))?/);

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
  memoryConfig?: MemoryConfig,
  memoryToken?: string,
): Promise<void> {
  const sanitizedPattern = findingRef
    .replace(/</g, '').replace(/>/g, '')
    .slice(0, 200)
    .trim();

  if (findingRef && sanitizedPattern.length < 3) {
    core.warning('Finding reference too short to create suppression');
    return;
  }

  const authorAssociation = github.context.payload.comment?.author_association;
  const isTrusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation ?? '');

  if (!isTrusted) {
    core.info('Dismiss from non-collaborator — acknowledging but not persisting suppression');
  }

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `${BOT_MARKER}\nDismissed${sanitizedPattern ? `: ${sanitizedPattern}` : ''}. ${memoryConfig?.enabled && isTrusted ? 'Stored as suppression in review memory.' : 'Enable memory to persist this for future reviews.'}`,
  });

  if (isTrusted && memoryConfig?.enabled && memoryToken && sanitizedPattern) {
    try {
      const memoryOctokit = github.getOctokit(memoryToken);
      const memoryRepo = memoryConfig.repo || `${owner}/review-memory`;

      await writeSuppression(memoryOctokit, memoryRepo, repo, {
        id: `supp-${Date.now()}`,
        pattern: sanitizedPattern,
        reason: `Dismissed by user on PR #${prNumber}`,
        created_by: github.context.actor,
        created_at: new Date().toISOString().split('T')[0],
        pr_ref: `${owner}/${repo}#${prNumber}`,
      });
      core.info(`Wrote suppression for "${findingRef}" to memory repo`);
    } catch (error) {
      core.warning(`Failed to write suppression: ${error}`);
    }
  }
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
    body: `${BOT_MARKER}\n**Manki Commands:**\n\n| Command | Description |\n|---------|-------------|\n| \`@manki review\` | Run a full multi-agent review |\n| \`@manki explain [topic]\` | Explain something about this PR |\n| \`@manki dismiss [finding]\` | Dismiss a review finding |\n| \`@manki remember <instruction>\` | Teach the reviewer something for future reviews |\n| \`@manki remember global: <instruction>\` | Teach globally (all repos) |\n| \`@manki check\` | Check if all blocking issues are resolved and auto-approve |\n| \`@manki triage\` | Process nit issue checkboxes — create issues for ticked items, suppress unticked |\n| \`@manki help\` | Show this help message |\n\nYou can also reply to any review comment to start a conversation.`,
  });
}

async function handleRemember(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  instruction: string,
  memoryConfig?: MemoryConfig,
  memoryToken?: string,
): Promise<void> {
  const authorAssociation = github.context.payload.comment?.author_association;
  const isTrusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation ?? '');

  if (!isTrusted) {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: prNumber,
      body: `${BOT_MARKER}\nOnly collaborators can teach the reviewer.`,
    });
    return;
  }

  if (!instruction || instruction.trim().length < 10) {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: prNumber,
      body: `${BOT_MARKER}\nPlease provide a more detailed instruction (at least 10 characters).\n\nExample: \`@manki remember always check for SQL injection in query builders\``,
    });
    return;
  }

  if (!memoryConfig?.enabled || !memoryToken) {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: prNumber,
      body: `${BOT_MARKER}\nMemory is not enabled for this repo. Add \`memory.enabled: true\` to \`.manki.yml\` to use this feature.`,
    });
    return;
  }

  let scope: 'repo' | 'global' = 'repo';
  let content = instruction.trim();

  if (content.toLowerCase().startsWith('global:')) {
    scope = 'global';
    content = content.slice(7).trim();
  }

  const sanitized = sanitizeMemoryField(content);

  try {
    const memoryOctokit = github.getOctokit(memoryToken);
    const memoryRepo = memoryConfig.repo || `${owner}/review-memory`;

    await writeLearning(memoryOctokit, memoryRepo, repo, {
      id: `learn-${Date.now()}`,
      content: sanitized,
      scope,
      source: `${owner}/${repo}#${prNumber}`,
      created_at: new Date().toISOString().split('T')[0],
    });

    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: prNumber,
      body: `${BOT_MARKER}\nRemembered (scope: ${scope}): "${sanitized}"`,
    });

    core.info(`Stored learning: "${sanitized}" (scope: ${scope})`);
  } catch (error) {
    core.warning(`Failed to store learning: ${error}`);
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: prNumber,
      body: `${BOT_MARKER}\nFailed to store learning. Check that the memory repo token has write access.`,
    });
  }
}

async function handleCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  config?: ReviewConfig,
): Promise<void> {
  const authorAssociation = github.context.payload.comment?.author_association;
  const isTrusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation ?? '');

  if (!isTrusted) {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: prNumber,
      body: `${BOT_MARKER}\nOnly collaborators can trigger auto-approve checks.`,
    });
    return;
  }

  if (!config?.auto_approve) {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: prNumber,
      body: `${BOT_MARKER}\nAuto-approve is disabled. Set \`auto_approve: true\` in \`.manki.yml\` to enable.`,
    });
    return;
  }

  const approved = await checkAndAutoApprove(octokit, owner, repo, prNumber);

  if (!approved) {
    const threads = await fetchBotReviewThreads(octokit, owner, repo, prNumber);
    const blocking = threads.filter(t => t.isBlocking && !t.isResolved);

    if (blocking.length > 0) {
      const list = blocking.map(t => `- "${t.findingTitle}"`).join('\n');
      await octokit.rest.issues.createComment({
        owner, repo,
        issue_number: prNumber,
        body: `${BOT_MARKER}\n**${blocking.length} blocking issue(s) still open:**\n\n${list}\n\nResolve all blocking threads to trigger auto-approval.`,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner, repo,
        issue_number: prNumber,
        body: `${BOT_MARKER}\nNo blocking issues found. Checking approval status...`,
      });
    }
  }
}

async function handleTriage(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  memoryConfig?: MemoryConfig,
  memoryToken?: string,
): Promise<void> {
  const authorAssociation = github.context.payload.comment?.author_association;
  const isTrusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation ?? '');
  if (!isTrusted) {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: issueNumber,
      body: `${BOT_MARKER}\nOnly collaborators can triage findings.`,
    });
    return;
  }

  const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const body = issue.body ?? '';

  const checkedRegex = /^- \[x\] [💡❓] \*\*(.+?)\*\* — `(.+?)`/gmiu;
  const uncheckedRegex = /^- \[ \] [💡❓] \*\*(.+?)\*\* — `(.+?)`/gmu;

  const accepted: Array<{ title: string; ref: string }> = [];
  const rejected: Array<{ title: string; ref: string }> = [];

  let match;
  while ((match = checkedRegex.exec(body)) !== null) {
    accepted.push({ title: match[1], ref: match[2] });
  }
  while ((match = uncheckedRegex.exec(body)) !== null) {
    rejected.push({ title: match[1], ref: match[2] });
  }

  if (accepted.length === 0 && rejected.length === 0) {
    await octokit.rest.issues.createComment({
      owner, repo,
      issue_number: issueNumber,
      body: `${BOT_MARKER}\nCouldn't parse any findings from the issue body. Make sure the checkboxes follow the expected format.`,
    });
    return;
  }

  const createdIssues: number[] = [];
  for (const item of accepted) {
    const sectionRegex = new RegExp(
      `- \\[x\\] [💡❓] \\*\\*${escapeRegex(item.title)}\\*\\*[\\s\\S]*?(?=\\n- \\[|\\n---|$)`,
      'iu',
    );
    const sectionMatch = body.match(sectionRegex);
    const context = sectionMatch ? sectionMatch[0] : item.title;

    try {
      const { data: newIssue } = await octokit.rest.issues.create({
        owner, repo,
        title: item.title,
        body: `## Finding from review triage\n\nSource: #${issueNumber}\n\n${context}`,
      });
      createdIssues.push(newIssue.number);
      core.info(`Created issue #${newIssue.number} for "${item.title}"`);
    } catch (error) {
      core.warning(`Failed to create issue for "${item.title}": ${error}`);
    }
  }

  if (memoryConfig?.enabled && memoryToken) {
    const memoryOctokit = github.getOctokit(memoryToken);
    const memoryRepo = memoryConfig.repo || `${owner}/review-memory`;

    for (const item of accepted) {
      try {
        await writeLearning(memoryOctokit, memoryRepo, repo, {
          id: `accept-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          content: `Finding pattern "${item.title}" was accepted for fix — team considers this valuable`,
          scope: 'repo',
          source: `${owner}/${repo}#${issueNumber}`,
          created_at: new Date().toISOString().split('T')[0],
        });
      } catch (error) {
        core.debug(`Failed to store acceptance for "${item.title}": ${error}`);
      }
    }

    for (const item of rejected) {
      try {
        await writeSuppression(memoryOctokit, memoryRepo, repo, {
          id: `supp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          pattern: item.title,
          reason: `Dismissed during triage of #${issueNumber}`,
          created_by: github.context.actor,
          created_at: new Date().toISOString().split('T')[0],
          pr_ref: `${owner}/${repo}#${issueNumber}`,
        });
      } catch (error) {
        core.debug(`Failed to store suppression for "${item.title}": ${error}`);
      }
    }

    const decisions = [
      ...accepted.map(item => ({ title: item.title, accepted: true })),
      ...rejected.map(item => ({ title: item.title, accepted: false })),
    ];
    if (decisions.length > 0) {
      try {
        await batchUpdatePatternDecisions(memoryOctokit, memoryRepo, repo, decisions);
      } catch (error) {
        core.debug(`Failed to batch-update pattern decisions: ${error}`);
      }
    }
  }

  try {
    await octokit.rest.issues.removeLabel({
      owner, repo,
      issue_number: issueNumber,
      name: 'needs-human',
    });
  } catch {
    // Label might not exist
  }

  const issueLinks = createdIssues.map(n => `#${n}`).join(', ');
  await octokit.rest.issues.createComment({
    owner, repo,
    issue_number: issueNumber,
    body: `${BOT_MARKER}\n**Triage complete:**\n- ${accepted.length} finding(s) accepted → issues created: ${issueLinks || 'none'}\n- ${rejected.length} finding(s) dismissed → stored as suppressions\n\nClosing this issue.`,
  });

  await octokit.rest.issues.update({
    owner, repo,
    issue_number: issueNumber,
    state: 'closed',
  });

  core.info(`Triage complete: ${accepted.length} accepted, ${rejected.length} rejected`);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function isBotComment(body: string): boolean {
  return body.includes('<!-- manki');
}

function hasBotMention(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('@manki');
}

export { parseCommand, buildReplyContext, ParsedCommand, BOT_MARKER, isBotComment, hasBotMention };
