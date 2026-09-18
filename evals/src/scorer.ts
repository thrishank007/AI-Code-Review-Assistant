import type { CaseResult, EvalMetrics } from "./types.js";

/** Identity key for a finding set element (used for Jaccard consistency). */
export function findingKey(f: { file: string; severity: string; title: string }): string {
  return `${f.file}::${f.severity}::${f.title.trim().toLowerCase()}`;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Compute aggregate metrics across all case results.
 *
 * Cases without expectations (snapshots, or cases with no `expected` block)
 * contribute only to format compliance, latency, and token metrics —
 * not to precision/recall.
 */
export function scoreResults(cases: CaseResult[]): EvalMetrics {
  if (cases.length === 0) {
    return {
      formatCompliance: 1,
      precision: 1,
      recall: 1,
      lineAccuracy: 1,
      severityCalibration: 1,
      consistency: 1,
      avgLatencyMs: 0,
      totalTokenEstimate: 0,
    };
  }

  const firstTry = cases.filter((c) => c.parsedOnFirstTry).length;
  const formatCompliance = firstTry / cases.length;

  let totalMatched = 0;
  let totalUnmatchedActual = 0;
  let totalExpected = 0;
  let lineSpecified = 0;
  let lineCorrect = 0;
  let severityCorrect = 0;

  for (const c of cases) {
    const matched = c.matches.filter((m) => m.actual !== null);
    totalMatched += matched.length;
    totalUnmatchedActual += c.unmatchedActual.length;
    totalExpected += c.matches.length;
    for (const m of matched) {
      if (m.expected.lineRange) {
        lineSpecified += 1;
        if (m.lineMatched) lineCorrect += 1;
      }
      if (m.severityMatched) severityCorrect += 1;
    }
  }

  const precision =
    totalMatched + totalUnmatchedActual === 0 ? 1 : totalMatched / (totalMatched + totalUnmatchedActual);
  const recall = totalExpected === 0 ? 1 : totalMatched / totalExpected;
  const lineAccuracy = lineSpecified === 0 ? 1 : lineCorrect / lineSpecified;
  const severityCalibration = totalMatched === 0 ? 1 : severityCorrect / totalMatched;

  const consistency = scoreConsistency(cases);

  const avgLatencyMs = cases.reduce((s, c) => s + c.latencyMs, 0) / cases.length;
  const totalTokenEstimate = cases.reduce(
    (s, c) => s + c.promptTokenEstimate + c.completionTokenEstimate,
    0,
  );

  return {
    formatCompliance,
    precision,
    recall,
    lineAccuracy,
    severityCalibration,
    consistency,
    avgLatencyMs,
    totalTokenEstimate,
  };
}

/**
 * Consistency = average pairwise Jaccard similarity of finding sets across
 * repeat runs of the same case (grouped by caseId). With a single run per
 * case there is nothing to compare, so it returns 1.0 (not measured).
 */
export function scoreConsistency(cases: CaseResult[]): number {
  const byCase = new Map<string, CaseResult[]>();
  for (const c of cases) {
    const group = byCase.get(c.caseId) ?? [];
    group.push(c);
    byCase.set(c.caseId, group);
  }

  const groups = [...byCase.values()].filter((g) => g.length > 1);
  if (groups.length === 0) return 1;

  const groupScores: number[] = [];
  for (const group of groups) {
    const sets = group.map(
      (c) =>
        new Set([
          ...(c.reviewResult?.findings ?? []).map(findingKey),
        ]),
    );
    let pairSum = 0;
    let pairCount = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        pairSum += jaccard(sets[i]!, sets[j]!);
        pairCount++;
      }
    }
    groupScores.push(pairCount === 0 ? 1 : pairSum / pairCount);
  }

  return groupScores.reduce((s, v) => s + v, 0) / groupScores.length;
}

/** Rough token estimate used when the provider reports no usage: ceil(chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
