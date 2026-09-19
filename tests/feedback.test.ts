import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFeedbackTracker,
  fingerprintTitle,
  type FeedbackTracker,
} from "../src/feedback/tracker.js";
import { buildLearnedPreferences, enrichInstructions } from "../src/feedback/prompt-enricher.js";
import { createLogger } from "../src/logger.js";
import type { Finding } from "../src/types.js";

const logger = createLogger("fatal");

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 3,
    severity: "warning",
    confidence: "high",
    title: "Missing await",
    body: "The call is not awaited.",
    ...over,
  };
}

describe("fingerprintTitle", () => {
  it("groups titles that differ only in punctuation and casing", () => {
    expect(fingerprintTitle("Retry loop never increments!")).toBe("retry loop never increments");
    expect(fingerprintTitle("retry   loop  never increments")).toBe("retry loop never increments");
  });
});

describe("FeedbackTracker", () => {
  let tracker: FeedbackTracker;

  beforeEach(async () => {
    tracker = (await createFeedbackTracker({ path: ":memory:", logger }))!;
    expect(tracker).not.toBeNull();
  });

  afterEach(() => tracker?.close());

  it("stores posted findings and finds them by comment id", () => {
    tracker.recordPostedFindings("o/r", 7, [
      { commentId: 101, finding: finding() },
      { commentId: 102, finding: finding({ severity: "critical", title: "Auth bypass" }) },
    ]);

    expect(tracker.findByCommentId(101)).toEqual({
      commentId: 101,
      repo: "o/r",
      pullNumber: 7,
      path: "src/a.ts",
      line: 3,
      severity: "warning",
      title: "Missing await",
    });
    expect(tracker.findByCommentId(999)).toBeNull();
  });

  it("records signals and aggregates them per repo", () => {
    tracker.recordPostedFindings("o/r", 7, [
      { commentId: 1, finding: finding() },
      { commentId: 2, finding: finding() },
      { commentId: 3, finding: finding({ severity: "suggestion", title: "Naming" }) },
    ]);
    tracker.recordSignal(1, "disputed");
    tracker.recordSignal(2, "agreed");
    tracker.recordSignal(3, "applied");

    const summary = tracker.getPreferences("o/r");
    expect(summary.total).toBe(3);
    expect(summary.bySeverity.warning).toEqual({ posted: 2, accepted: 0, disputed: 1, agreed: 1 });
    expect(summary.bySeverity.suggestion).toEqual({ posted: 1, accepted: 1, disputed: 0, agreed: 0 });
  });

  it("keeps repos isolated from each other", () => {
    tracker.recordPostedFindings("o/r", 1, [{ commentId: 1, finding: finding() }]);
    tracker.recordPostedFindings("o/other", 1, [{ commentId: 2, finding: finding() }]);
    tracker.recordSignal(2, "disputed");

    expect(tracker.getPreferences("o/r").total).toBe(1);
    expect(tracker.getPreferences("o/r").bySeverity.warning?.disputed).toBe(0);
    expect(tracker.getPreferences("o/other").bySeverity.warning?.disputed).toBe(1);
  });

  it("groups disputed titles by fingerprint", () => {
    tracker.recordPostedFindings("o/r", 1, [
      { commentId: 1, finding: finding({ title: "Retry loop never increments!" }) },
      { commentId: 2, finding: finding({ title: "retry loop never increments" }) },
    ]);
    tracker.recordSignal(1, "disputed");
    tracker.recordSignal(2, "disputed");

    expect(tracker.getPreferences("o/r").topDisputed).toEqual([
      { title: "Retry loop never increments!", count: 2 },
    ]);
  });

  it("is idempotent when the same comment is recorded twice", () => {
    tracker.recordPostedFindings("o/r", 1, [{ commentId: 1, finding: finding() }]);
    tracker.recordPostedFindings("o/r", 1, [
      { commentId: 1, finding: finding({ severity: "critical", title: "Escalated" }) },
    ]);

    const row = tracker.findByCommentId(1)!;
    expect(row.severity).toBe("critical");
    expect(row.title).toBe("Escalated");
    expect(tracker.getPreferences("o/r").total).toBe(1);
  });

  it("returns an empty summary for an unseen repo", () => {
    expect(tracker.getPreferences("nobody/here")).toEqual({
      total: 0,
      bySeverity: {},
      topDisputed: [],
    });
  });
});

describe("buildLearnedPreferences", () => {
  it("stays quiet below the minimum sample size", () => {
    expect(
      buildLearnedPreferences({
        total: 3,
        bySeverity: { warning: { posted: 3, accepted: 0, disputed: 3, agreed: 0 } },
        topDisputed: [{ title: "x", count: 3 }],
      }),
    ).toEqual([]);
  });

  it("flags a severity bucket with a high dispute rate", () => {
    const lines = buildLearnedPreferences({
      total: 10,
      bySeverity: {
        warning: { posted: 10, accepted: 0, disputed: 6, agreed: 1 },
        critical: { posted: 6, accepted: 5, disputed: 0, agreed: 0 },
      },
      topDisputed: [],
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("warning");
    expect(lines[0]).toContain("60%");
    expect(lines.join(" ")).not.toContain("critical");
  });

  it("lists the most disputed finding titles", () => {
    const lines = buildLearnedPreferences({
      total: 8,
      bySeverity: {},
      topDisputed: [{ title: "Missing await", count: 4 }],
    });
    expect(lines[0]).toContain('"Missing await" (4x)');
  });

  it("handles a null summary", () => {
    expect(buildLearnedPreferences(null)).toEqual([]);
  });
});

describe("enrichInstructions", () => {
  it("returns the original instructions when there is nothing learned", () => {
    expect(enrichInstructions("flagg X", null)).toBe("flagg X");
    expect(enrichInstructions(undefined, null)).toBeUndefined();
  });

  it("appends the learned block to existing instructions", () => {
    const out = enrichInstructions("Use Fastify", {
      total: 10,
      bySeverity: {},
      topDisputed: [{ title: "Off-by-one", count: 3 }],
    })!;
    expect(out.startsWith("Use Fastify")).toBe(true);
    expect(out).toContain("Learned from past reviews");
    expect(out).toContain("Off-by-one");
  });

  it("produces a block on its own when there were no instructions", () => {
    const out = enrichInstructions(undefined, {
      total: 10,
      bySeverity: {},
      topDisputed: [{ title: "Off-by-one", count: 3 }],
    })!;
    expect(out).toContain("Learned from past reviews");
  });
});
