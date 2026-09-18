import { describe, expect, it } from "vitest";
import { clampFindings, parsePatchRanges, parseReviewResult } from "../src/review/findings.js";
import type { Finding, PRFile } from "../src/types.js";

const validResult = {
  summary: "Adds a login endpoint.",
  findings: [
    {
      file: "src/auth.js",
      line: 12,
      severity: "critical",
      confidence: "high",
      title: "SQL injection in login query",
      body: "Concatenates user input into the query. Use parameterized queries.",
    },
  ],
};

describe("parseReviewResult", () => {
  it("parses a clean JSON response", () => {
    expect(parseReviewResult(JSON.stringify(validResult))).toEqual({
      summary: "Adds a login endpoint.",
      overview: "",
      fileSummaries: [],
      findings: [
        {
          file: "src/auth.js",
          line: 12,
          severity: "critical",
          confidence: "high",
          title: "SQL injection in login query",
          body: "Concatenates user input into the query. Use parameterized queries.",
        },
      ],
    });
  });

  it("parses overview and file summaries when present", () => {
    const raw = JSON.stringify({
      ...validResult,
      overview: "Adds login.",
      fileSummaries: [{ file: "src/auth.js", summary: "New endpoint." }],
    });
    const result = parseReviewResult(raw);
    expect(result?.overview).toBe("Adds login.");
    expect(result?.fileSummaries).toEqual([{ file: "src/auth.js", summary: "New endpoint." }]);
  });

  it("parses JSON wrapped in markdown fences", () => {
    const raw = "```json\n" + JSON.stringify(validResult) + "\n```";
    expect(parseReviewResult(raw)?.findings).toHaveLength(1);
  });

  it("parses JSON with prose around it", () => {
    const raw = `Here is my review:\n${JSON.stringify(validResult)}\nHope this helps!`;
    expect(parseReviewResult(raw)?.summary).toBe("Adds a login endpoint.");
  });

  it("defaults missing optional fields", () => {
    const raw = JSON.stringify({ summary: "s", findings: [{ file: "a.ts", line: 1, severity: "nit", title: "t", body: "b" }] });
    expect(parseReviewResult(raw)?.findings[0]!.confidence).toBe("high");
  });

  it("returns null for garbage", () => {
    expect(parseReviewResult("I could not review this")).toBeNull();
    expect(parseReviewResult("")).toBeNull();
  });

  it("returns null when severity is outside the vocabulary", () => {
    const bad = { ...validResult, findings: [{ ...validResult.findings[0]!, severity: "superbad" }] };
    expect(parseReviewResult(JSON.stringify(bad))).toBeNull();
  });
});

describe("parsePatchRanges", () => {
  const patch = [
    "@@ -1,4 +1,6 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const b2 = 4;",
    " const c = 5;",
    "@@ -20,3 +22,4 @@",
    " function x() {",
    "+  return null;",
    " }",
  ].join("\n");

  it("extracts new-file line ranges visible in the diff", () => {
    expect(parsePatchRanges(patch)).toEqual([
      { start: 1, end: 4 }, // context+adds across the removed line (new lines 1-4)
      { start: 22, end: 24 },
    ]);
  });

  it("returns empty for a patch with no hunks", () => {
    expect(parsePatchRanges("")).toEqual([]);
  });
});

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    line: 2,
    severity: "warning",
    category: "bug",
    title: "t",
    body: "b",
    ...over,
  };
}

function file(over: Partial<PRFile> = {}): PRFile {
  return {
    filename: "src/app.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: "@@ -1,3 +1,4 @@\n line1\n+line2\n+line3\n line4",
    ...over,
  };
}

describe("clampFindings", () => {
  it("keeps a finding whose line is inside a hunk", () => {
    const placed = clampFindings([finding({ line: 3 })], [file()]);
    expect(placed[0]!.line).toBe(3);
    expect(placed[0]!.reason).toBeUndefined();
  });

  it("clamps an out-of-range line to the nearest visible diff line", () => {
    // hunks cover 1..4; line 99 -> 4, line -5 -> 1
    expect(clampFindings([finding({ line: 99 })], [file()])[0]!.line).toBe(4);
    expect(clampFindings([finding({ line: -5 })], [file()])[0]!.line).toBe(1);
  });

  it("moves findings for files not in the diff to the summary", () => {
    const placed = clampFindings([finding({ file: "other/thing.ts" })], [file()]);
    expect(placed[0]!.line).toBeUndefined();
    expect(placed[0]!.reason).toBe("file-not-in-diff");
  });

  it("matches by basename when the model trims the directory", () => {
    const placed = clampFindings([finding({ file: "app.ts", line: 2 })], [file()]);
    expect(placed[0]!.line).toBe(2);
  });

  it("moves findings on removed files to the summary", () => {
    const placed = clampFindings(
      [finding({ line: 1 })],
      [file({ status: "removed", patch: "@@ -1,2 +0,0 @@\n-old1\n-old2" })],
    );
    expect(placed[0]!.reason).toBe("no-valid-lines");
  });

  it("moves findings on files without visible new lines to the summary", () => {
    const placed = clampFindings(
      [finding({ line: 1 })],
      [file({ patch: "@@ -1,2 +0,0 @@\n-a\n-b" })], // pure deletion, no right-side lines
    );
    expect(placed[0]!.reason).toBe("no-valid-lines");
  });
});
