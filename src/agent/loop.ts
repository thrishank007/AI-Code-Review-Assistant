import { generateText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import type { GitHubClient } from "../github/client.js";
import type { Logger } from "../logger.js";
import { createChatModel, toLLMError, type AiSdkConfig } from "../llm/ai-sdk-client.js";
import { buildAgentMessages, type PromptInput } from "../review/prompt.js";
import { createReviewTools, type AgentToolContext } from "./tools.js";

/** Result of one agent run: the final text plus what it cost. */
export interface AgentRunResult {
  text: string;
  /** Model round trips taken. */
  steps: number;
  /** Tool names invoked, in order (repeats included). */
  toolCalls: string[];
  /** True when the loop hit its step ceiling before producing an answer. */
  exhausted: boolean;
}

/** Per-run GitHub coordinates the tools read from. */
export interface AgentToolContextInput {
  github: GitHubClient;
  installationId: number;
  owner: string;
  repo: string;
  /** Ref to read at — the PR head SHA. */
  headSha: string;
  /** Paths changed by the PR, used to label context reads. */
  changedPaths: string[];
}

export interface ReviewAgentRunOptions {
  /** Model override (Jev routing / per-repo config). */
  model?: string;
  /** Set on a retry after the previous answer failed schema validation. */
  repair?: string;
  /** GitHub coordinates for this PR. */
  tools: AgentToolContextInput;
}

/** The engine only ever needs this from an agent. */
export interface ReviewAgent {
  run(input: PromptInput, opts: ReviewAgentRunOptions): Promise<AgentRunResult>;
}

export interface ReviewAgentOptions {
  logger: Logger;
  /** Hard ceiling on model round trips per run. */
  maxSteps: number;
  /** Hard ceiling on tool calls per run. Defaults to `maxSteps`. */
  maxToolCalls?: number;
  /** Override model construction (used by tests and alternative providers). */
  modelFactory?: (modelId: string) => LanguageModel;
}

/** Last non-empty text in the step chain — providers leave `text` empty on tool-only steps. */
function pickFinalText(result: { text?: string; steps?: { text?: string }[] }): string {
  if (typeof result.text === "string" && result.text.trim()) return result.text;
  const steps = Array.isArray(result.steps) ? result.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const t = steps[i]?.text;
    if (typeof t === "string" && t.trim()) return t;
  }
  return "";
}

interface ToolLoopInput {
  system: string;
  user: string;
  tools: ToolSet;
  modelId: string;
  maxSteps: number;
  /** Overrides the configured JSON mode for this run (conversation = off). */
  jsonMode?: boolean;
  toolCalls: string[];
}

/**
 * One shared implementation of "call the model, let it use tools, collect the
 * final text". Both the review agent and the conversation agent ride on it.
 */
async function runToolLoop(
  cfg: AiSdkConfig,
  opts: ReviewAgentOptions,
  input: ToolLoopInput,
): Promise<AgentRunResult> {
  const model = opts.modelFactory
    ? opts.modelFactory(input.modelId)
    : createChatModel({ ...cfg, model: input.modelId, jsonMode: input.jsonMode ?? cfg.jsonMode });

  try {
    const result = await generateText({
      model,
      instructions: input.system,
      messages: [{ role: "user", content: input.user }],
      tools: input.tools,
      stopWhen: stepCountIs(Math.max(2, input.maxSteps)),
      temperature: 0.2,
      maxOutputTokens: cfg.maxTokens,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(cfg.timeoutMs),
    });

    const text = pickFinalText(result);
    const last = result.steps.at(-1);
    return {
      text,
      steps: result.steps.length,
      toolCalls: input.toolCalls,
      exhausted: !text.trim() && last?.finishReason === "tool-calls",
    };
  } catch (e) {
    throw toLLMError(e);
  }
}

/** Build the tool set for one run, wired to the shared call budget. */
function buildTools(
  ctx: AgentToolContextInput,
  opts: ReviewAgentOptions,
  toolCalls: string[],
  label: string,
): ToolSet {
  const budget = { used: 0 };
  const maxToolCalls = opts.maxToolCalls ?? opts.maxSteps;
  const full: AgentToolContext = {
    github: ctx.github,
    logger: opts.logger,
    installationId: ctx.installationId,
    owner: ctx.owner,
    repo: ctx.repo,
    headSha: ctx.headSha,
    changedPaths: ctx.changedPaths,
    maxToolCalls,
    budget,
    onToolCall: (name, toolInput) => {
      toolCalls.push(name);
      opts.logger.debug({ tool: name, input: toolInput, label }, "Agent tool call");
    },
  };
  return createReviewTools(full);
}

/**
 * Tool-calling review agent: the model may pull extra repository context before
 * committing to findings, then must answer with the review JSON.
 */
export class AiSdkReviewAgent implements ReviewAgent {
  constructor(
    private readonly cfg: AiSdkConfig,
    private readonly opts: ReviewAgentOptions,
  ) {}

  async run(input: PromptInput, runOpts: ReviewAgentRunOptions): Promise<AgentRunResult> {
    const toolCalls: string[] = [];
    const tools = buildTools(runOpts.tools, this.opts, toolCalls, "review");

    const [system, user] = buildAgentMessages(
      input,
      runOpts.repair ? { parseError: runOpts.repair } : undefined,
    );
    return runToolLoop(this.cfg, this.opts, {
      system: system!.content,
      user: user!.content,
      tools,
      modelId: runOpts.model ?? this.cfg.model,
      maxSteps: this.opts.maxSteps,
      jsonMode: this.cfg.jsonMode,
      toolCalls,
    });
  }
}

/** Exposed for the conversation agent, which needs the same loop. */
export { runToolLoop, buildTools };
