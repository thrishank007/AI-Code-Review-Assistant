import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import {
  AiSdkConversationAgent,
  ConversationEngine,
  type ConversationAgent,
} from "../src/agent/conversation.js";
import type { AgentRunResult } from "../src/agent/loop.js";
import type { GitHubClient, ReviewCommentDetail } from "../src/github/client.js";
import { createFeedbackTracker, type FeedbackTracker } from "../src/feedback/tracker.js";
import type { JevClient } from "../src/jev/client.js";
import { createLogger } from "../src/logger.js";
import { isOurInlineComment, renderInlineComment } from "../src/review/report.js";
import type { Finding } from "../src/types.js";

const logger = createLogger("fatal");

const ours = renderInlineComment({
  severity: "warning",
  confidence: "high",
  title: "Missing await",
  body: "The call is not awaited.",
});

const parent = (over: Partial<ReviewCommentDetail> = {}): ReviewCommentDetail => ({
  id: 101,
  body: ours,
  path: "src/a.ts",
  line: 3,
  user: { login: "ai-pr-reviewer[bot]", type: "Bot" },
  ...over,
});

function makeGithub(over: {
  parent?: ReviewCommentDetail | null;
  replies?: ReviewCommentDetail[];
  files?: unknown[];
} = {}) {
  const github = {
    getReviewCommentThread: vi.fn(async () => ({
      parent: over.parent === undefined ? parent() : over.parent,
      replies: over.replies ?? [],
    })),
    listPRFiles: vi.fn(async () => over.files ?? [{ filename: "src/a.ts" }]),
    replyToReviewComment: vi.fn(async () => 999),
  } as unknown as GitHubClient;
  return github;
}

function stubAgent(text: string): ConversationAgent & { reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn(async (): Promise<AgentRunResult> => ({
    text,
    steps: 2,
    toolCalls: ["read_file"],
    exhausted: false,
  }));
  return { reply } as unknown as ConversationAgent & { reply: ReturnType<typeof vi.fn> };
}

const request = {
  installationId: 42,
  owner: "o",
  repo: "r",
  pullNumber: 7,
  parentCommentId: 101,
  reply: { id: 202, body: "We handle this in the middleware.", author: "ada" },
  prTitle: "Add auth",
  headSha: "abc123",
};

