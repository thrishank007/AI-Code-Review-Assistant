import type { Logger } from "../logger.js";
import type { Env } from "../config.js";
import { DEFAULT_IGNORES, EMPTY_REPO_CONFIG, parseRepoConfig, SEVERITIES, type RepoConfig } from "../config.js";
import type { GitHubClient } from "../github/client.js";
import type { LLMClientLike } from "../llm/types.js";
import type { ReviewAgent } from "../agent/loop.js";
import type { JevClient } from "../jev/client.js";
import { judgeFindings, modelForComplexity, routePRComplexity, type ComplexityRouting } from "../jev/decisions.js";
import type { FeedbackTracker } from "../feedback/tracker.js";
import { enrichInstructions } from "../feedback/prompt-enricher.js";
import type { Finding } from "../types.js";
import { clampFindings, parseReviewResult } from "./findings.js";
import { filterFiles } from "./filters.js";
import { buildMessages, JSON_REPAIR_USER_PROMPT, type PromptInput } from "./prompt.js";
import { renderDegradedBody, renderFailureBody, renderInlineComment, renderReviewBody } from "./report.js";

export interface ReviewRequest {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  body: string | null;
  headSha: string;
}

export interface ReviewOutcome {
  status: "reviewed" | "skipped-duplicate" | "skipped-empty" | "degraded";
  body: string;
  inlineComments: { path: string; line: number; body: string }[];
}

/** Optional collaborators; every one of them can be missing. */
export interface ReviewEngineDeps {
  /** Tool-calling agent. Only available on the `ai-sdk` provider. */
  agent?: ReviewAgent;
  /** Jev decision layer. */
  jev?: JevClient | null;
  /** SQLite feedback store. */
  feedback?: FeedbackTracker | null;
}

const REPO_CONFIG_PATH = ".aireview.yml";

/** Below this Jev probability, treat a finding as pre-existing rather than introduced. */
const MIN_INTRODUCED_BY_DIFF = 0.5;
/** Only override the model's severity when Jev is reasonably sure. */
const MIN_SEVERITY_CONFIDENCE = 0.6;

export class ReviewEngine {
  constructor(
    private readonly github: GitHubClient,
    private readonly llm: LLMClientLike,
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly deps: ReviewEngineDeps = {},
  ) {}

