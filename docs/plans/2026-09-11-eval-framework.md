# Eval Framework Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a comprehensive eval framework that measures LLM review quality (precision, recall, line accuracy, severity calibration, format compliance, consistency, latency, token usage), enables model comparison, catches regressions, and supports prompt iteration — all driven by a CLI that produces markdown reports.

**Architecture:** The eval harness lives in `evals/` at the project root. It feeds fixture PR data through the real `ReviewEngine` (mock GitHub client, real LLM) in dry-run mode, scores actual findings against hand-labeled expectations using a greedy matcher, computes 8 metrics, and renders results as both console output and timestamped markdown reports.

**Tech Stack:** TypeScript, tsx (runner), Zod (validation), existing ReviewEngine + LLMClient + types

---

## Decision Log

| # | Decision | Alternatives Considered | Rationale |
|---|----------|------------------------|-----------|
| 1 | Standalone harness in `evals/` | Vitest suite, promptfoo | Full control over metrics, reporting, and matching; no new deps; clean separation from unit tests |
| 2 | Reuse `ReviewEngine` with mock GitHub client | Call LLM directly, bypass engine | Tests the full pipeline (filter → prompt → LLM → parse → clamp), not just the LLM |
| 3 | Greedy best-match algorithm for finding comparison | Exact match, LLM-as-judge | Tolerates line drift and title variation without needing another LLM call |
| 4 | JSON dataset files with Zod schemas | YAML, TOML, inline in code | Consistent with the project's use of Zod; easy to validate; tooling-friendly |
| 5 | Real LLM calls only (no replay) | Replay/fixture mode | User's explicit preference; keeps evals honest |
| 6 | Markdown report output | HTML, JSON-only | Readable in GitHub, diffable, easy to compare over time |

---

## File Structure

```
evals/
├── datasets/
│   ├── golden/
│   │   ├── sql-injection.json
│   │   ├── null-deref.json
│   │   └── missing-await.json
│   ├── synthetic/
│   │   ├── xss-vulnerability.json
│   │   ├── race-condition.json
│   │   └── memory-leak.json
│   └── snapshots/
│       └── (empty — user captures from real PRs later)
├── reports/                  ← gitignored, generated
│   └── 2026-09-11T10-30-00_gpt-4o-mini.md
├── src/
│   ├── types.ts              ← EvalCase, EvalResult, Metrics schemas
│   ├── loader.ts             ← discovers and validates dataset files
│   ├── runner.ts             ← orchestrates ReviewEngine per case
│   ├── matcher.ts            ← greedy matching of actual vs expected findings
│   ├── scorer.ts             ← computes all 8 metrics from match results
│   ├── reporter.ts           ← markdown + console report rendering
│   └── cli.ts                ← entry point, arg parsing, orchestration
├── README.md
└── .gitkeep (in reports/)
```

---

## Proposed Changes

### Eval Types

#### [NEW] [types.ts](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/src/types.ts)

Core type definitions for the eval framework. All validated with Zod.

```typescript
// ---- Dataset types ----

interface ExpectedFinding {
  file: string;                           // exact or basename match
  lineRange?: [number, number];           // acceptable line range (inclusive)
  severity: Severity | Severity[];        // one or more acceptable severities
  category?: string;                      // optional category match
  titlePattern?: string;                  // regex matched against finding.title
  bodyPattern?: string;                   // regex matched against finding.body
}

interface EvalCase {
  id: string;                             // unique slug, e.g. "sql-injection"
  name: string;                           // human-readable name
  description: string;                    // what this case tests
  category: "golden" | "synthetic" | "snapshot";
  pr: { title: string; body: string | null };
  files: PRFile[];                        // from src/types.ts
  repoConfig?: string;                    // optional .aireview.yml content
  expected?: {
    findings: ExpectedFinding[];
    minFindings?: number;                 // floor on total findings
    maxFindings?: number;                 // ceiling on total findings
  };
}

// ---- Result types ----

interface FindingMatch {
  expected: ExpectedFinding;
  actual: Finding | null;                 // null = missed (false negative)
  fileMatched: boolean;
  lineMatched: boolean;
  severityMatched: boolean;
  titleMatched: boolean;
}

interface CaseResult {
  caseId: string;
  caseName: string;
  category: string;
  // Raw outputs
  rawLLMResponse: string;
  parsedOnFirstTry: boolean;
  reviewResult: ReviewResult | null;
  outcome: ReviewOutcome;
  // Matching
  matches: FindingMatch[];
  unmatchedActual: Finding[];             // false positives
  // Timing
  latencyMs: number;
  // Token estimate
  promptTokenEstimate: number;
  completionTokenEstimate: number;
}

interface EvalMetrics {
  formatCompliance: number;               // 0-1, fraction parsed on first try
  precision: number;                      // matched / (matched + unmatched actual)
  recall: number;                         // matched / total expected
  lineAccuracy: number;                   // fraction of matches with correct line
  severityCalibration: number;            // fraction of matches with correct severity
  consistency: number;                    // Jaccard similarity across repeat runs
  avgLatencyMs: number;
  totalTokenEstimate: number;
}

interface EvalReport {
  timestamp: string;
  model: string;
  datasetFilter: string;
  cases: CaseResult[];
  metrics: EvalMetrics;
  durationMs: number;
}
```

