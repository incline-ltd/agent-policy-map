import fs from "node:fs";
import path from "node:path";
import type { Diagnostic, PolicySource, SourceState } from "../types.js";
import type { AdapterResult, AgentAdapter, InspectContext } from "./types.js";
import { MAX_WALK_DEPTH } from "../constants.js";
import { isReadError, readTextBounded } from "../fs/read.js";
import { isInside, relPosix } from "../fs/paths.js";
import { walkDir } from "../fs/walk.js";
import { parseFrontmatter } from "../frontmatter/parse.js";
import { validateFrontmatter } from "../frontmatter/validate.js";
import { matchPatterns, normalizePatterns } from "../match/glob.js";
import { findImports } from "./claude-imports.js";
import {
  dirsRootToLeaf,
  displayFor,
  isDir,
  loadFile,
  makeSource,
  recordTruncatedRead,
  sourceFromFile,
  symlinkDiagnostics,
  type LoadedFile,
  type SourceInit,
} from "./shared.js";

const SURFACE = "GitHub Copilot CLI";

type ImportRoot = {
  file: LoadedFile;
  state: SourceState;
  allowedRoot: string;
};

type LoadOptions = {
  allowedRoot: string;
  expandImports?: boolean;
  deduplicateIdentical?: boolean;
};

type AddLoaded = (
  file: LoadedFile,
  init: Omit<SourceInit, "path" | "bytes" | "lines" | "contentHash">,
  options: LoadOptions,
) => void;

export const copilotAdapter: AgentAdapter = {
  name: "copilot",
  surface: SURFACE,
  inspect(ctx: InspectContext): AdapterResult {
    const sources: PolicySource[] = [];
    const diagnostics: Diagnostic[] = [];
    const assumptions: string[] = [];
    const importRoots: ImportRoot[] = [];
    const seenPaths = new Set<string>();
    const seenDeduplicatedContent = new Map<string, string>();
    const targetRelRoot = relPosix(ctx.root, ctx.targetAbs);
    const rootToCwd = dirsRootToLeaf(ctx.root, ctx.cwd);
    const targetDir = path.dirname(ctx.targetAbs);
    const targetPathDirs =
      ctx.mode === "inspect" && isInside(ctx.cwd, targetDir)
        ? dirsRootToLeaf(ctx.cwd, targetDir).filter((dir) => dir !== ctx.cwd)
        : [];
    const standardDirs = uniqueDirs([...rootToCwd, ...targetPathDirs]);
    const modularRepoDirs = uniqueDirs([ctx.root, ctx.cwd, ...targetPathDirs]);

    const addLoaded: AddLoaded = (file, init, options) => {
      const canonical = canonicalPath(file.abs);
      if (seenPaths.has(canonical)) return;
      seenPaths.add(canonical);

      const completeHash = file.read.contentHash;
      if (
        init.state !== "excluded" &&
        options.deduplicateIdentical === true &&
        completeHash !== undefined
      ) {
        const first = seenDeduplicatedContent.get(completeHash);
        if (first !== undefined) {
          sources.push(
            sourceFromFile(file, {
              ...init,
              state: "excluded",
              matchReason: `Duplicate of ${first}; Copilot CLI loads identical instructions once`,
            }),
          );
          diagnostics.push({
            code: "duplicate-instruction",
            level: "info",
            message: `Duplicate Copilot instructions were de-duplicated: ${file.display}`,
            paths: [first, file.display],
          });
          return;
        }
        seenDeduplicatedContent.set(completeHash, file.display);
      }

      sources.push(sourceFromFile(file, init));
      if (
        options.expandImports === true &&
        (init.state === "active" || init.state === "conditional")
      ) {
        importRoots.push({ file, state: init.state, allowedRoot: options.allowedRoot });
      }
    };

    // Repository-wide and agent instructions use all standard locations: the
    // repository root, cwd, intermediate root-to-cwd directories, and
    // directories nested from cwd toward the target file.
    for (const dir of standardDirs) {
      addKnownFile(
        ctx,
        path.join(dir, ".github", "copilot-instructions.md"),
        "copilot-repo-instructions",
        `Repository instructions found at ${displayFor(ctx, dir) || "."}`,
        {
          allowedRoot: ctx.root,
          expandImports: true,
          deduplicateIdentical: true,
        },
        addLoaded,
      );

      for (const [rel, kind, expandImports] of [
        ["AGENTS.md", "copilot-agents-md", true],
        ["CLAUDE.md", "copilot-claude-md", true],
        [path.join(".claude", "CLAUDE.md"), "copilot-claude-md", true],
        ["GEMINI.md", "copilot-gemini-md", false],
      ] as const) {
        addKnownFile(
          ctx,
          path.join(dir, rel),
          kind,
          `${rel} found on the repository-root-to-target search path`,
          {
            allowedRoot: ctx.root,
            expandImports,
            deduplicateIdentical: true,
          },
          addLoaded,
        );
      }
    }

    // Modular repository instructions are checked at the repository root,
    // cwd, and target-path locations, but not intermediate root-to-cwd dirs.
    for (const dir of modularRepoDirs) {
      collectPathInstructions(
        ctx,
        path.join(dir, ".github", "instructions"),
        ctx.root,
        "copilot-path-instructions",
        targetRelRoot,
        addLoaded,
        diagnostics,
      );
    }

    if (ctx.includeUser) {
      if (ctx.env.copilotHome) {
        addKnownFile(
          ctx,
          path.join(ctx.env.copilotHome, "copilot-instructions.md"),
          "copilot-user-instructions",
          "User-level instructions from COPILOT_HOME",
          {
            allowedRoot: ctx.env.copilotHome,
            deduplicateIdentical: true,
          },
          addLoaded,
        );
        collectPathInstructions(
          ctx,
          path.join(ctx.env.copilotHome, "instructions"),
          ctx.env.copilotHome,
          "copilot-user-path-instructions",
          targetRelRoot,
          addLoaded,
          diagnostics,
        );
      }

      for (const dir of ctx.env.copilotCustomInstructionDirs ?? []) {
        addKnownFile(
          ctx,
          path.join(dir, "AGENTS.md"),
          "copilot-custom-agents-md",
          "AGENTS.md from COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
          {
            allowedRoot: dir,
            expandImports: true,
            deduplicateIdentical: true,
          },
          addLoaded,
        );
        collectPathInstructions(
          ctx,
          dir,
          dir,
          "copilot-custom-path-instructions",
          targetRelRoot,
          addLoaded,
          diagnostics,
        );
      }
    } else {
      assumptions.push(
        "User-level Copilot instructions (COPILOT_HOME and COPILOT_CUSTOM_INSTRUCTIONS_DIRS) were not inspected. Pass --include-user to include them.",
      );
    }

    collectImports(ctx, importRoots, sources, diagnostics);

    sources.push(
      makeSource({
        path: "(session-disabled instructions)",
        kind: "copilot-session",
        state: "unknown-external",
        matchReason:
          "Whether specific instructions are disabled for a session is runtime state not visible to a local scan",
      }),
    );

    diagnostics.push({
      code: "no-precedence-defined",
      level: "info",
      message:
        "GitHub Copilot CLI documentation does not define a universal precedence among instruction sources; no ordering is asserted",
    });
    assumptions.push(
      "Surface modelled: GitHub Copilot CLI. GitHub.com, code review, and IDE precedence rules are NOT applied.",
    );

    return { surface: SURFACE, sources, diagnostics, assumptions, omittedByCapBytes: 0 };
  },
};

