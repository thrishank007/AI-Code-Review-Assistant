import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Logger } from "../logger.js";
import type { Finding } from "../types.js";

/** How a developer reacted to one of our findings. */
export type FeedbackSignal = "applied" | "disputed" | "agreed";

export interface StoredFinding {
  commentId: number;
  repo: string;
  pullNumber: number;
  path: string;
  line: number | null;
  severity: string;
  title: string;
}

export interface RepoFeedbackSummary {
  /** Findings we have posted for this repo that are stored. */
  total: number;
  bySeverity: Record<
    string,
    { posted: number; accepted: number; disputed: number; agreed: number }
  >;
  /** Most frequently disputed finding titles, most disputed first. */
  topDisputed: { title: string; count: number }[];
}

/** Persistent, per-repo record of what we found and how it landed. */
export interface FeedbackTracker {
  recordPostedFindings(
    repo: string,
    pullNumber: number,
    items: { commentId: number; finding: Finding }[],
  ): void;
  findByCommentId(commentId: number): StoredFinding | null;
  recordSignal(commentId: number, signal: FeedbackSignal): void;
  getPreferences(repo: string): RepoFeedbackSummary;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): any[];
  get(...params: unknown[]): any;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS findings (
  comment_id  INTEGER PRIMARY KEY,
  repo        TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  path        TEXT NOT NULL,
  line        INTEGER,
  severity    TEXT NOT NULL,
  title       TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  signal      TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_repo ON findings (repo);
CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings (repo, fingerprint);
`;

/**
 * Normalize a finding title so repeats group together across phrasing tweaks
 * ("Retry loop never increments" vs "retry loop never increments!").
 */
export function fingerprintTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

class SqliteFeedbackTracker implements FeedbackTracker {
  private closed = false;

  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(SCHEMA);
  }

  recordPostedFindings(
    repo: string,
    pullNumber: number,
    items: { commentId: number; finding: Finding }[],
  ): void {
    if (items.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO findings
         (comment_id, repo, pull_number, path, line, severity, title, fingerprint, created_at, signal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(comment_id) DO UPDATE SET
         severity = excluded.severity,
         title = excluded.title,
         fingerprint = excluded.fingerprint`,
    );
    const now = new Date().toISOString();
    for (const { commentId, finding } of items) {
      stmt.run(
        commentId,
        repo,
        pullNumber,
        finding.file,
        finding.line,
        finding.severity,
        finding.title,
        fingerprintTitle(finding.title),
        now,
      );
    }
  }

  findByCommentId(commentId: number): StoredFinding | null {
    const row = this.db
      .prepare(
        `SELECT comment_id, repo, pull_number, path, line, severity, title
           FROM findings WHERE comment_id = ?`,
      )
      .get(commentId);
    if (!row) return null;
    return {
      commentId: Number(row.comment_id),
      repo: String(row.repo),
      pullNumber: Number(row.pull_number),
      path: String(row.path),
      line: typeof row.line === "number" ? row.line : null,
      severity: String(row.severity),
      title: String(row.title),
    };
  }

  recordSignal(commentId: number, signal: FeedbackSignal): void {
    this.db.prepare(`UPDATE findings SET signal = ? WHERE comment_id = ?`).run(signal, commentId);
  }

  getPreferences(repo: string): RepoFeedbackSummary {
    const rows = this.db
      .prepare(
        `SELECT severity,
                COUNT(*) AS posted,
                SUM(CASE WHEN signal = 'applied' THEN 1 ELSE 0 END) AS accepted,
                SUM(CASE WHEN signal = 'disputed' THEN 1 ELSE 0 END) AS disputed,
                SUM(CASE WHEN signal = 'agreed' THEN 1 ELSE 0 END) AS agreed
           FROM findings WHERE repo = ?
          GROUP BY severity`,
      )
      .all(repo) as any[];

    const bySeverity: RepoFeedbackSummary["bySeverity"] = {};
    let total = 0;
    for (const r of rows) {
      const posted = Number(r.posted ?? 0);
      total += posted;
      bySeverity[String(r.severity)] = {
        posted,
        accepted: Number(r.accepted ?? 0),
        disputed: Number(r.disputed ?? 0),
        agreed: Number(r.agreed ?? 0),
      };
    }

    const disputedRows = this.db
      .prepare(
        `SELECT MIN(title) AS title, COUNT(*) AS count
           FROM findings
          WHERE repo = ? AND signal = 'disputed'
          GROUP BY fingerprint
          ORDER BY count DESC, title ASC
          LIMIT 5`,
      )
      .all(repo) as any[];

    return {
      total,
      bySeverity,
      topDisputed: disputedRows.map((r) => ({
        title: String(r.title ?? ""),
        count: Number(r.count ?? 0),
      })),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/**
 * Open the SQLite feedback store. Returns null (with a warning) when Node's
 * built-in SQLite is unavailable, so an older runtime degrades instead of
 * crashing the whole reviewer.
 *
 * Uses `node:sqlite` deliberately: no native dependency, no build step, and the
 * service stays a single small Node process.
 */
export async function createFeedbackTracker(opts: {
  path: string;
  logger: Logger;
}): Promise<FeedbackTracker | null> {
  let DatabaseSync: new (path: string) => SqliteDatabase;
  try {
    const require = createRequire(import.meta.url);
    ({ DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase });
  } catch (e) {
    opts.logger.warn(
      { err: e },
      "Feedback store disabled: the configured Node runtime has no node:sqlite (needs Node 22.5+ with --experimental-sqlite, or Node 23.4+)",
    );
    return null;
  }

  try {
    if (opts.path !== ":memory:") {
      mkdirSync(dirname(opts.path), { recursive: true });
    }
    const db = new DatabaseSync(opts.path);
    return new SqliteFeedbackTracker(db);
  } catch (e) {
    opts.logger.warn({ err: e, path: opts.path }, "Feedback store disabled: could not open database");
    return null;
  }
}
