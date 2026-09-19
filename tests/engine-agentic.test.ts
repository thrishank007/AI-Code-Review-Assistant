import { describe, expect, it, vi } from "vitest";
import { ReviewEngine } from "../src/review/engine.js";
import type { Env } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { GitHubClient, type OctokitLike } from "../src/github/client.js";
import type { ReviewAgent } from "../src/agent/loop.js";
import type { JevClient } from "../src/jev/client.js";
import { createFeedbackTracker, type FeedbackTracker } from "../src/feedback/tracker.js";
import { renderInlineComment } from "../src/review/report.js";
import type { Finding } from "../src/types.js";

const logger = createLogger("fatal");

const env = {
  APP_ID: 1,
  PRIVATE_KEY: "x",
  WEBHOOK_SECRET: "s",
  PORT: 3000,
  LOG_LEVEL: "fatal",
  LLM_BASE_URL: "http://x/v1",
  LLM_MODEL: "test-model",
  LLM_TIMEOUT_MS: 1000,
  LLM_MAX_TOKENS: 100,
  LLM_JSON_MODE: true,
  LLM_PROVIDER: "ai-sdk",
  MAX_FILES: 30,
  MAX_DIFF_CHARS: 120_000,
  CHECKS_ENABLED: false,
  AGENT_TOOLS_ENABLED: true,
  AGENT_MAX_STEPS: 10,
  JEV_ENABLED: true,
  JEV_CONFIDENCE_THRESHOLD: 60,
  JEV_TIMEOUT_MS: 10_000,
  FEEDBACK_ENABLED: true,
  FEEDBACK_DB_PATH: ":memory:",
} satisfies Env;

const patch = "@@ -1,3 +1,5 @@\n ctx\n+new1\n+new2\n ctx2";
const files = [
  { filename: "src/app.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch },
];

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: "src/app.ts",
  line: 2,
  severity: "warning",
  confidence: "high",
  title: "Missing await",
  body: "The call is not awaited.",
  ...over,
});

function reviewJson(findings: Finding[]): string {
  return JSON.stringify({
    summary: "Adds two lines.",
    overview: "Small change.",
    fileSummaries: [{ file: "src/app.ts", summary: "Adds two lines." }],
    findings,
  });
}

function makeGithub(over: Record<string, any> = {}) {
  // Pre-declared so every test can index into them without optional chaining.
  const calls = { createReview: [] as any[], createCheck: [] as any[] };
  const octokit: OctokitLike = {
    rest: {
      pulls: {
        listFiles: vi.fn(async () => ({ data: over.files ?? files })),
        listReviews: vi.fn(async () => ({ data: [] })),
        createReview: vi.fn(async (p: any) => {
          calls.createReview.push(p);
          return {};
        }),
        get: vi.fn(async () => ({ data: {} })),
        listReviewComments: vi.fn(async () => ({ data: over.reviewComments ?? [] })),
        getReviewComment: vi.fn(async () => ({ data: {} })),
        createReplyForReviewComment: vi.fn(async () => ({ data: {} })),
      },
      repos: {
        getContent: vi.fn(async () => ({
          data: over.repoConfigYml
            ? {
                content: Buffer.from(over.repoConfigYml).toString("base64"),
                encoding: "base64",
              }
            : null,
        })),
        listCommits: vi.fn(async () => ({ data: [] })),
      },
      search: { code: vi.fn(async () => ({ data: { items: [] } })) },
      issues: { createComment: vi.fn(async () => ({})) },
      checks: {
        create: vi.fn(async (p: any) => {
          calls.createCheck.push(p);
          return {};
        }),
      },
    },
  } as unknown as OctokitLike;
  return { github: new GitHubClient(async () => octokit), calls };
}

function stubAgent(text: string, toolCalls: string[] = []): ReviewAgent & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => ({
    text,
    steps: 2,
    toolCalls,
    exhausted: false,
  }));
  return { run } as unknown as ReviewAgent & { run: ReturnType<typeof vi.fn> };
}

/** Jev fake that answers routing, per-finding support, and severity. */
function makeJev(over: {
  complexity?: string;
  score?: number;
  noul?: number;
  severity?: string;
  severityConfidence?: number;
} = {}): JevClient & { systemOne: ReturnType<typeof vi.fn> } {
  return {
    systemOne: vi.fn(async (_state: unknown, questions: Record<string, any>) => {
      const answers: Record<string, unknown> = {};
      for (const name of Object.keys(questions)) {
        if (name === "complexity") {
          answers[name] = {
            type: "choice",
            choice: over.complexity ?? "moderate",
            confidence: 0.8,
          };
        } else if (name.startsWith("supported_")) {
          answers[name] = { type: "score", score: over.score ?? 3, confidence: 0.9 };
        } else if (name.startsWith("introduced_")) {
          answers[name] = { type: "noul", noul: over.noul ?? 0.95 };
        } else if (name.startsWith("severity_")) {
          answers[name] = {
            type: "choice",
            choice: over.severity ?? "warning",
            confidence: over.severityConfidence ?? 0.9,
          };
        }
      }
      return { model: "jev-test", answers };
    }),
  } as unknown as JevClient & { systemOne: ReturnType<typeof vi.fn> };
}

