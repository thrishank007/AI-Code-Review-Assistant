import type { PlacedFinding } from "../types.js";
import type { FilterResult } from "./filters.js";

const SEVERITY_ICONS: Record<string, string> = {
  critical: "🔴",
  warning: "🟠",
  suggestion: "🔵",
  nit: "⚪",
};

const SEVERITY_ORDER = ["critical", "warning", "suggestion", "nit"] as const;

/** Marker used to recognize our own reviews when deduping webhook redeliveries. */
export const REVIEW_MARKER = "<!-- ai-pr-reviewer -->";

export interface ReportInput {
  summary: string;
  overview: string;
  fileSummaries: { file: string; summary: string }[];
  placed: PlacedFinding[];
  filtered: FilterResult;
  configWarnings: string[];
}

/** Verdict heading driven by the highest finding severity. */
export function verdictFor(placed: PlacedFinding[]): string {
  const severities = new Set(placed.map((p) => p.finding.severity));
  if (severities.has("critical")) return "🔴 Changes required";
  if (severities.has("warning")) return "🟡 Changes recommended";
  if (placed.length > 0) return "💡 Minor suggestions";
  return "✅ Looks good";
}

export function renderReviewBody(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(REVIEW_MARKER);
  lines.push(`## ${verdictFor(input.placed)}`);
  lines.push("");
  lines.push(input.summary.trim() || "No summary provided.");
  lines.push("");
  lines.push("Get a fresh assessment by commenting `/review`.");
  lines.push("");

  // --- Pull request overview ---
  lines.push("<details>");
  lines.push("<summary>Pull request overview</summary>");
  lines.push("");
  lines.push(input.overview.trim() || input.summary.trim() || "No overview provided.");
  lines.push("");
  const stats = input.filtered.included
    .map((f) => `\`${f.filename}\` (+${f.additions}/-${f.deletions})`)
    .join(", ");
  lines.push(
    `Changed files: ${input.filtered.included.length}${stats ? ` — ${stats}` : ""}`,
  );
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // --- File summaries ---
  const summaryByFile = new Map(input.fileSummaries.map((s) => [s.file, s.summary]));
  lines.push("<details>");
  lines.push("<summary>File summaries</summary>");
  lines.push("");
  lines.push("| File | Summary |");
  lines.push("| --- | --- |");
  for (const f of input.filtered.included) {
    const summary = summaryByFile.get(f.filename) ?? `+${f.additions}/-${f.deletions} changes.`;
    lines.push(`| \`${f.filename}\` | ${summary.replace(/\n+/g, " ")} |`);
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // --- Review details ---
  lines.push("<details>");
  lines.push("<summary>Review details</summary>");
  lines.push("");
  if (input.placed.length === 0) {
    lines.push("No findings — the changed lines look clean. 🎉");
    lines.push("");
  } else {
    for (const severity of SEVERITY_ORDER) {
      const group = input.placed.filter((p) => p.finding.severity === severity);
      if (group.length === 0) continue;
      lines.push(`### ${SEVERITY_ICONS[severity]} ${severity} (${group.length})`);
      lines.push("");
      for (const p of group) {
        const f = p.finding;
        const where = p.line !== undefined ? `\`${f.file}:${p.line}\`` : `\`${f.file}\``;
        lines.push(`- **${where} — ${f.title}** (${f.confidence})`);
        lines.push(`  ${f.body.replace(/\n+/g, "\n  ")}`);
        lines.push("");
      }
    }
  }

  if (input.filtered.skipped.length > 0) {
    lines.push(
      `Skipped ${input.filtered.skipped.length} file(s) (ignored, binary, or over size caps): ` +
        input.filtered.skipped.map((s) => `\`${s.path}\``).join(", "),
    );
    lines.push("");
  }

  if (input.configWarnings.length > 0) {
    lines.push(`> ⚠️ ${input.configWarnings.join(" · ")}`);
    lines.push("");
  }
  lines.push("</details>");

  lines.push("");
  lines.push("---");
  lines.push(`*Self-hosted ai-pr-reviewer*`);
  return lines.join("\n");
}

export function renderInlineComment(finding: {
  severity: string;
  confidence: string;
  title: string;
  body: string;
}): string {
  return `**${SEVERITY_ICONS[finding.severity] ?? "⚪"} ${
    finding.severity
  } · ${finding.confidence} — ${finding.title}**\n\n${finding.body}`;
}

export function renderDegradedBody(rawText: string): string {
  return [
    REVIEW_MARKER,
    "## 🤖 AI Code Review",
    "",
    "> ⚠️ The model did not return structured findings; showing its raw response instead.",
    "",
    rawText.trim(),
    "",
    "---",
    `*Self-hosted ai-pr-reviewer*`,
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
