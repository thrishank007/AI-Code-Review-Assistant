# ai-pr-reviewer

A self-hosted **GitHub App** that reviews your pull requests with **your own LLM** — like CodeRabbit or Copilot code review, but open source (MIT) and running against any OpenAI-compatible provider: OpenAI, Ollama, vLLM, LM Studio, Groq, OpenRouter, and anything else that speaks the chat-completions API.

- 🔔 Triggered automatically on every PR (opened / new pushes / ready for review)
- 💬 Posts one review per push: inline comments on the exact lines + a markdown summary
- 🔌 Bring your own model — one base URL + key + model name
- 🏠 Single small Node service, no database, deploys anywhere (Docker or plain Node)
- ⚙️ Per-repo config file (`.aireview.yml`) for ignores, extra instructions, and severity filters
- 🎯 **Jev decision layer** (TypeSafe AI): routes PR complexity to the right model, scores finding confidence, and independently validates severity
- 🛡️ Non-blocking: reviews are advisory (`COMMENT`), never `REQUEST_CHANGES`

## How it works

```
GitHub ── pull_request webhook ──▶ POST /webhook (signature-verified, 202 fast-ack)
                                      │
                                      ▼
                          fetch PR files + .aireview.yml
                                      │
                                      ▼
                    filter (ignores, caps) ─▶ build prompt (diff hunks)
                                      │
                                      ▼
                    Jev: route PR complexity ─▶ pick model
                                      │
                                      ▼
                       your LLM (OpenAI-compatible endpoint)
                                      │
                                      ▼
              parse JSON findings ─▶ Jev: score confidence + validate severity ─▶ filter
                                      │
                                      ▼
              POST PR review: summary + inline comments
```

Hallucinated line numbers are clamped to lines that actually exist in the diff, so GitHub never rejects a comment. Duplicate webhook deliveries are deduped per head SHA. If the LLM returns unparseable output, it gets one corrective retry and then falls back to posting the raw response. Every optional layer (agent, Jev, feedback) degrades independently: if it is misconfigured or failing, the review still happens.

## Quick start

### 1. Create the GitHub App

On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App** (or the equivalent org-level page).

| Field | Value |
|---|---|
| GitHub App name | anything, e.g. `ai-pr-reviewer` |
| Webhook URL | your service's public HTTPS URL, e.g. `https://reviewer.example.com/webhook` |
| Webhook secret | a random string (→ `WEBHOOK_SECRET`) |
| Permissions | **Pull requests: Read & write**, **Contents: Read-only**, **Checks: Read & write** (for status checks) |
| Subscribe to events | **Pull request**, **Issue comment** (`/review` command) |
| Where can this app be installed | Only this account / organization (for an internal app) |

After creating it: note the **App ID** (→ `APP_ID`), and under **Private keys** generate a `.pem` (→ `PRIVATE_KEY`). Install the app on the repos you want reviewed.

### 2. Configure and run

```bash
cp .env.example .env   # fill in APP_ID, PRIVATE_KEY, WEBHOOK_SECRET, LLM_*
docker compose up -d   # or: npm ci && npm run build && npm start
curl http://localhost:3000/healthz
```

Open a non-draft PR in a repo where the app is installed — the review lands within a minute or two.

<details>
<summary>Local development without a public URL</summary>

