import type { PlacedFinding } from "../types.js";
import type { FilterResult } from "./filters.js";

const SEVERITY_ICONS: Record<string, string> = {
  critical: "🔴",
  warning: "🟠",
  suggestion: "🔵",
  nit: "⚪",
};

/** Marker used to recognize our own reviews when deduping webhook redeliveries. */
export const REVIEW_MARKER = "<!-- ai-pr-reviewer -->";

export interface ReportInput {
  summary: string;
  placed: PlacedFinding[];
  filtered: FilterResult;
  model: string;
  configWarnings: string[];
}

export function renderReviewBody(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(REVIEW_MARKER);
  lines.push("## 🤖 AI Code Review");
  lines.push("");
  lines.push(input.summary.trim() || "No summary provided.");
  lines.push("");

  const counts = { critical: 0, warning: 0, suggestion: 0, nit: 0 };
  for (const p of input.placed) counts[p.finding.severity]++;
  const parts: string[] = [];
  if (counts.critical) parts.push(`🔴 ${counts.critical} critical`);
  if (counts.warning) parts.push(`🟠 ${counts.warning} warning`);
  if (counts.suggestion) parts.push(`🔵 ${counts.suggestion} suggestion`);
  if (counts.nit) parts.push(`⚪ ${counts.nit} nit`);

  lines.push(
    `**Reviewed ${input.filtered.included.length} files · ${
      parts.length ? parts.join(" · ") : "no findings 🎉"
    }**`,
  );

  if (input.filtered.skipped.length > 0) {
    lines.push("");
    lines.push(
      `<details><summary>${input.filtered.skipped.length} file(s) skipped (ignored, binary, or over size caps)</summary>`,
    );
    lines.push("");
    for (const s of input.filtered.skipped) lines.push(`- \`${s.path}\` — ${s.reason}`);
    lines.push("");
    lines.push("</details>");
  }

  const unplaced = input.placed.filter((p) => p.line === undefined);
  if (unplaced.length > 0) {
    lines.push("");
    lines.push("### Findings that could not be placed inline");
    for (const p of unplaced) {
      const f = p.finding;
      lines.push(`- **\`${f.file}\`** — ${SEVERITY_ICONS[f.severity]} **${f.title}** (${f.category})`);
      lines.push(`  - ${f.body.replace(/\n+/g, " ")}`);
    }
  }

  if (input.configWarnings.length > 0) {
    lines.push("");
    lines.push(`> ⚠️ ${input.configWarnings.join(" · ")}`);
  }

  lines.push("");
  lines.push("---");
  lines.push(`*Self-hosted ai-pr-reviewer · model: \`${input.model}\`*`);
  return lines.join("\n");
}

export function renderInlineComment(finding: {
  severity: string;
  category: string;
  title: string;
  body: string;
}): string {
  return `**${SEVERITY_ICONS[finding.severity] ?? "⚪"} ${
    finding.severity
  } · ${finding.category} — ${finding.title}**\n\n${finding.body}`;
}

export function renderDegradedBody(rawText: string, model: string): string {
  return [
    REVIEW_MARKER,
    "## 🤖 AI Code Review",
    "",
    "> ⚠️ The model did not return structured findings; showing its raw response instead.",
    "",
    rawText.trim(),
    "",
    "---",
    `*Self-hosted ai-pr-reviewer · model: \`${model}\`*`,
  ].join("\n");
}

export function renderFailureBody(message: string): string {
  return [
    REVIEW_MARKER,
    "## 🤖 AI Code Review",
    "",
    `> ⚠️ The automated review failed: ${message}`,
    "",
    "Check the reviewer service logs for details.",
  ].join("\n");
}
