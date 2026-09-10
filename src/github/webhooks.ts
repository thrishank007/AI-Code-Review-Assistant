import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "../logger.js";
import type { IssueCommentEvent, PullRequestEvent } from "../types.js";

/**
 * Verify GitHub's X-Hub-Signature-256 header against the raw request body.
 * Timing-safe; never throws.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signatureHeader.slice(7), "hex");
  } catch {
    return false;
  }
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface WebhookDeps {
  onPullRequest: (payload: PullRequestEvent) => Promise<void>;
  onIssueComment?: (payload: IssueCommentEvent) => Promise<void>;
  logger: Logger;
}

/** Route a verified webhook payload by its event name. Never throws. */
export async function dispatchWebhookEvent(
  event: string,
  payload: unknown,
  deps: WebhookDeps,
): Promise<void> {
  try {
    if (event === "ping") {
      deps.logger.info("Received ping event from GitHub");
      return;
    }
    if (event === "pull_request") {
      await deps.onPullRequest(payload as PullRequestEvent);
      return;
    }
    if (event === "issue_comment") {
      if (deps.onIssueComment) {
        await deps.onIssueComment(payload as IssueCommentEvent);
      } else {
        deps.logger.debug("Ignoring issue_comment event (no handler)");
      }
      return;
    }
    deps.logger.debug({ event }, "Ignoring webhook event");
  } catch (e) {
    // The HTTP response has already been sent (202); logging is our only channel.
    deps.logger.error({ event, err: e }, "Webhook processing failed");
  }
}
