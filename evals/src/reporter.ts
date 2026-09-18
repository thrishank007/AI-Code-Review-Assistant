import { readdirSync } from "node:fs";
import type { CaseResult, EvalMetrics, EvalReport } from "./types.js";

// ---- ANSI helpers (no new deps) ----

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function colorFor(pct: number): string {
  if (pct >= 0.8) return GREEN;
  if (pct >= 0.5) return YELLOW;
  return RED;
}

function bar(pct: number, width = 26): string {
  const filled = Math.round(Math.min(1, Math.max(0, pct)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`.padStart(4);
}

function fmtLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtTokens(n: number): string {
  return `~${Math.round(n).toLocaleString("en-US")}`;
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export interface CaseStats {
  matched: number;
  expected: number;
  unmatched: number;
  precision: number | null;
  recall: number | null;
}

/** Per-case precision/recall; null when the case has no expectations (snapshot). */
export function caseStats(c: CaseResult): CaseStats {
  const matched = c.matches.filter((m) => m.actual !== null).length;
  const expected = c.matches.length;
  const unmatched = c.unmatchedActual.length;
  if (expected === 0 && unmatched === 0) {
    // No expectations and no findings — vacuously clean; still reportable
    // only when the case actually declares expectations.
    return { matched, expected, unmatched, precision: null, recall: null };
  }
  if (expected === 0) return { matched, expected, unmatched, precision: null, recall: null };
  const precision = matched + unmatched === 0 ? 1 : matched / (matched + unmatched);
  const recall = expected === 0 ? 1 : matched / expected;
  return { matched, expected, unmatched, precision, recall };
}

export function caseIcon(c: CaseResult): string {
  if (!c.parsedOnFirstTry) return "❌";
  const s = caseStats(c);
  if (s.precision === null || s.recall === null) {
    return (c.reviewResult?.findings.length ?? 0) === 0 ? "✅" : "⚠️";
  }
  if (s.precision === 1 && s.recall === 1) return "✅";
  if (s.recall >= 0.5 && s.precision >= 0.5) return "⚠️";
  return "❌";
}

// ---- Console output ----

function metricRow(label: string, value: number, extra?: string): string {
  const c = colorFor(value);
  return `│ ${label.padEnd(17)}│ ${c}${bar(value)} ${pct(value)}${RESET}  ${extra ?? ""}`.trimEnd();
}

export function renderConsole(report: EvalReport, reportPath: string): string {
  const m: EvalMetrics = report.metrics;
  const lines: string[] = [];
  lines.push(`┌${"─".repeat(55)}┐`);
  lines.push(`│  ${BOLD}ai-pr-reviewer evals · ${report.model} · ${report.cases.length} cases${RESET}`);
  lines.push(`├${"─".repeat(19)}┬${"─".repeat(35)}┤`);
  lines.push(metricRow("Format Compliance", m.formatCompliance));
  lines.push(metricRow("Precision", m.precision));
  lines.push(metricRow("Recall", m.recall));
  lines.push(metricRow("Line Accuracy", m.lineAccuracy));
  lines.push(metricRow("Severity Calib.", m.severityCalibration));
  const cons = m.consistency;
  const measured = report.cases.some((c) => c.runIndex > 0);
  lines.push(
    `│ ${"Consistency".padEnd(17)}│ ${!measured ? DIM : colorFor(cons)}${!measured ? "n/a (repeat=1)".padEnd(31) : `${bar(cons)} ${pct(cons)}`}  ${RESET}`.trimEnd(),
  );
  lines.push(`│ ${"Avg Latency".padEnd(17)}│ ${fmtLatency(m.avgLatencyMs)}`);
  lines.push(`│ ${"Est. Tokens".padEnd(17)}│ ${fmtTokens(m.totalTokenEstimate)}`);
  lines.push(`├${"─".repeat(55)}┤`);
  lines.push(`│ ${BOLD}Per-Case Results${RESET}`);
  lines.push(`├${"─".repeat(18)}┬${"─".repeat(8)}┬${"─".repeat(7)}┬${"─".repeat(7)}┬${"─".repeat(11)}┤`);
  lines.push(`│ ${"Case".padEnd(16)}│ ${"Format".padEnd(6)}│ ${"P".padEnd(5)}│ ${"R".padEnd(5)}│ ${"Latency".padEnd(9)}│`);
  lines.push(`├${"─".repeat(18)}┼${"─".repeat(8)}┼${"─".repeat(7)}┼${"─".repeat(7)}┼${"─".repeat(11)}┤`);
  for (const c of report.cases) {
    const s = caseStats(c);
    const fmt = c.parsedOnFirstTry ? `${GREEN}✅${RESET}` : `${RED}❌${RESET}`;
    const p = s.precision === null ? `${DIM}n/a${RESET}` : pct(s.precision);
    const r = s.recall === null ? `${DIM}n/a${RESET}` : pct(s.recall);
    lines.push(
      `│ ${c.caseId.slice(0, 16).padEnd(16)}│ ${fmt}    │ ${p} │ ${r} │ ${fmtLatency(c.latencyMs).padEnd(9)}│`,
    );
  }
  lines.push(`└${"─".repeat(18)}┴${"─".repeat(8)}┴${"─".repeat(7)}┴${"─".repeat(7)}┴${"─".repeat(11)}┘`);
  lines.push(`${DIM}Duration: ${fmtDuration(report.durationMs)}${RESET}`);
  lines.push(`${CYAN}Report: ${reportPath}${RESET}`);
  return lines.join("\n");
}

// ---- Markdown report ----

export function sanitizeModelForFilename(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

export function reportFilename(report: EvalReport): string {
  const stamp = report.timestamp.replace(/[:.]/g, "-");
  return `${stamp}_${sanitizeModelForFilename(report.model)}.md`;
}

/** Other markdown reports already in the reports dir (for the comparison section). */
export function listExistingReports(reportsDir: string, excludeFile: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(reportsDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".md") && e !== excludeFile)
    .sort();
}

export function renderMarkdown(report: EvalReport, existingReports: string[] = []): string {
  const m = report.metrics;
  const out: string[] = [];

  out.push(`# Eval Report — ${report.model}`);
  out.push("");
  out.push(`- **Timestamp:** ${report.timestamp}`);
  out.push(`- **Model:** \`${report.model}\``);
  out.push(`- **Dataset filter:** \`${report.datasetFilter}\``);
  out.push(`- **Cases:** ${report.cases.length}`);
  out.push(`- **Duration:** ${fmtDuration(report.durationMs)}`);
  out.push("");

  out.push(`## Metrics`);
  out.push("");
  out.push(`| Metric | Value |`);
  out.push(`| --- | --- |`);
  out.push(`| Format compliance | ${pct(m.formatCompliance)} |`);
  out.push(`| Precision | ${pct(m.precision)} |`);
  out.push(`| Recall | ${pct(m.recall)} |`);
  out.push(`| Line accuracy | ${pct(m.lineAccuracy)} |`);
  out.push(`| Severity calibration | ${pct(m.severityCalibration)} |`);
  out.push(
    `| Consistency | ${report.cases.some((c) => c.runIndex > 0) ? pct(m.consistency) : "n/a (repeat=1)"} |`,
  );
  out.push(`| Avg latency | ${fmtLatency(m.avgLatencyMs)} |`);
  out.push(`| Est. tokens | ${fmtTokens(m.totalTokenEstimate)} |`);
  out.push("");

  out.push(`## Per-Case Results`);
  out.push("");
  out.push(`| Case | Category | Format | Precision | Recall | Latency |`);
  out.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const c of report.cases) {
    const s = caseStats(c);
    const fmt = c.parsedOnFirstTry ? "✅" : "❌";
    const p = s.precision === null ? "n/a" : pct(s.precision).trim();
    const r = s.recall === null ? "n/a" : pct(s.recall).trim();
    out.push(
      `| ${c.caseId} | ${c.category} | ${fmt} | ${p} | ${r} | ${fmtLatency(c.latencyMs)} |`,
    );
  }
  out.push("");

  for (const c of report.cases) {
    out.push(`### ${caseIcon(c)} ${c.caseId} — ${c.caseName}`);
    out.push("");
    out.push(`- **Outcome:** \`${c.outcome.status}\` · **Latency:** ${fmtLatency(c.latencyMs)} · **Tokens:** ${fmtTokens(c.promptTokenEstimate + c.completionTokenEstimate)}`);
    if (c.matches.length === 0 && c.unmatchedActual.length === 0) {
      const actualCount = c.reviewResult?.findings.length ?? 0;
      out.push(`- No expectations declared (snapshot-style case); model reported ${actualCount} finding(s).`);
      out.push("");
      continue;
    }
    out.push("");
    out.push(`| Expected | Actual | File | Line | Severity | Title |`);
    out.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const mt of c.matches) {
      const exp = `\`${mt.expected.file}\`${mt.expected.lineRange ? ` [${mt.expected.lineRange[0]}–${mt.expected.lineRange[1]}]` : ""}`;
      if (!mt.actual) {
        out.push(`| ${exp} | _missed_ | ❌ | ❌ | ❌ | ❌ |`);
        continue;
      }
      const a = mt.actual;
      out.push(
        `| ${exp} | ${a.title.replace(/\|/g, "\\|").slice(0, 80)} | ${mt.fileMatched ? "✅" : "❌"} | ${mt.lineMatched ? "✅" : `❌ (${a.line})`} | ${mt.severityMatched ? "✅" : `❌ (${a.severity})`} | ${mt.titleMatched ? "✅" : "❌"} |`,
      );
    }
    for (const fp of c.unmatchedActual) {
      out.push(
        `| _— (false positive)_ | ${fp.title.replace(/\|/g, "\\|").slice(0, 80)} | \`${fp.file}:${fp.line}\` | — | ${fp.severity} | — |`,
      );
    }
    out.push("");
  }

  out.push(`## Model Comparison`);
  out.push("");
  if (existingReports.length === 0) {
    out.push(`No other reports in \`evals/reports/\` yet. Run the eval with a different \`--model\` to compare.`);
  } else {
    out.push(`Other reports available for comparison:`);
    out.push("");
    for (const f of existingReports) {
      out.push(`- \`${f}\``);
    }
  }
  out.push("");

  return out.join("\n");
}
