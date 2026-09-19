import "dotenv/config";
import { App } from "octokit";
import { loadEnv } from "./config.js";
import { createLogger } from "./logger.js";
import { createAppServer } from "./server.js";
import { GitHubClient } from "./github/client.js";
import {
  handleIssueCommentEvent,
  handlePullRequestEvent,
  handleReviewCommentEvent,
} from "./github/events.js";
import { createReviewerStack } from "./wiring.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  logger.info(env.GITHUB_API_URL ? { api: env.GITHUB_API_URL } : {}, "Starting ai-pr-reviewer");

  const app = new App({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
    ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}),
  });
  const github = GitHubClient.fromApp(app);

  const { engine, conversation, close } = await createReviewerStack(env, logger, github);

  const server = createAppServer({
    webhookSecret: env.WEBHOOK_SECRET,
    onPullRequest: (payload) => handlePullRequestEvent(payload, { engine, logger }),
    onIssueComment: (payload) => handleIssueCommentEvent(payload, { engine, github, logger }),
    onReviewComment: (payload) =>
      handleReviewCommentEvent(payload, { engine, github, logger, conversation }),
    logger,
  });
  server.listen(env.PORT, () => {
    logger.info(`Listening on port ${env.PORT} (POST /webhook, GET /healthz)`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    server.close(() => {
      close();
      process.exit(0);
    });
    // In-flight reviews are best-effort; do not hang forever on open sockets.
    setTimeout(() => {
      close();
      process.exit(0);
    }, 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
