/**
 * Eval harness entry point. Usage:
 *
 *   npm run eval -- [options]
 *
 * Options:
 *   --category <golden|synthetic|snapshot|all>   Filter dataset category (default: all)
 *   --case <id>                                  Run a single case by ID
 *   --repeat <N>                                 Repeat each case N times for consistency (default: 1)
 *   --model <name>                               Override LLM_MODEL env var
 *   --base-url <url>                             Override LLM_BASE_URL env var
 *   --no-report                                  Skip writing markdown report file
 *   --verbose                                    Print detailed per-case output
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type Env } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { LLMClient } from "../../src/llm/client.js";
import { loadEvalCases } from "./loader.js";
import { runEvalCases } from "./runner.js";
import { scoreResults } from "./scorer.js";
import {
  listExistingReports,
  renderConsole,
  renderMarkdown,
  reportFilename,
} from "./reporter.js";
import type { EvalReport } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = dirname(HERE);
const DATASETS_DIR = join(EVALS_DIR, "datasets");
const REPORTS_DIR = join(EVALS_DIR, "reports");

interface CliOptions {
  category: "golden" | "synthetic" | "snapshot" | "all";
  caseId?: string;
  repeat: number;
  model?: string;
  baseUrl?: string;
  writeReport: boolean;
  verbose: boolean;
}

function printUsage(): void {
  console.log(`Usage: npm run eval -- [options]

Options:
  --category <golden|synthetic|snapshot|all>   Filter dataset category (default: all)
  --case <id>                                  Run a single case by ID
  --repeat <N>                                 Repeat each case N times for consistency (default: 1)
  --model <name>                               Override LLM_MODEL env var
  --base-url <url>                             Override LLM_BASE_URL env var
  --no-report                                  Skip writing markdown report file
  --verbose                                    Print detailed per-case output`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    category: "all",
    repeat: 1,
    writeReport: true,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      case "--category": {
        const value = argv[++i];
        if (value !== "golden" && value !== "synthetic" && value !== "snapshot" && value !== "all") {
          console.error(`Invalid --category "${value}". Expected golden|synthetic|snapshot|all.`);
          process.exit(2);
        }
        opts.category = value;
        break;
      }
      case "--case":
        opts.caseId = argv[++i];
        if (!opts.caseId) {
          console.error("Missing value for --case.");
          process.exit(2);
        }
        break;
      case "--repeat": {
        const value = parseInt(argv[++i] ?? "", 10);
        if (!Number.isFinite(value) || value < 1) {
          console.error(`Invalid --repeat value. Expected a positive integer.`);
          process.exit(2);
        }
        opts.repeat = value;
        break;
      }
      case "--model":
        opts.model = argv[++i];
        if (!opts.model) {
          console.error("Missing value for --model.");
          process.exit(2);
        }
        break;
      case "--base-url":
        opts.baseUrl = argv[++i];
        if (!opts.baseUrl) {
          console.error("Missing value for --base-url.");
          process.exit(2);
        }
        break;
      case "--no-report":
        opts.writeReport = false;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      default:
        console.error(`Unknown option "${arg}". Use --help for usage.`);
        process.exit(2);
    }
  }
  return opts;
}

/**
 * Evals drive the review engine with a mock GitHub client, so GitHub App
 * credentials are irrelevant — fill dummy defaults when they are absent.
 * LLM settings stay required (or overridden via --model/--base-url).
 */
function loadEvalEnv(opts: CliOptions): Env {
  const vars: Record<string, string | undefined> = { ...process.env };
  vars.APP_ID ??= "1";
  vars.PRIVATE_KEY ??= "eval-dummy-private-key-not-used-by-the-harness-0000";
  vars.WEBHOOK_SECRET ??= "eval";
  if (opts.model) vars.LLM_MODEL = opts.model;
  if (opts.baseUrl) vars.LLM_BASE_URL = opts.baseUrl;
  try {
    return loadEnv(vars);
  } catch (e) {
    console.error((e as Error).message);
    console.error("\nHint: set LLM_BASE_URL / LLM_MODEL in .env, or pass --model / --base-url.");
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const env = loadEvalEnv(opts);
  const logger = createLogger("warn");

  const cases = loadEvalCases(DATASETS_DIR, {
    category: opts.category,
    caseId: opts.caseId,
  });
  if (cases.length === 0) {
    console.error("No eval cases matched the given filter.");
    process.exit(2);
  }

  const filterDesc =
    opts.category === "all" && !opts.caseId
      ? "all"
      : `category=${opts.category}${opts.caseId ? ` case=${opts.caseId}` : ""}`;
  console.log(
    `Running ${cases.length} case(s)${opts.repeat > 1 ? ` × ${opts.repeat} repeat(s)` : ""} with model ${env.LLM_MODEL} [${filterDesc}]`,
  );

  const started = performance.now();
  const results = await runEvalCases(cases, {
    env,
    logger,
    repeat: opts.repeat,
    makeLLM: () =>
      new LLMClient({
        baseURL: env.LLM_BASE_URL,
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL,
        timeoutMs: env.LLM_TIMEOUT_MS,
        maxTokens: env.LLM_MAX_TOKENS,
        jsonMode: env.LLM_JSON_MODE,
      }),
    onProgress: (caseId, completed, total) => {
      console.log(`  [${completed + 1}/${total}] ${caseId}`);
    },
  });
  const durationMs = performance.now() - started;

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    model: env.LLM_MODEL,
    datasetFilter: filterDesc,
    cases: results,
    metrics: scoreResults(results),
    durationMs,
  };

  if (opts.verbose) {
    for (const c of results) {
      console.log(`\n--- ${c.caseId} (run ${c.runIndex}) → ${c.outcome.status} ---`);
      console.log(`parsedOnFirstTry=${c.parsedOnFirstTry} latency=${Math.round(c.latencyMs)}ms`);
      for (const m of c.matches) {
        console.log(
          `  expected ${m.expected.file} ← ${m.actual ? `${m.actual.file}:${m.actual.line} [${m.actual.severity}] "${m.actual.title}"` : "MISSED"}`,
        );
      }
      for (const fp of c.unmatchedActual) {
        console.log(`  false-positive ${fp.file}:${fp.line} [${fp.severity}] "${fp.title}"`);
      }
    }
    console.log("");
  }

  let reportPath = "(report skipped via --no-report)";
  if (opts.writeReport) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const filename = reportFilename(report);
    const existing = listExistingReports(REPORTS_DIR, filename);
    const markdown = renderMarkdown(report, existing);
    reportPath = join(REPORTS_DIR, filename);
    writeFileSync(reportPath, markdown, "utf8");
  }

  console.log("");
  console.log(renderConsole(report, reportPath));

  // Non-zero exit when any response failed first-try parsing (regression signal).
  // NOTE: assign exitCode and return instead of process.exit() — exiting
  // explicitly while undici keep-alive sockets are still draining crashes
  // Node on Windows (libuv UV_HANDLE_CLOSING assertion).
  process.exitCode = report.metrics.formatCompliance === 1 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
