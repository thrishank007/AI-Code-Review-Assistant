import { describe, expect, it } from "vitest";
import {
  DEFAULT_IGNORES,
  EMPTY_REPO_CONFIG,
  loadEnv,
  parseRepoConfig,
} from "../src/config.js";

const validEnv = {
  APP_ID: "123456",
  PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpA\n-----END RSA PRIVATE KEY-----",
  WEBHOOK_SECRET: "s3cret",
  LLM_BASE_URL: "http://localhost:11434/v1",
  LLM_MODEL: "qwen2.5-coder:7b",
};

describe("loadEnv", () => {
  it("parses a valid environment with defaults applied", () => {
    const env = loadEnv(validEnv);
    expect(env.APP_ID).toBe(123456);
    expect(env.PORT).toBe(3000);
    expect(env.LLM_JSON_MODE).toBe(true);
    expect(env.MAX_FILES).toBe(30);
    expect(env.LLM_TIMEOUT_MS).toBe(120_000);
  });

  it("unescapes literal \\n in private keys", () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----
abcdefghijklmnopqrstuvwxyz0123456789
-----END RSA PRIVATE KEY-----`.replace(/\n/g, "\\n");
    const env = loadEnv({ ...validEnv, PRIVATE_KEY: key });
    expect(env.PRIVATE_KEY).not.toContain("\\n");
    expect(env.PRIVATE_KEY).toContain("\nabcdefghijklmnopqrstuvwxyz0123456789\n");
  });

  it("LLM_JSON_MODE=false disables JSON mode", () => {
    expect(loadEnv({ ...validEnv, LLM_JSON_MODE: "false" }).LLM_JSON_MODE).toBe(false);
  });

  it("fails fast listing every missing required var", () => {
    expect(() => loadEnv({})).toThrow(/Invalid environment/);
    expect(() => loadEnv({})).toThrow(/APP_ID/);
    expect(() => loadEnv({})).toThrow(/LLM_BASE_URL/);
  });

  it("rejects a non-URL LLM base", () => {
    expect(() => loadEnv({ ...validEnv, LLM_BASE_URL: "not-a-url" })).toThrow(/LLM_BASE_URL/);
  });
});

describe("parseRepoConfig", () => {
  it("returns empty config for missing/empty yaml", () => {
    expect(parseRepoConfig("")).toEqual({ config: EMPTY_REPO_CONFIG });
    expect(parseRepoConfig("null")).toEqual({ config: EMPTY_REPO_CONFIG });
  });

  it("parses all fields", () => {
    const { config, error } = parseRepoConfig(`
ignore: ["**/*.spec.ts"]
max_files: 10
instructions: "Flag missing error handling"
severities: [critical, warning]
`);
    expect(error).toBeUndefined();
    expect(config.ignore).toEqual(["**/*.spec.ts"]);
    expect(config.max_files).toBe(10);
    expect(config.instructions).toBe("Flag missing error handling");
    expect(config.severities).toEqual(["critical", "warning"]);
  });

  it("defaults ignore to an array", () => {
    expect(parseRepoConfig("max_files: 5").config.ignore).toEqual([]);
  });

  it("reports invalid yaml instead of throwing", () => {
    const { error } = parseRepoConfig("ignore: [unclosed");
    expect(error).toMatch(/YAML parse error/);
  });

  it("reports schema violations", () => {
    const { error } = parseRepoConfig("severities: [bogus]");
    expect(error).toMatch(/severities/);
  });

  it("DEFAULT_IGNORES covers lockfiles and build output", () => {
    expect(DEFAULT_IGNORES).toContain("package-lock.json");
    expect(DEFAULT_IGNORES).toContain("dist/**");
  });
});
