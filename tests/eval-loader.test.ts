import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEvalCases } from "../evals/src/loader.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evals-loader-"));
  tempDirs.push(dir);
  return dir;
}

function validCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-a",
    name: "Case A",
    description: "A test case",
    category: "golden",
    pr: { title: "PR title", body: null },
    files: [
      {
        filename: "src/app.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -1,2 +1,3 @@\n ctx\n+new\n ctx2",
      },
    ],
    ...overrides,
  };
}

describe("loadEvalCases", () => {
  it("discovers nested dataset files sorted by category then id", () => {
    const dir = makeDir();
    mkdirSync(join(dir, "golden"), { recursive: true });
    mkdirSync(join(dir, "synthetic"), { recursive: true });
    writeFileSync(join(dir, "synthetic", "b.json"), JSON.stringify(validCase({ id: "b", category: "synthetic" })));
    writeFileSync(join(dir, "golden", "z.json"), JSON.stringify(validCase({ id: "z", category: "golden" })));
    writeFileSync(join(dir, "golden", "a.json"), JSON.stringify(validCase({ id: "a", category: "golden" })));

    const cases = loadEvalCases(dir);
    expect(cases.map((c) => c.id)).toEqual(["a", "z", "b"]);
  });

  it("filters by category and case id", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "a.json"), JSON.stringify(validCase({ id: "a", category: "golden" })));
    writeFileSync(join(dir, "b.json"), JSON.stringify(validCase({ id: "b", category: "synthetic" })));

    expect(loadEvalCases(dir, { category: "golden" }).map((c) => c.id)).toEqual(["a"]);
    expect(loadEvalCases(dir, { caseId: "b" }).map((c) => c.id)).toEqual(["b"]);
    expect(loadEvalCases(dir, { category: "snapshot" })).toHaveLength(0);
  });

  it("returns an empty array for a missing directory", () => {
    expect(loadEvalCases(join(makeDir(), "nope"))).toEqual([]);
  });

  it("throws a clear error for invalid JSON", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => loadEvalCases(dir)).toThrow(/Invalid JSON in eval dataset .*bad\.json/);
  });

  it("throws a clear error for schema violations", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ id: "x" }));
    expect(() => loadEvalCases(dir)).toThrow(/Invalid eval dataset .*bad\.json/);
  });

  it("loads the real starter datasets", async () => {
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const datasetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "datasets");
    const cases = loadEvalCases(datasetsDir);
    expect(cases.map((c) => c.id)).toEqual([
      "missing-await",
      "null-deref",
      "sql-injection",
      "clean-diff",
      "race-condition",
      "xss-vulnerability",
    ]);
  });
});
