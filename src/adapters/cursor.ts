import path from "node:path";
import fs from "node:fs";
import type { Diagnostic, PolicySource, SourceState } from "../types.js";
import type { AdapterResult, AgentAdapter, InspectContext } from "./types.js";
import { MAX_WALK_DEPTH } from "../constants.js";
import {
  dirsRootToLeaf,
  displayFor,
  isDir,
  loadFile,
  makeSource,
  readTextForContext,
  sourceFromFile,
  symlinkDiagnostics,
} from "./shared.js";
import { isInside, relPosix, toPosix } from "../fs/paths.js";
import { isReadError } from "../fs/read.js";
import { walkDir } from "../fs/walk.js";
import { parseFrontmatter } from "../frontmatter/parse.js";
import { validateFrontmatter } from "../frontmatter/validate.js";
import { matchPatterns, normalizePatterns } from "../match/glob.js";
import { findImports } from "./claude-imports.js";
import { ruleScope } from "./rule-scope.js";

const SURFACE = "Cursor IDE";

export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  surface: SURFACE,
  inspect(ctx: InspectContext): AdapterResult {
    const sources: PolicySource[] = [];
    const diagnostics: Diagnostic[] = [];
    const assumptions: string[] = [];

    // 1. AGENTS.md from root down toward the target directory (in scope).
    const leaf = ctx.mode === "discover" ? ctx.cwd : path.dirname(ctx.targetAbs);
    const chain = isInside(ctx.root, leaf)
      ? dirsRootToLeaf(ctx.root, leaf)
      : dirsRootToLeaf(ctx.root, ctx.cwd);
    for (const dir of chain) {
      const f = loadFile(ctx, path.join(dir, "AGENTS.md"));
      if (f && f.read) {
        sources.push(
          sourceFromFile(f, {
            kind: "cursor-agents-md",
            state: "active",
            matchReason: `AGENTS.md applies to its directory subtree (${displayFor(ctx, dir) || "."})`,
          }),
        );
      }
    }

    // 2. .cursor/rules/**/*.mdc (and .md, which is excluded).
    const targetRelRoot = relPosix(ctx.root, ctx.targetAbs);

    const walks =
      ctx.mode === "discover"
        ? [
            walkDir(ctx.root, {
              root: ctx.root,
              budget: ctx.walkBudget,
              maxDepth: MAX_WALK_DEPTH,
              filter: isCursorRule,
            }),
          ]
        : chain
            .map((dir) => path.join(dir, ".cursor", "rules"))
            .filter(isDir)
            .map((dir) =>
              walkDir(dir, {
                root: ctx.root,
                budget: ctx.walkBudget,
                maxDepth: MAX_WALK_DEPTH,
                filter: isCursorRule,
              }),
            );

    for (const res of walks) {
      diagnostics.push(...symlinkDiagnostics(ctx, res));
      for (const entry of res.files) {
        const read = readTextForContext(ctx, entry.abs);
        if (isReadError(read)) continue;
        const display = displayFor(ctx, entry.abs);

        if (entry.abs.endsWith(".md") && !entry.abs.endsWith(".mdc")) {
          sources.push(
            makeSource({
              path: display,
              kind: "cursor-plain-md",
              state: "excluded",
              matchReason:
                "Cursor only loads .mdc rule files; plain .md under .cursor/rules is ignored",
              bytes: read.bytes,
              lines: read.lines,
              contentHash: read.contentHash,
            }),
          );
          continue;
        }

        const parsed = parseFrontmatter(read.content);
        diagnostics.push(...validateFrontmatter("cursor-mdc", parsed, display));
        const fm = parsed.data ?? {};

        // Scope check for nested .cursor/rules directories.
        const scopeDir = ruleScope(entry.abs, ".cursor") ?? ctx.root;
        const inScope =
          ctx.mode === "discover" || scopeDir === ctx.root || isInside(scopeDir, ctx.targetAbs);

        const alwaysApply = fm["alwaysApply"] === true;
        const globs = normalizePatterns(fm["globs"]);
        const hasDescription =
          typeof fm["description"] === "string" &&
          (fm["description"] as string).trim() !== "";

        let state: SourceState;
        let reason: string;

        if (!inScope) {
          state = "excluded";
          reason = `Rule scope ${displayFor(ctx, scopeDir) || "."} does not contain the target`;
        } else if (alwaysApply) {
          state = "active";
          reason = "alwaysApply: true — always attached";
        } else if (globs.length > 0) {
          if (ctx.mode === "discover") {
            state = "conditional";
            reason = `Auto Attached (path-scoped): applies to files matching globs (${globs.join(", ")})`;
          } else {
            const m = matchPatterns(globs, targetRelRoot, { matchBase: true });
            if (m.matched) {
              state = "active";
              reason = `Auto Attached: target matches globs via "${m.by}"`;
            } else {
              state = "excluded";
              reason = `Auto Attached rule; globs (${globs.join(", ")}) do not match the target`;
            }
          }
        } else if (hasDescription) {
          state = "conditional";
          reason =
            "Agent Requested: the model decides whether to include this rule from its description";
        } else {
          state = "manual";
          reason = "Manual: included only when explicitly @-mentioned";
        }

        const source = makeSource({
          path: display,
          kind: "cursor-mdc",
          state,
          matchReason: reason,
          bytes: read.bytes,
          lines: read.lines,
          contentHash: read.contentHash,
        });
        sources.push(source);

        // @filename references included alongside an active/conditional rule.
        if (state === "active" || state === "conditional") {
          collectReferences(ctx, entry.abs, parsed.body, display, state, sources, diagnostics);
        }
      }
    }

    // 3. Account and team rules are stored outside the repository.
    sources.push(
      makeSource({
        path: "(user / team rules)",
        kind: "cursor-external-rules",
        state: "unknown-external",
        matchReason:
          "User rules and team rules are configured in the Cursor account/dashboard and are not stored locally",
      }),
    );

    assumptions.push(
      "Cursor does not define an order between multiple active .mdc rules, so no ordering is asserted here.",
    );

    return { surface: SURFACE, sources, diagnostics, assumptions, omittedByCapBytes: 0 };
  },
};