Use [smee.io](https://smee.io) (or ngrok) to forward webhooks to your laptop:

```bash
npx smee-client --target http://localhost:3000/webhook --url https://smee.io/XXXX
npm run dev
```

Point the app's Webhook URL at the smee.io URL while developing. You can also test the engine without any webhook:

```bash
npm run review:pr -- owner/repo#123
```

(prints the review to stdout instead of posting it — handy for prompt iteration.)

</details>

## Configuration

### Service environment (`.env`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APP_ID` | ✅ | | GitHub App ID |
| `PRIVATE_KEY` | ✅ | | App private key; literal `\n` escapes are fine |
| `WEBHOOK_SECRET` | ✅ | | Must match the app's webhook secret |
| `LLM_BASE_URL` | ✅ | | e.g. `https://api.openai.com/v1`, `http://localhost:11434/v1` |
| `LLM_MODEL` | ✅ | | e.g. `gpt-4o-mini`, `qwen2.5-coder:7b` |
| `LLM_API_KEY` | ➖ | | Omit for keyless local servers (Ollama, vLLM) |
| `GITHUB_API_URL` | ➖ | | GitHub Enterprise override |
| `PORT` | ➖ | `3000` | |
| `LOG_LEVEL` | ➖ | `info` | pino level |
| `LLM_TIMEOUT_MS` / `LLM_MAX_TOKENS` / `LLM_JSON_MODE` | ➖ | `120000` / `4096` / on | |
| `MAX_FILES` / `MAX_DIFF_CHARS` | ➖ | `30` / `120000` | Review-size caps |
| `CHECKS_ENABLED` | ➖ | on | Set `false` to disable check-runs (needs **Checks: Read & write**) |
| `AGENT_TOOLS_ENABLED` / `AGENT_MAX_STEPS` | ➖ | on / `10` | Let the model read full files, search the repo, and check history before committing to findings |
| `TYPESAFE_API_KEY` | ➖ | | Jev key from [console.typesafe.ai](https://console.typesafe.ai/settings/keys); unset disables the decision layer |
| `TYPESAFE_BASE_URL` / `JEV_MODEL` | ➖ | `https://api.typesafe.ai` / `jev-latest` | |
| `JEV_ENABLED` | ➖ | on | Set `false` to skip all Jev calls |
| `JEV_CONFIDENCE_THRESHOLD` | ➖ | `60` | Drop findings scoring below this (0-100) |
| `JEV_TIMEOUT_MS` | ➖ | `10000` | |
| `FEEDBACK_ENABLED` / `FEEDBACK_DB_PATH` | ➖ | on / `./data/feedback.sqlite` | Learn reviewer preferences from developer replies (SQLite) |

### Per-repo config (`.aireview.yml` at repo root, optional)

```yaml
# Extra glob patterns to skip, merged with the built-in list
# (lockfiles, dist/, node_modules/, minified files, ...)
ignore:
  - "src/generated/**"

# Override the service's MAX_FILES for this repo
max_files: 15

# Extra context injected into the prompt
instructions: "We use Fastify and Vitest. Flag missing await and missing tests."

# Only post findings at these severities (default: all)
severities: [critical, warning, suggestion]

# Check-runs: set false to skip status checks for this repo
checks: true

# Fail the check (red X) when these severities appear; default [] = never fail
fail_on: [critical]

# Model per routed PR complexity (Jev decides which bucket a PR is in)
# models:
#   simple: qwen2.5-coder:7b
#   complex: gpt-4o

# Skip the Jev decision layer for this repo
jev: false

# Learn reviewer preferences from developer replies for this repo
feedback: true
```

Severities: 🔴 `critical` (bug/security/data loss), 🟠 `warning` (likely bug/risky), 🔵 `suggestion` (meaningful improvement), ⚪ `nit` (polish).

## The Jev decision layer

[Jev](https://typesafe.ai) by TypeSafe AI returns typed, calibrated decisions instead of generated text. Set `TYPESAFE_API_KEY` and three decisions run around the review:

1. **Complexity routing** — before the model is called, Jev classifies the PR (`simple` / `moderate` / `complex`), which selects the model from the per-repo `models` block.
2. **Finding confidence** — every finding is graded in one batched call against its diff excerpt. Anything below `JEV_CONFIDENCE_THRESHOLD` is dropped, and findings Jev judges pre-existing (rather than introduced by the diff) are dropped too.
3. **Severity validation** — Jev independently picks a severity; when it disagrees confidently, its call wins. This curbs the usual model habit of inflating everything to `critical`.

Without a key the reviewer works exactly as before, just without these three decisions. Jev failures are logged and skipped, never fatal.

## Feedback learning

Findings we post are recorded, and when a developer replies, Jev classifies the reply as a dispute or an acknowledgement. Those signals accumulate per repo, and once a bucket has enough samples the reviewer is told about it in later prompts:

```text
Learned from past reviews on this repo: developers frequently dispute findings about [X]; verify them extra carefully.
```

Signals are only recorded when Jev is confident about the reading, so the store does not fill up with noise. Storage uses Node's built-in `node:sqlite`: no native dependency, no build step, one file at `FEEDBACK_DB_PATH`.

## Development

```bash
npm ci
npm test        # 251 unit/integration tests, all external calls mocked
npm run lint
npm run build   # emits dist/
```

Layout: `src/github/` (webhooks + API client), `src/review/` (engine, prompt, findings clamping, filters, report rendering), `src/agent/` (tool-calling review and conversation loops), `src/jev/` (TypeSafe decision layer), `src/feedback/` (SQLite store + prompt enricher), `src/llm/` (AI SDK client, fetch client, provider factory), `src/wiring.ts` (assembles the stack), `src/server.ts` (node:http). Design doc: [`docs/superpowers/specs/`](docs/superpowers/specs/).

## Manual re-review

Comment `/review` on any PR to force a fresh review (bypasses the duplicate-SHA skip, works on drafts too). Setup: GitHub App → Permissions (**Pull requests: Read & write**, **Contents: Read-only**) → Subscribe to **Issue comment** events.

## Roadmap

- [x] `/review` comment command to re-request a review
- [x] Check-run status (optional gating via `fail_on`)
- [x] Tool-calling agent for extra context (full files, code search, file history)
- [x] Jev routing, confidence scoring, and severity validation
- [x] Conversational replies to review comments
- [x] Code suggestions + feedback learning
- Queue mode (BullMQ) for high-volume orgs
- Packaged CLI + GitHub Action wrappers around the same engine
- GitLab support

## License

[MIT](LICENSE) © Thrishank Chintham