function addKnownFile(
  ctx: InspectContext,
  abs: string,
  kind: string,
  matchReason: string,
  options: LoadOptions,
  addLoaded: AddLoaded,
): void {
  const file = loadAndReport(ctx, abs);
  if (file === null) return;
  addLoaded(file, { kind, state: "active", matchReason }, options);
}

function collectPathInstructions(
  ctx: InspectContext,
  dir: string,
  allowedRoot: string,
  kind: string,
  targetRelRoot: string,
  addLoaded: AddLoaded,
  diagnostics: Diagnostic[],
): void {
  if (!isDir(dir)) return;
  const walked = walkDir(dir, {
    root: allowedRoot,
    maxDepth: MAX_WALK_DEPTH,
    budget: ctx.walkBudget,
    filter: (abs) => abs.endsWith(".instructions.md"),
  });
  diagnostics.push(...symlinkDiagnostics(ctx, walked));
  for (const entry of walked.files) {
    addPathInstruction(
      ctx,
      entry.abs,
      allowedRoot,
      kind,
      targetRelRoot,
      addLoaded,
      diagnostics,
    );
  }
}

function addPathInstruction(
  ctx: InspectContext,
  abs: string,
  allowedRoot: string,
  kind: string,
  targetRelRoot: string,
  addLoaded: AddLoaded,
  diagnostics: Diagnostic[],
): void {
  const file = loadAndReport(ctx, abs);
  if (file === null) return;

  const parsed = parseFrontmatter(file.read.content);
  diagnostics.push(...validateFrontmatter("copilot-instructions", parsed, file.display));
  const applyTo = normalizePatterns((parsed.data ?? {})["applyTo"]);

  let state: SourceState;
  let reason: string;
  if (applyTo.length === 0) {
    state = "excluded";
    reason = "Missing required applyTo metadata; Copilot CLI does not load this path instruction";
  } else if (ctx.mode === "discover") {
    state = "conditional";
    reason = `Path-scoped: applies to files matching applyTo (${applyTo.join(", ")})`;
  } else {
    const match = matchPatterns(applyTo, targetRelRoot);
    state = match.matched ? "active" : "excluded";
    reason = match.matched
      ? `applyTo matched the target via "${match.by}"`
      : `applyTo (${applyTo.join(", ")}) does not match the target`;
  }

  addLoaded(file, { kind, state, matchReason: reason }, { allowedRoot });
}

