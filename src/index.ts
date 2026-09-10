import "dotenv/config";
import { App } from "octokit";
import { loadEnv } from "./config.js";
import { createLogger } from "./logger.js";
import { createAppServer } from "./server.js";
import { GitHubClient } from "./github/client.js";
import { handleIssueCommentEvent, handlePullRequestEvent } from "./github/events.js";
import { ReviewEngine } from "./review/engine.js";
import { LLMClient } from "./llm/client.js";

function main(): void {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  logger.info(env.GITHUB_API_URL ? { api: env.GITHUB_API_URL } : {}, "Starting ai-pr-reviewer");

  const app = new App({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
    ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}),
  });

  const github = GitHubClient.fromApp(app);
  const llm = new LLMClient({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxTokens: env.LLM_MAX_TOKENS,
    jsonMode: env.LLM_JSON_MODE,
  });
  const engine = new ReviewEngine(github, llm, env, logger);

  const server = createAppServer({
    webhookSecret: env.WEBHOOK_SECRET,
    onPullRequest: (payload) => handlePullRequestEvent(payload, { engine, logger }),
    onIssueComment: (payload) => handleIssueCommentEvent(payload, { engine, github, logger }),
    logger,
  });

  server.listen(env.PORT, () => {
    logger.info(`Listening on port ${env.PORT} (POST /webhook, GET /healthz)`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    server.close(() => process.exit(0));
    // In-flight reviews are best-effort; do not hang forever on open sockets.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
