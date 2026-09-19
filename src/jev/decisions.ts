import type { PRComplexity } from "../config.js";
import type { Finding } from "../types.js";
import type { JevClient, JevQuestion } from "./client.js";

/** The reviewer's model of how involved a PR is; drives model choice and effort. */
export interface ComplexityRouting {
  complexity: PRComplexity;
  /** Calibrated confidence in the label, 0-1. */
  confidence: number;
}

export interface ComplexityRoutingInput {
  prTitle: string;
  files: { filename: string; additions: number; deletions: number }[];
  totalDiffChars: number;
}

/** One finding's Jev verdict. */
export interface FindingJudgement {
  index: number;
  /** 0-100; below the configured threshold the finding is suppressed. */
  confidence: number;
  /** Probability (0-1) that the defect was introduced by this diff rather than pre-existing. */
  introducedByDiff: number;
  /** Jev's independent severity call. */
  severity: Finding["severity"];
  /** Confidence (0-1) of the severity call. */
  severityConfidence: number;
}

const SEVERITY_CRITERIA: Record<Finding["severity"], string> = {
  critical:
    "Exploitable security flaw, auth bypass, data corruption or loss, crash of core functionality, or a severe production regression",
  warning:
    "Likely functional bug, reachable edge case causing incorrect behavior, meaningful reliability issue, or backward-compatibility regression",
  suggestion:
    "Concrete improvement with a measurable maintainability, performance, robustness, or clarity benefit — not required for correctness",
  nit: "Extremely small local polish point with no behavioral impact",
};

const CONFIDENCE_RUBRIC = [
  "Almost certainly wrong: the claim depends on assumptions the supplied code does not support",
  "Weak: the concern may be real, but the triggering condition cannot be confirmed from the supplied code",
  "Strong: the supplied code supports the concern, resting on at most one stated contextual assumption",
  "Certain: the defect follows directly from the changed lines and the surrounding code shown",
];

/** Compact, factual state for the router — no padding, per TypeSafe guidance. */
function routerState(input: ComplexityRoutingInput): unknown {
  return {
    pr_title: input.prTitle,
    file_count: input.files.length,
    diff_chars: input.totalDiffChars,
    files: input.files.map((f) => ({
      path: f.filename,
      added: f.additions,
      removed: f.deletions,
    })),
  };
}

/**
 * Classify PR complexity so the engine can pick a cheaper or more capable model
 * and (later) scale effort. Failure is the caller's problem: this throws.
 */
export async function routePRComplexity(
  jev: JevClient,
  input: ComplexityRoutingInput,
): Promise<ComplexityRouting> {
  const questions: Record<string, JevQuestion> = {
    complexity: {
      type: "choice",
      instructions:
        "How much review effort does this pull request need? Judge from the size, spread, and riskiness of the changes.",
      criteria: {
        simple:
          "A small, self-contained change: documentation, comments, config, typo fixes, dependency bumps, or a handful of lines in one file with no control-flow changes",
        moderate:
          "A normal feature or fix: several files, or real logic changes in one area, that can be understood from the diff alone",
        complex:
          "A large or risky change: many files, concurrency, auth, cryptography, parsing, migrations, public API changes, or logic whose correctness depends on code outside the diff",
      },
    },
  };

  const { answers } = await jev.systemOne(routerState(input), questions);
  const answer = answers.complexity;
  const choice = answer?.choice;
  const complexity: PRComplexity =
    choice === "simple" || choice === "complex" ? choice : "moderate";
  return { complexity, confidence: answer?.confidence ?? 0 };
}

/** Truncated diff context per file, so Jev judges claims against real code. */
export interface FindingContext {
  /** file path -> unified diff patch (already truncated by the caller). */
  diffByFile: Map<string, string>;
}

function judgeState(findings: Finding[], context: FindingContext): unknown {
  return {
    instructions:
      "Each entry is a code review finding from an automated reviewer. Judge each one independently against the diff excerpt shown for its file.",
    findings: findings.map((f, index) => ({
      index,
      file: f.file,
      line: f.line,
      severity_claimed: f.severity,
      title: f.title,
      body: f.body,
      diff_excerpt: (context.diffByFile.get(f.file) ?? "").slice(0, 6_000),
    })),
  };
}