  async reviewPullRequest(
    req: ReviewRequest,
    opts: { dryRun?: boolean; force?: boolean } = {},
  ): Promise<ReviewOutcome> {
    const repoSlug = `${req.owner}/${req.repo}`;
    const log = this.logger.child({ repo: repoSlug, pr: req.pullNumber, sha: req.headSha });
    log.info("Starting PR review");

    if (
      !opts.force &&
      await this.github.hasReviewedHead(
        req.installationId,
        req.owner,
        req.repo,
        req.pullNumber,
        req.headSha,
      )
    ) {
      log.info("Head SHA already reviewed; skipping duplicate delivery");
      return { status: "skipped-duplicate", body: "", inlineComments: [] };
    }

    const files = await this.github.listPRFiles(
      req.installationId,
      req.owner,
      req.repo,
      req.pullNumber,
    );
    if (files.length === 0) {
      log.info("PR has no changed files; skipping");
      await this.maybePostCheck(req, opts, null, "neutral", "No changed files", "This PR has no changed files to review.");
      return { status: "skipped-empty", body: "", inlineComments: [] };
    }

    const { config, error } = await this.loadRepoConfig(req);
    const configWarnings = error ? [`Invalid ${REPO_CONFIG_PATH}: ${error}; using defaults`] : [];
    const notes: string[] = [];

    const ignore = [...DEFAULT_IGNORES, ...config.ignore];
    const maxFiles = config.max_files ?? this.env.MAX_FILES;
    const severities = new Set(config.severities ?? SEVERITIES);
    const filtered = filterFiles(files, {
      ignorePatterns: ignore,
      maxFiles,
      maxDiffChars: this.env.MAX_DIFF_CHARS,
    });
    if (filtered.included.length === 0) {
      log.info({ skipped: filtered.skipped.length }, "All files filtered out; skipping");
      await this.maybePostCheck(
        req,
        opts,
        config,
        "neutral",
        "No reviewable files",
        `All ${files.length} changed file(s) were ignored or over size caps.`,
      );
      return { status: "skipped-empty", body: "", inlineComments: [] };
    }

    const jev = this.jevFor(config);
    const instructions = this.enrichWithFeedback(config, repoSlug, opts);
    const promptInput: PromptInput = {
      prTitle: req.title,
      prBody: req.body,
      files: filtered.included,
      instructions,
      skippedCount: files.length - filtered.included.length,
    };

    // --- Jev: route PR complexity before spending a model call ---------------
    const routing = await this.routeComplexity(jev, promptInput, log);
    const modelOverride = this.pickModel(routing, config);
    if (routing) {
      notes.push(
        `Jev classified this PR as \`${routing.complexity}\` (${Math.round(
          routing.confidence * 100,
        )}% confident)${modelOverride ? ` and routed it to \`${modelOverride}\`` : ""}`,
      );
      log.info({ complexity: routing.complexity, model: modelOverride }, "Jev routed PR complexity");
    }

    const useAgent = Boolean(this.deps.agent) && this.env.AGENT_TOOLS_ENABLED;
    // Read-only GitHub context the agent's tools resolve against.
    const toolContext = {
      github: this.github,
      installationId: req.installationId,
      owner: req.owner,
      repo: req.repo,
      headSha: req.headSha,
      changedPaths: filtered.included.map((f) => f.filename),
    };
    // The non-agent repair path needs the previous raw answer to correct.
    let lastRaw: string | undefined;
    // Counted across attempts and reported once, so a repair never doubles it.
    const agentToolCalls: string[] = [];

    const runModel = async (repair?: string): Promise<string> => {
      if (useAgent) {
        const result = await this.deps.agent!.run(promptInput, {
          tools: toolContext,
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(repair ? { repair } : {}),
        });
        agentToolCalls.push(...result.toolCalls);
        if (result.exhausted) {
          log.warn({ steps: result.steps }, "Agent exhausted its step budget without a final answer");
        }
        return result.text;
      }
      if (repair) {
        const messages = buildMessages(promptInput);
        return this.llm.chat([
          ...messages,
          { role: "assistant", content: lastRaw ?? "" },
          { role: "user", content: JSON_REPAIR_USER_PROMPT(repair) },
        ]);
      }
      return this.llm.chat(buildMessages(promptInput));
    };

    const generate = async (repair?: string): Promise<{ raw: string; result: ReturnType<typeof parseReviewResult> }> => {
      const raw = await runModel(repair);
      lastRaw = raw;
      return { raw, result: parseReviewResult(raw) };
    };

    log.info({ provider: useAgent ? "agent" : "chat", files: filtered.included.length }, "Calling model");
    let { raw, result } = await generate();
    if (!result) {
      log.warn("LLM response failed JSON parsing; retrying with correction prompt");
      ({ raw, result } = await generate("not valid JSON matching the schema"));
    }

    if (agentToolCalls.length > 0) {
      const counts = new Map<string, number>();
      for (const name of agentToolCalls) counts.set(name, (counts.get(name) ?? 0) + 1);
      notes.push(
        `Agent gathered context with ${agentToolCalls.length} lookup(s): ${[...counts]
          .map(([name, n]) => `${name}×${n}`)
          .join(", ")}`,
      );
    }

    if (!result) {
      log.warn("LLM response still unparseable; posting degraded raw review");
      const body = this.appendNotes(renderDegradedBody(raw), notes);
      if (!opts.dryRun) {
        await this.github.submitReview(
          req.installationId,
          req.owner,
          req.repo,
          req.pullNumber,
          body,
          [],
        );
      }
      await this.maybePostCheck(
        req,
        opts,
        config,
        "neutral",
        "Review degraded",
        "The model did not return structured findings; see the PR review for raw output.",
        body,
      );
      return { status: "degraded", body, inlineComments: [] };
    }

    // --- Jev: validate findings after the model produced them ---------------
    const findings = await this.judgeWithJev(jev, result.findings, filtered, notes, log);

    const placed = clampFindings(findings, filtered.included).filter(
      (p) => severities.has(p.finding.severity),
    );
    const body = renderReviewBody({
      summary: result.summary,
      overview: result.overview,
      fileSummaries: result.fileSummaries,
      placed,
      filtered,
      configWarnings,
      notes,
    });
    const posted = placed
      .filter((p) => p.line !== undefined)
      .map((p) => ({
        finding: p.finding,
        path: p.finding.file,
        line: p.line!,
        body: renderInlineComment(p.finding),
      }));

    if (!opts.dryRun) {
      await this.github.submitReview(
        req.installationId,
        req.owner,
        req.repo,
        req.pullNumber,
        body,
        posted.map((p) => ({ path: p.path, line: p.line, body: p.body })),
      );
      await this.recordFeedback(req, repoSlug, posted, log);
    }

    const gate = new Set(config.fail_on ?? []);
    const gated = placed.filter((p) => gate.has(p.finding.severity));
    const conclusion = gated.length > 0 ? "failure" : placed.length === 0 ? "success" : "neutral";
    const title =
      gated.length > 0
        ? `Found ${gated.length} gated finding(s)`
        : placed.length === 0
          ? "No findings"
          : `Found ${placed.length} finding(s)`;
    await this.maybePostCheck(req, opts, config, conclusion, title, body, body);
    log.info(
      { findings: placed.length, inline: posted.length, skipped: filtered.skipped.length },
      "PR review complete",
    );
    return { status: "reviewed", body, inlineComments: posted.map((p) => ({ path: p.path, line: p.line, body: p.body })) };
  }

  /** Best-effort check-run; missing Checks permission must never break the review. */
  private async maybePostCheck(
    req: ReviewRequest,
    opts: { dryRun?: boolean },
    config: RepoConfig | null,
    conclusion: "success" | "neutral" | "failure",
    title: string,
    summary: string,
    text?: string,
  ): Promise<void> {
    if (opts.dryRun) return;
    if (!this.env.CHECKS_ENABLED) return;
    if (config && config.checks === false) return;
    try {
      await this.github.createCheckRun(
        req.installationId,
        req.owner,
        req.repo,
        req.headSha,
        conclusion,
        title,
        summary,
        text,
      );
    } catch (e) {
      this.logger.warn({ err: e }, "Could not create check run; continuing without checks");
    }
  }

  /** Last-resort error report posted as a PR comment (called by the events layer). */
  async reportFailure(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    message: string,
  ): Promise<void> {
    await this.github.commentOnPR(
      installationId,
      owner,
      repo,
      pullNumber,
      renderFailureBody(message),
    );
  }

  // --- Jev decision layer ---------------------------------------------------

  /** Jev is used only when it is configured, enabled, and not disabled per repo. */
  private jevFor(config: RepoConfig): JevClient | null {
    if (!this.deps.jev) return null;
    if (config.jev === false) return null;
    return this.deps.jev;
  }

  private async routeComplexity(
    jev: JevClient | null,
    input: PromptInput,
    log: Logger,
  ): Promise<ComplexityRouting | null> {
    if (!jev) return null;
    try {
      return await routePRComplexity(jev, {
        prTitle: input.prTitle,
        files: input.files.map((f) => ({
          filename: f.filename,
          additions: f.additions,
          deletions: f.deletions,
        })),
        totalDiffChars: input.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0),
      });
    } catch (e) {
      log.warn({ err: e }, "Jev complexity routing failed; continuing without it");
      return null;
    }
  }

  private pickModel(routing: ComplexityRouting | null, config: RepoConfig): string | undefined {
    if (!config.models) return undefined;
    return modelForComplexity(routing?.complexity ?? "moderate", config.models, this.env.LLM_MODEL);
  }

  /**
   * Ask Jev to grade every finding in one call, then apply the decisions:
   * drop what it cannot support, re-grade severity when it disagrees.
   * Any Jev failure is non-fatal — findings pass through unchanged.
   */
  private async judgeWithJev(
    jev: JevClient | null,
    findings: Finding[],
    filtered: { included: { filename: string; patch?: string }[] },
    notes: string[],
    log: Logger,
  ): Promise<Finding[]> {
    if (!jev || findings.length === 0) return findings;

    const diffByFile = new Map<string, string>(
      filtered.included.map((f) => [f.filename, f.patch ?? ""]),
    );

    let judged;
    try {
      judged = await judgeFindings(jev, findings, { diffByFile });
    } catch (e) {
      log.warn({ err: e }, "Jev finding validation failed; keeping model output as-is");
      return findings;
    }

    const threshold = this.env.JEV_CONFIDENCE_THRESHOLD;
    const kept: Finding[] = [];
    let suppressedLow = 0;
    let suppressedPreexisting = 0;
    let regraded = 0;

    for (const judgement of judged) {
      const finding = findings[judgement.index]!;
      if (judgement.confidence < threshold) {
        suppressedLow++;
        continue;
      }
      if (judgement.introducedByDiff < MIN_INTRODUCED_BY_DIFF) {
        suppressedPreexisting++;
        continue;
      }
      if (
        judgement.severity !== finding.severity &&
        judgement.severityConfidence >= MIN_SEVERITY_CONFIDENCE
      ) {
        regraded++;
        kept.push({ ...finding, severity: judgement.severity });
        continue;
      }
      kept.push(finding);
    }

    if (suppressedLow > 0) {
      notes.push(
        `Jev suppressed ${suppressedLow} finding(s) below the confidence threshold (${threshold}/100)`,
      );
    }
    if (suppressedPreexisting > 0) {
      notes.push(`Jev suppressed ${suppressedPreexisting} finding(s) it judged pre-existing`);
    }
    if (regraded > 0) notes.push(`Jev re-graded the severity of ${regraded} finding(s)`);

    log.info(
      { kept: kept.length, suppressedLow, suppressedPreexisting, regraded },
      "Jev validated findings",
    );
    return kept;
  }

  // --- Feedback -------------------------------------------------------------

  private enrichWithFeedback(
    config: RepoConfig,
    repoSlug: string,
    opts: { dryRun?: boolean },
  ): string | undefined {
    if (opts.dryRun) return config.instructions;
    if (!this.deps.feedback) return config.instructions;
    if (config.feedback === false) return config.instructions;
    try {
      return enrichInstructions(config.instructions, this.deps.feedback.getPreferences(repoSlug));
    } catch (e) {
      this.logger.warn({ err: e }, "Could not read learned preferences; continuing without them");
      return config.instructions;
    }
  }

  /**
   * Match the inline comments GitHub actually created back to our findings and
   * persist them, so developer replies can be attributed later.
   */
  private async recordFeedback(
    req: ReviewRequest,
    repoSlug: string,
    posted: { finding: Finding; path: string; line: number; body: string }[],
    log: Logger,
  ): Promise<void> {
    const feedback = this.deps.feedback;
    if (!feedback || posted.length === 0) return;
    try {
      const comments = await this.github.listReviewComments(
        req.installationId,
        req.owner,
        req.repo,
        req.pullNumber,
      );
      const byBody = new Map<string, number>();
      for (const c of comments) {
        const key = `${c.path ?? ""}\u0000${c.line ?? ""}\u0000${c.body}`;
        if (!byBody.has(key)) byBody.set(key, c.id);
      }
      const items: { commentId: number; finding: Finding }[] = [];
      for (const p of posted) {
        const id = byBody.get(`${p.path}\u0000${p.line}\u0000${p.body}`);
        if (id) items.push({ commentId: id, finding: p.finding });
      }
      feedback.recordPostedFindings(repoSlug, req.pullNumber, items);
      log.debug({ recorded: items.length }, "Recorded findings for feedback learning");
    } catch (e) {
      log.warn({ err: e }, "Could not record findings for feedback learning");
    }
  }

  private appendNotes(body: string, notes: string[]): string {
    if (notes.length === 0) return body;
    return `${body}\n\n> ℹ️ ${notes.join(" · ")}`;
  }

  private async loadRepoConfig(req: ReviewRequest): Promise<{ config: RepoConfig; error?: string }> {
    try {
      const yml = await this.github.getFileContent(
        req.installationId,
        req.owner,
        req.repo,
        REPO_CONFIG_PATH,
        req.headSha,
      );
      if (yml === null) return { config: EMPTY_REPO_CONFIG };
      return parseRepoConfig(yml);
    } catch (e) {
      this.logger.warn({ err: e }, `Could not read ${REPO_CONFIG_PATH}; using defaults`);
      return { config: EMPTY_REPO_CONFIG };
    }
  }
}
