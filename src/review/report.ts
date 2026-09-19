import type { Finding } from "../types.js";

const SEVERITY_ICONS = {
  critical: "🔴",
  warning: "🟠",
  suggestion: "🔵",
  nit: "⚪",
} as const;

const SEVERITY_ORDER = ["critical", "warning", "suggestion", "nit"] as const;

/** Marker used to recognize our own reviews when deduping webhook redeliveries. */
export const REVIEW_MARKER = "<!-- ai-pr-reviewer -->";

/** Verdict heading driven by the highest finding severity. */
export function verdictFor(placed: { finding: { severity: string } }[]): string {
  const severities = new Set(placed.map((p) => p.finding.severity));
  if (severities.has("critical")) return "🔴 Changes required";
  if (severities.has("warning")) return "🟡 Changes recommended";
  if (placed.length > 0) return "💡 Minor suggestions";
  return "✅ Looks good";
}

export interface RenderReviewInput {
  summary: string;
  overview: string;
  fileSummaries: { file: string; summary: string }[];
  placed: { finding: Finding; line?: number }[];
  filtered: { included: { filename: string; additions: number; deletions: number }[]; skipped: { path: string }[] };
  configWarnings: string[];
  /** Informational lines (e.g. Jev decision-layer outcomes). */
  notes?: string[];
}

export function renderReviewBody(input: RenderReviewInput): string {
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
  lines.push(`Changed files: ${input.filtered.included.length}${stats ? ` — ${stats}` : ""}`);
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

  if (input.notes && input.notes.length > 0) {
    lines.push(`> ℹ️ ${input.notes.join(" · ")}`);
    lines.push("");
  }

  lines.push("</details>");
  lines.push("");
  lines.push("---");
  lines.push(`*Self-hosted ai-pr-reviewer*`);
  return lines.join("\n");
}

/**
 * Matches the header every inline comment we post starts with. Used to tell our
 * own review comments apart from a human's when a thread gets a reply.
 */
export const INLINE_COMMENT_PREFIX_RE =
  /^\*\*(?:🔴|🟠|🔵|⚪)\s+(?:critical|warning|suggestion|nit)\s+·\s+(?:high|medium)\s+—/;

/** True when a comment body was produced by this reviewer. */
export function isOurInlineComment(body: string): boolean {
  return INLINE_COMMENT_PREFIX_RE.test(body.trim());
}

export function renderInlineComment(finding: Finding): string {
  const parts = [
    `**${SEVERITY_ICONS[finding.severity] ?? "⚪"} ${finding.severity} · ${finding.confidence} — ${finding.title}**`,
    "",
    finding.body,
  ];
  const suggestion = renderSuggestion(finding.fix);
  if (suggestion) parts.push("", suggestion);
  return parts.join("\n");
}

/**
 * Render a GitHub one-click suggestion block. Returns null when the fix is
 * missing or cannot be expressed safely as a suggestion (nested fences would
 * break out of the block).
 */
export function renderSuggestion(fix?: string): string | null {
  const body = fix?.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!body?.trim()) return null;
  if (body.includes("```")) return null;
  return ["```suggestion", body, "```"].join("\n");
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
