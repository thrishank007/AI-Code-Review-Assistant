import { describe, expect, it, vi } from "vitest";
import { GitHubClient, type OctokitLike } from "../src/github/client.js";

function makeOctokit(overrides: Partial<Record<string, unknown>> = {}): OctokitLike {
  return {
    rest: {
      pulls: {
        listFiles: vi.fn(overrides.listFiles as any ?? (() => ({ data: [] }))),
        listReviews: vi.fn(overrides.listReviews as any ?? (() => ({ data: [] }))),
        createReview: vi.fn(overrides.createReview as any ?? (async () => ({}))),
      },
      repos: {
        getContent: vi.fn(overrides.getContent as any ?? (async () => ({ data: null }))),
      },
      issues: {
        createComment: vi.fn(overrides.createComment as any ?? (async () => ({}))),
      },
    },
  } as unknown as OctokitLike;
}

function clientFor(oktokit: OctokitLike): GitHubClient {
  const client = new GitHubClient(async (installationId) => {
    if (installationId !== 42) throw new Error("unknown installation");
    return oktokit;
  });
  return client;
}

describe("GitHubClient", () => {
  it("paginates listPRFiles until a short page", async () => {
    const oktokit = makeOctokit({
      listFiles: vi
        .fn()
        .mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}` })) })
        .mockResolvedValueOnce({ data: [{ filename: "last" }] }),
    });
    const files = await clientFor(oktokit).listPRFiles(42, "o", "r", 1);
    expect(files).toHaveLength(101);
    expect(oktokit.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
    expect((oktokit.rest.pulls.listFiles as any).mock.calls[1][0].page).toBe(2);
  });

  it("returns null when the repo config file 404s", async () => {
    const err = Object.assign(new Error("not found"), { status: 404 });
    const oktokit = makeOctokit({ getContent: vi.fn().mockRejectedValue(err) });
    expect(await clientFor(oktokit).getFileContent(42, "o", "r", ".aireview.yml", "sha")).toBeNull();
  });

  it("rethrows non-404 content errors", async () => {
    const oktokit = makeOctokit({ getContent: vi.fn().mockRejectedValue(new Error("500")) });
    await expect(clientFor(oktokit).getFileContent(42, "o", "r", "x", "sha")).rejects.toThrow(/500/);
  });

  it("decodes base64 file content", async () => {
    const oktokit = makeOctokit({
      getContent: vi.fn().mockResolvedValue({
        data: { content: Buffer.from("ignore: [a]").toString("base64"), encoding: "base64" },
      }),
    });
    expect(await clientFor(oktokit).getFileContent(42, "o", "r", "x", "sha")).toBe("ignore: [a]");
  });

  it("detects an existing review on the head SHA only via our marker", async () => {
    const oktokit = makeOctokit({
      listReviews: vi.fn().mockResolvedValue({
        data: [
          { commit_id: "other-sha", body: "<!-- ai-pr-reviewer -->" },
          { commit_id: "abc", body: "human review, no marker" },
          { commit_id: "abc", body: "<!-- ai-pr-reviewer --> old" },
        ],
      }),
    });
    expect(await clientFor(oktokit).hasReviewedHead(42, "o", "r", 1, "abc")).toBe(true);
    expect(await clientFor(oktokit).hasReviewedHead(42, "o", "r", 1, "zzz")).toBe(false);
  });

  it("submits reviews as COMMENT with RIGHT-side inline comments", async () => {
    const createReview = vi.fn().mockResolvedValue({});
    const oktokit = makeOctokit({ createReview });
    await clientFor(oktokit).submitReview(42, "o", "r", 7, "body", [
      { path: "a.ts", line: 3, body: "comment" },
    ]);
    expect(createReview).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 7,
      event: "COMMENT",
      body: "body",
      comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "comment" }],
    });
  });

  it("rejects calls for unknown installations", async () => {
    await expect(clientFor(makeOctokit()).listPRFiles(99, "o", "r", 1)).rejects.toThrow(
      /unknown installation/,
    );
  });
});