---

### Dataset Loader

#### [NEW] [loader.ts](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/src/loader.ts)

- Scans `evals/datasets/` recursively for `*.json` files
- Validates each file against `EvalCaseSchema` (Zod)
- Supports filtering by `--category` (golden/synthetic/snapshot) and `--case` (specific IDs)
- Returns `EvalCase[]` sorted by category then ID
- Fails fast with clear error messages on invalid datasets

---

### Eval Runner

#### [NEW] [runner.ts](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/src/runner.ts)

The runner is the core orchestration layer. For each `EvalCase`:

1. **Build a mock GitHub client** that returns the case's `files` array from `listPRFiles`, returns the case's `repoConfig` from `getFileContent`, returns `[]` from `listReviews` (no dupe skip), and no-ops on `submitReview`/`createCheckRun`/`commentOnPR`
2. **Build a real LLM client** using env vars (`LLM_BASE_URL`, `LLM_MODEL`, etc.)
3. **Construct a `ReviewEngine`** with the mock GitHub + real LLM
4. **Call `reviewPullRequest()`** in dry-run mode with a `ReviewRequest` built from the case's PR metadata
5. **Intercept the raw LLM response** — this requires a thin wrapper around `LLMClient.chat()` that captures the raw response string and timing before it flows into the engine. We wrap the LLM client with a `RecordingLLMClient` proxy.
6. **Return a `CaseResult`** with all raw data for the scorer

Key implementation detail — **`RecordingLLMClient`**:
```typescript
class RecordingLLMClient {
  responses: { raw: string; latencyMs: number }[] = [];
  constructor(private inner: LLMClient) {}
  async chat(messages: ChatMessage[]): Promise<string> {
    const start = performance.now();
    const raw = await this.inner.chat(messages);
    this.responses.push({ raw, latencyMs: performance.now() - start });
    return raw;
  }
}
```

For **consistency measurement**: the runner optionally runs each case N times (configurable via `--repeat`, default 1) and passes all runs to the scorer.

---

### Finding Matcher

#### [NEW] [matcher.ts](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/src/matcher.ts)

Greedy best-match algorithm to pair expected findings with actual findings:

1. For each `(expected, actual)` pair, compute a match score (0–4):
   - +1 if file matches (exact path or basename)
   - +1 if line falls within `lineRange` (or no range specified)
   - +1 if severity matches (single or any-of)
   - +1 if `titlePattern` regex matches (or no pattern specified)
2. Build a score matrix: `expected.length × actual.length`
3. Greedy assignment: repeatedly pick the highest-scoring unassigned pair (score ≥ 1, file must match)
4. Unmatched expected → false negatives (missed)
5. Unmatched actual → false positives (noise)

Returns: `{ matches: FindingMatch[], unmatchedActual: Finding[] }`

---

### Scorer

#### [NEW] [scorer.ts](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/src/scorer.ts)

Computes `EvalMetrics` from `CaseResult[]`:

| Metric | Computation |
|--------|-------------|
| **Format compliance** | `casesWithFirstTryParse / totalCases` |
| **Precision** | `totalMatched / (totalMatched + totalUnmatchedActual)` across all cases with expectations |
| **Recall** | `totalMatched / totalExpected` across all cases with expectations |
| **Line accuracy** | `matchesWithLineInRange / totalMatches` (only counted when `lineRange` is specified) |
| **Severity calibration** | `matchesWithCorrectSeverity / totalMatches` |
| **Consistency** | When `--repeat N > 1`: average pairwise Jaccard similarity of finding sets (by file+severity+title) across runs of the same case. When repeat=1: `1.0` (not measured) |
| **Avg latency** | `sum(latencyMs) / totalCases` |
| **Token estimate** | `sum(promptTokenEstimate + completionTokenEstimate)` — estimated as `ceil(charCount / 4)` |

Cases without `expected` block (snapshots) contribute only to format compliance, latency, and token metrics — not precision/recall.

---

### Report Renderer

#### [NEW] [reporter.ts](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/src/reporter.ts)

Generates two outputs:

