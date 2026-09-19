# Agentic AI Review System — Design

**Date:** 2026-09-19
**Status:** Implemented
**Builds on:** [`2026-08-22-ai-pr-reviewer-github-app-design.md`](./2026-08-22-ai-pr-reviewer-github-app-design.md)

## Problem

The original pipeline was one blind LLM call: diff hunks in, findings out. It could not see a full file, could not follow an import to check a callee's contract, could not tell whether a flagged bug was introduced by the diff or merely pre-existing, and could not talk to the developer who pushed back on a finding. It also treated every PR — a typo fix and a concurrency rewrite — identically.

## Decision summary

| Question | Decision |
|---|---|
| Agent runtime | **Vercel AI SDK** (`ai` v7 + `@ai-sdk/openai`), used with `provider.chat()` so any OpenAI-compatible endpoint works |
| Default provider | `ai-sdk`. `LLM_PROVIDER=openai-compatible` keeps the original fetch client as a no-tools fallback |
| Context acquisition | Read-only GitHub tools driven by the model, bounded by `AGENT_MAX_STEPS` |
| Decision layer | **Jev** (TypeSafe AI) for PR complexity routing, finding confidence, and severity validation |
| Jev requirement | First-class and on by default, but **not mandatory at startup**: no `TYPESAFE_API_KEY` ⇒ warn and skip the layer |
| Conversation | `pull_request_review_comment` replies on our own findings get an agent answer in-thread |
| Persistence | **SQLite** via Node's built-in `node:sqlite` for per-repo feedback learning |
| Failure posture | Every optional layer degrades independently; a review always ships |

## Architecture

```
src/
  llm/
    types.ts             # ChatMessage + LLMClientLike contract
    client.ts            # FetchLLMClient (no tool support), exported as LLMClient for compatibility
    ai-sdk-client.ts     # AiSdkLLMClient + createChatModel + response_format transport middleware
    factory.ts           # provider selection + llmConfigFromEnv
  agent/
    tools.ts             # read_file, list_directory, search_code, get_file_history, read_repo_conventions
    loop.ts              # tool loop, call budget, ModelFactory injection for tests
    conversation.ts      # conversation agent + ConversationEngine (reply orchestration)
  jev/
    client.ts            # TypeSafe SDK wrapper, normalized answers, createJevClient
    decisions.ts         # routePRComplexity, judgeFindings, classifyReply, modelForComplexity
  feedback/
    tracker.ts           # node:sqlite store: posted findings, signals, per-repo summary
    prompt-enricher.ts   # summary -> prompt guidance (with a minimum-sample gate)
  review/
    engine.ts            # orchestration: route -> review -> judge -> clamp -> post -> record
    prompt.ts            # base review prompt, agent prompt, conversation prompt
    report.ts            # review body, inline comments, GitHub suggestion blocks
  wiring.ts              # assembles the whole stack (shared by server + dev CLI)
```

## Key decisions

### 1. The agent returns raw text, not a parsed object

The agent is a smarter way to produce the same JSON string the fetch client produces. The engine's existing parse → repair → degrade ladder is untouched, so `ReviewAgent` failing in a new way still lands in a path that was already tested. `AiSdkReviewAgent.run()` takes a **per-run tool context** (installation, owner, repo, head SHA, changed paths) rather than being constructed per PR — one agent instance, no leaked state.

### 2. Tool budget is enforced inside the tools

`stopWhen: stepCountIs(n)` bounds model round trips, but a model can emit many parallel calls in one step. A shared `{ used }` counter in the tool set caps total calls, and exhausting it returns a *message* to the model ("emit the final JSON now") rather than throwing out of the loop.

### 3. Jev judges all findings in one call

Jev answers questions in parallel, so a 12-finding PR costs one request with 36 questions rather than 12 round trips. `judgeFindings` also asks a `noul` question per finding — "did this diff introduce the problem?" — which is what stops the reviewer reporting pre-existing bugs. Severity is only overridden when Jev's own confidence clears a bar; otherwise the model's call stands.

### 4. Feedback signals only from confident readings

Replies are classified by Jev. Below `MIN_SIGNAL_CONFIDENCE` nothing is recorded. Keyword heuristics were rejected: a poisoned preference store silently degrades every future review on that repo, which is worse than having no learning at all. The enricher additionally refuses to say anything until a repo has at least 5 stored findings.

### 5. `node:sqlite` over `better-sqlite3`

No native build step, no supply-chain surface, one file path. The cost is a runtime floor (Node 23.4+, or 22.5+ with `--experimental-sqlite`), so `createFeedbackTracker` catches a failed require, warns, and returns null — the reviewer runs without learning on older runtimes. The Docker image moved to Node 24 and mounts `/app/data` as a volume.

### 6. JSON mode lives in the transport layer

AI SDK v7's OpenAI chat provider does not forward a top-level `responseFormat` to `response_format`. Rather than give up parity with the fetch client, `createChatModel` wraps the fetch implementation and adds `response_format: { type: "json_object" }` to tool-free chat requests. Tool-bearing requests are deliberately excluded: forcing JSON output there fights tool calling. The conversation agent sets `jsonMode: false` explicitly so replies are never JSON.

## Verified behaviour

`npm test` → 274 tests, all external calls mocked. Coverage of the new surface:

| Area | Tests |
|---|---|
| AI SDK client + JSON-mode middleware + factory | `tests/ai-sdk-client.test.ts` |
| Tool execution, budget, failure handling | `tests/agent-tools.test.ts` |
| Tool loop, model override, repair, exhaustion | `tests/agent-loop.test.ts` (mock `MockLanguageModelV4`) |
| Jev routing, judging, reply classification | `tests/jev.test.ts` |
| SQLite store + prompt enricher | `tests/feedback.test.ts` |
| Conversation engine + signals | `tests/conversation.test.ts` |
| Reply webhook routing | `tests/review-comment-events.test.ts` |
| Engine: agent, Jev, feedback paths | `tests/engine-agentic.test.ts` |
| Suggestion rendering + `fix` schema | `tests/suggestions.test.ts` |

## Known limits

- **Suggestions are not tracked as applied.** GitHub exposes no webhook for "suggestion applied", so `FeedbackSignal["applied"]` is defined but nothing produces it; only `disputed` and `agreed` are recorded today.
- **The router runs before the review, not per finding.** Model routing is per PR, not per file.
- **`openai-compatible` provider gets no tools.** Deliberate: the whole point of the fetch client is to be dependency-free.
- **Node's SQLite is still marked experimental**, so a Node upgrade can require attention at `feedback/tracker.ts`.
