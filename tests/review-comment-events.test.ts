import { describe, expect, it, vi } from "vitest";
import { handleReviewCommentEvent } from "../src/github/events.js";
import type { ConversationEngine } from "../src/agent/conversation.js";
import type { GitHubClient, ReviewCommentDetail } from "../src/github/client.js";
import { createLogger } from "../src/logger.js";
import { renderInlineComment } from "../src/review/report.js";
import type { ReviewCommentEvent } from "../src/types.js";

const logger = createLogger("fatal");

const oursBody = renderInlineComment({
  severity: "warning",
  confidence: "high",
  title: "Missing await",
  body: "The call is not awaited.",
});

function payload(over: {
  comment?: Partial<ReviewCommentEvent["comment"]>;
  action?: string;
  installation?: boolean;
} = {}): ReviewCommentEvent {
  const event: ReviewCommentEvent = {
    action: over.action ?? "created",
    repository: { name: "repo", owner: { login: "owner" } },
    pull_request: { number: 7, title: "Add auth", body: "d", head: { sha: "abc123" } },
    comment: {
      id: 202,
      body: "We already handle this in the middleware.",
      path: "src/a.ts",
      line: 3,
      user: { login: "ada", type: "User" },
      in_reply_to_id: 101,
      ...over.comment,
    },
  };
  if (over.installation !== false) event.installation = { id: 42 };
  return event;
}

const ourParent: ReviewCommentDetail = {
  id: 101,
  body: oursBody,
  path: "src/a.ts",
  line: 3,
  user: { login: "ai-pr-reviewer[bot]", type: "Bot" },
};

function deps(over: {
  parent?: ReviewCommentDetail | null;
  conversation?: Partial<ConversationEngine> | undefined;
} = {}) {
  const github = {
    getReviewComment: vi.fn(async () => (over.parent === undefined ? ourParent : over.parent)),
  } as unknown as GitHubClient;
  const conversation = {
    respond: vi.fn(async () => ({ status: "replied" as const })),
    ...over.conversation,
  } as unknown as ConversationEngine;
  return { engine: {} as never, github, logger, conversation };
}

describe("handleReviewCommentEvent", () => {
  it("routes a reply on one of our findings to the conversation engine", async () => {
    const d = deps();
    await handleReviewCommentEvent(payload(), d as any);

    expect(d.github.getReviewComment).toHaveBeenCalledWith(42, "owner", "repo", 101);
    expect((d.conversation as any).respond).toHaveBeenCalledWith({
      installationId: 42,
      owner: "owner",
      repo: "repo",
      pullNumber: 7,
      parentCommentId: 101,
      reply: { id: 202, body: "We already handle this in the middleware.", author: "ada" },
      prTitle: "Add auth",
      headSha: "abc123",
    });
  });

  it("ignores top-level review comments (no reply target)", async () => {
    const d = deps();
    const p = payload();
    delete (p.comment as any).in_reply_to_id;
    await handleReviewCommentEvent(p, d as any);
    expect((d.conversation as any).respond).not.toHaveBeenCalled();
  });

  it("ignores edits, bot authors, and other actions", async () => {
    const d = deps();
    await handleReviewCommentEvent(payload({ action: "edited" }), d as any);
    await handleReviewCommentEvent(
      payload({ comment: { user: { login: "bot", type: "Bot" } } }),
      d as any,
    );
    expect((d.conversation as any).respond).not.toHaveBeenCalled();
  });

  it("ignores /review commands typed into a thread", async () => {
    const d = deps();
    await handleReviewCommentEvent(payload({ comment: { body: "/review please" } }), d as any);
    expect((d.conversation as any).respond).not.toHaveBeenCalled();
  });

  it("ignores replies to comments that are not ours", async () => {
    const d = deps({
      parent: { ...ourParent, body: "A human wrote this", user: { login: "bob", type: "User" } },
    });
    await handleReviewCommentEvent(payload(), d as any);
    expect((d.conversation as any).respond).not.toHaveBeenCalled();
  });

  it("ignores replies whose parent comment is gone", async () => {
    const d = deps({ parent: null });
    await handleReviewCommentEvent(payload(), d as any);
    expect((d.conversation as any).respond).not.toHaveBeenCalled();
  });

  it("ignores everything when no conversation engine is wired", async () => {
    const d = deps();
    await handleReviewCommentEvent(payload(), {
      engine: {} as never,
      github: d.github,
      logger,
    });
    expect(d.github.getReviewComment).not.toHaveBeenCalled();
  });

  it("skips events without an installation", async () => {
    const d = deps();
    await handleReviewCommentEvent(payload({ installation: false }), d as any);
    expect(d.github.getReviewComment).not.toHaveBeenCalled();
  });

  it("never throws when the conversation engine fails", async () => {
    const d = deps({
      conversation: {
        respond: vi.fn(async () => {
          throw new Error("agent exploded");
        }),
      } as any,
    });
    await expect(handleReviewCommentEvent(payload(), d as any)).resolves.toBeUndefined();
  });
});