describe("ConversationEngine.respond", () => {
  it("replies in the thread with the agent's answer", async () => {
    const github = makeGithub();
    const agent = stubAgent("You're right — `src/auth.ts:42` handles it. Withdrawing.");
    const engine = new ConversationEngine({ github, agent, logger });

    const outcome = await engine.respond(request);

    expect(outcome.status).toBe("replied");
    expect(github.replyToReviewComment).toHaveBeenCalledWith(
      42,
      "o",
      "r",
      7,
      101,
      "You're right — `src/auth.ts:42` handles it. Withdrawing.",
    );
    // the agent gets the finding, the thread, and the new reply
    const [input] = agent.reply.mock.calls[0]!;
    expect(input.findingComment).toBe(ours);
    expect(input.reply).toEqual({ author: "ada", body: "We handle this in the middleware." });
    expect(input.file).toBe("src/a.ts");
  });

  it("passes the PR head SHA and changed files to the agent's tools", async () => {
    const github = makeGithub({ files: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }] });
    const agent = stubAgent("ok");
    await new ConversationEngine({ github, agent, logger }).respond(request);

    const [, opts] = agent.reply.mock.calls[0]!;
    expect(opts.tools.headSha).toBe("abc123");
    expect(opts.tools.changedPaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("excludes the new reply from the thread history it passes on", async () => {
    const github = makeGithub({
      replies: [
        { id: 150, body: "earlier", path: "src/a.ts", line: 3, user: { login: "bob" } },
        { id: 202, body: "the new one", path: "src/a.ts", line: 3, user: { login: "ada" } },
      ],
    });
    const agent = stubAgent("ok");
    await new ConversationEngine({ github, agent, logger }).respond(request);

    const [input] = agent.reply.mock.calls[0]!;
    expect(input.thread).toEqual([{ author: "bob", body: "earlier" }]);
  });

  it("skips when the parent comment is gone", async () => {
    const github = makeGithub({ parent: null });
    const agent = stubAgent("ok");
    const outcome = await new ConversationEngine({ github, agent, logger }).respond(request);

    expect(outcome).toEqual({ status: "skipped", reason: "parent-missing" });
    expect(agent.reply).not.toHaveBeenCalled();
    expect(github.replyToReviewComment).not.toHaveBeenCalled();
  });

  it("skips when the agent produces nothing", async () => {
    const github = makeGithub();
    const outcome = await new ConversationEngine({
      github,
      agent: stubAgent("   "),
      logger,
    }).respond(request);

    expect(outcome).toEqual({ status: "skipped", reason: "empty-reply" });
    expect(github.replyToReviewComment).not.toHaveBeenCalled();
  });

  it("still works when the PR file list fails", async () => {
    const github = makeGithub();
    (github as any).listPRFiles = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const agent = stubAgent("ok");

    expect((await new ConversationEngine({ github, agent, logger }).respond(request)).status).toBe(
      "replied",
    );
    const [, opts] = agent.reply.mock.calls[0]!;
    expect(opts.tools.changedPaths).toEqual([]);
  });

  describe("feedback signals", () => {
    const finding: Finding = {
      file: "src/a.ts",
      line: 3,
      severity: "warning",
      confidence: "high",
      title: "Missing await",
      body: "The call is not awaited.",
    };

    async function withTracker(
      tracker: FeedbackTracker,
      jev: JevClient | null,
      github = makeGithub(),
    ) {
      tracker.recordPostedFindings("o/r", 7, [{ commentId: 101, finding }]);
      const engine = new ConversationEngine({ github, agent: stubAgent("ok"), logger, jev, feedback: tracker });
      await engine.respond(request);
      return tracker;
    }

    it("records a dispute when Jev reads the reply that way", async () => {
      const tracker = (await createFeedbackTracker({ path: ":memory:", logger }))!;
      try {
        const jev: JevClient = {
          systemOne: async () => ({
            model: "jev",
            answers: {
              disputes: { type: "noul", noul: 0.92 },
              acknowledges: { type: "noul", noul: 0.05 },
              asks_question: { type: "noul", noul: 0.2 },
            },
          }),
        };
        await withTracker(tracker, jev);
        expect(tracker.getPreferences("o/r").bySeverity.warning?.disputed).toBe(1);
      } finally {
        tracker.close();
      }
    });

    it("records agreement when the developer accepts the finding", async () => {
      const tracker = (await createFeedbackTracker({ path: ":memory:", logger }))!;
      try {
        const jev: JevClient = {
          systemOne: async () => ({
            model: "jev",
            answers: {
              disputes: { type: "noul", noul: 0.1 },
              acknowledges: { type: "noul", noul: 0.9 },
              asks_question: { type: "noul", noul: 0.1 },
            },
          }),
        };
        await withTracker(tracker, jev);
        expect(tracker.getPreferences("o/r").bySeverity.warning?.agreed).toBe(1);
      } finally {
        tracker.close();
      }
    });

    it("records nothing when the reply is inconclusive", async () => {
      const tracker = (await createFeedbackTracker({ path: ":memory:", logger }))!;
      try {
        const jev: JevClient = {
          systemOne: async () => ({
            model: "jev",
            answers: {
              disputes: { type: "noul", noul: 0.5 },
              acknowledges: { type: "noul", noul: 0.5 },
              asks_question: { type: "noul", noul: 0.9 },
            },
          }),
        };
        await withTracker(tracker, jev);
        const stats = tracker.getPreferences("o/r").bySeverity.warning!;
        expect(stats.disputed).toBe(0);
        expect(stats.agreed).toBe(0);
      } finally {
        tracker.close();
      }
    });

    it("records nothing without Jev, and never fails the reply", async () => {
      const tracker = (await createFeedbackTracker({ path: ":memory:", logger }))!;
      try {
        await withTracker(tracker, null);
        expect(tracker.getPreferences("o/r").bySeverity.warning?.disputed).toBe(0);
      } finally {
        tracker.close();
      }
    });

    it("ignores replies to comments it never posted", async () => {
      const tracker = (await createFeedbackTracker({ path: ":memory:", logger }))!;
      try {
        const jevCalls = vi.fn();
        const jev: JevClient = {
          systemOne: async () => {
            jevCalls();
            return { model: "jev", answers: {} };
          },
        };
        const engine = new ConversationEngine({
          github: makeGithub(),
          agent: stubAgent("ok"),
          logger,
          jev,
          feedback: tracker,
        });
        await engine.respond(request);
        expect(jevCalls).not.toHaveBeenCalled();
      } finally {
        tracker.close();
      }
    });
  });
});

const mockUsage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
  totalTokens: 10,
};

describe("AiSdkConversationAgent", () => {
  it("asks for prose, not JSON, and returns the model's reply", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text" as const, text: "Verified in src/middleware/auth.ts:42." }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: mockUsage,
        warnings: [],
      },
    });
    const agent = new AiSdkConversationAgent(
      {
        baseURL: "http://llm.local/v1",
        apiKey: "k",
        model: "m",
        timeoutMs: 5_000,
        maxTokens: 128,
        // json mode is on globally, but a reply must still be prose
        jsonMode: true,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      },
      { logger, maxSteps: 3, modelFactory: () => model },
    );

    const result = await agent.reply(
      {
        prTitle: "Add auth",
        findingComment: ours,
        thread: [],
        reply: { author: "ada", body: "middleware handles it" },
        file: "src/a.ts",
        line: 3,
      },
      {
        tools: {
          github: { getFileContent: vi.fn(async () => "code") } as unknown as GitHubClient,
          installationId: 1,
          owner: "o",
          repo: "r",
          headSha: "sha",
          changedPaths: ["src/a.ts"],
        },
      },
    );

    expect(result.text).toBe("Verified in src/middleware/auth.ts:42.");
    const prompt = JSON.stringify((model.doGenerateCalls[0] as any).prompt);
    expect(prompt).toContain("technical conversation");
    expect(prompt).toContain("middleware handles it");
    // prose mode: the review JSON contract must not be requested here
    expect(prompt).not.toContain("Return ONLY one valid JSON object");
  });
});

describe("isOurInlineComment", () => {
  it("recognizes our findings and rejects everything else", () => {
    expect(isOurInlineComment(ours)).toBe(true);
    expect(isOurInlineComment("**🔴 critical · high — Auth bypass**")).toBe(true);
    expect(isOurInlineComment("Thanks, fixed!")).toBe(false);
    expect(isOurInlineComment("")).toBe(false);
  });
});
