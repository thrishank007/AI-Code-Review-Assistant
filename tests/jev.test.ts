import { describe, expect, it, vi } from "vitest";
import type { JevClient, JevQuestion, JevResult } from "../src/jev/client.js";
import { createJevClient } from "../src/jev/client.js";
import {
  classifyReply,
  judgeFindings,
  modelForComplexity,
  routePRComplexity,
  scoreFindingConfidence,
  validateSeverity,
} from "../src/jev/decisions.js";
import { createLogger } from "../src/logger.js";
import type { Finding } from "../src/types.js";

const logger = createLogger("fatal");

/** Fake Jev that answers from a lookup table keyed by question name. */
function fakeJev(answers: Record<string, unknown>): { jev: JevClient; calls: { state: unknown; questions: Record<string, JevQuestion> }[] } {
  const calls: { state: unknown; questions: Record<string, JevQuestion> }[] = [];
  const jev: JevClient = {
    systemOne: async (state, questions): Promise<JevResult> => {
      calls.push({ state, questions });
      return { model: "jev-test", answers: answers as JevResult["answers"] };
    },
  };
  return { jev, calls };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 3,
    severity: "warning",
    confidence: "high",
    title: "Missing await",
    body: "The call is not awaited.",
    ...over,
  };
}

describe("routePRComplexity", () => {
  it("returns the chosen label with its confidence", async () => {
    const { jev } = fakeJev({ complexity: { type: "choice", choice: "simple", confidence: 0.91 } });

    const routing = await routePRComplexity(jev, {
      prTitle: "Fix typo",
      files: [{ filename: "README.md", additions: 1, deletions: 1 }],
      totalDiffChars: 120,
    });

    expect(routing).toEqual({ complexity: "simple", confidence: 0.91 });
  });

  it("sends a compact factual state, not the diff itself", async () => {
    const { jev, calls } = fakeJev({ complexity: { type: "choice", choice: "moderate", confidence: 0.5 } });

    await routePRComplexity(jev, {
      prTitle: "Add caching",
      files: [{ filename: "src/a.ts", additions: 10, deletions: 2 }],
      totalDiffChars: 500,
    });

    const state = calls[0]!.state as any;
    expect(state.file_count).toBe(1);
    expect(state.diff_chars).toBe(500);
    expect(state.files[0]).toEqual({ path: "src/a.ts", added: 10, removed: 2 });
  });

  it("falls back to moderate for an unknown label", async () => {
    const { jev } = fakeJev({ complexity: { type: "choice", choice: "banana", confidence: 0.2 } });
    const routing = await routePRComplexity(jev, { prTitle: "t", files: [], totalDiffChars: 0 });
    expect(routing.complexity).toBe("moderate");
  });

  it("surfaces a missing answer as zero confidence", async () => {
    const { jev } = fakeJev({});
    const routing = await routePRComplexity(jev, { prTitle: "t", files: [], totalDiffChars: 0 });
    expect(routing).toEqual({ complexity: "moderate", confidence: 0 });
  });
});

describe("judgeFindings", () => {
  const context = { diffByFile: new Map([["src/a.ts", "@@ -1,2 +1,3 @@\n+const x = fetch()"]]) };

  it("asks one question set for every finding in a single call", async () => {
    const { jev, calls } = fakeJev({
      supported_0: { type: "score", score: 3, confidence: 0.9 },
      introduced_0: { type: "noul", noul: 0.95 },
      severity_0: { type: "choice", choice: "critical", confidence: 0.8 },
      supported_1: { type: "score", score: 1, confidence: 0.6 },
      introduced_1: { type: "noul", noul: 0.3 },
      severity_1: { type: "choice", choice: "nit", confidence: 0.4 },
    });

    const judged = await judgeFindings(jev, [finding(), finding({ title: "Other" })], context);

    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions).sort()).toEqual([
      "introduced_0",
      "introduced_1",
      "severity_0",
      "severity_1",
      "supported_0",
      "supported_1",
    ]);
    expect(judged[0]).toEqual({
      index: 0,
      confidence: 100,
      introducedByDiff: 0.95,
      severity: "critical",
      severityConfidence: 0.8,
    });
    expect(judged[1]!.confidence).toBe(33);
    expect(judged[1]!.severity).toBe("nit");
  });

  it("shows Jev the diff excerpt for each finding's file", async () => {
    const { jev, calls } = fakeJev({});
    await judgeFindings(jev, [finding()], context);
    const state = calls[0]!.state as any;
    expect(state.findings[0].diff_excerpt).toContain("fetch()");
  });

  it("keeps the model's severity when Jev's choice is not a known label", async () => {
    const { jev } = fakeJev({
      supported_0: { type: "score", score: 2 },
      introduced_0: { type: "noul", noul: 0.9 },
      severity_0: { type: "choice", choice: "catastrophic", confidence: 0.99 },
    });
    const judged = await judgeFindings(jev, [finding()], context);
    expect(judged[0]!.severity).toBe("warning");
  });

  it("makes no call for an empty finding list", async () => {
    const { jev, calls } = fakeJev({});
    expect(await judgeFindings(jev, [], context)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("exposes confidence-only and severity-only views", async () => {
    const answers = {
      supported_0: { type: "score", score: 2, confidence: 0.7 },
      introduced_0: { type: "noul", noul: 0.8 },
      severity_0: { type: "choice", choice: "suggestion", confidence: 0.9 },
    };
    const a = fakeJev(answers);
    expect(await scoreFindingConfidence(a.jev, [finding()], context)).toEqual([
      { index: 0, confidence: 67, introducedByDiff: 0.8 },
    ]);
    const b = fakeJev(answers);
    expect(await validateSeverity(b.jev, [finding()], context)).toEqual([
      { index: 0, severity: "suggestion", confidence: 0.9 },
    ]);
  });
});

describe("classifyReply", () => {
  it("returns calibrated probabilities for the three readings", async () => {
    const { jev } = fakeJev({
      disputes: { type: "noul", noul: 0.9 },
      acknowledges: { type: "noul", noul: 0.05 },
      asks_question: { type: "noul", noul: 0.4 },
    });

    expect(await classifyReply(jev, { reply: "that's wrong", finding: "body" })).toEqual({
      disputes: 0.9,
      acknowledges: 0.05,
      asksQuestion: 0.4,
    });
  });
});

describe("modelForComplexity", () => {
  it("prefers the routed key, then default, then the service model", () => {
    expect(
      modelForComplexity("complex", { complex: "big", default: "mid" }, "fallback"),
    ).toBe("big");
    expect(modelForComplexity("simple", { default: "mid" }, "fallback")).toBe("mid");
    expect(modelForComplexity("simple", { complex: "big" }, "fallback")).toBe("fallback");
    expect(modelForComplexity("simple", undefined, "fallback")).toBe("fallback");
  });
});

describe("createJevClient", () => {
  it("is disabled when the feature flag is off", () => {
    expect(createJevClient({ enabled: false, timeoutMs: 1000 }, logger)).toBeNull();
  });

  it("warns and disables itself when the API key is missing", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    expect(createJevClient({ enabled: true, timeoutMs: 1000 }, logger)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("builds a client when configured", () => {
    const client = createJevClient({ enabled: true, apiKey: "sk-test", timeoutMs: 1000 }, logger);
    expect(client).not.toBeNull();
    expect(typeof client!.systemOne).toBe("function");
  });
});
