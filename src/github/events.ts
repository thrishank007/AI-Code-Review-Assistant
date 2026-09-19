import { isOurInlineComment } from "../review/report.js";

const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "ready_for_review"]);
const REVIEW_COMMAND_RE = /^\/review\b/i;

/** True when a comment body is a `/review` re-request. */
export function isReviewCommand(body: string): boolean {
  return REVIEW_COMMAND_RE.test(body.trim());
}

export interface IssueCommentDeps {
  github: import("./client.js").GitHubClient;
  engine: import("../review/engine.js").ReviewEngine;
  logger: import("../logger.js").Logger;
}

/** Handle an issue_comment webhook payload for `/review`. Never throws. */
export async function handleIssueCommentEvent(payload: any, deps: IssueCommentDeps): Promise<void> {
  const { installation, repository, issue, comment } = payload;
  const repoSlug = `${repository.owner.login}/${repository.name}`;
  if (!installation) {
    deps.logger.warn({ repo: repoSlug, issue: issue.number }, "issue_comment event without installation; skipping");
    return;
  }
  if (payload.action !== "created") {
    deps.logger.debug({ repo: repoSlug, issue: issue.number, action: payload.action }, "Ignoring issue_comment action");
    return;
  }
  if (!issue.pull_request) {
    deps.logger.debug({ repo: repoSlug, issue: issue.number }, "Ignoring non-PR issue comment");
    return;
  }
  if (comment.user?.type === "Bot") {
    deps.logger.debug({ repo: repoSlug, issue: issue.number }, "Ignoring bot comment");
    return;
  }
  if (!isReviewCommand(comment.body ?? "")) {
    deps.logger.debug({ repo: repoSlug, issue: issue.number }, "Ignoring non-review comment");
    return;
  }

  try {
    const pr = await deps.github.getPullRequest(
      installation.id,
      repository.owner.login,
      repository.name,
      issue.number,
    );
    await deps.engine.reviewPullRequest(
      {
        installationId: installation.id,
        owner: repository.owner.login,
        repo: repository.name,
        pullNumber: issue.number,
        title: pr.title,
        body: pr.body,
        headSha: pr.headSha,
      },
      { force: true },
    );
  } catch (e: any) {
    deps.logger.error({ repo: repoSlug, issue: issue.number, err: e }, "Manual review failed");
    try {
      await deps.engine.reportFailure(installation.id, repository.owner.login, repository.name, issue.number, e.message);
    } catch (commentErr) {
      deps.logger.error({ err: commentErr }, "Also failed to post failure comment");
    }
  }
}

export interface ReviewCommentDeps {
  github: import("./client.js").GitHubClient;
  engine: import("../review/engine.js").ReviewEngine;
  logger: import("../logger.js").Logger;
  conversation?: import("../agent/conversation.js").ConversationEngine;
}

/**
 * Handle a `pull_request_review_comment` payload: a developer replied to one of
 * our inline findings. Routine `/review` commands are left to the issue-comment
 * handler. Never throws.
 */
export async function handleReviewCommentEvent(payload: any, deps: ReviewCommentDeps): Promise<void> {
  const { installation, repository, pull_request: pr, comment } = payload;
  const repoSlug = `${repository.owner.login}/${repository.name}`;
  if (payload.action !== "created") {
    deps.logger.debug({ repo: repoSlug, action: payload.action }, "Ignoring review comment action");
    return;
  }
  if (!installation) {
    deps.logger.warn({ repo: repoSlug, pr: pr.number }, "review_comment event without installation; skipping");
    return;
  }
  if (!deps.conversation) {
    deps.logger.debug("Ignoring review comment reply (no conversation agent wired)");
    return;
  }
  if (comment.user?.type === "Bot") {
    deps.logger.debug({ repo: repoSlug }, "Ignoring bot review comment");
    return;
  }
  if (typeof comment.in_reply_to_id !== "number") {
    deps.logger.debug({ repo: repoSlug }, "Ignoring top-level review comment");
    return;
  }
  // `/review` on a thread is a re-review request, not a conversation.
  if (isReviewCommand(comment.body ?? "")) {
    deps.logger.debug({ repo: repoSlug }, "Ignoring /review reply in a thread");
    return;
  }

  try {
    const parent = await deps.github.getReviewComment(
      installation.id,
      repository.owner.login,
      repository.name,
      comment.in_reply_to_id,
    );
    if (!parent) {
      deps.logger.debug({ repo: repoSlug }, "Parent review comment not found; skipping reply");
      return;
    }
    if (parent.user.type !== "Bot" || !isOurInlineComment(parent.body)) {
      deps.logger.debug({ repo: repoSlug, author: parent.user.login }, "Reply is not on one of our findings; skipping");
      return;
    }
    await deps.conversation.respond({
      installationId: installation.id,
      owner: repository.owner.login,
      repo: repository.name,
      pullNumber: pr.number,
      parentCommentId: comment.in_reply_to_id,
      reply: {
        id: comment.id,
        body: comment.body ?? "",
        author: comment.user?.login ?? "unknown",
      },
      prTitle: pr.title,
      headSha: pr.head.sha,
    });
  } catch (e) {
    deps.logger.error({ repo: repoSlug, pr: pr.number, err: e }, "Conversation reply failed");
  }
}

export interface PullRequestDeps {
  engine: import("../review/engine.js").ReviewEngine;
  logger: import("../logger.js").Logger;
}

/** Handle a pull_request webhook payload. Never throws (posts a failure comment instead). */
export async function handlePullRequestEvent(payload: any, deps: PullRequestDeps): Promise<void> {
  const { action, installation, repository, pull_request: pr } = payload;
  const repoSlug = `${repository.owner.login}/${repository.name}`;
  if (!installation) {
    deps.logger.warn({ repo: repoSlug, pr: pr.number }, "pull_request event without installation; skipping");
    return;
  }
  if (!REVIEWABLE_ACTIONS.has(action)) {
    deps.logger.debug({ repo: repoSlug, pr: pr.number, action }, "Ignoring pull_request action");
    return;
  }
  if (pr.draft) {
    deps.logger.info({ repo: repoSlug, pr: pr.number }, "Skipping draft PR");
    return;
  }

  try {
    await deps.engine.reviewPullRequest({
      installationId: installation.id,
      owner: repository.owner.login,
      repo: repository.name,
      pullNumber: pr.number,
      title: pr.title,
      body: pr.body,
      headSha: pr.head.sha,
    });
  } catch (e: any) {
    deps.logger.error({ repo: repoSlug, pr: pr.number, err: e }, "Review failed");
    try {
      await deps.engine.reportFailure(installation.id, repository.owner.login, repository.name, pr.number, e.message);
    } catch (commentErr) {
      deps.logger.error({ err: commentErr }, "Also failed to post failure comment");
    }
  }
}
