import type { Logger } from "../logger.js";
import type { IssueCommentEvent, PullRequestEvent } from "../types.js";
import type { GitHubClient } from "./client.js";
import type { ReviewEngine } from "../review/engine.js";

const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "ready_for_review"]);

export interface EventDeps {
  engine: ReviewEngine;
  logger: Logger;
}

export interface IssueCommentDeps extends EventDeps {
  github: GitHubClient;
}

const REVIEW_COMMAND_RE = /^\/review\b/i;

/** True when a comment body is a `/review` re-request. */
export function isReviewCommand(body: string): boolean {
  return REVIEW_COMMAND_RE.test(body.trim());
}

/** Handle an issue_comment webhook payload for `/review`. Never throws. */
export async function handleIssueCommentEvent(
  payload: IssueCommentEvent,
  deps: IssueCommentDeps,
): Promise<void> {
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
  } catch (e) {
    deps.logger.error({ repo: repoSlug, issue: issue.number, err: e }, "Manual review failed");
    try {
      await deps.engine.reportFailure(
        installation.id,
        repository.owner.login,
        repository.name,
        issue.number,
        (e as Error).message,
      );
    } catch (commentErr) {
      deps.logger.error({ err: commentErr }, "Also failed to post failure comment");
    }
  }
}
/** Handle a pull_request webhook payload. Never throws (posts a failure comment instead). */
export async function handlePullRequestEvent(
  payload: PullRequestEvent,
  deps: EventDeps,
): Promise<void> {
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
  } catch (e) {
    deps.logger.error({ repo: repoSlug, pr: pr.number, err: e }, "Review failed");
    try {
      await deps.engine.reportFailure(
        installation.id,
        repository.owner.login,
        repository.name,
        pr.number,
        (e as Error).message,
      );
    } catch (commentErr) {
      deps.logger.error({ err: commentErr }, "Also failed to post failure comment");
    }
  }
}
