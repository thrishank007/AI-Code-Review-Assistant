import type { Logger } from "../logger.js";
import type { PullRequestEvent } from "../types.js";
import type { ReviewEngine } from "../review/engine.js";
import { renderFailureBody } from "../review/report.js";

const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "ready_for_review"]);

export interface EventDeps {
  engine: ReviewEngine;
  logger: Logger;
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