function loadAndReport(
  ctx: InspectContext,
  abs: string,
): LoadedFile | null {
  const file = loadFile(ctx, abs);
  if (file === null) return null;
  if (file.read === null) return null;
  return file;
}

function collectImports(
  ctx: InspectContext,
  roots: ImportRoot[],
  sources: PolicySource[],
  diagnostics: Diagnostic[],
): void {
  const seenImports = new Map<string, string>();

  const recurse = (
    file: LoadedFile,
    state: SourceState,
    allowedRoot: string,
    depth: number,
    chain: Set<string>,
  ): void => {
    for (const ref of findImports(file.read.content)) {
      const resolved = resolveImport(ref.raw, path.dirname(file.abs), ctx.env.home);
      if (resolved === null) {
        diagnostics.push({
          code: "missing-import",
          level: "warning",
          message: `Cannot resolve Copilot import "@${ref.raw}" without a home directory`,
          paths: [file.display],
          evidence: [`@${ref.raw}`],
        });
        continue;
      }
      const display = displayFor(ctx, resolved);
      if (depth + 1 > MAX_WALK_DEPTH) {
        diagnostics.push({
          code: "import-over-depth",
          level: "warning",
          message: `Copilot import recursion exceeded the safety limit (${MAX_WALK_DEPTH})`,
          paths: [file.display, display],
        });
        continue;
      }
      if (!isInside(path.resolve(allowedRoot), resolved)) {
        diagnostics.push({
          code: "reference-outside-root",
          level: "warning",
          message: `Copilot import "@${ref.raw}" escapes its configured instruction root and was not loaded`,
          paths: [file.display, display],
        });
        continue;
      }

      const read = readTextBounded(resolved, ctx.budget, undefined, [allowedRoot]);
      if (isReadError(read)) {
        diagnostics.push({
          code: read.code === "EOUTSIDE" ? "reference-outside-root" : "missing-import",
          level: "warning",
          message:
            read.code === "EOUTSIDE"
              ? `Copilot import "@${ref.raw}" resolves outside its configured instruction root and was not loaded`
              : `Unable to read Copilot import "@${ref.raw}" (${read.code})`,
          paths: [file.display, display],
          evidence: [`@${ref.raw}`],
        });
        continue;
      }
      recordTruncatedRead(ctx, resolved, read);

      const canonical = canonicalPath(resolved);
      if (chain.has(canonical)) {
        diagnostics.push({
          code: "import-cycle",
          level: "error",
          message: `Copilot import cycle detected at ${display}`,
          paths: [file.display, display],
        });
        continue;
      }
      const firstImport = seenImports.get(canonical);
      if (firstImport !== undefined) {
        diagnostics.push({
          code: "duplicate-import",
          level: "info",
          message: `Copilot import ${display} was already loaded`,
          paths: [firstImport, display],
        });
        continue;
      }
      seenImports.set(canonical, display);

      sources.push(
        makeSource({
          path: display,
          kind: "copilot-import",
          state,
          matchReason: `Imported via "@${ref.raw}" from ${file.display} (hop ${depth + 1})`,
          bytes: read.bytes,
          lines: read.lines,
          contentHash: read.contentHash,
        }),
      );

      const nextChain = new Set(chain);
      nextChain.add(canonical);
      recurse(
        { abs: resolved, display, read },
        state,
        allowedRoot,
        depth + 1,
        nextChain,
      );
    }
  };

  for (const root of roots) {
    recurse(root.file, root.state, root.allowedRoot, 0, new Set([canonicalPath(root.file.abs)]));
  }
}

function uniqueDirs(dirs: string[]): string[] {
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function resolveImport(raw: string, fromDir: string, home?: string): string | null {
  if (raw.startsWith("~/")) return home ? path.resolve(home, raw.slice(2)) : null;
  if (raw === "~") return home ? path.resolve(home) : null;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(fromDir, raw);
}

function canonicalPath(abs: string): string {
  try {
    return fs.realpathSync(abs);
  } catch {
    return path.resolve(abs);
  }
}