const req = {
  installationId: 42,
  owner: "owner",
  repo: "repo",
  pullNumber: 7,
  title: "PR",
  body: "b",
  headSha: "abc",
};

const llmStub = { chat: vi.fn(async () => reviewJson([])) };

describe("ReviewEngine with the agent", () => {
  it("uses the agent instead of a single chat call when tools are enabled", async () => {
    const { github, calls } = makeGithub();
    const agent = stubAgent(reviewJson([finding()]), ["read_file"]);
    const engine = new ReviewEngine(github, llmStub, env, logger, { agent });

    const outcome = await engine.reviewPullRequest(req);

    expect(outcome.status).toBe("reviewed");
    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(llmStub.chat).not.toHaveBeenCalled();
    expect(calls.createReview).toHaveLength(1);
    // the report tells the reader what context the agent pulled
    expect(calls.createReview[0]!.body).toContain("read_file×1");
  });

  it("hands the agent the PR head SHA and changed paths", async () => {
    const { github } = makeGithub();
    const agent = stubAgent(reviewJson([]));
    await new ReviewEngine(github, llmStub, env, logger, { agent }).reviewPullRequest(req);

    const [, opts] = agent.run.mock.calls[0]!;
    expect(opts.tools).toMatchObject({
      installationId: 42,
      owner: "owner",
      repo: "repo",
      headSha: "abc",
      changedPaths: ["src/app.ts"],
    });
  });

  it("falls back to the single-shot client when the provider cannot do tools", async () => {
    const { github } = makeGithub();
    const agent = stubAgent(reviewJson([]));
    const chat = vi.fn(async () => reviewJson([]));
    const engine = new ReviewEngine(
      github,
      { chat },
      { ...env, AGENT_TOOLS_ENABLED: false },
      logger,
      { agent },
    );

    await engine.reviewPullRequest(req);

    expect(agent.run).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("repairs an agent answer that failed schema validation", async () => {
    const { github, calls } = makeGithub();
    const run = vi
      .fn()
      .mockResolvedValueOnce({ text: "not json at all", steps: 1, toolCalls: [], exhausted: false })
      .mockResolvedValueOnce({ text: reviewJson([finding()]), steps: 1, toolCalls: [], exhausted: false });
    const engine = new ReviewEngine(github, llmStub, env, logger, {
      agent: { run } as unknown as ReviewAgent,
    });

    const outcome = await engine.reviewPullRequest(req);

    expect(outcome.status).toBe("reviewed");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![1].repair).toMatch(/not valid JSON/);
    expect(calls.createReview).toHaveLength(1);
  });

  it("degrades gracefully when the agent never answers", async () => {
    const { github, calls } = makeGithub();
    const engine = new ReviewEngine(github, llmStub, env, logger, {
      agent: stubAgent(""),
    });

    const outcome = await engine.reviewPullRequest(req);

    expect(outcome.status).toBe("degraded");
    expect(calls.createReview[0]!.body).toContain("did not return structured findings");
  });
});

describe("ReviewEngine with Jev", () => {
  it("records the routed complexity in the review notes", async () => {
    const { github, calls } = makeGithub();
    const jev = makeJev({ complexity: "simple" });
    const engine = new ReviewEngine(github, llmStub, env, logger, {
      agent: stubAgent(reviewJson([finding()])),
      jev,
    });

    await engine.reviewPullRequest(req);

    expect(calls.createReview[0]!.body).toContain("classified this PR as `simple`");
  });

  it("routes to the per-repo model override for that complexity", async () => {
    const { github } = makeGithub({ repoConfigYml: "models:\n  simple: cheap-model\n" });
    const agent = stubAgent(reviewJson([]));
    await new ReviewEngine(github, llmStub, env, logger, {
      agent,
      jev: makeJev({ complexity: "simple" }),
    }).reviewPullRequest(req);

    expect(agent.run.mock.calls[0]![1].model).toBe("cheap-model");
  });

  it("reports routing failures without breaking the review", async () => {
    const { github, calls } = makeGithub();
    const jev: JevClient = {
      systemOne: vi.fn(async () => {
        throw new Error("jev is down");
      }),
    };
    const engine = new ReviewEngine(github, llmStub, env, logger, {
      agent: stubAgent(reviewJson([finding()])),
      jev,
    });

    const outcome = await engine.reviewPullRequest(req);
    expect(outcome.status).toBe("reviewed");
    expect(calls.createReview).toHaveLength(1);
  });

  it("suppresses findings Jev is not confident about", async () => {
    const { github, calls } = makeGithub();
    const engine = new ReviewEngine(github, llmStub, env, logger, {
      agent: stubAgent(reviewJson([finding()])),
      jev: makeJev({ score: 1 }), // 33/100, below the default threshold of 60
    });

    const outcome = await engine.reviewPullRequest(req);

    expect(outcome.inlineComments).toHaveLength(0);
    expect(calls.createReview[0]!.body).toContain("Jev suppressed 1 finding(s)");
    expect(calls.createReview[0]!.body).toContain("No findings");
  });

  it("suppresses findings Jev judges to be pre-existing", async () => {
    const { github, calls } = makeGithub();
    const engine = new ReviewEngine(github, llmStub, env, logger, {
      agent: stubAgent(reviewJson([finding()])),
      jev: makeJev({ score: 3, noul: 0.1 }),
    });

    await engine.reviewPullRequest(req);

    expect(calls.createReview[0]!.body).toContain("judged pre-existing");
  });

  it("applies Jev's severity regrade when it disagrees confidently", async () => {
    const { github, calls } = makeGithub();
    const engine = new ReviewEngine(github, llmStub, env, logger, {
      agent: stubAgent(reviewJson([finding({ severity: "nit" })])),
      jev: makeJev({ severity: "critical", severityConfidence: 0.95 }),
    });

    await engine.reviewPullRequest(req);

    const review = calls.createReview[0]!;
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0].body).toContain("critical");
    expect(review.body).toContain("Jev re-graded the severity of 1 finding(s)");
  });

  it("keeps the model's severity when Jev is unsure of its own choice", async () => {
    const { github, calls } = makeGithub();
    const engine = new ReviewEngine(github, llmStub, env, logger, {
      agent: stubAgent(reviewJson([finding({ severity: "nit" })])),
      jev: makeJev({ severity: "critical", severityConfidence: 0.2 }),
    });

    await engine.reviewPullRequest(req);

    expect(calls.createReview[0]!.comments[0].body).toContain("nit");
  });

  it("can be disabled per repository", async () => {
    const { github, calls } = makeGithub({ repoConfigYml: "jev: false\n" });
    const jev = makeJev({ score: 0 });
    const engine = new ReviewEngine(github, llmStub, env, logger, {
      agent: stubAgent(reviewJson([finding()])),
      jev,
    });

    await engine.reviewPullRequest(req);

    expect(jev.systemOne).not.toHaveBeenCalled();
    expect(calls.createReview[0]!.comments).toHaveLength(1);
  });

  it("honours a custom confidence threshold", async () => {
    const { github, calls } = makeGithub();
    const engine = new ReviewEngine(
      github,
      llmStub,
      { ...env, JEV_CONFIDENCE_THRESHOLD: 20 },
      logger,
      { agent: stubAgent(reviewJson([finding()])), jev: makeJev({ score: 1 }) },
    );

    await engine.reviewPullRequest(req);

    expect(calls.createReview[0]!.comments).toHaveLength(1);
  });
});

