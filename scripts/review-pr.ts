/**
 * Dev utility: run the review engine against a real PR and print the report
 * to stdout instead of posting it. Usage:
 *
 *   npm run review:pr -- owner/repo#123
 *   npm run review:pr -- owner repo 123
 *
 * Requires the standard .env plus the app being installed on the target
 * owner/org. Useful for iterating on prompts without opening PRs.
 */
import "dotenv/config";
import { App } from "octokit";
import { loadEnv } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { GitHubClient } from "../src/github/client.js";
import { ReviewEngine } from "../src/review/engine.js";
import { LLMClient } from "../src/llm/client.js";

function parseArgs(argv: string[]): { owner: string; repo: string; pullNumber: number } {
  const [a, b, c] = argv;
  if (a && !b && a.includes("#")) {
    const [slug, num] = a.split("#");
    const [owner, repo] = slug!.split("/");
    const pullNumber = parseInt(num!, 10);
    if (owner && repo && Number.isFinite(pullNumber)) return { owner, repo, pullNumber };
  }
  if (a && b && c) {
    const pullNumber = parseInt(c, 10);
    if (Number.isFinite(pullNumber)) return { owner: a, repo: b, pullNumber };
  }
  console.error("Usage: npm run review:pr -- owner/repo#123");
  process.exit(1);
}

async function main(): Promise<void> {
  const { owner, repo, pullNumber } = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const logger = createLogger("info");

  const app = new App({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
    ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}),
  });

  // Find the installation id for the target owner.
  const { data: installations } = await app.octokit.rest.apps.listInstallations({ per_page: 100 });
  const installation = installations.find(
    (i: any) => i.account?.login?.toLowerCase() === owner.toLowerCase(),
  );
  if (!installation) {
    console.error(`The app is not installed on "${owner}". Install it first, then retry.`);
    process.exit(1);
  }

  const octokit = await app.getInstallationOctokit(installation.id);
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });

  const github = new GitHubClient(async (installationId) => {
    if (installationId !== installation.id) throw new Error("unexpected installation");
    return octokit as never;
  });
  const llm = new LLMClient({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxTokens: env.LLM_MAX_TOKENS,
    jsonMode: env.LLM_JSON_MODE,
  });
  const engine = new ReviewEngine(github, llm, env, logger);

  const outcome = await engine.reviewPullRequest(
    {
      installationId: installation.id,
      owner,
      repo,
      pullNumber,
      title: pr.title,
      body: pr.body,
      headSha: pr.head.sha,
    },
    { dryRun: true },
  );

  console.log(`\n=== status: ${outcome.status}, inline comments: ${outcome.inlineComments.length} ===\n`);
  for (const c of outcome.inlineComments) {
    console.log(`--- ${c.path}:${c.line} ---\n${c.body}\n`);
  }
  console.log("=== review body ===\n");
  console.log(outcome.body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