function judgeQuestions(findings: Finding[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  findings.forEach((f, index) => {
    const subject = `the finding "${f.title}"`;
    questions[`supported_${index}`] = {
      type: "score",
      instructions: `How well does the code shown for this file support ${subject}?`,
      criteria: CONFIDENCE_RUBRIC,
    };
    questions[`introduced_${index}`] = {
      type: "noul",
      instructions: `Does the diff excerpt shown introduce or activate the problem described by ${subject}, as opposed to it merely existing in unchanged surrounding code?`,
      criteria: {
        true: "The problematic behavior is created or newly reachable because of the changed lines",
        false: "The condition already existed in unchanged code and the diff does not materially enable it",
      },
    };
    questions[`severity_${index}`] = {
      type: "choice",
      instructions: `What is the realistic impact severity of ${subject}?`,
      criteria: SEVERITY_CRITERIA,
    };
  });
  return questions;
}

/**
 * Judge every finding in ONE Jev call (questions run in parallel, so asking
 * more of them is nearly free). Returns one verdict per finding, in order.
 */
export async function judgeFindings(
  jev: JevClient,
  findings: Finding[],
  context: FindingContext,
): Promise<FindingJudgement[]> {
  if (findings.length === 0) return [];
  const { answers } = await jev.systemOne(judgeState(findings, context), judgeQuestions(findings));

  return findings.map((finding, index) => {
    const supported = answers[`supported_${index}`];
    const introduced = answers[`introduced_${index}`];
    const severity = answers[`severity_${index}`];

    // Rubric has 4 levels (0-3); a position of 3 means "certain".
    const rawScore = Math.max(0, Math.min(3, supported?.score ?? 1.5));
    const confidence = Math.round((rawScore / 3) * 100);
    const choice = severity?.choice;

    return {
      index,
      confidence,
      introducedByDiff: introduced?.noul ?? 0.5,
      severity:
        choice === "critical" || choice === "warning" || choice === "suggestion" || choice === "nit"
          ? choice
          : finding.severity,
      severityConfidence: severity?.confidence ?? 0,
    };
  });
}

/** Confidence-only view of {@link judgeFindings}, for callers that don't need severity. */
export async function scoreFindingConfidence(
  jev: JevClient,
  findings: Finding[],
  context: FindingContext,
): Promise<{ index: number; confidence: number; introducedByDiff: number }[]> {
  const judged = await judgeFindings(jev, findings, context);
  return judged.map(({ index, confidence, introducedByDiff }) => ({
    index,
    confidence,
    introducedByDiff,
  }));
}

/** Severity-only view of {@link judgeFindings}. */
export async function validateSeverity(
  jev: JevClient,
  findings: Finding[],
  context: FindingContext,
): Promise<{ index: number; severity: Finding["severity"]; confidence: number }[]> {
  const judged = await judgeFindings(jev, findings, context);
  return judged.map(({ index, severity, severityConfidence }) => ({
    index,
    severity,
    confidence: severityConfidence,
  }));
}

/** How a developer's reply reads against the finding it answers. */
export interface ReplyVerdict {
  /** Probability the reply disputes the finding. */
  disputes: number;
  /** Probability the reply accepts the finding. */
  acknowledges: number;
  /** Probability the reply is mainly a question. */
  asksQuestion: number;
}

/** Classify a reply to one of our review comments (used for feedback learning). */
export async function classifyReply(
  jev: JevClient,
  input: { reply: string; finding: string },
): Promise<ReplyVerdict> {
  const { answers } = await jev.systemOne(
    {
      review_comment_we_posted: input.finding.slice(0, 8_000),
      developer_reply: input.reply.slice(0, 8_000),
    },
    {
      disputes: {
        type: "noul",
        instructions:
          "Does the developer's reply dispute that the problem described in the review comment is real, relevant, or worth acting on? A question asking us to justify the finding counts as a dispute.",
      },
      acknowledges: {
        type: "noul",
        instructions:
          "Does the developer's reply accept the finding, agree with it, or state that they will address it?",
      },
      asks_question: {
        type: "noul",
        instructions:
          "Is the reply mainly asking a question rather than asserting a position?",
      },
    },
  );
  return {
    disputes: answers.disputes?.noul ?? 0,
    acknowledges: answers.acknowledges?.noul ?? 0,
    asksQuestion: answers.asks_question?.noul ?? 0,
  };
}

/** Pick the model for a routed complexity, honouring per-repo overrides. */
export function modelForComplexity(
  complexity: PRComplexity,
  overrides: { default?: string; simple?: string; moderate?: string; complex?: string } | undefined,
  fallback: string,
): string {
  if (!overrides) return fallback;
  return overrides[complexity] ?? overrides.default ?? fallback;
}
