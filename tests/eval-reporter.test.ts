import { describe, expect, it } from "vitest";
import {
  caseIcon,
  caseStats,
  renderConsole,
  renderMarkdown,
  reportFilename,
  sanitizeModelForFilename,
} from "../evals/src/reporter.js";
import type { CaseResult, EvalReport } from "../evals/src/types.js";

function caseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: "sql-injection",
    caseName: "SQL injection",
    category: "golden",
    runIndex: 0,
    rawLLMResponse: "{}",
    parsedOnFirstTry: true,
    reviewResult: { summary: "ok", findings: [] },
    outcome: { status: "reviewed", body: "ok", inlineComments: [] },
    matches: [
      {
        expected: { file: "src/db/users.ts", lineRange: [10, 12], severity: "critical" },
        actual: {
          file: "src/db/users.ts",
          line: 11,
          severity: "critical",
          category: "security",
          title: "SQL injection",
          body: "Use parameters.",
        },
        fileMatched: true,
        lineMatched: true,
        severityMatched: true,
        titleMatched: true,
      },
    ],
    unmatchedActual: [],
    latencyMs: 1500,
    promptTokenEstimate: 500,
    completionTokenEstimate: 100,
    ...overrides,
  };
}

function report(cases: CaseResult[]): EvalReport {
  return {
    timestamp: "2026-09-11T10:30:00.000Z",
    model: "test-model",
    datasetFilter: "all",
    cases,
    metrics: {
      formatCompliance: 1,
      precision: 1,
      recall: 1,
      lineAccuracy: 1,
      severityCalibration: 1,
      consistency: 1,
      avgLatencyMs: 1500,
      totalTokenEstimate: 600,
    },
    durationMs: 2000,
  };
}

describe("caseStats", () => {
  it("computes per-case precision/recall", () => {
    expect(caseStats(caseResult())).toMatchObject({ matched: 1, expected: 1, precision: 1, recall: 1 });
  });

  it("returns null precision/recall for expectation-free cases", () => {
    const s = caseStats(caseResult({ matches: [], unmatchedActual: [] }));
    expect(s.precision).toBeNull();
    expect(s.recall).toBeNull();
  });
});

describe("caseIcon", () => {
  it("marks unparseable cases as failed", () => {
    expect(caseIcon(caseResult({ parsedOnFirstTry: false }))).toBe("❌");
  });

  it("marks perfect cases as passed", () => {
    expect(caseIcon(caseResult())).toBe("✅");
  });
});

describe("renderConsole", () => {
  it("shows n/a for consistency with a single run per case", () => {
    const out = renderConsole(report([caseResult()]), "report.md");
    expect(out).toContain("n/a (repeat=1)");
    expect(out).toContain("sql-injection");
  });

  it("shows the consistency bar when cases ran multiple times", () => {
    const out = renderConsole(
      report([caseResult({ runIndex: 0 }), caseResult({ runIndex: 1 })]),
      "report.md",
    );
    expect(out).not.toContain("n/a (repeat=1)");
    expect(out).toContain("Consistency");
  });
});

describe("renderMarkdown", () => {
  it("renders header, metrics, per-case rows, and match details", () => {
    const md = renderMarkdown(report([caseResult()]), []);
    expect(md).toContain("# Eval Report — test-model");
    expect(md).toContain("| Format compliance | 100% |");
    expect(md).toContain("| sql-injection | golden | ✅ | 100% | 100% |");
    expect(md).toContain("### ✅ sql-injection");
    expect(md).toContain("No other reports");
  });

  it("lists existing reports for comparison", () => {
    const md = renderMarkdown(report([caseResult()]), ["older_model.md"]);
    expect(md).toContain("`older_model.md`");
  });

  it("notes snapshot-style cases without expectations", () => {
    const md = renderMarkdown(
      report([caseResult({ caseId: "snap", matches: [], unmatchedActual: [] })]),
      [],
    );
    expect(md).toContain("No expectations declared");
  });
});

describe("reportFilename", () => {
  it("builds a timestamped filename with a sanitized model", () => {
    expect(reportFilename(report([]))).toBe("2026-09-11T10-30-00-000Z_test-model.md");
    expect(sanitizeModelForFilename("org/model:v2")).toBe("org-model-v2");
  });
});
