import type { Env } from "../../src/config.js";
import type { GitHubClient } from "../../src/github/client.js";
import type { ChatMessage, LLMClient } from "../../src/llm/client.js";
import type { Logger } from "../../src/logger.js";
import { createLogger } from "../../src/logger.js";
import { ReviewEngine } from "../../src/review/engine.js";
import { parseReviewResult } from "../../src/review/findings.js";
import type { CaseResult, EvalCase } from "./types.js";
import { matchFindings } from "./matcher.js";
import { estimateTokens } from "./scorer.js";

export interface RunOptions {
  env: Env;
  logger?: Logger;
  /** Repeat each case N times (for consistency measurement). Default 1. */
  repeat?: number;
  /** Factory for fresh LLM clients (one per case run). Defaults to real LLMClient. */
  makeLLM?: () => LLMClient;
  onProgress?: (caseId: string, completedRuns: number, totalRuns: number) => void;
}

interface RecordedCall {
  messages: ChatMessage[];
  raw: string;
  latencyMs: number;
}

/**
 * Thin proxy around LLMClient that captures every prompt/response pair
 * plus per-call latency, so the eval harness can score format compliance,
 * latency, and token usage without changing engine behavior.
 */
export class RecordingLLMClient {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly inner: LLMClient) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const start = performance.now();
    const raw = await this.inner.chat(messages);
    this.calls.push({ messages, raw, latencyMs: performance.now() - start });
    return raw;
  }
}

/** Mock GitHub client backed by a single EvalCase: no network, no side effects. */
export function makeMockGitHub(evalCase: EvalCase): GitHubClient {
  return {
    // No prior reviews → the engine never takes the duplicate-skip path.
    hasReviewedHead: async () => false,
    listPRFiles: async () => evalCase.files,
    getFileContent: async () => evalCase.repoConfig ?? null,
    // Dry-run mode means the engine never calls these, but they must exist.
    submitReview: async () => {},
    createCheckRun: async () => {},
    commentOnPR: async () => {},
    getPullRequest: async () => ({
      number: 1,
      title: evalCase.pr.title,
      body: evalCase.pr.body,
      draft: false,
      headSha: `eval-${evalCase.id}`,
    }),
  } as unknown as GitHubClient;
}

/** Run a single case once through the real ReviewEngine in dry-run mode. */
export async function runSingleCase(
  evalCase: EvalCase,
  runIndex: number,
  opts: RunOptions,
): Promise<CaseResult> {
  const logger = opts.logger ?? createLogger("warn");
  const llm = opts.makeLLM!();
  const recording = new RecordingLLMClient(llm);
  const github = makeMockGitHub(evalCase);
  const engine = new ReviewEngine(
    github,
    recording as unknown as LLMClient,
    opts.env,
    logger,
  );

  const wallStart = performance.now();
  const outcome = await engine.reviewPullRequest(
    {
      installationId: 1,
      owner: "eval",
      repo: "eval",
      pullNumber: 1,
      title: evalCase.pr.title,
      body: evalCase.pr.body,
      headSha: `eval-${evalCase.id}`,
    },
    { dryRun: true },
  );
  const latencyMs = performance.now() - wallStart;

  const firstRaw = recording.calls[0]?.raw ?? "";
  const lastRaw = recording.calls.length > 0 ? recording.calls[recording.calls.length - 1]!.raw : "";
  const parsedOnFirstTry = parseReviewResult(firstRaw) !== null;
  const reviewResult = lastRaw ? parseReviewResult(lastRaw) : null;

  const actualFindings = reviewResult?.findings ?? [];
  const { matches, unmatchedActual } = evalCase.expected
    ? matchFindings(evalCase.expected.findings, actualFindings)
    : { matches: [], unmatchedActual: [] as typeof actualFindings };

  const promptTokenEstimate = recording.calls.reduce(
    (sum, c) => sum + estimateTokens(c.messages.map((m) => m.content).join("\n")),
    0,
  );
  const completionTokenEstimate = recording.calls.reduce(
    (sum, c) => sum + estimateTokens(c.raw),
    0,
  );

  return {
    caseId: evalCase.id,
    caseName: evalCase.name,
    category: evalCase.category,
    runIndex,
    rawLLMResponse: firstRaw,
    parsedOnFirstTry,
    reviewResult,
    outcome,
    matches,
    unmatchedActual,
    latencyMs,
    promptTokenEstimate,
    completionTokenEstimate,
  };
}

/**
 * Run every case sequentially (LLM calls are not parallelized by default).
 * Each case runs `repeat` times; results are grouped by caseId downstream
 * for the consistency metric.
 */
export async function runEvalCases(
  cases: EvalCase[],
  opts: RunOptions,
): Promise<CaseResult[]> {
  if (!opts.makeLLM) {
    throw new Error("runEvalCases requires opts.makeLLM (use makeRealLLMFactory in cli.ts)");
  }
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const results: CaseResult[] = [];
  const totalRuns = cases.length * repeat;
  let completed = 0;
  for (const evalCase of cases) {
    for (let runIndex = 0; runIndex < repeat; runIndex++) {
      opts.onProgress?.(evalCase.id, completed, totalRuns);
      results.push(await runSingleCase(evalCase, runIndex, opts));
      completed++;
    }
  }
  return results;
}
