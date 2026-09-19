/** A single review finding produced by the model. */
export interface Finding {
  file: string;
  line: number;
  severity: "critical" | "warning" | "suggestion" | "nit";
  confidence: "high" | "medium";
  title: string;
  body: string;
  /** Optional one-click fix; rendered as a GitHub suggestion when present. */
  fix?: string;
}

/** Structured result the review model must return. */
export interface ReviewResult {
  summary: string;
  overview: string;
  fileSummaries: { file: string; summary: string }[];
  findings: Finding[];
}

/** A changed file as GitHub reports it for a PR. */
export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/** Comment left on a PR. */
export interface Comment {
  id: number;
  body: string;
  user: { login: string; type?: string };
}

/** The ways a developer's reply can read to us. */
export type FeedbackSignal = "disputed" | "agreed";

/** One finding recorded for feedback learning. */
export interface FeedbackFinding {
  commentId: number;
  finding: Finding;
}
