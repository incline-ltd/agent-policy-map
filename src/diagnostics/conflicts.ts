import type { Diagnostic } from "../types.js";
import { excerpt } from "../security/redact.js";

export type ContentEntry = { path: string; content: string };

/**
 * Mutually exclusive tool choices. If two sources endorse different members of
 * the same group, that is surfaced as a *possible* conflict (heuristic, not a
 * semantic proof).
 */
const EXCLUSIVE_GROUPS: Array<{ name: string; members: string[] }> = [
  { name: "package manager", members: ["npm", "pnpm", "yarn", "bun"] },
  { name: "indentation", members: ["tabs", "spaces"] },
];

const ENDORSE_RE = /\b(?:use|using|prefer|run|install with|choose)\s+([a-z][\w.+-]{1,20})/gi;
const POSITIVE_RE = /\b(?:use|prefer|always use|always run)\s+([a-z][\w.+-]{1,30})/gi;
const NEGATIVE_RE = /\b(?:do not use|don't use|never use|avoid using|avoid|do not run|never run)\s+([a-z][\w.+-]{1,30})/gi;

function normalizedToken(value: string): string {
  return value.toLowerCase().replace(/[.,;:!?]+$/g, "");
}

function isNegatedAt(content: string, index: number): boolean {
  const prefix = content.slice(Math.max(0, index - 24), index);
  return /(?:do not|don't|never|avoid(?: using)?)\s*$/i.test(prefix);
}

function firstLineContaining(content: string, needle: string): string {
  const lines = content.split(/\r?\n/);
  const lower = needle.toLowerCase();
  for (const line of lines) {
    if (line.toLowerCase().includes(lower)) return excerpt(line);
  }
  return excerpt(needle);
}

/** Detect endorsements of conflicting members within an exclusive group. */
function detectGroupConflicts(entries: ContentEntry[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const group of EXCLUSIVE_GROUPS) {
    const endorsedBy = new Map<string, { path: string; evidence: string }>();
    for (const entry of entries) {
      ENDORSE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((m = ENDORSE_RE.exec(entry.content)) !== null) {
        if (isNegatedAt(entry.content, m.index)) continue;
        const tok = normalizedToken(m[1] ?? "");
        if (group.members.includes(tok) && !seen.has(tok)) {
          seen.add(tok);
          if (!endorsedBy.has(tok)) {
            endorsedBy.set(tok, {
              path: entry.path,
              evidence: firstLineContaining(entry.content, tok),
            });
          }
        }
      }
    }
    if (endorsedBy.size > 1) {
      const parts = [...endorsedBy.entries()];
      out.push({
        code: "possible-conflict",
        level: "warning",
        message: `Possible ${group.name} conflict: ${parts
          .map(([tok, info]) => `${info.path} endorses ${tok}`)
          .join("; ")}`,
        paths: parts.map(([, info]) => info.path),
        evidence: parts.map(([, info]) => info.evidence),
      });
    }
  }
  return out;
}

/** Detect a token that one source says to use and another says to avoid. */
function detectNegationConflicts(entries: ContentEntry[]): Diagnostic[] {
  const positive = new Map<string, { path: string; evidence: string }>();
  const negative = new Map<string, { path: string; evidence: string }>();

  const collect = (
    re: RegExp,
    map: Map<string, { path: string; evidence: string }>,
    entry: ContentEntry,
    skipNegated: boolean,
  ): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(entry.content)) !== null) {
      if (skipNegated && isNegatedAt(entry.content, m.index)) continue;
      const tok = normalizedToken(m[1] ?? "");
      if (tok.length < 2) continue;
      if (!map.has(tok)) {
        map.set(tok, { path: entry.path, evidence: firstLineContaining(entry.content, m[0]) });
      }
    }
  };

  for (const entry of entries) {
    collect(POSITIVE_RE, positive, entry, true);
    collect(NEGATIVE_RE, negative, entry, false);
  }

  const out: Diagnostic[] = [];
  for (const [tok, pos] of positive) {
    const neg = negative.get(tok);
    if (neg && neg.path !== pos.path) {
      out.push({
        code: "possible-conflict",
        level: "warning",
        message: `Possible conflict on "${tok}": ${pos.path} says to use it while ${neg.path} says to avoid it`,
        paths: [pos.path, neg.path],
        evidence: [pos.evidence, neg.evidence],
      });
    }
  }
  return out;
}

/**
 * Run heuristic conflict detection across loadable source contents. All results
 * are labelled possible conflicts: without an LLM we cannot claim complete
 * semantic understanding of natural-language instructions.
 */
export function detectConflicts(entries: ContentEntry[]): Diagnostic[] {
  if (entries.length < 2) return [];
  return [...detectGroupConflicts(entries), ...detectNegationConflicts(entries)];
}
