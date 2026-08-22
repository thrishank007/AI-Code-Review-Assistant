import { describe, expect, it, vi } from "vitest";
import { ReviewEngine } from "../src/review/engine.js";
import type { Env } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { GitHubClient, type OctokitLike, type ReviewComment } from "../src/github/client.js";
import type { LLMClient } from "../src/llm/client.js";
import { REVIEW_MARKER } from "../src/review/report.js";

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
  MAX_FILES: 30,
  MAX_DIFF_CHARS: 120_000,
} satisfies Env;

const patch = "@@ -1,3 +1,5 @@\n ctx\n+new1\n+new2\n ctx2";

const files = [
  { filename: "src/app.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch },
  { filename: "package-lock.json", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -1,1 +1,2 @@\n x\n+y" },
];

const goodLLMJson = JSON.stringify({
  summary: "Adds two lines.",
  findings: [
    { file: "src/app.ts", line: 2, severity: "warning", category: "bug", title: "T1", body: "B1" },
    { file: "src/app.ts", line: 999, severity: "nit", category: "style", title: "T2", body: "B2" },
    { file: "not/in-diff.ts", line: 1, severity: "critical", category: "bug", title: "T3", body: "B3" },
  ],
});

function makeGithub(overrides: Record<string, any> = {}) {
  const calls: Record<string, any[]> = {};
  const octokit: OctokitLike = {
    rest: {
      pulls: {
        listFiles: vi.fn(async () => ({ data: overrides.files ?? files })),
        listReviews: vi.fn(async () => ({ data: overrides.reviews ?? [] })),
        createReview: vi.fn(async (p: any) => {
          (calls.createReview ??= []).push(p);
        }),
      },
      repos: {
        getContent: vi.fn(async () => ({
          data: overrides.repoConfigYml
            ? { content: Buffer.from(overrides.repoConfigYml).toString("base64"), encoding: "base64" }
            : null,
        })),
      },
      issues: {
        createComment: vi.fn(async (p: any) => {
          (calls.createComment ??= []).push(p);
        }),
      },
    },
  } as unknown as OctokitLike;
  const github = new GitHubClient(async () => octokit);
  return { github, calls, octokit };
}

function makeLLM(responses: string[]) {
  let i = 0;
  const chat = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);
  return { llm: { chat } as unknown as LLMClient, chat };
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

describe("ReviewEngine.reviewPullRequest", () => {
  it("runs the full happy path: dedupe check, filter, LLM, clamp, submit", async () => {
    const { github, calls } = makeGithub();
    const { llm, chat } = makeLLM([goodLLMJson]);
    const engine = new ReviewEngine(github, llm, env, logger);

    const outcome = await engine.reviewPullRequest(req);

    expect(outcome.status).toBe("reviewed");
    expect(chat).toHaveBeenCalledTimes(1);
    // lockfile filtered out of the prompt
    const prompt = (chat.mock.calls[0]![0] as any[])[1].content as string;
    expect(prompt).toContain("src/app.ts");
    expect(prompt).not.toContain("package-lock.json");

    expect(calls.createReview).toHaveLength(1);
    const review = calls.createReview[0]!;
    expect(review.event).toBe("COMMENT");
    expect(review.body.startsWith(REVIEW_MARKER)).toBe(true);
    expect(review.body).toContain("Adds two lines.");
    // line 999 clamped into the hunk; not-in-diff finding moved to summary
    expect(review.comments).toHaveLength(2);
    expect(review.comments.map((c: ReviewComment) => c.line).sort()).toEqual([2, 4]);
    expect(review.body).toContain("not/in-diff.ts");
  });

  it("skips when the head SHA was already reviewed", async () => {
    const { github, calls } = makeGithub({
      reviews: [{ commit_id: "abc", body: `${REVIEW_MARKER} old review` }],
    });
    const { llm, chat } = makeLLM([goodLLMJson]);
    const engine = new ReviewEngine(github, llm, env, logger);

    const outcome = await engine.reviewPullRequest(req);
    expect(outcome.status).toBe("skipped-duplicate");
    expect(chat).not.toHaveBeenCalled();
    expect(calls.createReview).toBeUndefined();
  });

  it("skips when all files are filtered out", async () => {
    const { github } = makeGithub({
      files: [files[1]!], // only the lockfile
    });
    const { llm, chat } = makeLLM([goodLLMJson]);
    const engine = new ReviewEngine(github, llm, env, logger);

    expect((await engine.reviewPullRequest(req)).status).toBe("skipped-empty");
    expect(chat).not.toHaveBeenCalled();
  });

  it("retries once on unparseable JSON, then succeeds", async () => {
    const { github, calls } = makeGithub();
    const { llm, chat } = makeLLM(["sure looks fine to me!", goodLLMJson]);
    const engine = new ReviewEngine(github, llm, env, logger);

    const outcome = await engine.reviewPullRequest(req);
    expect(outcome.status).toBe("reviewed");
    expect(chat).toHaveBeenCalledTimes(2);
    // second call includes the correction exchange
    const second = chat.mock.calls[1]![0] as any[];
    expect(second.some((m) => m.role === "assistant")).toBe(true);
    expect(calls.createReview).toHaveLength(1);
  });

  it("degrades to a raw-text review when JSON never parses", async () => {
    const { github, calls } = makeGithub();
    const { llm } = makeLLM(["just prose", "still prose"]);
    const engine = new ReviewEngine(github, llm, env, logger);

    const outcome = await engine.reviewPullRequest(req);
    expect(outcome.status).toBe("degraded");
    expect(outcome.inlineComments).toHaveLength(0);
    expect(calls.createReview).toHaveLength(1);
    // the degraded body carries the retried (final) raw response
    expect(calls.createReview[0]!.body).toContain("still prose");
  });

  it("applies repo config: severities filter + instructions + custom ignores", async () => {
    const { github } = makeGithub({
      repoConfigYml: "severities: [critical]\ninstructions: 'flag X'\nignore: ['src/app.ts']",
    });
    const { llm, chat } = makeLLM([goodLLMJson]);
    const engine = new ReviewEngine(github, llm, env, logger);

    const outcome = await engine.reviewPullRequest(req);
    // src/app.ts ignored -> no placeable files at all -> empty skip
    expect(outcome.status).toBe("skipped-empty");
    expect(chat).not.toHaveBeenCalled();
  });

  it("dry run renders but never posts", async () => {
    const { github, calls } = makeGithub();
    const { llm } = makeLLM([goodLLMJson]);
    const engine = new ReviewEngine(github, llm, env, logger);

    const outcome = await engine.reviewPullRequest(req, { dryRun: true });
    expect(outcome.status).toBe("reviewed");
    expect(outcome.inlineComments).toHaveLength(2);
    expect(calls.createReview).toBeUndefined();
  });

  it("reportFailure posts an issue comment", async () => {
    const { github, calls } = makeGithub();
    const engine = new ReviewEngine(github, makeLLM([""]).llm, env, logger);
    await engine.reportFailure(42, "owner", "repo", 7, "boom");
    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]!.body).toContain("boom");
  });
});