**1. Console output** (colorized with ANSI):
```
┌─────────────────────────────────────────────────────┐
│  ai-pr-reviewer evals · gpt-4o-mini · 6 cases      │
├──────────────────┬──────────────────────────────────┤
│ Format Compliance│ ██████████████████████████ 100%  │
│ Precision        │ ████████████████████░░░░░░  78%  │
│ Recall           │ █████████████████████░░░░░  82%  │
│ Line Accuracy    │ ███████████████████████░░░  91%  │
│ Severity Calib.  │ ██████████████████░░░░░░░░  74%  │
│ Avg Latency      │ 3.8s                             │
│ Est. Tokens      │ ~12,400                          │
├──────────────────┴──────────────────────────────────┤
│ Per-Case Results                                     │
├────────────────┬────────┬─────┬────────┬────────────┤
│ Case           │ Format │ P   │ R     │ Latency     │
├────────────────┼────────┼─────┼───────┼─────────────┤
│ sql-injection  │ ✅     │100% │ 100%  │ 2.1s        │
│ null-deref     │ ✅     │ 50% │ 100%  │ 4.3s        │
│ ...            │        │     │       │             │
└────────────────┴────────┴─────┴───────┴─────────────┘
Duration: 45.2s
Report: evals/reports/2026-09-11T10-30-00_gpt-4o-mini.md
```

**2. Markdown report** (written to `evals/reports/<timestamp>_<model>.md`):
- Header with model, timestamp, dataset filter, duration
- Metric summary table
- Per-case results table with pass/warn/fail icons
- Detailed per-case sections showing expected vs actual findings, match details
- Model comparison section (if multiple reports exist in `evals/reports/`)

---

### CLI Entry Point

#### [NEW] [cli.ts](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/src/cli.ts)

```
Usage: npm run eval -- [options]

Options:
  --category <golden|synthetic|snapshot|all>   Filter dataset category (default: all)
  --case <id>                                  Run a single case by ID
  --repeat <N>                                 Repeat each case N times for consistency (default: 1)
  --model <name>                               Override LLM_MODEL env var
  --base-url <url>                             Override LLM_BASE_URL env var
  --no-report                                  Skip writing markdown report file
  --verbose                                    Print detailed per-case output
```

Flow:
1. Parse args + load env (reuse `loadEnv` from `src/config.ts` — but only LLM-related vars are required; GitHub vars are optional with dummy defaults)
2. Load and filter datasets via `loader.ts`
3. Run all cases via `runner.ts` (sequential — LLM calls shouldn't be parallelized by default)
4. Score results via `scorer.ts`
5. Render console output + write markdown report via `reporter.ts`
6. Exit code: 0 if format compliance = 100%, 1 otherwise

---

### Starter Datasets

#### [NEW] [sql-injection.json](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/datasets/golden/sql-injection.json)

A "golden" eval case with a diff that introduces an obvious SQL injection vulnerability. Expected: 1 critical finding on the vulnerable line.

#### [NEW] [null-deref.json](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/datasets/golden/null-deref.json)

A diff that accesses a property on a potentially null value without a guard. Expected: 1 warning finding.

#### [NEW] [missing-await.json](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/datasets/golden/missing-await.json)

A diff in an async function that calls an async method without `await`. Expected: 1 warning finding.

#### [NEW] [xss-vulnerability.json](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/datasets/synthetic/xss-vulnerability.json)

User input rendered as raw HTML via `innerHTML`. Expected: 1 critical finding.

#### [NEW] [race-condition.json](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/datasets/synthetic/race-condition.json)

Read-modify-write on shared state without synchronization. Expected: 1 warning finding.

#### [NEW] [clean-diff.json](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/evals/datasets/synthetic/clean-diff.json)

A genuinely clean diff (simple rename, formatting). Expected: 0 findings, summary should say "clean".

---

### Project Config Changes

#### [MODIFY] [package.json](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/package.json)

Add eval script:
```diff
   "scripts": {
     "dev": "tsx watch src/index.ts",
     "build": "tsc",
     "start": "node dist/index.js",
     "test": "vitest run",
     "lint": "eslint .",
-    "review:pr": "tsx scripts/review-pr.ts"
+    "review:pr": "tsx scripts/review-pr.ts",
+    "eval": "tsx evals/src/cli.ts"
   },
```

#### [MODIFY] [.gitignore](file:///c:/Users/thris/Experiments/E2-Assist/AI-Code-Review-Assistant/.gitignore)

Add eval reports directory:
```diff
+evals/reports/
```

---

## Verification Plan

### Automated Tests

New Vitest tests for the pure-logic eval modules (no LLM calls):

```bash
# Unit tests for matcher, scorer, reporter, loader
npx vitest run tests/eval-matcher.test.ts tests/eval-scorer.test.ts tests/eval-loader.test.ts
```

- **matcher.test.ts** — verify greedy matching with known inputs (exact match, partial match, no match, multiple candidates)
- **scorer.test.ts** — verify metric computation from known `CaseResult[]` arrays
- **loader.test.ts** — verify dataset discovery, validation, filtering

### Manual Verification

```bash
# Run evals against a live model (requires LLM env vars)
npm run eval -- --category golden --verbose

# Verify report is generated
ls evals/reports/

# Run with model comparison
npm run eval -- --model gpt-4o-mini
npm run eval -- --model gpt-4o
# Compare the two markdown reports
```

### Build Verification

```bash
npm run build   # ensure no TypeScript errors
npm run lint    # ensure no lint errors
npm test        # ensure existing 102 tests still pass
```
