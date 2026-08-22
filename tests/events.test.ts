import { describe, expect, it, vi } from "vitest";
import { handlePullRequestEvent } from "../src/github/events.js";
import type { ReviewEngine } from "../src/review/engine.js";
import { createLogger } from "../src/logger.js";
import type { PullRequestEvent } from "../src/types.js";

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
