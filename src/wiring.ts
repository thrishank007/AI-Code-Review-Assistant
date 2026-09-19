import type { Env } from "./config.js";
import type { Logger } from "./logger.js";
import type { GitHubClient } from "./github/client.js";
import { AiSdkConversationAgent, ConversationEngine } from "./agent/conversation.js";
import { AiSdkReviewAgent } from "./agent/loop.js";
import { createFeedbackTracker, type FeedbackTracker } from "./feedback/tracker.js";
import { createJevClient, type JevClient } from "./jev/client.js";
import { createLLMClient, llmConfigFromEnv, supportsToolCalling } from "./llm/factory.js";
import type { LLMClientLike } from "./llm/types.js";
import { ReviewEngine } from "./review/engine.js";

/** Replies are cheap conversations, not full reviews — keep the loop short. */
const CONVERSATION_MAX_STEPS = 4;

export interface ReviewerStack {
  llm: LLMClientLike;
  jev: JevClient | null;
  feedback: FeedbackTracker | null;
  reviewAgent: AiSdkReviewAgent | undefined;
  conversation: ConversationEngine | undefined;
  engine: ReviewEngine;
  /** Release the SQLite handle. Safe to call more than once. */
  close(): void;
}

/**
 * Assemble the whole reviewer from the environment: LLM client, Jev decision
 * layer, feedback store, review agent, conversation agent, and the engine that
 * ties them together. Shared by the server entrypoint and the dev CLI so the
 * two can never drift.
 */
export async function createReviewerStack(
  env: Env,
  logger: Logger,
  github: GitHubClient,
): Promise<ReviewerStack> {
  const llm = createLLMClient(env);
  const llmCfg = llmConfigFromEnv(env);

  const jev = createJevClient(
    {
      apiKey: env.TYPESAFE_API_KEY,
      baseURL: env.TYPESAFE_BASE_URL,
      model: env.JEV_MODEL,
      timeoutMs: env.JEV_TIMEOUT_MS,
      enabled: env.JEV_ENABLED,
    },
    logger,
  );

  const feedback = env.FEEDBACK_ENABLED
    ? await createFeedbackTracker({ path: env.FEEDBACK_DB_PATH, logger })
    : null;
  if (feedback) logger.info({ path: env.FEEDBACK_DB_PATH }, "Feedback store ready");

  const toolsEnabled = supportsToolCalling(env);
  const reviewAgent = toolsEnabled
    ? new AiSdkReviewAgent(llmCfg, { logger, maxSteps: env.AGENT_MAX_STEPS })
    : undefined;
  if (!reviewAgent) {
    logger.info(
      { provider: env.LLM_PROVIDER, tools: env.AGENT_TOOLS_ENABLED },
      "Tool-calling agent disabled; using single-shot review",
    );
  }

  const conversationAgent = toolsEnabled
    ? new AiSdkConversationAgent(llmCfg, {
        logger,
        maxSteps: CONVERSATION_MAX_STEPS,
        maxToolCalls: CONVERSATION_MAX_STEPS,
      })
    : undefined;
  const conversation = conversationAgent
    ? new ConversationEngine({ github, agent: conversationAgent, logger, jev, feedback })
    : undefined;

  const engine = new ReviewEngine(github, llm, env, logger, { agent: reviewAgent, jev, feedback });

  return {
    llm,
    jev,
    feedback,
    reviewAgent,
    conversation,
    engine,
    close: () => feedback?.close(),
  };
}
