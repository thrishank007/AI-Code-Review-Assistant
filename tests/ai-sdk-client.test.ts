import { describe, expect, it, vi } from "vitest";
import { AiSdkLLMClient, createChatModel, toLLMError } from "../src/llm/ai-sdk-client.js";
import { FetchLLMClient, LLMError } from "../src/llm/client.js";
import { createLLMClient, llmConfigFromEnv, supportsToolCalling } from "../src/llm/factory.js";
import type { Env } from "../src/config.js";

function chatCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    baseURL: "http://llm.local/v1",
    apiKey: "key-123",
    model: "test-model",
    timeoutMs: 5_000,
    maxTokens: 256,
    jsonMode: false,
    ...overrides,
  };
}

describe("AiSdkLLMClient.chat", () => {
  it("posts an OpenAI chat-completions request and returns the text", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      chatCompletion("hello from ai sdk"),
    );
    const client = new AiSdkLLMClient(baseConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    const out = await client.chat([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);

    expect(out).toBe("hello from ai sdk");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/chat/completions");
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("test-model");
    // system is forwarded to the provider as a system message
    expect(JSON.stringify(body.messages)).toContain("be terse");
    expect(JSON.stringify(body.messages)).toContain("hi");
  });

  it("sends response_format when json mode is on", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => chatCompletion("{}"));
    const client = new AiSdkLLMClient(
      baseConfig({ jsonMode: true, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    await client.chat([{ role: "user", content: "hi" }]);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.response_format).toMatchObject({ type: "json_object" });
  });

  it("wraps provider failures in LLMError with the status", async () => {
    const fetchImpl = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response("upstream exploded", { status: 502, statusText: "Bad Gateway" }),
    );
    const client = new AiSdkLLMClient(baseConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).status).toBe(502);
  });
});

describe("JSON-mode transport middleware", () => {
  it("leaves tool-bearing requests alone so tool calling still works", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      const isToolStep = bodies.length === 1;
      return new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [
            isToolStep
              ? {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "c1",
                        type: "function",
                        function: { name: "lookup", arguments: '{"q":"a"}' },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                }
              : {
                  index: 0,
                  message: { role: "assistant", content: "{} " },
                  finish_reason: "stop",
                },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const { generateText, stepCountIs, tool } = await import("ai");
    const { z } = await import("zod");
    await generateText({
      model: createChatModel(
        baseConfig({ jsonMode: true, fetchImpl: fetchImpl as unknown as typeof fetch }),
      ),
      prompt: "hi",
      maxRetries: 0,
      stopWhen: stepCountIs(3),
      tools: {
        lookup: tool({
          description: "lookup",
          inputSchema: z.object({ q: z.string() }),
          execute: async () => "found",
        }),
      },
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools).toBeDefined();
    expect(bodies[0].response_format).toBeUndefined();
  });
});

describe("toLLMError", () => {
  it("passes LLMError through unchanged", () => {
    const original = new LLMError("nope", 500);
    expect(toLLMError(original)).toBe(original);
  });

  it("maps a statusCode-bearing error onto LLMError", () => {
    const mapped = toLLMError(Object.assign(new Error("bad request"), { statusCode: 400 }));
    expect(mapped.status).toBe(400);
    expect(mapped.message).toMatch(/400/);
  });

  it("handles non-Error throwables", () => {
    expect(toLLMError("boom").message).toMatch(/boom/);
  });
});

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
  CHECKS_ENABLED: true,
  AGENT_TOOLS_ENABLED: true,
  AGENT_MAX_STEPS: 10,
  JEV_ENABLED: true,
  JEV_CONFIDENCE_THRESHOLD: 60,
  JEV_TIMEOUT_MS: 10_000,
  FEEDBACK_ENABLED: true,
  FEEDBACK_DB_PATH: ":memory:",
} satisfies Env;

describe("llm factory", () => {
  it("maps env onto a client config", () => {
    const cfg = llmConfigFromEnv(env);
    expect(cfg).toMatchObject({
      baseURL: "http://x/v1",
      model: "test-model",
      timeoutMs: 1000,
      maxTokens: 100,
      jsonMode: true,
    });
  });

  it("builds the AI SDK client by default and the fetch client on request", () => {
    expect(createLLMClient(env)).toBeInstanceOf(AiSdkLLMClient);
    expect(createLLMClient({ ...env, LLM_PROVIDER: "openai-compatible" })).toBeInstanceOf(
      FetchLLMClient,
    );
  });

  it("only advertises tool calling for the AI SDK provider with tools enabled", () => {
    expect(supportsToolCalling(env)).toBe(true);
    expect(supportsToolCalling({ ...env, LLM_PROVIDER: "openai-compatible" })).toBe(false);
    expect(supportsToolCalling({ ...env, AGENT_TOOLS_ENABLED: false })).toBe(false);
  });
});
