import type { Logger } from "../logger.js";
import type { Env } from "../config.js";
import { DEFAULT_IGNORES, EMPTY_REPO_CONFIG, parseRepoConfig, SEVERITIES, type RepoConfig } from "../config.js";
import type { GitHubClient } from "../github/client.js";
import type { LLMClient } from "../llm/client.js";
import { clampFindings, parseReviewResult } from "./findings.js";
import { filterFiles } from "./filters.js";
import { buildMessages, JSON_REPAIR_USER_PROMPT } from "./prompt.js";
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

const REPO_CONFIG_PATH = ".aireview.yml";

export class ReviewEngine {
  constructor(
    private readonly github: GitHubClient,
    private readonly llm: LLMClient,
    private readonly env: Env,
    private readonly logger: Logger,
  ) {}

  async reviewPullRequest(
    req: ReviewRequest,
    opts: { dryRun?: boolean; force?: boolean } = {},
  ): Promise<ReviewOutcome> {
    const log = this.logger.child({ repo: `${req.owner}/${req.repo}`, pr: req.pullNumber, sha: req.headSha });
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

    const { config, error } = await this.loadRepoConfig(req);    const configWarnings = error ? [`Invalid ${REPO_CONFIG_PATH}: ${error}; using defaults`] : [];

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

    const messages = buildMessages({
      prTitle: req.title,
      prBody: req.body,
      files: filtered.included,
      instructions: config.instructions,
      skippedCount: files.length - filtered.included.length,
    });

    let raw = await this.llm.chat(messages);
    let result = parseReviewResult(raw);
    if (!result) {
      log.warn("LLM response failed JSON parsing; retrying with correction prompt");
      raw = await this.llm.chat([
        ...messages,
        { role: "assistant", content: raw },
        { role: "user", content: JSON_REPAIR_USER_PROMPT("not valid JSON matching the schema") },
      ]);
      result = parseReviewResult(raw);
    }

    if (!result) {
      log.warn("LLM response still unparseable; posting degraded raw review");
      const body = renderDegradedBody(raw, this.env.LLM_MODEL);
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

    const placed = clampFindings(result.findings, filtered.included).filter(
      (p) => severities.has(p.finding.severity),
    );
    const body = renderReviewBody({
      summary: result.summary,
      overview: result.overview,
      fileSummaries: result.fileSummaries,
      placed,
      filtered,
      model: this.env.LLM_MODEL,
      configWarnings,
    });
    const inlineComments = placed
      .filter((p) => p.line !== undefined)
      .map((p) => ({
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
        inlineComments,
      );
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
      { findings: placed.length, inline: inlineComments.length, skipped: filtered.skipped.length },
      "PR review complete",
    );
    return { status: "reviewed", body, inlineComments };
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
