import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Logger } from "../logger.js";

/**
 * A Jev question. Structurally identical to the TypeSafe SDK's question types,
 * but declared here so callers (and tests) never depend on SDK internals.
 */
export type JevQuestion =
  | { type: "noul"; instructions?: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions?: string; criteria: Record<string, string> }
  | { type: "score"; instructions?: string; criteria: string[] };

/** A normalized answer, regardless of question type. */
export interface JevAnswer {
  type: "noul" | "choice" | "score";
  /** Probability of "yes" for noul questions (0-1). */
  noul?: number;
  /** Selected label for choice questions. */
  choice?: string;
  /** Position on the rubric for score questions; may fall between levels. */
  score?: number;
  /** Calibrated confidence (0-1) for choice and score questions. */
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevResult {
  /** Model that answered, e.g. `jev-1.13.0`. */
  model: string;
  answers: Record<string, JevAnswer>;
}

/** The narrow Jev surface the decision layer needs (easy to fake in tests). */
export interface JevClient {
  systemOne(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult>;
}

export interface JevConfig {
  apiKey: string;
  /** Defaults to https://api.typesafe.ai */
  baseURL?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  timeoutMs: number;
  logger: Logger;
}

function normalizeAnswers(raw: Record<string, any>): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!value || typeof value !== "object") continue;
    out[name] = {
      type: value.type ?? "noul",
      ...(typeof value.noul === "number" ? { noul: value.noul } : {}),
      ...(typeof value.choice === "string" ? { choice: value.choice } : {}),
      ...(typeof value.score === "number" ? { score: value.score } : {}),
      ...(typeof value.confidence === "number" ? { confidence: value.confidence } : {}),
      ...(value.probabilities ? { probabilities: value.probabilities } : {}),
    };
  }
  return out;
}

/** TypeSafe AI (Jev) client. Returns typed decisions, never generated text. */
export class TypeSafeJevClient implements JevClient {
  private readonly client: TypeSafeClient;

  constructor(cfg: JevConfig) {
    this.client = new TypeSafeClient({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      ...(cfg.model ? { defaultModel: cfg.model } : {}),
      timeout: cfg.timeoutMs,
      // The reviewer owns logging; keep the SDK quiet.
      logLevel: "off",
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, ...args) => cfg.logger.warn({ args }, message),
        error: (message, ...args) => cfg.logger.error({ args }, message),
      },
    });
  }

  async systemOne(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
    const result = await this.client.systemOne({
      state,
      questions,
    } as any);
    return {
      model: result.model,
      answers: normalizeAnswers(result.answers as Record<string, any>),
    };
  }
}

/** Build a Jev client, or null when the feature is off / unconfigured. */
export function createJevClient(
  cfg: { apiKey?: string; baseURL?: string; model?: string; timeoutMs: number; enabled: boolean },
  logger: Logger,
): JevClient | null {
  if (!cfg.enabled) {
    logger.info("Jev decision layer disabled (JEV_ENABLED=false)");
    return null;
  }
  if (!cfg.apiKey) {
    logger.warn(
      "Jev decision layer disabled: set TYPESAFE_API_KEY to enable complexity routing, confidence scoring, and severity validation",
    );
    return null;
  }
  return new TypeSafeJevClient({
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    logger,
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    ...(cfg.model ? { model: cfg.model } : {}),
  });
}
