import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppServer } from "../src/server.js";
import { createLogger } from "../src/logger.js";
import type { PullRequestEvent } from "../src/types.js";

const logger = createLogger("fatal");
const secret = "whsec";

describe("HTTP server", () => {
  let onPullRequest: ReturnType<typeof vi.fn>;
  let server: ReturnType<typeof createAppServer>;
  let port: number;

  beforeAll(async () => {
    onPullRequest = vi.fn().mockResolvedValue(undefined);
    server = createAppServer({ webhookSecret: secret, onPullRequest, logger });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const base = () => `http://127.0.0.1:${port}`;

  it("GET /healthz returns ok", async () => {
    const res = await fetch(`${base()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unknown routes 404", async () => {
    const res = await fetch(`${base()}/nope`);
    expect(res.status).toBe(404);
  });

  it("rejects unsigned webhook POSTs with 401", async () => {
    const res = await fetch(`${base()}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON with 400 (after signature check)", async () => {
    const body = "not json";
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    const res = await fetch(`${base()}/webhook`, {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${sig}` },
      body,
    });
    expect(res.status).toBe(400);
  });

  it("accepts a signed pull_request webhook, 202s fast, then dispatches", async () => {
    const payload: PullRequestEvent = {
      action: "opened",
      installation: { id: 1 },
      repository: { name: "r", owner: { login: "o" } },
      pull_request: { number: 1, title: "t", body: null, draft: false, head: { sha: "s" } },
    };
    const body = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(body).digest("hex");

    const res = await fetch(`${base()}/webhook`, {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${sig}`, "x-github-event": "pull_request" },
      body,
    });
    expect(res.status).toBe(202);

    // setImmediate dispatch — wait for the handler to fire
    await vi.waitFor(() => expect(onPullRequest).toHaveBeenCalledTimes(1));
    expect(onPullRequest.mock.calls[0]![0]).toEqual(payload);
  });
});
