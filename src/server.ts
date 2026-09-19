import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dispatchWebhookEvent, verifyWebhookSignature } from "./github/webhooks.js";

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export interface AppServerDeps {
  webhookSecret: string;
  onPullRequest: (payload: any) => Promise<void>;
  onIssueComment?: (payload: any) => Promise<void>;
  onReviewComment?: (payload: any) => Promise<void>;
  logger: import("./logger.js").Logger;
}

export function createAppServer(deps: AppServerDeps) {
  const server = createServer((req, res) => {
    void handle(req, res, deps).catch((e) => {
      deps.logger.error({ err: e }, "Unhandled request error");
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse, d: AppServerDeps): Promise<void> {
    const url = req.url?.split("?")[0];
    if (req.method === "GET" && url === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url === "/webhook") {
      const raw = await readRawBody(req);
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!verifyWebhookSignature(raw, signature, d.webhookSecret)) {
        d.logger.warn("Rejected webhook with invalid signature");
        sendJson(res, 401, { ok: false, error: "invalid signature" });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      // Ack immediately: GitHub must not retry (and duplicate) while we review.
      sendJson(res, 202, { ok: true });
      const event = req.headers["x-github-event"];
      setImmediate(() => {
        void dispatchWebhookEvent(typeof event === "string" ? event : "", payload, {
          onPullRequest: d.onPullRequest,
          onIssueComment: d.onIssueComment,
          onReviewComment: d.onReviewComment,
          logger: d.logger,
        });
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  }

  return server;
}
