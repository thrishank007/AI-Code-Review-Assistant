import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { GitHubClient } from "../github/client.js";
import type { Logger } from "../logger.js";

/** Shared state every tool needs: GitHub access, PR coordinates, and a budget. */
export interface AgentToolContext {
  github: GitHubClient;
  logger: Logger;
  installationId: number;
  owner: string;
  repo: string;
  /** Ref the agent reads from — the PR head SHA, so it sees the proposed code. */
  headSha: string;
  /** Paths changed by the PR, so `read_file` can flag out-of-scope reads. */
  changedPaths: string[];
  /** Hard ceiling on tool calls across the whole review. */
  maxToolCalls: number;
  /** Mutable counter shared by every tool in one review run. */
  budget: { used: number };
  /** Injectable for tests; counts calls per tool name. */
  onToolCall?: (name: string, input: unknown) => void;
}

const MAX_FILE_LINES = 400;
const MAX_FILE_CHARS = 40_000;
const MAX_OUTPUT_CHARS = 12_000;

/** Files that describe how a repo wants contributions to look. */
const CONVENTION_FILES = [
  "CONTRIBUTING.md",
  "AGENTS.md",
  ".editorconfig",
  "CODE_OF_CONDUCT.md",
  "docs/CONTRIBUTING.md",
];

function sanitizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} characters]`;
}

/** Number lines so the model can cite exact new-side line numbers. */
function withLineNumbers(content: string): string {
  const lines = content.split("\n").slice(0, MAX_FILE_LINES);
  return lines.map((l, i) => `${String(i + 1).padStart(5)} | ${l}`).join("\n");
}

/** Charge the shared tool budget; throws so the model sees a usable message. */
function charge(ctx: AgentToolContext, name: string, input: unknown): void {
  if (ctx.budget.used >= ctx.maxToolCalls) {
    throw new Error(
      `Tool budget exhausted (${ctx.maxToolCalls} calls). Stop calling tools and emit the final review JSON now.`,
    );
  }
  ctx.budget.used++;
  ctx.onToolCall?.(name, input);
}

async function safe<T>(ctx: AgentToolContext, name: string, fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn();
  } catch (e) {
    ctx.logger.debug({ err: e, tool: name }, "Agent tool failed");
    return `Tool "${name}" failed: ${(e as Error).message}`;
  }
}

/**
 * The context tools available to the review agent. Every tool is read-only and
 * installation-scoped; there is no way for the model to touch anything but the
 * PR's own repository at its head SHA.
 */
export function createReviewTools(ctx: AgentToolContext): ToolSet {
  return {
    read_file: tool({
      description:
        "Read a file from the repository at the PR head revision, with line numbers. Use this to see code the diff only shows partially (imports, callers, surrounding functions).",
      inputSchema: z.object({
        path: z.string().min(1).describe("Repository-relative path, e.g. src/auth/session.ts"),
      }),
      execute: async ({ path }) => {
        charge(ctx, "read_file", path);
        const clean = sanitizePath(path);
        return safe(ctx, "read_file", async () => {
          const content = await ctx.github.getFileContent(
            ctx.installationId,
            ctx.owner,
            ctx.repo,
            clean,
            ctx.headSha,
          );
          if (content === null) {
            return `File not found at ${clean} (or it is a directory). Try list_directory instead.`;
          }
          const header = ctx.changedPaths.includes(clean)
            ? `${clean} (changed by this PR, at head ${ctx.headSha.slice(0, 7)}):`
            : `${clean} (unchanged by this PR — for context only, at head ${ctx.headSha.slice(0, 7)}):`;
          return `${header}\n${truncate(withLineNumbers(content.slice(0, MAX_FILE_CHARS)))}`;
        });
      },
    }),

    list_directory: tool({
      description:
        "List the entries of a repository directory. Use it to understand project structure before searching.",
      inputSchema: z.object({
        path: z.string().describe("Directory path relative to the repo root; use \".\" for the root"),
      }),
      execute: async ({ path }) => {
        charge(ctx, "list_directory", path);
        const clean = sanitizePath(path) || "";
        return safe(ctx, "list_directory", async () => {
          const entries = await ctx.github.listDirectory(
            ctx.installationId,
            ctx.owner,
            ctx.repo,
            clean,
            ctx.headSha,
          );
          if (entries.length === 0) return `No entries at ${clean || "/"}.`;
          return entries
            .map(
              (e) =>
                `${e.type === "dir" ? "dir " : "file"} ${e.path}${e.size ? ` (${e.size} bytes)` : ""}`,
            )
            .join("\n");
        });
      },
    }),

    search_code: tool({
      description:
        "Search the repository's code for a symbol, string, or pattern. Use it to find callers or definitions the diff does not include.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Search query, e.g. \"validateSession\" or \"process.env.DATABASE_URL\""),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 10)"),
      }),
      execute: async ({ query, limit }) => {
        charge(ctx, "search_code", query);
        return safe(ctx, "search_code", async () => {
          const hits = await ctx.github.searchCode(
            ctx.installationId,
            ctx.owner,
            ctx.repo,
            query,
            limit ?? 10,
          );
          if (hits.length === 0) return `No matches for ${JSON.stringify(query)}.`;
          return hits
            .map((h) => `- ${h.path}${h.excerpt ? `\n  ${h.excerpt.replace(/\n/g, "\n  ")}` : ""}`)
            .join("\n");
        });
      },
    }),

    get_file_history: tool({
      description:
        "Show recent commits touching a path. Use it to judge whether a change is a regression in an area that churns often.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Repository-relative file path"),
        limit: z.number().int().min(1).max(20).optional().describe("Max commits (default 5)"),
      }),
      execute: async ({ path, limit }) => {
        charge(ctx, "get_file_history", path);
        return safe(ctx, "get_file_history", async () => {
          const commits = await ctx.github.listFileCommits(
            ctx.installationId,
            ctx.owner,
            ctx.repo,
            sanitizePath(path),
            ctx.headSha,
            limit ?? 5,
          );
          if (commits.length === 0) return `No commits found for ${path}.`;
          return commits
            .map((c) => `${c.sha} ${c.date ?? ""} ${c.author ?? ""} — ${c.message}`)
            .join("\n");
        });
      },
    }),

    read_repo_conventions: tool({
      description:
        "Read the repository's contribution conventions (CONTRIBUTING.md, AGENTS.md, .editorconfig, README). Use it before flagging style or process issues.",
      inputSchema: z.object({}),
      execute: async () => {
        charge(ctx, "read_repo_conventions", {});
        return safe(ctx, "read_repo_conventions", async () => {
          const wanted = ["README.md", ...CONVENTION_FILES];
          const found: string[] = [];
          for (const path of wanted) {
            const content = await ctx.github.getFileContent(
              ctx.installationId,
              ctx.owner,
              ctx.repo,
              path,
              ctx.headSha,
            );
            if (content === null || !content.trim()) continue;
            found.push(`----- ${path} -----\n${content.trim().slice(0, 4_000)}`);
          }
          if (found.length === 0) return "No convention files found (no README, CONTRIBUTING, or AGENTS.md).";
          return truncate(found.join("\n\n"));
        });
      },
    }),
  };
}

/** Tool names, in the order they appear in logs and the system prompt. */
export const AGENT_TOOL_NAMES = [
  "read_file",
  "list_directory",
  "search_code",
  "get_file_history",
  "read_repo_conventions",
] as const;
