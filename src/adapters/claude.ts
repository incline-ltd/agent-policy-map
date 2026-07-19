import path from "node:path";
import type { Diagnostic, PolicySource, SourceState } from "../types.js";
import type { AdapterResult, AgentAdapter, InspectContext } from "./types.js";
import { MAX_WALK_DEPTH } from "../constants.js";
import {
  dirsRootToLeaf,
  displayFor,
  isDir,
  isFile,
  loadFile,
  makeSource,
  readTextForContext,
  sourceFromFile,
  symlinkDiagnostics,
  type LoadedFile,
} from "./shared.js";
import { isInside, relPosix, toPosix } from "../fs/paths.js";
import { isReadError } from "../fs/read.js";
import { walkDir } from "../fs/walk.js";
import { parseFrontmatter } from "../frontmatter/parse.js";
import { validateFrontmatter } from "../frontmatter/validate.js";
import { matchPatterns, normalizePatterns } from "../match/glob.js";
import { resolveImports } from "./claude-imports.js";
import { ruleScope } from "./rule-scope.js";

const SURFACE = "Claude Code";

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  surface: SURFACE,
  inspect(ctx: InspectContext): AdapterResult {
    const sources: PolicySource[] = [];
    const diagnostics: Diagnostic[] = [];
    const assumptions: string[] = [];
    let order = 0;

    const excludes = readClaudeExcludes(ctx, diagnostics);
    const importRoots: Array<{ file: LoadedFile; state: SourceState }> = [];

    const addMemory: AddMemory = (file, kind, state, reason, options = {}) => {
      const excludedBy =
        options.excludable === false
          ? undefined
          : excludes.find((glob) => matchPatterns([glob], toPosix(file.abs)).matched);
      if (excludedBy) {
        sources.push(
          sourceFromFile(file, {
            kind,
            state: "excluded",
            matchReason: `Excluded by claudeMdExcludes pattern "${excludedBy}"`,
          }),
        );
        return;
      }
      const init =
        state === "active" && options.ordered !== false
          ? { kind, state, order: ++order, matchReason: reason }
          : { kind, state, matchReason: reason };
      sources.push(sourceFromFile(file, init));
      importRoots.push({ file, state });
    };

    // 1. Managed (enterprise) policy: a real system file, opt-in to read.
    if (ctx.includeUser) {
      const managed = managedPath();
      if (managed) {
        const f = loadFile(ctx, managed);
        if (f && f.read) {
          addMemory(f, "claude-managed", "active", "Managed enterprise policy (system location)", {
            excludable: false,
          });
        }
      }
    } else {
      sources.push(
        makeSource({
          path: "(managed enterprise policy)",
          kind: "claude-managed",
          state: "unknown-external",
          matchReason:
            "Managed enterprise policy lives in a system location and may be set by an administrator; not inspected without --include-user",
        }),
      );
    }

    // 2. User memory (~/.claude/CLAUDE.md), opt-in.
    if (ctx.includeUser && ctx.env.home) {
      const f = loadFile(ctx, path.join(ctx.env.home, ".claude", "CLAUDE.md"));
      if (f && f.read) addMemory(f, "claude-user-memory", "active", "User memory at ~/.claude/CLAUDE.md");
    } else if (!ctx.includeUser) {
      assumptions.push(
        "User memory (~/.claude/CLAUDE.md) was not inspected. Pass --include-user to include it.",
      );
    }

    // 3. Project memory: root → cwd, all active (documented recursive read).
    const rootToCwd = dirsRootToLeaf(ctx.root, ctx.cwd);
    for (const dir of rootToCwd) {
      collectDirMemories(ctx, dir, "active", "on the root→cwd memory path", addMemory, diagnostics);
    }

    // 4. Nested memory below cwd toward the target: conditional lazy loads.
    const targetDir = path.dirname(ctx.targetAbs);
    if (isInside(ctx.cwd, targetDir) && targetDir !== ctx.cwd) {
      const below = dirsRootToLeaf(ctx.cwd, targetDir).filter((d) => d !== ctx.cwd);
      for (const dir of below) {
        collectDirMemories(
          ctx,
          dir,
          "conditional",
          "below cwd; loaded lazily only when Claude reads a file in this subtree",
          addMemory,
          diagnostics,
        );
      }
    }

    // 5. Imports for every discovered memory file.
    for (const { file, state } of importRoots) {
      const res = resolveImports(
        ctx,
        { abs: file.abs, content: file.read.content, display: file.display },
        state,
      );
      sources.push(...res.sources);
      diagnostics.push(...res.diagnostics);
    }

    // 6. User and project rules under .claude/rules/**/*.md.
    if (ctx.includeUser && ctx.env.home) {
      discoverClaudeRules(
        ctx,
        sources,
        diagnostics,
        excludes,
        path.join(ctx.env.home, ".claude", "rules"),
        true,
      );
    }
    discoverClaudeRules(ctx, sources, diagnostics, excludes);

    // 7. Local, project, and session-derived state we cannot see.
    sources.push(
      makeSource({
        path: "(session / --add-dir memory)",
        kind: "claude-session",
        state: "unknown-external",
        matchReason:
          "Memory added at runtime (e.g. session #-memories, --add-dir roots) is not visible to a static local scan",
      }),
    );

    assumptions.push(
      "Order reflects the documented load sequence, not a guaranteed conflict winner; Claude does not define a universal precedence for conflicting instructions.",
      "CLAUDE.md files above --root are outside this inspection scope and may still be loaded by Claude Code.",
    );

    return { surface: SURFACE, sources, diagnostics, assumptions, omittedByCapBytes: 0 };
  },
};

