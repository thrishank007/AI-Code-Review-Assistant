import type { ChatMessage } from "./types.js";

/** Error raised for any failure talking to the LLM backend. */
export class LLMError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = "LLMError";
  }
}

/** Shared config for every LLM backend (fetch and AI SDK clients). */
export interface LLMConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  jsonMode: boolean;
}

export type FetchLLMConfig = LLMConfig;

/**
 * Minimal chat-completions client over plain fetch, so it works with any
 * OpenAI-compatible server (OpenAI, Ollama, vLLM, LM Studio, Groq, OpenRouter...).
 *
 * This is the zero-dependency fallback: it has no tool-calling support, so the
 * agent loop is only available on the `ai-sdk` provider.
 */
export class FetchLLMClient {
  constructor(private readonly cfg: FetchLLMConfig) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.cfg.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: 0.2,
      max_tokens: this.cfg.maxTokens,
    };
    if (this.cfg.jsonMode) body.response_format = { type: "json_object" };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      throw new LLMError(`LLM request failed: ${(e as Error).message}`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new LLMError(`LLM returned HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new LLMError("LLM returned a non-JSON body");
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new LLMError("LLM response missing choices[0].message.content");
    }
    return content;
  }
}

/** Back-compat alias for the original class name. */
export { FetchLLMClient as LLMClient };
