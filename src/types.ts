/** A changed file as returned by the GitHub pulls.listFiles API. */
export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** Unified diff patch; absent for binaries and files GitHub deems too large. */
  patch?: string;
}

/** The subset of the `pull_request` webhook payload we consume. */
export interface PullRequestEvent {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    draft: boolean;
    head: { sha: string };
  };
}

/** One problem the LLM reported, before placement validation. */
export interface Finding {
  file: string;
  line: number;
  severity: "critical" | "warning" | "suggestion" | "nit";
  category: string;
  title: string;
  body: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

/** A finding with its final placement decision applied. */
export interface PlacedFinding {
  finding: Finding;
  /** Diff line to comment on; undefined means it can only live in the summary. */
  line?: number;
  reason?: "file-not-in-diff" | "no-valid-lines";
}
