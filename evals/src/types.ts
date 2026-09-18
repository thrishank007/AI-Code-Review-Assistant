import { z } from "zod";
import { SEVERITIES } from "../../src/config.js";
import type { Finding, PRFile, ReviewResult } from "../../src/types.js";
import type { ReviewOutcome } from "../../src/review/engine.js";

// ---- Dataset schemas ----

export const ExpectedFindingSchema = z.object({
  file: z.string().min(1),
  lineRange: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  severity: z.union([z.enum(SEVERITIES), z.array(z.enum(SEVERITIES)).min(1)]),
  category: z.string().optional(),
  titlePattern: z.string().optional(),
  bodyPattern: z.string().optional(),
});

export type ExpectedFinding = z.infer<typeof ExpectedFindingSchema>;

export const PRFileSchema = z.object({
  filename: z.string().min(1),
  status: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().optional(),
});

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(["golden", "synthetic", "snapshot"]),
  pr: z.object({
    title: z.string().min(1),
    body: z.string().nullable(),
  }),
  files: z.array(PRFileSchema).min(1),
  repoConfig: z.string().optional(),
  expected: z
    .object({
      findings: z.array(ExpectedFindingSchema).default([]),
      minFindings: z.number().int().nonnegative().optional(),
      maxFindings: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type EvalCase = z.infer<typeof EvalCaseSchema> & {
  // Narrow files to the shared PRFile type for engine consumption.
  files: PRFile[];
};

// ---- Result types ----

export interface FindingMatch {
  expected: ExpectedFinding;
  actual: Finding | null;
  fileMatched: boolean;
  lineMatched: boolean;
  severityMatched: boolean;
  titleMatched: boolean;
}

export interface CaseResult {
  caseId: string;
  caseName: string;
  category: string;
  /** Repeat-run index (0-based) when --repeat N > 1. */
  runIndex: number;
  // Raw outputs
  rawLLMResponse: string;
  parsedOnFirstTry: boolean;
  reviewResult: ReviewResult | null;
  outcome: ReviewOutcome;
  // Matching
  matches: FindingMatch[];
  unmatchedActual: Finding[];
  // Timing
  latencyMs: number;
  // Token estimate
  promptTokenEstimate: number;
  completionTokenEstimate: number;
}

export interface EvalMetrics {
  formatCompliance: number;
  precision: number;
  recall: number;
  lineAccuracy: number;
  severityCalibration: number;
  consistency: number;
  avgLatencyMs: number;
  totalTokenEstimate: number;
}

export interface EvalReport {
  timestamp: string;
  model: string;
  datasetFilter: string;
  cases: CaseResult[];
  metrics: EvalMetrics;
  durationMs: number;
}
