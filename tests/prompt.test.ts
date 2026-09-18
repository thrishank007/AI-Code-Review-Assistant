import { describe, expect, it } from "vitest";
import { buildMessages, JSON_REPAIR_USER_PROMPT, SYSTEM_PROMPT } from "../src/review/prompt.js";
import type { PRFile } from "../src/types.js";

const files: PRFile[] = [
  {
    filename: "src/server.ts",
    status: "modified",
    additions: 4,
    deletions: 1,
    changes: 5,
    patch: "@@ -10,4 +10,5 @@\n ctx\n+added()",
  },
  {
    filename: "README.md",
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1,1 +1,2 @@\n # Title\n+New line",
  },
];

describe("buildMessages", () => {
  const messages = buildMessages({
    prTitle: "Add health endpoint",
    prBody: "Implements GET /healthz",
    files,
    instructions: "We use Fastify; flag missing await",
    skippedCount: 3,
  });

  it("returns system + user messages with the strict-JSON contract", () => {
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toMatch(/valid JSON object/);
    expect(SYSTEM_PROMPT).toMatch(/"severity"/);
    expect(SYSTEM_PROMPT).toMatch(/"overview"/);
    expect(SYSTEM_PROMPT).toMatch(/"fileSummaries"/);
  });

  it("user message includes PR context, file stats, diffs, and instructions", () => {
    const user = messages[1]!.content;
    expect(user).toContain("Add health endpoint");
    expect(user).toContain("GET /healthz");
    expect(user).toContain("src/server.ts (+4/-1)");
    expect(user).toContain("----- src/server.ts -----");
    expect(user).toContain("+added()");
    expect(user).toContain("3 additional files were skipped");
    expect(user).toContain("We use Fastify");
  });

  it("omits the instructions and skipped sections when not provided", () => {
    const user = buildMessages({ prTitle: "t", prBody: null, files })[1]!.content;
    expect(user).not.toContain("Maintainer review instructions");
    expect(user).not.toContain("skipped");
    expect(user).toContain("(none)");
  });
});

describe("JSON_REPAIR_USER_PROMPT", () => {
  it("mentions the parse error", () => {
    expect(JSON_REPAIR_USER_PROMPT("Unexpected token")).toContain("Unexpected token");
    expect(JSON_REPAIR_USER_PROMPT("x")).toMatch(/corrected JSON/);
  });
});