describe("ReviewEngine with the feedback store", () => {
  let tracker: FeedbackTracker;

  async function withTracker(run: (t: FeedbackTracker) => Promise<void>) {
    tracker = (await createFeedbackTracker({ path: ":memory:", logger }))!;
    try {
      await run(tracker);
    } finally {
      tracker.close();
    }
  }

  it("records posted findings so replies can be attributed later", async () => {
    await withTracker(async (t) => {
      const posted = renderInlineComment(finding());
      const { github } = makeGithub({
        reviewComments: [{ id: 555, body: posted, path: "src/app.ts", line: 2, user: { login: "bot", type: "Bot" } }],
      });
      const engine = new ReviewEngine(github, llmStub, env, logger, {
        agent: stubAgent(reviewJson([finding()])),
        feedback: t,
      });

      await engine.reviewPullRequest(req);

      expect(t.findByCommentId(555)?.title).toBe("Missing await");
    });
  });

  it("injects learned preferences into the prompt", async () => {
    await withTracker(async (t) => {
      t.recordPostedFindings(
        "owner/repo",
        1,
        Array.from({ length: 6 }, (_, i) => ({ commentId: i + 1, finding: finding() })),
      );
      for (let i = 1; i <= 6; i++) t.recordSignal(i, "disputed");

      const { github } = makeGithub();
      const agent = stubAgent(reviewJson([]));
      await new ReviewEngine(github, llmStub, env, logger, { agent, feedback: t }).reviewPullRequest(req);

      const input = agent.run.mock.calls[0]![0] as any;
      expect(input.instructions).toContain("Learned from past reviews");
    });
  });

  it("does not read preferences on a dry run", async () => {
    await withTracker(async (t) => {
      const getPreferences = vi.spyOn(t, "getPreferences");
      const { github } = makeGithub();
      const agent = stubAgent(reviewJson([]));
      await new ReviewEngine(github, llmStub, env, logger, { agent, feedback: t }).reviewPullRequest(
        req,
        { dryRun: true },
      );
      expect(getPreferences).not.toHaveBeenCalled();
    });
  });
});
