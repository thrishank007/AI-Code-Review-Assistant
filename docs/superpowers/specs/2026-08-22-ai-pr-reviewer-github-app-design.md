# AI PR Reviewer — GitHub App Design

**Date:** 2026-08-22
**Status:** Approved
**Supersedes:** the original Express/Mongo/Postgres "code review API" design (full reset)

## Problem

We want a CodeRabbit/Copilot-review-style experience — automatic code review on every pull request, with issues reported inline — but open source and running against **our own LLM provider** (any OpenAI-compatible endpoint: OpenAI, Ollama, vLLM, LM Studio, Groq, OpenRouter, …).

## Decision summary

| Question | Decision |
|---|---|
| Product shape | Self-hosted **GitHub App** (webhook service), not a CLI |
| Trigger | `pull_request` events: `opened`, `synchronize`, `ready_for_review`; drafts skipped |
| Reporting | One PR review per push (`event: COMMENT`, non-blocking): inline comments + markdown summary |
| Existing code | Nothing kept — fresh TypeScript codebase; git history preserved |
| LLM | OpenAI-compatible only: base URL + API key + model name |
| Storage | None. GitHub is the storage (findings live on the PR) |
| Language | TypeScript, ESM, NodeNext, Node ≥ 20 |
| License | MIT |

### Why not a CLI

A CLI only fires when the one developer who installed it runs it; it cannot trigger on teammates' commits or annotate PRs on the host. The webhook service is the product. A debug CLI wrapper around the same engine is roadmap material.

## Architecture

Single Node process, no database. Five concerns, one module each:

```
src/
  index.ts            # entry: boot config, start server, graceful shutdown
  config.ts           # env (zod-validated) + repo config (.aireview.yml) load & merge
  logger.ts           # pino
  server.ts           # node:http: POST /webhook, GET /healthz
  types.ts            # shared payload types
  github/
    webhooks.ts       # HMAC-SHA256 signature verify (timing-safe), event routing
    client.ts         # Octokit (App auth → installation tokens): files, repo file, reviews
    events.ts         # pull_request handler → engine invocation + error containment
  review/
    engine.ts         # orchestrates one review end-to-end
    filters.ts        # ignore globs, file-count/size caps, binary/no-patch skip
    prompt.ts         # system + user prompt (diff hunks, PR context, instructions)
    findings.ts       # zod Finding schema, JSON parsing, line clamping to diff hunks
    report.ts         # findings → PR review markdown
  llm/
    client.ts         # plain-fetch chat-completions client
scripts/
  review-pr.ts        # dev utility: run engine on owner/repo#pr, print report (no posting)
```

Dependencies: `octokit`, `zod`, `yaml`, `dotenv`, `pino`. Dev: `typescript`, `tsx`, `vitest`, `eslint` + `typescript-eslint`.

`node:http` instead of Express: the server is one POST route + healthz; not worth a framework.

## Flows

### Webhook → review

1. GitHub App (permissions: `pull_requests: write`, `contents: read`; events: `pull_request`) posts to `POST /webhook`.
2. Verify `x-hub-signature-256` (timing-safe HMAC compare) → **401** on mismatch.
3. Respond **202 immediately**, then process async (GitHub must never retry-fire a slow review).
4. Route by `x-github-event`: `ping` → log; `pull_request` → handler; else ignore.
5. Handler: skip non-reviewable actions and drafts; dedupe by checking whether a review containing our marker footer already exists for this head SHA.
6. Engine runs (below). Any thrown error → best-effort PR comment `⚠️ AI review failed: …` + log. The webhook path never throws.

### Engine

1. List PR files (paginated, capped by `MAX_FILES` / repo `max_files`).
2. Filter: default ignore globs (lockfiles, `dist/`, minified, vendored…) merged with repo config `ignore`; skip files without a `patch` (binary/too large); stop when cumulative patch size exceeds `MAX_DIFF_CHARS`.
3. Load `.aireview.yml` from the PR head (404 → defaults; invalid → defaults + warning in footer).
4. Build prompt: system prompt demanding **strict JSON** `{summary, findings[{file, line, severity, category, title, body}]}` + rules (only changed lines, exact paths, new-file line numbers, severity vocabulary, prioritize real bugs); user prompt with PR title/description, file stats, raw patches, maintainer instructions.
5. Call the LLM (chat completions; `response_format: json_object` when JSON mode is on).
6. Parse + zod-validate. On failure: one retry feeding the parse error back. On second failure: degrade to posting the raw LLM text as the review body.
7. **Clamp** every finding to a line that actually exists in that file's diff hunks (nearest valid line; findings on files not in the diff or with no valid lines drop to the summary section). This prevents GitHub's "unable to create comment" rejections on hallucinated line numbers.
8. Apply severity filter from repo config.
9. Submit one review: `event: COMMENT`, markdown summary body, inline comments on `RIGHT` side.

### Failure modes

| Failure | Behavior |
|---|---|
| Bad signature | 401, nothing processed |
| LLM timeout/non-200 | Error comment on PR + log |
| LLM returns invalid JSON | One corrective retry → raw-text degrade |
| Hallucinated file/line | Clamped or moved to summary |
| Engine crash | Caught in events layer; error comment best-effort |
| Duplicate webhook delivery | Dedupe on head SHA + marker in existing review body |

## Configuration

**Server env** (`.env`, zod-validated at boot, fail fast):

| Var | Meaning | Default |
|---|---|---|
| `APP_ID` / `PRIVATE_KEY` / `WEBHOOK_SECRET` | GitHub App credentials | required |
| `GITHUB_API_URL` | GHES override | public api |
| `PORT` | listen port | 3000 |
| `LOG_LEVEL` | pino level | info |
| `LLM_BASE_URL` | e.g. `https://api.openai.com/v1`, `http://localhost:11434/v1` | required |
| `LLM_API_KEY` | omitted for keyless local servers | – |
| `LLM_MODEL` | model name | required |
| `LLM_TIMEOUT_MS` / `LLM_MAX_TOKENS` / `LLM_JSON_MODE` | LLM knobs | 120000 / 4096 / on |
| `MAX_FILES` / `MAX_DIFF_CHARS` | review caps | 30 / 120000 |

**Repo config** (`.aireview.yml`, optional): `ignore` (extra globs), `max_files`, `instructions` (extra prompt context), `severities` (which to post).

## Security

- Webhook secret required; timing-safe comparison.
- The old `.env` on disk contains real-looking API keys — it must not be reused; rotate keys before making the repo public.
- Installation-scoped tokens (via Octokit `App`), never a user PAT.

## Out of scope for v1 (roadmap)

DB/dashboard, bot chat (`/review` command), auto-fix, check-run gating, queue/workers (the async boundary is designed so BullMQ can slot in later), packaged CLI, native Anthropic/Gemini adapters, GitLab.

## Verification

Unit tests per module (vitest, all external calls mocked) + one integration test of the webhook → engine → review-submission path. Manual smoke test (documented in README): smee.io → local run → open a non-draft PR on a test repo → bot review appears.