function managedPath(): string | null {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/CLAUDE.md";
    case "win32":
      return path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "ClaudeCode", "CLAUDE.md");
    default:
      return "/etc/claude-code/CLAUDE.md";
  }
}

type AddMemory = (
  file: LoadedFile,
  kind: string,
  state: SourceState,
  reason: string,
  options?: { excludable?: boolean; ordered?: boolean },
) => void;

/**
 * Collect CLAUDE.md, .claude/CLAUDE.md, and CLAUDE.local.md in one directory.
 * When both CLAUDE.md and .claude/CLAUDE.md exist, emit an ambiguity
 * diagnostic instead of inventing an order between them.
 */
function collectDirMemories(
  ctx: InspectContext,
  dir: string,
  state: SourceState,
  where: string,
  add: AddMemory,
  diagnostics: Diagnostic[],
): void {
  const rootMd = loadFile(ctx, path.join(dir, "CLAUDE.md"));
  const dotMd = loadFile(ctx, path.join(dir, ".claude", "CLAUDE.md"));
  const localMd = loadFile(ctx, path.join(dir, "CLAUDE.local.md"));

  const ambiguous = Boolean(rootMd?.read && dotMd?.read);
  if (rootMd && rootMd.read) {
    add(rootMd, "claude-memory", state, `CLAUDE.md ${where}`, { ordered: !ambiguous });
  }
  if (dotMd && dotMd.read) {
    add(dotMd, "claude-memory", state, `.claude/CLAUDE.md ${where}`, {
      ordered: !ambiguous,
    });
  }
  if (localMd && localMd.read) {
    add(localMd, "claude-local-memory", state, `CLAUDE.local.md ${where}`);
  }

  if (rootMd && rootMd.read && dotMd && dotMd.read) {
    diagnostics.push({
      code: "ambiguous-precedence",
      level: "warning",
      message: `Both CLAUDE.md and .claude/CLAUDE.md exist in ${displayFor(ctx, dir) || "."}; official docs do not define which wins`,
      paths: [rootMd.display, dotMd.display],
    });
  }
}

