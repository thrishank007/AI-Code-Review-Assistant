import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EvalCaseSchema, type EvalCase } from "./types.js";

export interface LoadFilter {
  category?: "golden" | "synthetic" | "snapshot" | "all";
  caseId?: string;
}

const CATEGORY_ORDER = ["golden", "synthetic", "snapshot"] as const;

function collectJsonFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectJsonFiles(full, out);
    } else if (entry.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Discover and validate every `*.json` dataset file under `datasetsDir`.
 * Files are validated against EvalCaseSchema; invalid files throw with the
 * file path and the Zod issues attached. Results are sorted by category
 * (golden → synthetic → snapshot) then by case id for stable runs.
 */
export function loadEvalCases(
  datasetsDir: string,
  filter: LoadFilter = {},
): EvalCase[] {
  const files = collectJsonFiles(datasetsDir);
  const cases: EvalCase[] = [];

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Invalid JSON in eval dataset ${file}: ${(e as Error).message}`);
    }
    const result = EvalCaseSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid eval dataset ${file}: ${issues}`);
    }
    cases.push(result.data as EvalCase);
  }

  const category = filter.category ?? "all";
  const filtered = cases.filter((c) => {
    if (category !== "all" && c.category !== category) return false;
    if (filter.caseId && c.id !== filter.caseId) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const orderA = CATEGORY_ORDER.indexOf(a.category);
    const orderB = CATEGORY_ORDER.indexOf(b.category);
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });

  return filtered;
}
