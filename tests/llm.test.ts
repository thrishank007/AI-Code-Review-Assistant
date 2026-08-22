import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClient, LLMError } from "../src/llm/client.js";

function makeClient(overrides: Partial<ConstructorParameters<typeof LLMClient>[0]> = {}) {
  return new LLMClient({
    baseURL: "http://llm.local/v1",
    apiKey: "key-123",
    model: "test-model",
    timeoutMs: 5000,
    maxTokens: 1024,
    jsonMode: true,
    ...overrides,
  });
}

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();
afterEach(() => fetchMock.mockReset());

describe("LLMClient.chat", () => {
  it("sends an OpenAI-compatible chat-completions request", async () => {
    fetchMock.mockResolvedValue(okResponse("hello"));
    vi.stubGlobal("fetch", fetchMock);

    const out = await makeClient().chat([{ role: "user", content: "hi" }]);

    expect(out).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://llm.local/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer key-123");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("test-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("omits auth header when no api key (local servers)", async () => {
    fetchMock.mockResolvedValue(okResponse("x"));
    vi.stubGlobal("fetch", fetchMock);

    await makeClient({ apiKey: undefined }).chat([{ role: "user", content: "hi" }]);

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("omits response_format when jsonMode is off", async () => {
    fetchMock.mockResolvedValue(okResponse("x"));
    vi.stubGlobal("fetch", fetchMock);

    await makeClient({ jsonMode: false }).chat([{ role: "user", content: "hi" }]);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.response_format).toBeUndefined();
  });

  it("strips trailing slashes from the base URL", async () => {
    fetchMock.mockResolvedValue(okResponse("x"));
    vi.stubGlobal("fetch", fetchMock);

    await makeClient({ baseURL: "http://llm.local/v1///" }).chat([{ role: "user", content: "hi" }]);

    expect(fetchMock.mock.calls[0]![0]).toBe("http://llm.local/v1/chat/completions");
  });

  it("throws LLMError with status and body excerpt on HTTP errors", async () => {
    fetchMock.mockResolvedValue(
      new Response("upstream exploded", { status: 502, statusText: "Bad Gateway" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const err = await makeClient().chat([{ role: "user", content: "hi" }]).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).status).toBe(502);
    expect((err as LLMError).message).toMatch(/502/);
  });

  it("wraps network failures as LLMError", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const err = await makeClient().chat([{ role: "user", content: "hi" }]).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).message).toMatch(/ECONNREFUSED/);
  });

  it("throws when the response body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /non-JSON body/,
    );
  });

  it("throws when choices[0].message.content is missing", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{}] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /missing choices/,
    );
  });
});
