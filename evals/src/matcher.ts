import type { Finding } from "../../src/types.js";
import type { ExpectedFinding, FindingMatch } from "./types.js";

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function fileMatches(expectedFile: string, actualFile: string): boolean {
  return expectedFile === actualFile || basename(expectedFile) === basename(actualFile);
}

function lineMatches(expected: ExpectedFinding, actual: Finding): boolean {
  if (!expected.lineRange) return true;
  const [start, end] = expected.lineRange;
  return actual.line >= start && actual.line <= end;
}

function severityMatches(expected: ExpectedFinding, actual: Finding): boolean {
  return Array.isArray(expected.severity)
    ? expected.severity.includes(actual.severity)
    : expected.severity === actual.severity;
}

function safeRegexMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
}

function titleMatches(expected: ExpectedFinding, actual: Finding): boolean {
  if (!expected.titlePattern) return true;
  return safeRegexMatch(expected.titlePattern, actual.title);
}

function bodyMatches(expected: ExpectedFinding, actual: Finding): boolean {
  if (!expected.bodyPattern) return true;
  return safeRegexMatch(expected.bodyPattern, actual.body);
}

/** Score an (expected, actual) pair 0–4 per the plan's rubric. */
export function scorePair(expected: ExpectedFinding, actual: Finding): number {
  let score = 0;
  if (fileMatches(expected.file, actual.file)) score += 1;
  if (lineMatches(expected, actual)) score += 1;
  if (severityMatches(expected, actual)) score += 1;
  if (titleMatches(expected, actual)) score += 1;
  return score;
}

export interface MatchResult {
  matches: FindingMatch[];
  unmatchedActual: Finding[];
}

/**
 * Greedy best-match: repeatedly pick the highest-scoring unassigned
 * (expected, actual) pair with score >= 1 where the file matches.
 * Unmatched expected findings become misses (actual: null);
 * unmatched actual findings become false positives.
 */
export function matchFindings(
  expected: ExpectedFinding[],
  actual: Finding[],
): MatchResult {
  interface Candidate {
    expectedIdx: number;
    actualIdx: number;
    score: number;
  }

  const candidates: Candidate[] = [];
  for (let e = 0; e < expected.length; e++) {
    for (let a = 0; a < actual.length; a++) {
      const exp = expected[e]!;
      const act = actual[a]!;
      if (!fileMatches(exp.file, act.file)) continue;
      const score = scorePair(exp, act);
      if (score >= 1) candidates.push({ expectedIdx: e, actualIdx: a, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);

  const usedExpected = new Set<number>();
  const usedActual = new Set<number>();
  const matches: FindingMatch[] = [];

  for (const c of candidates) {
    if (usedExpected.has(c.expectedIdx) || usedActual.has(c.actualIdx)) continue;
    usedExpected.add(c.expectedIdx);
    usedActual.add(c.actualIdx);
    const exp = expected[c.expectedIdx]!;
    const act = actual[c.actualIdx]!;
    matches.push({
      expected: exp,
      actual: act,
      fileMatched: fileMatches(exp.file, act.file),
      lineMatched: lineMatches(exp, act),
      severityMatched: severityMatches(exp, act),
      titleMatched: titleMatches(exp, act) && (!exp.bodyPattern || bodyMatches(exp, act)),
    });
  }

  // Misses: every expected finding that was never assigned.
  for (let e = 0; e < expected.length; e++) {
    if (usedExpected.has(e)) continue;
    matches.push({
      expected: expected[e]!,
      actual: null,
      fileMatched: false,
      lineMatched: false,
      severityMatched: false,
      titleMatched: false,
    });
  }

  // Preserve the original expected order for stable reporting.
  matches.sort((a, b) => expected.indexOf(a.expected) - expected.indexOf(b.expected));

  const unmatchedActual = actual.filter((_, i) => !usedActual.has(i));
  return { matches, unmatchedActual };
}
