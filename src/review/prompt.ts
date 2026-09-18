import type { ChatMessage } from "../llm/client.js";
import type { PRFile } from "../types.js";

export const SYSTEM_PROMPT = `You are a meticulous senior code reviewer embedded in a pull request pipeline.

Respond with ONLY a single valid JSON object — no markdown fences, no prose before or after — matching exactly this schema:
{
  "summary": string,            // 1-2 sentences, action-focused: what the author should address, plus your overall assessment
  "overview": string,           // 2-4 sentences: what this PR does and why (for the "Pull request overview" section)
  "fileSummaries": [            // one entry per file listed under Changed Files below, in the same order
    {
      "file": string,           // EXACT path as listed in the diffs below
      "summary": string         // 1 sentence: what changed in this file and why it matters
    }
  ],
  "findings": [                 // at most 12, ordered by severity
    {
      "file": string,           // EXACT path as listed in the diffs below
      "line": number,           // line number in the NEW (right-side) version of the file
      "severity": "critical" | "warning" | "suggestion" | "nit",
      "category": string,       // bug | security | performance | style | maintainability | tests | docs | general
      "title": string,          // <= 80 chars, states the problem
      "body": string            // concise markdown: what is wrong, why it matters, and the suggested fix
    }
  ]
}

Rules:
- Report ONLY issues in or directly caused by the CHANGED lines (+/-) of this diff. Do not review unchanged code.
- "line" must be a line that is visible in the new version of the diff hunks for that file.
- severity: critical = bug/security flaw/data loss that will break something; warning = likely bug or risky pattern; suggestion = meaningful improvement; nit = minor style/polish.
- Prioritize correctness and security bugs. Skip speculative or stylistic churn. Quality over quantity.
- The summary must name the concrete areas to address (e.g. "Address the registration validation, UUID normalization, and coverage gaps."), not generic praise.
- If the diff is genuinely clean, return an empty findings array and say so in the summary.`;

export interface PromptInput {
  prTitle: string;
  prBody?: string | null;
  files: PRFile[];
  instructions?: string;
  skippedCount?: number;
}

export function buildMessages(input: PromptInput): ChatMessage[] {
  const parts: string[] = [];
  parts.push(`## Pull Request\nTitle: ${input.prTitle}`);
  parts.push(`Description:\n${(input.prBody ?? "").trim() || "(none)"}`);

  const stats = input.files
    .map((f) => `- ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join("\n");
  parts.push(`## Changed Files (${input.files.length})\n${stats}`);
  if (input.skippedCount) {
    parts.push(`(${input.skippedCount} additional files were skipped by review configuration.)`);
  }

  const diffs = input.files
    .map((f) => `----- ${f.filename} -----\n${f.patch ?? ""}`)
    .join("\n\n");
  parts.push(`## Diffs (unified; line numbers in @@ headers refer to the new version)\n${diffs}`);

  if (input.instructions?.trim()) {
    parts.push(
      `## Maintainer review instructions (follow with high priority)\n${input.instructions.trim()}`,
    );
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") },
  ];
}

export const JSON_REPAIR_USER_PROMPT = (parseError: string) =>
  `Your previous response could not be parsed as JSON matching the required schema (${parseError}). Respond again with ONLY the corrected JSON object — no fences, no commentary.`;
