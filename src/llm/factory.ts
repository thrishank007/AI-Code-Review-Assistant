import type { Env } from "../config.js";
import { AiSdkLLMClient, type AiSdkConfig } from "./ai-sdk-client.js";
import { FetchLLMClient } from "./client.js";
import type { LLMClientLike } from "./types.js";

/** Map the service environment onto a client config. */
export function llmConfigFromEnv(env: Env): AiSdkConfig {
  return {
    baseURL: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxTokens: env.LLM_MAX_TOKENS,
    jsonMode: env.LLM_JSON_MODE,
    ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}),
  };
}

/**
 * Pick the LLM client for the configured provider. Both implement the same
 * `chat()` contract; only the AI SDK client can be used by the agent loop.
 */
export function createLLMClient(env: Env, opts: { fetchImpl?: typeof fetch } = {}): LLMClientLike {
  const cfg: AiSdkConfig = {
    ...llmConfigFromEnv(env),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };
  return env.LLM_PROVIDER === "openai-compatible"
    ? new FetchLLMClient(cfg)
    : new AiSdkLLMClient(cfg);
}

/** True when the configured provider supports tool calling. */
export function supportsToolCalling(env: Env): boolean {
  return env.LLM_PROVIDER === "ai-sdk" && env.AGENT_TOOLS_ENABLED;
}
