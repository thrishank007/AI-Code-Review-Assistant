import { describe, expect, it } from "vitest";
import { matchFindings, scorePair } from "../evals/src/matcher.js";
import type { ExpectedFinding } from "../evals/src/types.js";
import type { Finding } from "../src/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    line: 10,
    severity: "warning",
    category: "bug",
    title: "Possible null dereference",
    body: "Guard against null before access.",
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedFinding> = {}): ExpectedFinding {
  return {
    file: "src/app.ts",
    lineRange: [8, 12],
    severity: "warning",
    titlePattern: "null",
    ...overrides,
  };
}

describe("scorePair", () => {
  it("scores a perfect match as 4", () => {
    expect(scorePair(expected(), finding())).toBe(4);
  });

  it("deducts for each mismatched criterion", () => {
    expect(scorePair(expected(), finding({ line: 99 }))).toBe(3);
    expect(scorePair(expected(), finding({ severity: "nit" }))).toBe(3);
    expect(scorePair(expected(), finding({ title: "Unrelated style nit" }))).toBe(3);
  });

  it("treats absent lineRange/titlePattern as automatic matches", () => {
    const exp = expected({ lineRange: undefined, titlePattern: undefined });
    expect(scorePair(exp, finding({ line: 999, title: "anything" }))).toBe(4);
  });

  it("supports a list of acceptable severities", () => {
    const exp = expected({ severity: ["critical", "warning"] });
    expect(scorePair(exp, finding({ severity: "critical" }))).toBe(4);
    expect(scorePair(exp, finding({ severity: "nit" }))).toBe(3);
  });
});

describe("matchFindings", () => {
  it("pairs an exact match with all flags set", () => {
    const { matches, unmatchedActual } = matchFindings([expected()], [finding()]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actual).not.toBeNull();
    expect(matches[0]).toMatchObject({
      fileMatched: true,
      lineMatched: true,
      severityMatched: true,
      titleMatched: true,
    });
    expect(unmatchedActual).toHaveLength(0);
  });

  it("matches on basename when the model returns a short path", () => {
    const { matches } = matchFindings(
      [expected({ file: "src/deep/app.ts" })],
      [finding({ file: "app.ts" })],
    );
    expect(matches[0]!.actual).not.toBeNull();
    expect(matches[0]!.fileMatched).toBe(true);
  });

  it("reports misses and false positives separately", () => {
    const { matches, unmatchedActual } = matchFindings(
      [expected()],
      [finding({ file: "other/file.ts", title: "Something else" })],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actual).toBeNull();
    expect(unmatchedActual).toHaveLength(1);
  });

  it("greedily assigns the highest-scoring pair first", () => {
    const exps = [
      expected({ file: "a.ts", lineRange: [1, 5], severity: "warning", titlePattern: "alpha" }),
      expected({ file: "a.ts", lineRange: [1, 100], severity: "warning", titlePattern: undefined }),
    ];
    const acts = [
      // Matches both expected findings on file, but only the second on title.
      finding({ file: "a.ts", line: 3, title: "something generic" }),
    ];
    const { matches, unmatchedActual } = matchFindings(exps, acts);
    // The generic actual (score 3 vs exp[1]) must beat the partial (score 2 vs exp[0]).
    expect(matches[1]!.actual).not.toBeNull();
    expect(matches[0]!.actual).toBeNull();
    expect(unmatchedActual).toHaveLength(0);
  });

  it("never assigns the same actual finding twice", () => {
    const exps = [
      expected({ titlePattern: "null" }),
      expected({ titlePattern: undefined }),
    ];
    const { matches, unmatchedActual } = matchFindings(exps, [finding()]);
    const assigned = matches.filter((m) => m.actual !== null);
    expect(assigned).toHaveLength(1);
    expect(matches).toHaveLength(2);
    expect(unmatchedActual).toHaveLength(0);
  });

  it("handles empty inputs", () => {
    expect(matchFindings([], [])).toEqual({ matches: [], unmatchedActual: [] });
    const onlyActual = matchFindings([], [finding()]);
    expect(onlyActual.matches).toHaveLength(0);
    expect(onlyActual.unmatchedActual).toHaveLength(1);
  });

  it("treats an invalid titlePattern regex as a non-match, not a throw", () => {
    const { matches } = matchFindings([expected({ titlePattern: "([" })], [finding()]);
    expect(matches[0]!.actual).not.toBeNull();
    expect(matches[0]!.titleMatched).toBe(false);
  });
});
