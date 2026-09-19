import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { LLMError, type LLMConfig } from "./client.js";
import type { ChatMessage, LLMClientLike } from "./types.js";

export type { LLMClientLike };

/** Config for the AI SDK client; a superset of the fetch client's config. */
export type AiSdkConfig = LLMConfig & {
  /** Injectable fetch, used by tests to keep everything offline. */
  fetchImpl?: typeof fetch;
};

/**
 * AI SDK v7's OpenAI chat provider does not forward `responseFormat` to
 * `response_format`, so JSON mode is applied at the transport layer instead.
 * Tool-bearing requests are left alone: forcing JSON output there would fight
 * with tool calling.
 */
function withJsonMode(fetchImpl: typeof fetch | undefined, jsonMode: boolean): typeof fetch | undefined {
  if (!jsonMode) return fetchImpl;
  const base = fetchImpl ?? fetch;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        if (body && !body.tools && !body.response_format) {
          body.response_format = { type: "json_object" };
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // Not JSON (or not a chat request) — pass it through untouched.
      }
    }
    return base(input, init);
  }) as typeof fetch;
}

/**
 * Build a chat-completions language model pointed at any OpenAI-compatible
 * endpoint. `provider.chat()` is deliberate: the default OpenAI provider in
 * AI SDK v7 uses the Responses API, which local servers (Ollama, vLLM,
 * LM Studio) do not implement.
 */
export function createChatModel(cfg: AiSdkConfig) {
  const fetchImpl = withJsonMode(cfg.fetchImpl, cfg.jsonMode);
  const provider = createOpenAI({
    name: "ai-pr-reviewer",
    baseURL: cfg.baseURL,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return provider.chat(cfg.model);
}

/** Turn any AI SDK failure into the LLMError the rest of the app already handles. */
export function toLLMError(e: unknown): LLMError {
  if (e instanceof LLMError) return e;
  const status = (e as any)?.statusCode ?? (e as any)?.status;
  const message = (e as Error)?.message ?? String(e);
  return new LLMError(
    status ? `LLM returned HTTP ${status}: ${message}` : `LLM request failed: ${message}`,
    typeof status === "number" ? status : undefined,
  );
}

/**
 * Vercel AI SDK implementation of the LLM client. Same contract as the fetch
 * client, but it goes through a real provider abstraction so the agent loop
 * can attach tools.
 */
export class AiSdkLLMClient implements LLMClientLike {
  constructor(private readonly cfg: AiSdkConfig) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const rest = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    try {
      const { text } = await generateText({
        model: createChatModel(this.cfg),
        ...(system ? { instructions: system } : {}),
        messages: rest,
        temperature: 0.2,
        maxOutputTokens: this.cfg.maxTokens,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      if (!text) throw new LLMError("LLM response missing text");
      return text;
    } catch (e) {
      throw toLLMError(e);
    }
  }
}
