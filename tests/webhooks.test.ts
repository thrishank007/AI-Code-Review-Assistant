import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dispatchWebhookEvent, verifyWebhookSignature } from "../src/github/webhooks.js";
import { createLogger } from "../src/logger.js";
import type { PullRequestEvent } from "../src/types.js";

const secret = "whsec";
const logger = createLogger("fatal");

function sign(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ action: "opened" });

  it("accepts a correctly signed payload", () => {
    expect(verifyWebhookSignature(Buffer.from(body), sign(body), secret)).toBe(true);
  });

  it("rejects missing, malformed, or wrong signatures", () => {
    expect(verifyWebhookSignature(Buffer.from(body), undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), "sha256=zz", secret)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), sign("tampered"), secret)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), "md5=abc", secret)).toBe(false);
  });

  it("rejects a signature signed with a different secret", () => {
    const other = `sha256=${createHmac("sha256", "other").update(body).digest("hex")}`;
    expect(verifyWebhookSignature(Buffer.from(body), other, secret)).toBe(false);
  });
});

describe("dispatchWebhookEvent", () => {
  const payload = {
    action: "opened",
    installation: { id: 42 },
    repository: { name: "r", owner: { login: "o" } },
    pull_request: { number: 7, title: "t", body: null, draft: false, head: { sha: "abc" } },
  } satisfies PullRequestEvent;

  it("routes pull_request events to the handler", async () => {
    let called = 0;
    await dispatchWebhookEvent("pull_request", payload, {
      onPullRequest: async () => {
        called++;
      },
      logger,
    });
    expect(called).toBe(1);
  });

  it("ignores ping and unknown events without calling the handler", async () => {
    let called = 0;
    const deps = {
      onPullRequest: async () => {
        called++;
      },
      logger,
    };
    await dispatchWebhookEvent("ping", { zen: "x" }, deps);
    await dispatchWebhookEvent("push", {}, deps);
    expect(called).toBe(0);
  });

  it("never throws even when the handler explodes", async () => {
    await expect(
      dispatchWebhookEvent("pull_request", payload, {
        onPullRequest: async () => {
          throw new Error("boom");
        },
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("routes issue_comment events to the issue-comment handler", async () => {
    let called = 0;
    await dispatchWebhookEvent(
      "issue_comment",
      { action: "created", comment: { body: "/review" } },
      {
        onPullRequest: async () => {},
        onIssueComment: async () => {
          called++;
        },
        logger,
      },
    );
    expect(called).toBe(1);
  });

  it("ignores issue_comment when no handler is wired", async () => {
    await expect(
      dispatchWebhookEvent("issue_comment", { action: "created" }, {
        onPullRequest: async () => {},
        logger,
      }),
    ).resolves.toBeUndefined();
  });
});
