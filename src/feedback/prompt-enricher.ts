import type { RepoFeedbackSummary } from "./tracker.js";

/** Don't let a couple of replies rewrite the reviewer's behaviour. */
const MIN_POSTED_FOR_RATE = 5;
/** Dispute rate above this means the reviewer is guessing in that bucket. */
const HIGH_DISPUTE_RATE = 0.4;

/**
 * Turn accumulated feedback into short, factual guidance for the review prompt.
 * Empty when there is not enough signal — a handful of samples is noise, and
 * injecting noise into the prompt makes reviews worse, not better.
 */
export function buildLearnedPreferences(summary: RepoFeedbackSummary | null): string[] {
  if (!summary || summary.total < MIN_POSTED_FOR_RATE) return [];

  const lines: string[] = [];

  for (const [severity, stats] of Object.entries(summary.bySeverity)) {
    if (stats.posted < MIN_POSTED_FOR_RATE) continue;
    const disputeRate = stats.disputed / stats.posted;
    if (disputeRate >= HIGH_DISPUTE_RATE) {
      lines.push(
        `Findings reported as \`${severity}\` for this repository are disputed ${Math.round(
          disputeRate * 100,
        )}% of the time (${stats.disputed}/${stats.posted}). Treat that severity as harder to justify here and require stronger evidence before reporting it.`,
      );
    }
  }

  if (summary.topDisputed.length > 0) {
    const titles = summary.topDisputed.map((t) => `"${t.title}" (${t.count}x)`).join(", ");
    lines.push(
      `Developers on this repository have repeatedly pushed back on findings like: ${titles}. Check the code yourself before repeating one of these — do not assume the earlier report was correct.`,
    );
  }

  return lines;
}

/**
 * Merge learned preferences into a repo's maintainer instructions. Returns the
 * original string untouched when there is nothing to add.
 */
export function enrichInstructions(
  instructions: string | undefined,
  summary: RepoFeedbackSummary | null,
): string | undefined {
  const learned = buildLearnedPreferences(summary);
  if (learned.length === 0) return instructions;
  const block = ["Learned from past reviews on this repository (advisory):", ...learned.map((l) => `- ${l}`)].join(
    "\n",
  );
  return instructions?.trim() ? `${instructions.trim()}\n\n${block}` : block;
}
