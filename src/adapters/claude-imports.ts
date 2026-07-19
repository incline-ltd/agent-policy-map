import path from "node:path";
import fs from "node:fs";
import type { Diagnostic, PolicySource, SourceState } from "../types.js";
import type { InspectContext } from "./types.js";
import { CLAUDE_MAX_IMPORT_HOPS } from "../constants.js";
import { isReadError } from "../fs/read.js";
import { isInside } from "../fs/paths.js";
import { displayFor, makeSource, readTextForContext } from "./shared.js";

/**
 * Replace fenced code blocks and inline code spans with equal-length blanks so
 * that `@import` tokens inside code are ignored, while byte offsets (and thus
 * any later evidence extraction) stay aligned.
 */
export function stripCodeRegions(text: string): string {
  let out = text;
  // Fenced blocks: ``` ... ``` and ~~~ ... ~~~
  out = out.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[ \t]*(?=\n|$))/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  // Inline code spans: `...`
  out = out.replace(/`[^`\n]*`/g, (m) => m.replace(/[^\n]/g, " "));
  return out;
}

const IMPORT_RE = /(?:^|\s)@([^\s]+)/g;

export type ImportRef = { raw: string };

/** Extract `@path` import references, skipping code regions and non-paths. */
export function findImports(content: string): ImportRef[] {
  const scan = stripCodeRegions(content);
  const refs: ImportRef[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(scan)) !== null) {
    let raw = m[1] ?? "";
    // Trim trailing sentence punctuation not part of a filename.
    raw = raw.replace(/[).,;:]+$/g, "");
    if (raw === "") continue;
    // Must look like a path reference, not an @mention.
    const pathLike = raw.startsWith("~") || raw.startsWith("/") || raw.startsWith(".") || raw.includes("/") || /\.[A-Za-z0-9]+$/.test(raw);
    if (!pathLike) continue;
    refs.push({ raw });
  }
  return refs;
}

function resolveImportPath(raw: string, fromDir: string, home?: string): string | null {
  if (raw.startsWith("~/")) {
    if (!home) return null;
    return path.resolve(home, raw.slice(2));
  }
  if (raw === "~") return home ?? null;
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(fromDir, raw);
}

export type ImportResult = {
  sources: PolicySource[];
  diagnostics: Diagnostic[];
};

/**
 * Recursively resolve Claude `@` imports starting from one instruction file.
 *
 * - relative imports resolve against the containing file's directory;
 * - absolute and `~` imports are honored but flagged for external-project
 *   approval when they escape the project root;
 * - depth is bounded to the documented 5 hops;
 * - missing imports, cycles, over-depth, and duplicate imports are reported.
 */
export function resolveImports(
  ctx: InspectContext,
  rootFile: { abs: string; content: string; display: string },
  parentState: SourceState,
): ImportResult {
  const sources: PolicySource[] = [];
  const diagnostics: Diagnostic[] = [];
  const seenGlobal = new Map<string, string>(); // realpath -> first display path

  const realOf = (abs: string): string => {
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  };

  const rootReal = realOf(rootFile.abs);
  const projectRootReal = realOf(ctx.root);

  const recurse = (
    file: { abs: string; content: string; display: string },
    hop: number,
    chain: Set<string>,
  ): void => {
    const refs = findImports(file.content);
    for (const ref of refs) {
      const resolved = resolveImportPath(ref.raw, path.dirname(file.abs), ctx.env.home);
      if (resolved === null) {
        diagnostics.push({
          code: "missing-import",
          level: "warning",
          message: `Cannot resolve import "@${ref.raw}" (no home directory available)`,
          paths: [file.display],
          evidence: [`@${ref.raw}`],
        });
        continue;
      }
      const display = displayFor(ctx, resolved);
      const resolvedReal = realOf(resolved);
      const external = !isInside(projectRootReal, resolvedReal);

      if (hop + 1 > CLAUDE_MAX_IMPORT_HOPS) {
        diagnostics.push({
          code: "import-over-depth",
          level: "warning",
          message: `Import "@${ref.raw}" exceeds the documented ${CLAUDE_MAX_IMPORT_HOPS}-hop limit and would not be followed`,
          paths: [file.display, display],
        });
        continue;
      }

      // External-project import: Claude Code prompts for approval before reading
      // files outside the project. We flag it but never read outside the root,
      // so a crafted `@../../..` cannot exfiltrate arbitrary system files.
      if (external) {
        diagnostics.push({
          code: "external-import",
          level: "warning",
          message: `Import ${display} is outside the project root; Claude Code prompts for approval and this tool does not read it`,
          paths: [file.display, display],
          evidence: [`@${ref.raw}`],
        });
        sources.push(
          makeSource({
            path: display,
            kind: "claude-import",
            state: "unknown-external",
            matchReason: `imported via "@${ref.raw}" from ${file.display}, but resolves outside the project root; requires approval and is not inspected locally`,
          }),
        );
        continue;
      }

      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(resolved);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile()) {
        diagnostics.push({
          code: "missing-import",
          level: "warning",
          message: `Missing import "@${ref.raw}" referenced from ${file.display}`,
          paths: [file.display, display],
          evidence: [`@${ref.raw}`],
        });
        continue;
      }

      const real = resolvedReal;
      if (chain.has(real) || real === rootReal) {
        diagnostics.push({
          code: "import-cycle",
          level: "error",
          message: `Import cycle detected: ${file.display} re-imports ${display}`,
          paths: [file.display, display],
        });
        continue;
      }
      if (seenGlobal.has(real)) {
        diagnostics.push({
          code: "duplicate-import",
          level: "info",
          message: `Duplicate import: ${display} is imported more than once`,
          paths: [seenGlobal.get(real)!, display],
        });
        // Still counts once; do not re-read.
        continue;
      }
      seenGlobal.set(real, display);

      const read = readTextForContext(ctx, resolved);
      if (isReadError(read)) {
        diagnostics.push({
          code: "missing-import",
          level: "warning",
          message: `Unable to read import ${display} (${read.code})`,
          paths: [file.display, display],
        });
        continue;
      }

      sources.push(
        makeSource({
          path: display,
          kind: "claude-import",
          state: parentState,
          matchReason: `imported via "@${ref.raw}" from ${file.display} (hop ${hop + 1})`,
          bytes: read.bytes,
          lines: read.lines,
          contentHash: read.contentHash,
        }),
      );

      const nextChain = new Set(chain);
      nextChain.add(real);
      recurse({ abs: resolved, content: read.content, display }, hop + 1, nextChain);
    }
  };

  recurse(rootFile, 0, new Set([rootReal]));
  return { sources, diagnostics };
}
