import { describe, expect, it, vi } from "vitest";
import { handleIssueCommentEvent, handlePullRequestEvent, isReviewCommand } from "../src/github/events.js";
import type { ReviewEngine } from "../src/review/engine.js";
import type { GitHubClient } from "../src/github/client.js";
import { createLogger } from "../src/logger.js";
import type { IssueCommentEvent, PullRequestEvent } from "../src/types.js";

const logger = createLogger("fatal");

function payload(over: Partial<PullRequestEvent["pull_request"]> = {}, action = "opened"): PullRequestEvent {
  return {
    action,
    installation: { id: 42 },
    repository: { name: "repo", owner: { login: "owner" } },
    pull_request: {
      number: 7,
      title: "A PR",
      body: "desc",
      draft: false,
      head: { sha: "abc123" },
      ...over,
    },
  };
}

function deps(engine: Partial<ReviewEngine>): { engine: ReviewEngine; logger: typeof logger } {
  return { engine: engine as ReviewEngine, logger };
}

describe("handlePullRequestEvent", () => {
  it("reviews opened, synchronize, and ready_for_review PRs", async () => {
    for (const action of ["opened", "synchronize", "ready_for_review"]) {
      const review = vi.fn().mockResolvedValue(undefined);
      await handlePullRequestEvent(payload({}, action), deps({ reviewPullRequest: review as any, reportFailure: vi.fn() as any }));
      expect(review).toHaveBeenCalledTimes(1);
      expect((review.mock.calls[0]![0] as any).pullNumber).toBe(7);
    }
  });

  it("ignores other actions", async () => {
    const review = vi.fn();
    await handlePullRequestEvent(payload({}, "labeled"), deps({ reviewPullRequest: review as any, reportFailure: vi.fn() as any }));
    await handlePullRequestEvent(payload({}, "closed"), deps({ reviewPullRequest: review as any, reportFailure: vi.fn() as any }));
    expect(review).not.toHaveBeenCalled();
  });

  it("skips drafts", async () => {
    const review = vi.fn();
    await handlePullRequestEvent(payload({ draft: true }), deps({ reviewPullRequest: review as any, reportFailure: vi.fn() as any }));
    expect(review).not.toHaveBeenCalled();
  });

  it("skips events without an installation", async () => {
    const review = vi.fn();
    const p = payload();
    delete (p as any).installation;
    await handlePullRequestEvent(p, deps({ reviewPullRequest: review as any, reportFailure: vi.fn() as any }));
    expect(review).not.toHaveBeenCalled();
  });

  it("posts a failure comment when the engine throws", async () => {
    const reportFailure = vi.fn().mockResolvedValue(undefined);
    await handlePullRequestEvent(
      payload(),
      deps({
        reviewPullRequest: vi.fn().mockRejectedValue(new Error("LLM down")) as any,
        reportFailure: reportFailure as any,
      }),
    );
    expect(reportFailure).toHaveBeenCalledWith(42, "owner", "repo", 7, "LLM down");
  });

  it("does not throw when even the failure comment fails", async () => {
    await expect(
      handlePullRequestEvent(
        payload(),
        deps({
          reviewPullRequest: vi.fn().mockRejectedValue(new Error("x")) as any,
          reportFailure: vi.fn().mockRejectedValue(new Error("also broken")) as any,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("isReviewCommand", () => {
  it("matches /review with any suffix casing", () => {
    expect(isReviewCommand("/review")).toBe(true);
    expect(isReviewCommand("/Review please")).toBe(true);
    expect(isReviewCommand("  /review now  ")).toBe(true);
    expect(isReviewCommand("/reviewed")).toBe(false);
    expect(isReviewCommand("please review")).toBe(false);
    expect(isReviewCommand("")).toBe(false);
  });
});

describe("handleIssueCommentEvent", () => {
  function commentPayload(over: Partial<IssueCommentEvent> = {}): IssueCommentEvent {
    return {
      action: "created",
      installation: { id: 42 },
      repository: { name: "repo", owner: { login: "owner" } },
      issue: { number: 7, pull_request: {} },
      comment: { body: "/review", user: { login: "alice", type: "User" } },
      ...over,
    };
  }

  function commentDeps(over: Record<string, any> = {}) {
    return {
      engine: {
        reviewPullRequest: vi.fn().mockResolvedValue(undefined),
        reportFailure: vi.fn().mockResolvedValue(undefined),
        ...over.engine,
      } as unknown as ReviewEngine,
      github: {
        getPullRequest: vi.fn().mockResolvedValue({
          number: 7,
          title: "A PR",
          body: "desc",
          draft: false,
          headSha: "abc123",
        }),
        ...over.github,
      } as unknown as GitHubClient,
      logger,
    };
  }

  it("triggers a forced review on /review PR comments", async () => {
    const deps = commentDeps();
    await handleIssueCommentEvent(commentPayload(), deps);
    expect(deps.github.getPullRequest).toHaveBeenCalledWith(42, "owner", "repo", 7);
    expect(deps.engine.reviewPullRequest).toHaveBeenCalledTimes(1);
    const [req, opts] = (deps.engine.reviewPullRequest as any).mock.calls[0];
    expect(req.pullNumber).toBe(7);
    expect(req.headSha).toBe("abc123");
    expect(opts).toEqual({ force: true });
  });

  it("ignores non-created actions, non-PR issues, bots, and non-commands", async () => {
    const deps = commentDeps();
    await handleIssueCommentEvent(commentPayload({ action: "edited" }), deps);
    await handleIssueCommentEvent(commentPayload({ issue: { number: 7 } }), deps);
    await handleIssueCommentEvent(
      commentPayload({ comment: { body: "/review", user: { login: "bot", type: "Bot" } } }),
      deps,
    );
    await handleIssueCommentEvent(
      commentPayload({ comment: { body: "looks good", user: { login: "alice", type: "User" } } }),
      deps,
    );
    expect(deps.engine.reviewPullRequest).not.toHaveBeenCalled();
  });

  it("skips events without an installation", async () => {
    const deps = commentDeps();
    const p = commentPayload();
    delete (p as any).installation;
    await handleIssueCommentEvent(p, deps);
    expect(deps.engine.reviewPullRequest).not.toHaveBeenCalled();
  });

  it("posts a failure comment when getPullRequest or review throws", async () => {
    const deps = commentDeps({ github: { getPullRequest: vi.fn().mockRejectedValue(new Error("no PR")) } });
    await handleIssueCommentEvent(commentPayload(), deps);
    expect(deps.engine.reportFailure).toHaveBeenCalledWith(42, "owner", "repo", 7, "no PR");
  });
});
