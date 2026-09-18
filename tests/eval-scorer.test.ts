import { describe, expect, it } from "vitest";
import { estimateTokens, scoreConsistency, scoreResults } from "../evals/src/scorer.js";
import type { CaseResult, FindingMatch } from "../evals/src/types.js";
import type { Finding } from "../src/types.js";

function actual(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    line: 10,
    severity: "warning",
    category: "bug",
    title: "Null dereference",
    body: "Guard this access.",
    ...overrides,
  };
}

function hit(lineMatched = true, severityMatched = true): FindingMatch {
  return {
    expected: {
      file: "src/app.ts",
      lineRange: [8, 12],
      severity: "warning",
    },
    actual: actual(),
    fileMatched: true,
    lineMatched,
    severityMatched,
    titleMatched: true,
  };
}

function miss(): FindingMatch {
  return {
    expected: { file: "src/app.ts", severity: "warning" },
    actual: null,
    fileMatched: false,
    lineMatched: false,
    severityMatched: false,
    titleMatched: false,
  };
}

function caseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: "case-1",
    caseName: "Case 1",
    category: "golden",
    runIndex: 0,
    rawLLMResponse: "{}",
    parsedOnFirstTry: true,
    reviewResult: { summary: "ok", findings: [actual()] },
    outcome: { status: "reviewed", body: "ok", inlineComments: [] },
    matches: [hit()],
    unmatchedActual: [],
    latencyMs: 1000,
    promptTokenEstimate: 500,
    completionTokenEstimate: 100,
    ...overrides,
  };
}

describe("scoreResults", () => {
  it("scores a perfect run as 1.0 across quality metrics", () => {
    const m = scoreResults([caseResult()]);
    expect(m.formatCompliance).toBe(1);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.lineAccuracy).toBe(1);
    expect(m.severityCalibration).toBe(1);
    expect(m.consistency).toBe(1);
    expect(m.avgLatencyMs).toBe(1000);
    expect(m.totalTokenEstimate).toBe(600);
  });

  it("computes precision/recall across cases with misses and false positives", () => {
    const m = scoreResults([
      caseResult({ matches: [hit(), miss()], unmatchedActual: [actual({ title: "Noise" })] }),
    ]);
    // 1 matched, 1 missed, 1 false positive
    expect(m.precision).toBeCloseTo(1 / 2);
    expect(m.recall).toBeCloseTo(1 / 2);
  });

  it("counts line accuracy only when lineRange is specified", () => {
    const noRange: FindingMatch = {
      ...hit(),
      expected: { file: "src/app.ts", severity: "warning" },
      lineMatched: false, // irrelevant without a range
    };
    const m = scoreResults([
      caseResult({ matches: [hit(true), hit(false), noRange] }),
    ]);
    expect(m.lineAccuracy).toBeCloseTo(1 / 2);
  });

  it("measures severity calibration over matched findings", () => {
    const m = scoreResults([
      caseResult({ matches: [hit(true, true), hit(true, false)] }),
    ]);
    expect(m.severityCalibration).toBeCloseTo(1 / 2);
  });

  it("measures format compliance as the first-try parse fraction", () => {
    const m = scoreResults([
      caseResult(),
      caseResult({ caseId: "case-2", parsedOnFirstTry: false }),
    ]);
    expect(m.formatCompliance).toBeCloseTo(1 / 2);
  });

  it("excludes snapshot-style cases (no matches, no false positives) from precision/recall", () => {
    const snapshot = caseResult({
      caseId: "snap-1",
      category: "snapshot",
      matches: [],
      unmatchedActual: [],
      reviewResult: { summary: "clean", findings: [] },
    });
    const m = scoreResults([caseResult(), snapshot]);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.avgLatencyMs).toBe(1000);
  });

  it("averages latency and sums tokens", () => {
    const m = scoreResults([
      caseResult({ latencyMs: 1000, promptTokenEstimate: 100, completionTokenEstimate: 50 }),
      caseResult({ caseId: "c2", latencyMs: 3000, promptTokenEstimate: 200, completionTokenEstimate: 50 }),
    ]);
    expect(m.avgLatencyMs).toBe(2000);
    expect(m.totalTokenEstimate).toBe(400);
  });

  it("returns neutral defaults for an empty result set", () => {
    const m = scoreResults([]);
    expect(m).toMatchObject({
      formatCompliance: 1,
      precision: 1,
      recall: 1,
      avgLatencyMs: 0,
      totalTokenEstimate: 0,
    });
  });
});

describe("scoreConsistency", () => {
  function runWithTitles(caseId: string, runIndex: number, titles: string[]): CaseResult {
    return caseResult({
      caseId,
      runIndex,
      reviewResult: {
        summary: "",
        findings: titles.map((title) => actual({ title })),
      },
    });
  }

  it("returns 1.0 when every case ran once (not measured)", () => {
    expect(scoreConsistency([caseResult(), caseResult({ caseId: "c2" })])).toBe(1);
  });

  it("returns 1.0 for identical repeat runs", () => {
    expect(
      scoreConsistency([
        runWithTitles("c1", 0, ["A", "B"]),
        runWithTitles("c1", 1, ["A", "B"]),
      ]),
    ).toBe(1);
  });

  it("penalizes divergent repeat runs", () => {
    const score = scoreConsistency([
      runWithTitles("c1", 0, ["A", "B"]),
      runWithTitles("c1", 1, ["A", "C"]),
    ]);
    // Jaccard({A,B},{A,C}) = 1/3
    expect(score).toBeCloseTo(1 / 3);
  });

  it("treats two empty finding sets as identical", () => {
    expect(
      scoreConsistency([runWithTitles("c1", 0, []), runWithTitles("c1", 1, [])]),
    ).toBe(1);
  });
});

describe("estimateTokens", () => {
  it("estimates ceil(chars / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