function isCursorRule(abs: string): boolean {
  const p = toPosix(abs);
  return p.includes("/.cursor/rules/") && (p.endsWith(".mdc") || p.endsWith(".md"));
}

function collectReferences(
  ctx: InspectContext,
  ruleAbs: string,
  body: string,
  ruleDisplay: string,
  state: SourceState,
  sources: PolicySource[],
  diagnostics: Diagnostic[],
): void {
  const refs = findImports(body);
  for (const ref of refs) {
    const candidates = [
      path.resolve(path.dirname(ruleAbs), ref.raw),
      path.resolve(ctx.root, ref.raw.replace(/^\.?\//, "")),
    ];
    const resolved = candidates.find((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
    if (!resolved) {
      diagnostics.push({
        code: "missing-reference",
        level: "warning",
        message: `Referenced file "@${ref.raw}" from ${ruleDisplay} was not found`,
        paths: [ruleDisplay],
        evidence: [`@${ref.raw}`],
      });
      continue;
    }
    if (!isInside(ctx.root, resolved)) {
      diagnostics.push({
        code: "reference-outside-root",
        level: "warning",
        message: `Reference "@${ref.raw}" from ${ruleDisplay} resolves outside the project root`,
        paths: [ruleDisplay],
      });
      continue;
    }
    const read = readTextForContext(ctx, resolved);
    if (isReadError(read)) {
      if (read.code === "EOUTSIDE") {
        diagnostics.push({
          code: "reference-outside-root",
          level: "warning",
          message: `Reference "@${ref.raw}" from ${ruleDisplay} resolves outside the project root`,
          paths: [ruleDisplay, displayFor(ctx, resolved)],
        });
      }
      continue;
    }
    sources.push(
      makeSource({
        path: displayFor(ctx, resolved),
        kind: "cursor-reference",
        state,
        matchReason: `Referenced via "@${ref.raw}" from ${ruleDisplay}`,
        bytes: read.bytes,
        lines: read.lines,
        contentHash: read.contentHash,
      }),
    );
  }
}
