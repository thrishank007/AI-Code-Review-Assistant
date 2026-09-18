# Evals — LLM Review Quality Framework

Measures review quality (precision, recall, line accuracy, severity calibration,
format compliance, consistency, latency, token usage) by feeding fixture PR
data through the real `ReviewEngine` (mock GitHub client, real LLM) in
dry-run mode.

## Usage

```bash
# Run everything (requires LLM env vars in .env)
npm run eval -- --category golden --verbose

# Single case / repeat for consistency / model override
npm run eval -- --case sql-injection
npm run eval -- --repeat 3
npm run eval -- --model gpt-4o-mini

# Skip the markdown report
npm run eval -- --no-report
```

Exit code is `0` when format compliance is 100%, `1` otherwise (regression
signal for CI). Reports land in `evals/reports/` (gitignored).

## How it works

1. `loader.ts` discovers `datasets/**/*.json` and validates each file with Zod.
2. `runner.ts` replays each case through `ReviewEngine.reviewPullRequest()`
   with a mock GitHub client and a `RecordingLLMClient` that captures the raw
   LLM response, prompt, and timing.
3. `matcher.ts` pairs expected vs actual findings with a greedy best-match
   (file must match; +1 each for line-in-range, severity, title pattern).
4. `scorer.ts` aggregates the 8 metrics. Cases without an `expected` block
   (snapshots) contribute only to format compliance, latency, and tokens.
5. `reporter.ts` renders the console summary and the markdown report.

## Dataset categories

- `golden/` — hand-verified cases with known-vulnerable diffs.
- `synthetic/` — generated edge cases, including a clean diff (0 findings).
- `snapshots/` — captured from real PRs later; omit `expected` to measure
  only format compliance, latency, and token usage.

## Adding a case

Copy an existing JSON file, give it a unique `id`, and set `expected.findings`
with `file`, `lineRange` (new-file lines), `severity` (or list of acceptable
severities), and optional `titlePattern` / `bodyPattern` regexes.
