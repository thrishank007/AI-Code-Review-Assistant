export interface LLMConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://localhost:11434/v1 */
  baseURL: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  jsonMode: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/**
 * Minimal chat-completions client over plain fetch, so it works with any
 * OpenAI-compatible server (OpenAI, Ollama, vLLM, LM Studio, Groq, OpenRouter...).
 */
export class LLMClient {
  constructor(private readonly cfg: LLMConfig) {}

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

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new LLMError("LLM returned a non-JSON body");
    }
    const content = (data as any)?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new LLMError("LLM response missing choices[0].message.content");
    }
    return content;
  }
}
