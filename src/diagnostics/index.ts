import path from "node:path";
import type { Diagnostic, PolicySource } from "../types.js";
import type { InspectContext } from "../adapters/types.js";
import { readTextForContext } from "../adapters/shared.js";
import { isReadError } from "../fs/read.js";
import { detectConflicts, type ContentEntry } from "./conflicts.js";

/** Turn a display path back into an absolute path, or null for synthetic ones. */
function displayToAbs(ctx: InspectContext, display: string): string | null {
  if (display.startsWith("(")) return null;
  if (display.startsWith("~/")) return ctx.env.home ? path.join(ctx.env.home, display.slice(2)) : null;
  if (display === "~") return ctx.env.home ?? null;
  if (path.isAbsolute(display)) return display;
  return path.resolve(ctx.root, display.replace(/^\.\//, ""));
}

const LOADABLE = new Set(["active", "conditional", "manual"]);

/**
 * Cross-source diagnostics computed after all adapters run:
 * - exact duplicate content across distinct files;
 * - evidence-backed possible conflicts among loadable instruction contents.
 */
export function runCrossDiagnostics(
  ctx: InspectContext,
  sources: PolicySource[],
): Diagnostic[] {
  const out: Diagnostic[] = [];

  // Exact duplicate content by hash (loadable, distinct paths).
  const byHash = new Map<string, string[]>();
  for (const s of sources) {
    if (!s.contentHash || !LOADABLE.has(s.state)) continue;
    const list = byHash.get(s.contentHash) ?? [];
    if (!list.includes(s.path)) list.push(s.path);
    byHash.set(s.contentHash, list);
  }
  for (const [hash, paths] of byHash) {
    if (paths.length > 1) {
      out.push({
        code: "duplicate-content",
        level: "info",
        message: `Identical content in ${paths.length} files (sha256 ${hash}); the same guidance is loaded more than once`,
        paths,
      });
    }
  }

  // Re-read loadable local files (bounded by the shared budget) for conflicts.
  const entries: ContentEntry[] = [];
  const seenPaths = new Set<string>();
  for (const s of sources) {
    if (!LOADABLE.has(s.state) || !s.contentHash) continue;
    if (seenPaths.has(s.path)) continue;
    const abs = displayToAbs(ctx, s.path);
    if (!abs) continue;
    const read = readTextForContext(ctx, abs, s.bytes);
    if (isReadError(read)) continue;
    seenPaths.add(s.path);
    entries.push({ path: s.path, content: read.content });
  }
  out.push(...detectConflicts(entries));

  return out;
}
