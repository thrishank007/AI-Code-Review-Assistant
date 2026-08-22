import { describe, expect, it } from "vitest";
import {
  renderDegradedBody,
  renderFailureBody,
  renderInlineComment,
  renderReviewBody,
  REVIEW_MARKER,
} from "../src/review/report.js";
import type { FilterResult } from "../src/review/filters.js";
import type { Finding, PlacedFinding } from "../src/types.js";

const filtered: FilterResult = {
  included: [
    {
      filename: "src/app.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      changes: 4,
      patch: "@@ -1,2 +1,4 @@\n x\n+y",
    },
  ],
  skipped: [{ path: "dist/bundle.js", reason: "ignored by config" }],
  truncatedByCount: false,
  truncatedBySize: false,
};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    line: 2,
    severity: "warning",
    category: "bug",
    title: "Off-by-one",
    body: "Loop exits early. Use `i <= n`.",
    ...over,
  };
}

describe("renderReviewBody", () => {
  const body = renderReviewBody({
    summary: "Solid change overall.",
    placed: [
      { finding: finding() },
      { finding: finding({ severity: "critical", file: "gone.ts" }), reason: "file-not-in-diff" },
    ] as PlacedFinding[],
    filtered,
    model: "qwen2.5-coder:7b",
    configWarnings: [],
  });

  it("starts with the dedupe marker and heading", () => {
    expect(body.startsWith(REVIEW_MARKER)).toBe(true);
    expect(body).toContain("## 🤖 AI Code Review");
  });

  it("includes summary, counts, and model footer", () => {
    expect(body).toContain("Solid change overall.");
    expect(body).toContain("Reviewed 1 files");
    expect(body).toContain("🔴 1 critical");
    expect(body).toContain("🟠 1 warning");
    expect(body).toContain("`qwen2.5-coder:7b`");
  });

  it("lists skipped files in a collapsed section", () => {
    expect(body).toContain("dist/bundle.js");
    expect(body).toContain("ignored by config");
    expect(body).toContain("<details>");
  });

  it("surfaces unplaceable findings in their own section", () => {
    expect(body).toContain("could not be placed inline");
    expect(body).toContain("`gone.ts`");
  });

  it("celebrates clean diffs", () => {
    const clean = renderReviewBody({
      summary: "Looks good.",
      placed: [],
      filtered: { ...filtered, skipped: [] },
      model: "m",
      configWarnings: [],
    });
    expect(clean).toContain("no findings 🎉");
  });

  it("includes config warnings", () => {
    const warn = renderReviewBody({
      summary: "s",
      placed: [],
      filtered: { ...filtered, skipped: [] },
      model: "m",
      configWarnings: ["Invalid .aireview.yml: boom"],
    });
    expect(warn).toContain("Invalid .aireview.yml: boom");
  });
});

describe("renderInlineComment", () => {
  it("formats severity icon, category, title, and body", () => {
    const c = renderInlineComment(finding({ severity: "critical", category: "security" }));
    expect(c).toContain("🔴 critical · security — Off-by-one");
    expect(c).toContain("Loop exits early.");
  });
});

describe("degraded and failure bodies", () => {
  it("degraded body carries the raw text and a warning", () => {
    const b = renderDegradedBody("The model rambled here", "m");
    expect(b.startsWith(REVIEW_MARKER)).toBe(true);
    expect(b).toContain("did not return structured findings");
    expect(b).toContain("The model rambled here");
  });

  it("failure body states the error", () => {
    const b = renderFailureBody("LLM returned HTTP 502");
    expect(b).toContain("LLM returned HTTP 502");
  });
});
