import path from "node:path";
import fs from "node:fs";
import type { PolicySource, SourceState } from "../types.js";
import type { InspectContext } from "./types.js";
import { isReadError, readTextBounded, type ReadResult } from "../fs/read.js";
import { isInside, relPosix, toDisplayPath, toPosix } from "../fs/paths.js";
import type { Diagnostic } from "../types.js";
import type { WalkResult } from "../fs/walk.js";

/**
 * Stable display path for output:
 * - inside the project root => `./root-relative/path`
 * - inside the user home (and outside root) => `~/home-relative/path`
 * - otherwise the absolute POSIX path.
 *
 * Basing every path on the root (not cwd) keeps ancestor files readable and
 * output deterministic across machines.
 */
export function displayFor(ctx: InspectContext, abs: string): string {
  if (isInside(ctx.root, abs)) return toDisplayPath(ctx.root, abs);
  const home = ctx.env.home;
  if (home && isInside(home, abs)) {
    const rel = relPosix(home, abs);
    return rel === "" ? "~" : "~/" + rel;
  }
  return toPosix(abs);
}

/** Directories from `root` (inclusive) down to `leaf` (inclusive), root first. */
export function dirsRootToLeaf(root: string, leaf: string): string[] {
  const chain: string[] = [];
  let cur = leaf;
  // Guard against a leaf that is not inside root.
  const rel = path.relative(root, leaf);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [leaf];
  for (;;) {
    chain.push(cur);
    if (cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  chain.reverse();
  return chain;
}

/** True when `abs` exists and is a regular file. */
export function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** True when `abs` exists and is a directory. */
export function isDir(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

export type LoadedFile = {
  abs: string;
  display: string;
  read: ReadResult;
};

/**
 * Read an instruction file if present and non-empty. Returns null when the
 * file is absent, unreadable, or empty (Codex and others skip empty files).
 */
export function loadFile(
  ctx: InspectContext,
  abs: string,
  perFileCap?: number,
): LoadedFile | { abs: string; display: string; read: null; errorCode: string } | null {
  const display = displayFor(ctx, abs);
  const read = readTextForContext(ctx, abs, perFileCap);
  if (isReadError(read)) {
    if (read.code === "ENOENT" || read.code === "ENOTDIR" || read.code === "ENOTFILE") {
      return null;
    }
    ctx.readDiagnostics.push({
      code: read.code === "EOUTSIDE" ? "symlink-escape" : "instruction-read-error",
      level: "warning",
      message:
        read.code === "EOUTSIDE"
          ? `Skipped instruction path that resolves outside its allowed root: ${display}`
          : `Unable to read instruction file ${display} (${read.code})`,
      paths: [display],
    });
    return { abs, display, read: null, errorCode: read.code };
  }
  if (read.content.trim() === "") {
    // Empty file: treated as "not present" for discovery purposes.
    return null;
  }
  return { abs, display, read };
}

/** Read text through the same project/user containment policy as loadFile. */
export function readTextForContext(
  ctx: InspectContext,
  abs: string,
  perFileCap?: number,
): ReturnType<typeof readTextBounded> {
  const read = readTextBounded(abs, ctx.budget, perFileCap, allowedReadRoots(ctx, abs));
  if (!isReadError(read)) recordTruncatedRead(ctx, abs, read);
  return read;
}

/** Surface bounded partial reads once so a policy map never implies full inspection. */
export function recordTruncatedRead(
  ctx: InspectContext,
  abs: string,
  read: ReadResult,
): void {
  if (!read.truncated) return;
  const display = displayFor(ctx, abs);
  const alreadyRecorded = ctx.readDiagnostics.some(
    (diagnostic) =>
      diagnostic.code === "file-truncated" && diagnostic.paths?.includes(display) === true,
  );
  if (alreadyRecorded) return;

  const totalBytes = read.totalBytes ?? read.bytes;
  ctx.readDiagnostics.push({
    code: "file-truncated",
    level: "warning",
    message: `Inspected only the first ${read.bytes} of ${totalBytes} bytes; the per-file safety limit was reached and results for this file may be incomplete`,
    paths: [display],
  });
}

/**
 * Select the narrowest documented root for a direct instruction-file read.
 * Project paths stay project-contained. User/configured roots are available
 * only with includeUser. A managed system file is allowed as that exact path.
 */
function allowedReadRoots(ctx: InspectContext, abs: string): string[] {
  const candidate = path.resolve(abs);
  const roots = [ctx.root];
  if (ctx.includeUser) {
    const userRoots: Array<string | undefined> = [];
    if (ctx.agent === "codex") {
      userRoots.push(
        ctx.env.codexHome,
        ctx.env.home ? path.join(ctx.env.home, ".agents", "skills") : undefined,
        "/etc/codex/skills",
      );
    } else if (ctx.agent === "claude") {
      userRoots.push(ctx.env.home ? path.join(ctx.env.home, ".claude") : undefined);
    } else if (ctx.agent === "copilot") {
      userRoots.push(
        ctx.env.copilotHome,
        ...(ctx.env.copilotCustomInstructionDirs ?? []),
      );
    }
    for (const root of userRoots) {
      if (root !== undefined) roots.push(path.resolve(root));
    }
  }

  const lexicalMatches = roots.filter((root) => isInside(path.resolve(root), candidate));
  if (lexicalMatches.length > 0) {
    lexicalMatches.sort((a, b) => path.resolve(b).length - path.resolve(a).length);
    return [lexicalMatches[0]!];
  }

  // Claude managed policy is a documented system file rather than a user
  // directory. includeUser is the explicit opt-in, and only that exact path is
  // authorized here.
  if (ctx.includeUser && candidate === managedClaudePolicyPath()) return [candidate];
  return [ctx.root];
}

function managedClaudePolicyPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/CLAUDE.md";
    case "win32":
      return path.resolve(
        process.env["ProgramFiles"] ?? "C:\\Program Files",
        "ClaudeCode",
        "CLAUDE.md",
      );
    default:
      return "/etc/claude-code/CLAUDE.md";
  }
}

export type SourceInit = {
  path: string;
  kind: string;
  state: SourceState;
  matchReason: string;
  order?: number;
  bytes?: number;
  lines?: number;
  contentHash?: string | undefined;
};

/**
 * Build a PolicySource, omitting optional keys when undefined so the object
 * satisfies exactOptionalPropertyTypes. `id` is assigned later by the
 * orchestrator to guarantee global uniqueness.
 */
export function makeSource(init: SourceInit): PolicySource {
  const s: PolicySource = {
    id: "",
    path: init.path,
    kind: init.kind,
    state: init.state,
    matchReason: init.matchReason,
  };
  if (init.order !== undefined) s.order = init.order;
  if (init.bytes !== undefined) s.bytes = init.bytes;
  if (init.lines !== undefined) s.lines = init.lines;
  if (init.contentHash !== undefined) s.contentHash = init.contentHash;
  return s;
}

/**
 * Turn a walk's skipped symlinks into diagnostics. Contained directory
 * symlinks may be followed once; repeated or cyclic aliases are skipped.
 */
export function symlinkDiagnostics(ctx: InspectContext, res: WalkResult): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (res.skippedDirSymlinks.length > 0) {
    out.push({
      code: "symlink-skipped",
      level: "warning",
      message: `Skipped ${res.skippedDirSymlinks.length} repeated or cyclic directory symlink(s) for loop safety`,
      paths: res.skippedDirSymlinks.map((p) => displayFor(ctx, p)),
    });
  }
  if (res.skippedEscapingSymlinks.length > 0) {
    out.push({
      code: "symlink-escape",
      level: "warning",
      message: `Skipped ${res.skippedEscapingSymlinks.length} symlink(s) whose target escapes the containment root`,
      paths: res.skippedEscapingSymlinks.map((p) => displayFor(ctx, p)),
    });
  }
  if (res.truncated) {
    out.push({
      code: "walk-truncated",
      level: "warning",
      message: `Directory walk was truncated (${res.truncationReasons.join("; ")}); results may be incomplete`,
    });
  }
  return out;
}

/** Convenience: build a source directly from a loaded file. */
export function sourceFromFile(
  file: LoadedFile,
  init: Omit<SourceInit, "path" | "bytes" | "lines" | "contentHash">,
): PolicySource {
  return makeSource({
    ...init,
    path: file.display,
    bytes: file.read.bytes,
    lines: file.read.lines,
    contentHash: file.read.contentHash,
  });
}
