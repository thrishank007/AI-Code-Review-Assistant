import type { GitHubClient, ReviewCommentDetail } from "../github/client.js";
import type { JevClient } from "../jev/client.js";
import { classifyReply } from "../jev/decisions.js";
import type { FeedbackTracker } from "../feedback/tracker.js";
import type { Logger } from "../logger.js";
import type { AiSdkConfig } from "../llm/ai-sdk-client.js";
import { buildConversationMessages, type ConversationPromptInput } from "../review/prompt.js";
import {
  buildTools,
  runToolLoop,
  type AgentRunResult,
  type AgentToolContextInput,
  type ReviewAgentOptions,
} from "./loop.js";

export interface ConversationAgentRunOptions {
  /** GitHub coordinates for this PR. */
  tools: AgentToolContextInput;
  /** Model override (Jev routing / per-repo config). */
  model?: string;
}

/**
 * Answers a developer's reply to one of our review comments. It gets the same
 * read-only repository tools as the reviewer, so it can verify a claim like
 * "the middleware already handles that" instead of guessing.
 */
export interface ConversationAgent {
  reply(input: ConversationPromptInput, opts: ConversationAgentRunOptions): Promise<AgentRunResult>;
}

export class AiSdkConversationAgent implements ConversationAgent {
  constructor(
    private readonly cfg: AiSdkConfig,
    private readonly opts: ReviewAgentOptions,
  ) {}

  async reply(
    input: ConversationPromptInput,
    runOpts: ConversationAgentRunOptions,
  ): Promise<AgentRunResult> {
    const toolCalls: string[] = [];
    const tools = buildTools(runOpts.tools, this.opts, toolCalls, "conversation");

    const [system, user] = buildConversationMessages(input);
    return runToolLoop(this.cfg, this.opts, {
      system: system!.content,
      user: user!.content,
      tools,
      modelId: runOpts.model ?? this.cfg.model,
      maxSteps: this.opts.maxSteps,
      // Replies are prose: never ask the provider for JSON here.
      jsonMode: false,
      toolCalls,
    });
  }
}

export interface ConversationRequest {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  /** The review comment the developer replied to. */
  parentCommentId: number;
  /** The developer's new reply. */
  reply: { id: number; body: string; author: string };
  prTitle: string;
  headSha: string;
  /** Optional reroute from the Jev complexity router. */
  model?: string;
}

export interface ConversationEngineDeps {
  github: GitHubClient;
  agent: ConversationAgent;
  logger: Logger;
  jev?: JevClient | null;
  feedback?: FeedbackTracker | null;
}

/** Only record a feedback signal when Jev is reasonably sure of the reading. */
const MIN_SIGNAL_CONFIDENCE = 0.65;

/**
 * Orchestrates a reply: rebuild the thread, let the agent verify claims against
 * the code, post the answer, then record how the developer reacted.
 */
export class ConversationEngine {
  constructor(private readonly deps: ConversationEngineDeps) {}

  async respond(
    req: ConversationRequest,
  ): Promise<{ status: "replied" | "skipped"; body?: string; reason?: string }> {
    const { github, logger } = this.deps;
    const log = logger.child({
      repo: `${req.owner}/${req.repo}`,
      pr: req.pullNumber,
      comment: req.parentCommentId,
    });

    const { parent, replies } = await github.getReviewCommentThread(
      req.installationId,
      req.owner,
      req.repo,
      req.pullNumber,
      req.parentCommentId,
    );
    if (!parent) {
      log.warn("Parent review comment no longer exists; skipping reply");
      return { status: "skipped", reason: "parent-missing" };
    }

    const thread = replies
      .filter((r: ReviewCommentDetail) => r.id !== req.reply.id)
      .map((r) => ({ author: r.user.login, body: r.body }));

    const result = await this.deps.agent.reply(
      {
        prTitle: req.prTitle,
        findingComment: parent.body,
        thread,
        reply: { author: req.reply.author, body: req.reply.body },
        ...(parent.path ? { file: parent.path } : {}),
        line: parent.line,
      },
      {
        tools: {
          github,
          installationId: req.installationId,
          owner: req.owner,
          repo: req.repo,
          headSha: req.headSha,
          changedPaths: await this.listChangedPaths(req, log),
        },
        ...(req.model ? { model: req.model } : {}),
      },
    );

    const body = result.text.trim();
    if (!body) {
      log.warn({ steps: result.steps }, "Conversation agent produced no reply");
      return { status: "skipped", reason: "empty-reply" };
    }

    await github.replyToReviewComment(
      req.installationId,
      req.owner,
      req.repo,
      req.pullNumber,
      req.parentCommentId,
      body,
    );
    log.info(
      { toolCalls: result.toolCalls.length, steps: result.steps },
      "Replied to review comment",
    );

    await this.recordSignal(req, parent, log);

    return { status: "replied", body };
  }

  /** Best-effort: the reply agent works fine without the changed-file list. */
  private async listChangedPaths(req: ConversationRequest, log: Logger): Promise<string[]> {
    try {
      const files = await this.deps.github.listPRFiles(
        req.installationId,
        req.owner,
        req.repo,
        req.pullNumber,
      );
      return files.map((f) => f.filename);
    } catch (e) {
      log.debug({ err: e }, "Could not list PR files for the conversation agent");
      return [];
    }
  }

  /**
   * Attribute the reply to the finding it answers. Requires Jev: without a
   * calibrated reading, guessing "disagreed" from keywords would poison the
   * preference store with false signals.
   */
  private async recordSignal(
    req: ConversationRequest,
    parent: ReviewCommentDetail,
    log: Logger,
  ): Promise<void> {
    const feedback = this.deps.feedback;
    const jev = this.deps.jev;
    if (!feedback || !jev) return;

    try {
      if (!feedback.findByCommentId(req.parentCommentId)) return;
      const verdict = await classifyReply(jev, {
        reply: req.reply.body,
        finding: parent.body,
      });

      let signal: "disputed" | "agreed" | null = null;
      if (verdict.disputes >= MIN_SIGNAL_CONFIDENCE && verdict.disputes > verdict.acknowledges) {
        signal = "disputed";
      } else if (
        verdict.acknowledges >= MIN_SIGNAL_CONFIDENCE &&
        verdict.acknowledges > verdict.disputes
      ) {
        signal = "agreed";
      }

      if (!signal) {
        log.debug({ verdict }, "Reply was inconclusive; no feedback signal recorded");
        return;
      }
      feedback.recordSignal(req.parentCommentId, signal);
      log.info({ signal }, "Recorded developer feedback signal");
    } catch (e) {
      log.warn({ err: e }, "Could not record developer feedback signal");
    }
  }
}
