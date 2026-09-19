import { describe, expect, it, vi } from "vitest";
import { createReviewTools, type AgentToolContext } from "../src/agent/tools.js";
import type { GitHubClient } from "../src/github/client.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("fatal");

/** Call a tool's execute function directly — no model, no network. */
async function run(tools: ReturnType<typeof createReviewTools>, name: keyof typeof tools, input: unknown) {
  return (tools[name] as any).execute(input, { toolCallId: "1", messages: [] });
}

function makeContext(overrides: {
  github?: Partial<Record<string, unknown>>;
  maxToolCalls?: number;
  onToolCall?: (name: string, input: unknown) => void;
} = {}) {
  const github = {
    getFileContent: vi.fn(async (_i: number, _o: string, _r: string, path: string) =>
      path === "README.md" ? "# Readme" : path === "CONTRIBUTING.md" ? "Be nice" : null,
    ),
    listDirectory: vi.fn(async () => [
      { name: "src", path: "src", type: "dir" as const },
      { name: "index.ts", path: "index.ts", type: "file" as const, size: 42 },
    ]),
    searchCode: vi.fn(async () => [{ path: "src/a.ts", excerpt: "export const x = 1" }]),
    listFileCommits: vi.fn(async () => [
      { sha: "abc1234", message: "fix thing", author: "Ada", date: "2026-01-01" },
    ]),
    ...overrides.github,
  } as unknown as GitHubClient;

  const budget = { used: 0 };
  const ctx: AgentToolContext = {
    github,
    logger,
    installationId: 42,
    owner: "o",
    repo: "r",
    headSha: "deadbeef",
    changedPaths: ["src/a.ts"],
    maxToolCalls: overrides.maxToolCalls ?? 10,
    budget,
    ...(overrides.onToolCall ? { onToolCall: overrides.onToolCall } : {}),
  };
  return { tools: createReviewTools(ctx), github, budget };
}

describe("read_file", () => {
  it("returns the file with line numbers and reads at the PR head SHA", async () => {
    const { tools, github } = makeContext({
      github: { getFileContent: vi.fn(async () => "alpha\nbeta") },
    });

    const out = (await run(tools, "read_file", { path: "src/a.ts" })) as string;

    expect(out).toContain("1 | alpha");
    expect(out).toContain("2 | beta");
    expect(out).toContain("changed by this PR");
    expect((github.getFileContent as any).mock.calls[0]!.slice(3)).toEqual(["src/a.ts", "deadbeef"]);
  });

  it("marks unchanged files as context only", async () => {
    const { tools } = makeContext({
      github: { getFileContent: vi.fn(async () => "x") },
    });
    const out = (await run(tools, "read_file", { path: "src/other.ts" })) as string;
    expect(out).toContain("unchanged by this PR");
  });

  it("explains a missing file instead of throwing", async () => {
    const { tools } = makeContext({ github: { getFileContent: vi.fn(async () => null) } });
    const out = (await run(tools, "read_file", { path: "nope.ts" })) as string;
    expect(out).toContain("File not found");
  });
});

describe("other tools", () => {
  it("lists directories with types", async () => {
    const { tools } = makeContext();
    const out = (await run(tools, "list_directory", { path: "src" })) as string;
    expect(out).toContain("dir  src");
    expect(out).toContain("file src/index.ts".replace("src/index.ts", "index.ts"));
  });

  it("searches code and reports no matches cleanly", async () => {
    const { tools: t1 } = makeContext();
    expect((await run(t1, "search_code", { query: "export const" })) as string).toContain("src/a.ts");

    const { tools: t2 } = makeContext({ github: { searchCode: vi.fn(async () => []) } });
    expect((await run(t2, "search_code", { query: "zzz" })) as string).toContain("No matches");
  });

  it("summarizes file history", async () => {
    const { tools } = makeContext();
    const out = (await run(tools, "get_file_history", { path: "src/a.ts" })) as string;
    expect(out).toContain("abc1234");
    expect(out).toContain("fix thing");
  });

  it("aggregates convention files that exist", async () => {
    const { tools } = makeContext();
    const out = (await run(tools, "read_repo_conventions", {})) as string;
    expect(out).toContain("----- README.md -----");
    expect(out).toContain("----- CONTRIBUTING.md -----");
    expect(out).not.toContain("AGENTS.md");
  });

  it("says so when there are no convention files", async () => {
    const { tools } = makeContext({ github: { getFileContent: vi.fn(async () => null) } });
    expect((await run(tools, "read_repo_conventions", {})) as string).toContain("No convention files");
  });
});

describe("tool budget", () => {
  it("counts every call against the shared budget", async () => {
    const onToolCall = vi.fn();
    const { tools, budget } = makeContext({ maxToolCalls: 2, onToolCall });

    await run(tools, "list_directory", { path: "src" });
    await run(tools, "search_code", { query: "x" });

    expect(budget.used).toBe(2);
    expect(onToolCall.mock.calls.map((c) => c[0])).toEqual(["list_directory", "search_code"]);
  });

  it("refuses calls past the ceiling with a message the model can act on", async () => {
    const { tools } = makeContext({ maxToolCalls: 1 });
    await run(tools, "list_directory", { path: "src" });

    await expect(run(tools, "search_code", { query: "x" })).rejects.toThrow(/budget exhausted/i);
  });
});

describe("tool failures", () => {
  it("turns a GitHub error into a tool result instead of crashing the loop", async () => {
    const { tools } = makeContext({
      github: { getFileContent: vi.fn(async () => { throw new Error("rate limited"); }) },
    });
    const out = (await run(tools, "read_file", { path: "src/a.ts" })) as string;
    expect(out).toContain('Tool "read_file" failed');
    expect(out).toContain("rate limited");
  });
});
