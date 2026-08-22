import { z } from "zod";
import { parse as parseYaml } from "yaml";

export const SEVERITIES = ["critical", "warning", "suggestion", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

const envBool = z
  .string()
  .optional()
  .transform((v) => v !== "false");

export const EnvSchema = z.object({
  APP_ID: z.coerce.number().int().positive(),
  // GitHub App private keys pasted as env vars typically contain literal "\n".
  PRIVATE_KEY: z
    .string()
    .min(50)
    .transform((s) => s.replace(/\\n/g, "\n")),
  WEBHOOK_SECRET: z.string().min(1),
  GITHUB_API_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().min(1),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  LLM_JSON_MODE: envBool,
  MAX_FILES: z.coerce.number().int().positive().default(30),
  MAX_DIFF_CHARS: z.coerce.number().int().positive().default(120_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(vars: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(vars);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const RepoConfigSchema = z.object({
  ignore: z.array(z.string()).default([]),
  max_files: z.number().int().positive().optional(),
  instructions: z.string().optional(),
  severities: z.array(z.enum(SEVERITIES)).optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export interface RepoConfigResult {
  config: RepoConfig;
  /** Set when a .aireview.yml exists but could not be parsed/validated. */
  error?: string;
}

export function parseRepoConfig(yamlText: string): RepoConfigResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (e) {
    return { config: {}, error: `YAML parse error: ${(e as Error).message}` };
  }
  if (parsed == null) return { config: {} };
  const result = RepoConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: {},
      error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { config: result.data };
}

/** Glob patterns always ignored, merged with repo-level `ignore`. */
export const DEFAULT_IGNORES: string[] = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "Poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "go.work.sum",
  "flake.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "dist/**",
  "build/**",
  "out/**",
  "coverage/**",
  "node_modules/**",
  "vendor/**",
  ".min/**",
];
