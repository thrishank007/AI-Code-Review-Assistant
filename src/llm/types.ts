/** Minimal chat interface every LLM backend in this repo implements. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The narrow LLM surface the reviewer needs (easy to fake in tests). */
export interface LLMClientLike {
  chat(messages: ChatMessage[]): Promise<string>;
}

export { LLMClient } from "./client.js";
