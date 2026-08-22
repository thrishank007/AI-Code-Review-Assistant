import type { PRFile } from "../types.js";

/** Convert a simple glob (*, **, ?) to a RegExp anchored at both ends. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        if (pattern[i + 1] === "/") {
          // "**/" matches zero or more whole path segments
          re += "(?:[^/]*/)*";
          i += 2;
          continue;
        }
        re += ".*";
        i++;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`);
}

/** Match a repo path against glob patterns; basename-only patterns match any directory. */
export function isIgnored(path: string, patterns: string[]): boolean {
  const base = path.split("/").pop()!;
  return patterns.some((p) => {
    const re = globToRegExp(p);
    return re.test(path) || (!p.includes("/") && re.test(base));
  });
}

export interface FilterOptions {
  ignorePatterns: string[];
  maxFiles: number;
  maxDiffChars: number;
}

export interface FilterResult {
  /** Files to review, in GitHub order, within all caps. */
  included: PRFile[];
  /** Paths dropped, with a human-readable reason. */
  skipped: { path: string; reason: string }[];
  truncatedByCount: boolean;
  truncatedBySize: boolean;
}

export function filterFiles(files: PRFile[], opts: FilterOptions): FilterResult {
  const skipped: { path: string; reason: string }[] = [];
  const candidates: PRFile[] = [];

  for (const f of files) {
    if (isIgnored(f.filename, opts.ignorePatterns)) {
      skipped.push({ path: f.filename, reason: "ignored by config" });
      continue;
    }
    if (!f.patch) {
      skipped.push({ path: f.filename, reason: "binary or too large for patch" });
      continue;
    }
    candidates.push(f);
  }

  const result: FilterResult = {
    included: [],
    skipped,
    truncatedByCount: false,
    truncatedBySize: false,
  };

  let total = 0;
  for (const f of candidates) {
    if (result.included.length >= opts.maxFiles) {
      result.truncatedByCount = true;
      result.skipped.push({ path: f.filename, reason: "beyond max_files cap" });
      continue;
    }
    if (total + f.patch.length > opts.maxDiffChars) {
      result.truncatedBySize = true;
      result.skipped.push({ path: f.filename, reason: "beyond max diff size cap" });
      continue;
    }
    total += f.patch.length;
    result.included.push(f);
  }
  return result;
}
