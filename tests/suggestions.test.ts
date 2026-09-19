import { describe, expect, it } from "vitest";
import { parseReviewResult } from "../src/review/findings.js";
import { renderInlineComment, renderSuggestion } from "../src/review/report.js";
import type { Finding } from "../src/types.js";

const base: Finding = {
  file: "src/app.ts",
  line: 2,
  severity: "warning",
  confidence: "high",
  title: "Missing await",
  body: "The call is not awaited.",
};

describe("renderSuggestion", () => {
  it("wraps a fix in a GitHub suggestion block", () => {
    expect(renderSuggestion("const x = await fetchData();")).toBe(
      "```suggestion\nconst x = await fetchData();\n```",
    );
  });

  it("preserves multi-line fixes and drops trailing blank lines", () => {
    expect(renderSuggestion("a();\nb();\n\n")).toBe("```suggestion\na();\nb();\n```");
  });

  it("normalizes CRLF from a Windows-authored diff", () => {
    expect(renderSuggestion("a();\r\nb();")).toBe("```suggestion\na();\nb();\n```");
  });

  it("returns null for missing or blank fixes", () => {
    expect(renderSuggestion(undefined)).toBeNull();
    expect(renderSuggestion("")).toBeNull();
    expect(renderSuggestion("   \n  ")).toBeNull();
  });

  it("refuses a fix containing a code fence, which would break out of the block", () => {
    expect(renderSuggestion("```js\nx()\n```")).toBeNull();
  });
});

describe("renderInlineComment with a fix", () => {
  it("appends the suggestion after the body", () => {
    const body = renderInlineComment({ ...base, fix: "await fetchData();" });
    expect(body).toBe(
      [
        "**🟠 warning · high — Missing await**",
        "",
        "The call is not awaited.",
        "",
        "```suggestion",
        "await fetchData();",
        "```",
      ].join("\n"),
    );
  });

  it("is unchanged when there is no fix", () => {
    const body = renderInlineComment(base);
    expect(body).not.toContain("suggestion");
    expect(body).toBe("**🟠 warning · high — Missing await**\n\nThe call is not awaited.");
  });

  it("still renders the finding when the fix cannot be expressed as a suggestion", () => {
    const body = renderInlineComment({ ...base, fix: "```\nbad\n```" });
    expect(body).toContain("Missing await");
    expect(body).not.toContain("```suggestion");
  });
});

describe("findings with an optional fix", () => {
  function parsed(over: Partial<Finding> = {}) {
    const finding = { ...base, ...over };
    return parseReviewResult(
      JSON.stringify({ summary: "s", overview: "o", fileSummaries: [], findings: [finding] }),
    );
  }

  it("accepts a finding that carries a fix", () => {
    expect(parsed({ fix: "await fetchData();" })?.findings[0]?.fix).toBe("await fetchData();");
  });

  it("accepts a finding without a fix", () => {
    expect(parsed()?.findings[0]?.fix).toBeUndefined();
  });

  it("rejects an empty fix rather than rendering an empty suggestion", () => {
    expect(parsed({ fix: "" })).toBeNull();
  });
});
