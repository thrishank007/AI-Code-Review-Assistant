import { describe, expect, it } from "vitest";
import {
  renderDegradedBody,
  renderFailureBody,
  renderInlineComment,
  renderReviewBody,
  REVIEW_MARKER,
  verdictFor,
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
    confidence: "high",
    title: "Off-by-one",
    body: "Loop exits early. Use `i <= n`.",
    ...over,
  };
}

const baseInput = {
  summary: "Address the off-by-one and the unplaced finding.",
  overview: "This PR changes the main loop.",
  fileSummaries: [{ file: "src/app.ts", summary: "Reworks the main loop." }],
  placed: [
    { finding: finding(), line: 2 },
    { finding: finding({ severity: "critical", file: "gone.ts" }), reason: "file-not-in-diff" },
  ] as PlacedFinding[],
  filtered,
  configWarnings: [] as string[],
};

describe("verdictFor", () => {
  it("escalates with the highest severity", () => {
    expect(verdictFor([])).toContain("Looks good");
    expect(verdictFor([{ finding: finding({ severity: "nit" }) }])).toContain("Minor suggestions");
    expect(verdictFor([{ finding: finding({ severity: "suggestion" }) }])).toContain("Minor suggestions");
    expect(verdictFor(baseInput.placed)).toContain("Changes required");
    expect(verdictFor([{ finding: finding() }])).toContain("Changes recommended");
  });
});

describe("renderReviewBody", () => {
  const body = renderReviewBody(baseInput);

  it("starts with the dedupe marker and a verdict heading", () => {
    expect(body.startsWith(REVIEW_MARKER)).toBe(true);
    expect(body).toContain("## 🔴 Changes required");
  });

  it("includes summary, overview, and footer", () => {
    expect(body).toContain("Address the off-by-one");
    expect(body).toContain("This PR changes the main loop.");
    expect(body).toContain("commenting `/review`");
    expect(body).toContain("Self-hosted ai-pr-reviewer");
  });

  it("renders the three Copilot-style collapsed sections", () => {
    expect(body).toContain("<summary>Pull request overview</summary>");
    expect(body).toContain("<summary>File summaries</summary>");
    expect(body).toContain("<summary>Review details</summary>");
  });

  it("renders a file summary table row per changed file", () => {
    expect(body).toContain("| `src/app.ts` | Reworks the main loop. |");
  });

  it("groups findings by severity inside Review details", () => {
    expect(body).toContain("### 🟠 warning (1)");
    expect(body).toContain("### 🔴 critical (1)");
    expect(body).toContain("`src/app.ts:2` — Off-by-one");
    expect(body).toContain("`gone.ts`");
  });

  it("notes skipped files compactly", () => {
    expect(body).toContain("`dist/bundle.js`");
  });

  it("celebrates clean diffs but keeps overview sections", () => {
    const clean = renderReviewBody({
      ...baseInput,
      placed: [],
      fileSummaries: [],
      filtered: { ...filtered, skipped: [] },
    });
    expect(clean).toContain("## ✅ Looks good");
    expect(clean).toContain("No findings");
    expect(clean).toContain("<summary>File summaries</summary>");
  });

  it("includes config warnings", () => {
    const warn = renderReviewBody({
      ...baseInput,
      filtered: { ...filtered, skipped: [] },
      configWarnings: ["Invalid .aireview.yml: boom"],
    });
    expect(warn).toContain("Invalid .aireview.yml: boom");
  });
});

describe("renderInlineComment", () => {
  it("formats severity icon, confidence, title, and body", () => {
    const c = renderInlineComment(finding({ severity: "critical", confidence: "high" }));
    expect(c).toContain("🔴 critical · high — Off-by-one");
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
