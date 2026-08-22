import { describe, expect, it } from "vitest";
import { filterFiles, globToRegExp, isIgnored } from "../src/review/filters.js";
import { DEFAULT_IGNORES } from "../src/config.js";
import type { PRFile } from "../src/types.js";

function file(over: Partial<PRFile> = {}): PRFile {
  return {
    filename: "src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1,2 +1,3 @@\n x\n+y",
    ...over,
  };
}

const defaultOpts = { ignorePatterns: DEFAULT_IGNORES, maxFiles: 30, maxDiffChars: 120_000 };

describe("globToRegExp / isIgnored", () => {
  it("matches exact paths", () => {
    expect(globToRegExp("a.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("a.ts").test("b.ts")).toBe(false);
  });

  it("* does not cross directory boundaries", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/sub/a.ts")).toBe(false);
  });

  it("** crosses directory boundaries", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/x/y/z/a.ts")).toBe(true);
    expect(globToRegExp("**/*.min.js").test("deeply/nested/x.min.js")).toBe(true);
  });

  it("escapes regex metacharacters", () => {
    expect(globToRegExp("a.b+c.ts").test("a.b+c.ts")).toBe(true);
    expect(globToRegExp("a.b.ts").test("axb.ts")).toBe(false);
  });

  it("basename patterns match in any directory", () => {
    expect(isIgnored("backend/requirements/poetry.lock", ["poetry.lock"])).toBe(true);
  });
});

describe("filterFiles", () => {
  it("keeps normal modified files", () => {
    const r = filterFiles([file()], defaultOpts);
    expect(r.included).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it("drops ignored paths (defaults + custom merged by caller)", () => {
    const r = filterFiles(
      [file({ filename: "package-lock.json" }), file({ filename: "src/generated.ts" })],
      { ...defaultOpts, ignorePatterns: [...DEFAULT_IGNORES, "src/generated.ts"] },
    );
    expect(r.included).toHaveLength(0);
    expect(r.skipped.map((s) => s.path)).toEqual(["package-lock.json", "src/generated.ts"]);
  });

  it("drops files without a patch (binary/too large)", () => {
    const r = filterFiles([file({ filename: "logo.png", patch: undefined })], defaultOpts);
    expect(r.included).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/binary/);
  });

  it("caps file count and reports truncation", () => {
    const files = Array.from({ length: 5 }, (_, i) => file({ filename: `f${i}.ts` }));
    const r = filterFiles(files, { ...defaultOpts, maxFiles: 2 });
    expect(r.included.map((f) => f.filename)).toEqual(["f0.ts", "f1.ts"]);
    expect(r.truncatedByCount).toBe(true);
    expect(r.skipped).toHaveLength(3);
  });

  it("caps cumulative diff size and reports truncation", () => {
    const big = file({ filename: "big.ts", patch: "x".repeat(600) });
    const other = file({ filename: "other.ts", patch: "y".repeat(600) });
    const r = filterFiles([big, other], { ...defaultOpts, maxDiffChars: 1000 });
    expect(r.included.map((f) => f.filename)).toEqual(["big.ts"]);
    expect(r.truncatedBySize).toBe(true);
  });
});
