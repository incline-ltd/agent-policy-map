import picomatch from "picomatch";

/**
 * Normalize a `globs` / `applyTo` / `paths` value into a clean pattern list.
 * Accepts an array or a comma-separated string.
 */
export function normalizePatterns(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string") parts.push(...splitPatternList(v));
    }
  } else if (typeof value === "string") {
    parts.push(...splitPatternList(value));
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Split comma-separated patterns without breaking brace or bracket groups. */
function splitPatternList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let escaped = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "{") braceDepth++;
    else if (ch === "}" && braceDepth > 0) braceDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]" && bracketDepth > 0) bracketDepth--;
    else if (ch === "," && braceDepth === 0 && bracketDepth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

export type MatchResult = { matched: boolean; by?: string };

/**
 * Test a POSIX, root-relative target path against a list of glob patterns.
 * Braces and globstars are supported (picomatch defaults). Matching is strict
 * and root-relative by default. Formats with basename semantics can opt into
 * `matchBase`, where `*.ts` also matches `src/a.ts`.
 */
export function matchPatterns(
  patterns: string[],
  targetRel: string,
  options: { matchBase?: boolean } = {},
): MatchResult {
  const target = targetRel.replace(/^\.\//, "");
  for (const pattern of patterns) {
    const candidates =
      options.matchBase === true && !pattern.includes("/")
        ? [pattern, `**/${pattern}`]
        : [pattern];
    for (const cand of candidates) {
      const isMatch = picomatch(cand, { dot: true, nocase: false });
      if (isMatch(target)) return { matched: true, by: pattern };
    }
  }
  return { matched: false };
}
