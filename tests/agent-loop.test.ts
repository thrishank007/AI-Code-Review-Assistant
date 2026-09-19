import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { AiSdkReviewAgent, type AgentToolContextInput } from "../src/agent/loop.js";
import type { GitHubClient } from "../src/github/client.js";
import { createLogger } from "../src/logger.js";
import type { AiSdkConfig } from "../src/llm/ai-sdk-client.js";
import type { PromptInput } from "../src/review/prompt.js";

const logger = createLogger("fatal");

const cfg: AiSdkConfig = {
  baseURL: "http://llm.local/v1",
  apiKey: "k",
  model: "test-model",
  timeoutMs: 5_000,
  maxTokens: 256,
  jsonMode: false,
};

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
  totalTokens: 15,
};

// v4 finish reasons are structured ({ unified, raw }), not bare strings.
const finish = (unified: "stop" | "tool-calls") => ({ unified, raw: unified });

function text(value: string) {
  return {
    content: [{ type: "text" as const, text: value }],
    finishReason: finish("stop"),
    usage,
    warnings: [],
  };
}

// Providers hand the SDK a JSON *string* for tool arguments (see @ai-sdk/openai).
function toolCall(name: string, input: unknown, toolCallId = "call-1") {
  return {
    content: [
      { type: "tool-call" as const, toolCallId, toolName: name, input: JSON.stringify(input) },
    ],
    finishReason: finish("tool-calls"),
    usage,
    warnings: [],
  };
}

const input: PromptInput = {
  prTitle: "Add caching",
  prBody: "Caches lookups",
  files: [
    {
      filename: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -1,1 +1,2 @@\n x\n+y",
    },
  ],
};

function toolContext(overrides: Record<string, unknown> = {}): AgentToolContextInput {
  return {
    github: {
      getFileContent: vi.fn(async () => "export const a = 1;"),
      ...overrides,
    } as unknown as GitHubClient,
    installationId: 42,
    owner: "o",
    repo: "r",
    headSha: "abc1234567",
    changedPaths: ["src/a.ts"],
  };
}

function agent(model: MockLanguageModelV4, maxSteps = 5) {
  return new AiSdkReviewAgent(cfg, {
    logger,
    maxSteps,
    modelFactory: () => model,
  });
}

const reviewJson = JSON.stringify({
  summary: "Adds a line.",
  overview: "Small change.",
  fileSummaries: [{ file: "src/a.ts", summary: "Adds a line." }],
  findings: [],
});

describe("AiSdkReviewAgent", () => {
  it("returns the model's final review JSON", async () => {
    const result = await agent(new MockLanguageModelV4({ doGenerate: text(reviewJson) })).run(
      input,
      { tools: toolContext() },
    );

    expect(result.text).toBe(reviewJson);
    expect(result.toolCalls).toEqual([]);
    expect(result.steps).toBe(1);
    expect(result.exhausted).toBe(false);
  });

  it("runs a tool call, feeds the result back, and returns the final answer", async () => {
    const getFileContent = vi.fn(async () => "export const a = 1;");
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("read_file", { path: "src/a.ts" }), text(reviewJson)],
    });

    const result = await agent(model).run(input, {
      tools: toolContext({ getFileContent }),
    });

    expect(result.text).toBe(reviewJson);
    expect(result.toolCalls).toEqual(["read_file"]);
    expect(result.steps).toBe(2);
    expect(getFileContent).toHaveBeenCalledTimes(1);

    // The second model call must carry the tool result back.
    const secondCall = model.doGenerateCalls[1] as any;
    expect(JSON.stringify(secondCall.prompt)).toContain("export const a = 1;");
  });

  it("passes the model override from Jev routing through to the provider", async () => {
    const model = new MockLanguageModelV4({ doGenerate: text(reviewJson) });
    const modelFactory = vi.fn(() => model);
    const runner = new AiSdkReviewAgent(cfg, { logger, maxSteps: 3, modelFactory });

    await runner.run(input, { tools: toolContext(), model: "big-model" });

    expect(modelFactory).toHaveBeenCalledWith("big-model");
  });

  it("flags exhaustion when the model only ever calls tools", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("read_file", { path: "src/a.ts" }), toolCall("search_code", { query: "a" }, "call-2")],
    });

    const result = await agent(model, 2).run(input, { tools: toolContext() });

    expect(result.text).toBe("");
    expect(result.exhausted).toBe(true);
  });

  it("tells the model what was wrong when retrying a schema failure", async () => {
    const model = new MockLanguageModelV4({ doGenerate: text(reviewJson) });

    await agent(model).run(input, {
      tools: toolContext(),
      repair: "expected object, received string",
    });

    const prompt = JSON.stringify((model.doGenerateCalls[0] as any).prompt);
    expect(prompt).toContain("failed schema validation");
    expect(prompt).toContain("expected object, received string");
  });

  it("wraps provider errors as LLMError", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw Object.assign(new Error("upstream down"), { statusCode: 503 });
      },
    });

    const err = await agent(model)
      .run(input, { tools: toolContext() })
      .catch((e) => e);
    expect(err.name).toBe("LLMError");
    expect(err.status).toBe(503);
  });
});
