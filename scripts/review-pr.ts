/**
 * Standalone CLI: review one PR and print the outcome without running the
 * webhook server. Requires the same env vars as the server.
 *
 *   npx tsx scripts/review-pr.ts owner/repo#123 [--dry-run]
 */
import "dotenv/config";
import { App } from "octokit";
import { loadEnv } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { GitHubClient } from "../src/github/client.js";
import { createReviewerStack } from "../src/wiring.js";

function parseTarget(arg: string): { owner: string; repo: string; pullNumber: number } {
  const m = arg.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (!m) {
    console.error(`Usage: npx tsx scripts/review-pr.ts owner/repo#123 (got: ${arg})`);
    process.exit(1);
  }
  return { owner: m[1]!, repo: m[2]!, pullNumber: Number(m[3]) };
}

async function main(): Promise<void> {
  const target = process.argv[2] ? parseTarget(process.argv[2]) : null;
  if (!target) {
    console.error("Usage: npx tsx scripts/review-pr.ts owner/repo#123 [--dry-run]");
    process.exit(1);
  }

  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const app = new App({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
    ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}),
  });
  const github = GitHubClient.fromApp(app);

  // Resolve the app installation for the target repository.
  const installation = await app.octokit.rest.apps.getRepoInstallation({
    owner: target.owner,
    repo: target.repo,
  });
  const installationId = installation.data.id;

  const { engine, close } = await createReviewerStack(env, logger, github);
  try {
    const pr = await github.getPullRequest(
      installationId,
      target.owner,
      target.repo,
      target.pullNumber,
    );
    const outcome = await engine.reviewPullRequest(
      {
        installationId,
        owner: target.owner,
        repo: target.repo,
        pullNumber: target.pullNumber,
        title: pr.title,
        body: pr.body,
        headSha: pr.headSha,
      },
      { dryRun: process.argv.includes("--dry-run") },
    );
    console.log(outcome.body);
    console.log(`\n--- status: ${outcome.status} ---`);
  } finally {
    close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
