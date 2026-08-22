import { z } from "zod";
import { SEVERITIES } from "../config.js";
import type { Finding, PlacedFinding, PRFile, ReviewResult } from "../types.js";

export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(SEVERITIES),
  category: z.string().default("general"),
  title: z.string().min(1),
  body: z.string().min(1),
});

export const ReviewResultSchema = z.object({
  summary: z.string().default(""),
  findings: z.array(FindingSchema).default([]),
});

/**
 * Parse an LLM response into a validated ReviewResult.
 * Tolerates markdown fences and prose around the JSON object.
 * Returns null when the response cannot be salvaged.
 */
export function parseReviewResult(raw: string): ReviewResult | null {
  let candidate = raw.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidate = fence[1]!.trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return ReviewResultSchema.parse(JSON.parse(candidate.slice(start, end + 1)));
  } catch {
    return null;
  }
}

export interface LineRange {
  start: number;
  end: number;
}

/**
 * Extract the new-file line ranges that are actually visible in a unified
 * diff patch (added + context lines per hunk). These are the only lines
 * GitHub will accept inline review comments on (RIGHT side).
 */
export function parsePatchRanges(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  let current: LineRange | null = null;
  let newline = 0;

  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(?:\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newline = parseInt(hunk[1]!, 10);
      current = null;
      continue;
    }
    if (line.startsWith("+")) {
      if (!current) {
        current = { start: newline, end: newline };
        ranges.push(current);
      } else {
        current.end = newline;
      }
      newline++;
    } else if (line.startsWith(" ")) {
      if (!current) {
        current = { start: newline, end: newline };
        ranges.push(current);
      } else {
        current.end = newline;
      }
      newline++;
    }
    // "-" lines belong to the old version; "\" markers and blanks are metadata.
  }
  return ranges;
}

function clampToNearest(line: number, ranges: LineRange[]): number {
  let best = ranges[0]!.start;
  let bestDist = Infinity;
  for (const r of ranges) {
    for (const edge of [r.start, r.end]) {
      const dist = Math.abs(edge - line);
      if (dist < bestDist) {
        bestDist = dist;
        best = edge;
      }
    }
  }
  return best;
}

/**
 * Validate LLM-reported file/line pairs against the real diff so GitHub never
 * rejects the review with "unable to create comment". Findings that cannot be
 * placed inline (file not in diff, deleted file, no visible lines) are kept
 * with `line` undefined so the report moves them to the summary section.
 */
export function clampFindings(findings: Finding[], files: PRFile[]): PlacedFinding[] {
  const byPath = new Map<string, { ranges: LineRange[]; removed: boolean }>();
  for (const f of files) {
    byPath.set(f.filename, {
      ranges: f.patch ? parsePatchRanges(f.patch) : [],
      removed: f.status === "removed",
    });
  }

  return findings.map((finding) => {
    let entry = byPath.get(finding.file);
    if (!entry) {
      // Tolerate the model returning a basename or wrong-ish prefix.
      const base = finding.file.split("/").pop()!;
      for (const [path, e] of byPath) {
        if (path.split("/").pop() === base) {
          entry = e;
          break;
        }
      }
    }
    if (!entry) {
      return { finding, reason: "file-not-in-diff" as const };
    }
    if (entry.removed || entry.ranges.length === 0) {
      return { finding, reason: "no-valid-lines" as const };
    }
    const inRange = entry.ranges.some((r) => finding.line >= r.start && finding.line <= r.end);
    return { finding, line: inRange ? finding.line : clampToNearest(finding.line, entry.ranges) };
  });
}