function discoverClaudeRules(
  ctx: InspectContext,
  sources: PolicySource[],
  diagnostics: Diagnostic[],
  excludes: string[],
  userRulesDir?: string,
  userRules = false,
): void {
  const targetDir = path.dirname(ctx.targetAbs);
  const leaf = isInside(ctx.root, targetDir) ? targetDir : ctx.cwd;
  const walks = userRules
    ? userRulesDir && isDir(userRulesDir)
      ? [
          walkDir(userRulesDir, {
            root: userRulesDir,
            budget: ctx.walkBudget,
            maxDepth: MAX_WALK_DEPTH,
            filter: (abs) => abs.endsWith(".md"),
          }),
        ]
      : []
    : ctx.mode === "discover"
      ? [
          walkDir(ctx.root, {
            root: ctx.root,
            budget: ctx.walkBudget,
            maxDepth: MAX_WALK_DEPTH,
            filter: isClaudeRule,
          }),
        ]
      : dirsRootToLeaf(ctx.root, leaf)
          .map((dir) => path.join(dir, ".claude", "rules"))
          .filter(isDir)
          .map((dir) =>
            walkDir(dir, {
              root: ctx.root,
              budget: ctx.walkBudget,
              maxDepth: MAX_WALK_DEPTH,
              filter: isClaudeRule,
            }),
          );
  const targetRelRoot = relPosix(ctx.root, ctx.targetAbs);

  for (const res of walks) {
    diagnostics.push(...symlinkDiagnostics(ctx, res));
    for (const entry of res.files) {
      const read = readTextForContext(ctx, entry.abs);
      if (isReadError(read)) continue;
      const display = displayFor(ctx, entry.abs);
      const parsed = parseFrontmatter(read.content);
      diagnostics.push(...validateFrontmatter("claude-rule", parsed, display));

      const excludedBy = excludes.find((glob) =>
        matchPatterns([glob], toPosix(entry.abs)).matched,
      );
      if (excludedBy) {
        sources.push(
          makeSource({
            path: display,
            kind: userRules ? "claude-user-rule" : "claude-rule",
            state: "excluded",
            matchReason: `Excluded by claudeMdExcludes absolute-path pattern "${excludedBy}"`,
            bytes: read.bytes,
            lines: read.lines,
            contentHash: read.contentHash,
          }),
        );
        continue;
      }

      // Scope: a nested .claude/rules applies to its containing directory subtree.
      const scopeDir = userRules ? ctx.root : (ruleScope(entry.abs, ".claude") ?? ctx.root);
      const inScope =
        userRules ||
        ctx.mode === "discover" ||
        isInside(scopeDir, ctx.targetAbs) ||
        scopeDir === ctx.root;

      const fm = parsed.data ?? {};
      const patterns = normalizePatterns(fm["paths"]);

      let state: SourceState;
      let reason: string;
      if (!inScope) {
        state = "excluded";
        reason = `Rule scope ${displayFor(ctx, scopeDir) || "."} does not contain the target`;
      } else if (patterns.length === 0) {
        state = "active";
        reason = userRules
          ? "User rule has no `paths`, so it applies in scope; project rules take priority on conflicts"
          : "Project rule has no `paths`, so it applies to all files in scope";
      } else if (ctx.mode === "discover") {
        state = "conditional";
        reason = `Path-scoped rule: applies to files matching \`paths\` (${patterns.join(", ")})`;
      } else {
        const m = matchPatterns(patterns, targetRelRoot);
        if (m.matched) {
          state = "active";
          reason = userRules
            ? `User rule \`paths\` matched via "${m.by}"; project rules take priority on conflicts`
            : `Rule \`paths\` matched the target via "${m.by}"`;
        } else {
          state = "excluded";
          reason = `Rule \`paths\` (${patterns.join(", ")}) do not match the target`;
        }
      }

      sources.push(
        makeSource({
          path: display,
          kind: userRules ? "claude-user-rule" : "claude-rule",
          state,
          matchReason: reason,
          bytes: read.bytes,
          lines: read.lines,
          contentHash: read.contentHash,
        }),
      );
    }
  }
}

function isClaudeRule(abs: string): boolean {
  return abs.endsWith(".md") && toPosix(abs).includes("/.claude/rules/");
}

/** Read `claudeMdExcludes` glob patterns from local .claude settings (JSON only). */
function readClaudeExcludes(ctx: InspectContext, diagnostics: Diagnostic[]): string[] {
  const patterns: string[] = [];
  const settings = [
    ...(ctx.includeUser && ctx.env.home
      ? [path.join(ctx.env.home, ".claude", "settings.json")]
      : []),
    path.join(ctx.root, ".claude", "settings.json"),
    path.join(ctx.root, ".claude", "settings.local.json"),
  ];
  for (const p of settings) {
    if (!isFile(p)) continue;
    const read = readTextForContext(ctx, p);
    if (isReadError(read)) continue;
    try {
      const json = JSON.parse(read.content) as Record<string, unknown>;
      const raw = json["claudeMdExcludes"];
      if (Array.isArray(raw)) {
        for (const v of raw) if (typeof v === "string") patterns.push(v);
      }
    } catch {
      diagnostics.push({
        code: "invalid-settings",
        level: "warning",
        message: `Could not parse ${displayFor(ctx, p)} as JSON; claudeMdExcludes ignored`,
        paths: [displayFor(ctx, p)],
      });
    }
  }
  return patterns;
}
