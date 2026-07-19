import path from "node:path";
import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Diagnostic, PolicySource } from "../types.js";
import type { AdapterResult, AgentAdapter, InspectContext } from "./types.js";
import {
  CODEX_PROJECT_DOC_MAX_BYTES,
  MAX_WALK_DEPTH,
} from "../constants.js";
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
import { isReadError, shortHash } from "../fs/read.js";
import { walkDir } from "../fs/walk.js";
import { parseFrontmatter } from "../frontmatter/parse.js";
import { validateFrontmatter } from "../frontmatter/validate.js";

const SURFACE = "Codex CLI";
const ADMIN_SKILLS_DIR = "/etc/codex/skills";

type CodexConfig = {
  fallbackNames: string[];
  maxBytes: number;
  disabledSkillPaths: Set<string>;
};
type ParsedConfigLayer = {
  fallbackNames?: string[];
  maxBytes?: number;
  skillOverrides: Array<{ path: string; enabled: boolean }>;
  hasProjectRootMarkers: boolean;
};
type ProjectDocCap = { remaining: number; omitted: number };

/**
 * Read a couple of documented keys from `$CODEX_HOME/config.toml` using narrow
 * regexes. We never evaluate the file as TOML/JS; we only extract two scalar
 * settings if present.
 */
function readCodexConfig(
  ctx: InspectContext,
  projectChain: string[],
  diagnostics: Diagnostic[],
  assumptions: string[],
): CodexConfig {
  const cfg: CodexConfig = {
    fallbackNames: [],
    maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
    disabledSkillPaths: new Set(),
  };
  const layers: Array<{ path: string; base: string; project: boolean }> = [];
  if (ctx.includeUser && ctx.env.codexHome) {
    layers.push({
      path: path.join(ctx.env.codexHome, "config.toml"),
      base: ctx.env.codexHome,
      project: false,
    });
  }
  for (const dir of projectChain) {
    layers.push({
      path: path.join(dir, ".codex", "config.toml"),
      base: path.join(dir, ".codex"),
      project: true,
    });
  }

  const projectLayers: string[] = [];
  let rootMarkersSeen = false;
  for (const layer of layers) {
    if (!isFile(layer.path)) continue;
    if (layer.project) projectLayers.push(displayFor(ctx, layer.path));
    const parsed = parseCodexConfigLayer(ctx, layer.path, diagnostics);
    if (parsed === null) continue;
    if (parsed.fallbackNames !== undefined) cfg.fallbackNames = parsed.fallbackNames;
    if (parsed.maxBytes !== undefined) cfg.maxBytes = parsed.maxBytes;
    rootMarkersSeen ||= parsed.hasProjectRootMarkers;
    for (const override of parsed.skillOverrides) {
      const resolved = resolveConfiguredSkillPath(override.path, layer.base, ctx.env.home);
      if (resolved === null) {
        diagnostics.push({
          code: "codex-config-invalid",
          level: "warning",
          message: `Ignored invalid skills.config path in ${displayFor(ctx, layer.path)}`,
          paths: [displayFor(ctx, layer.path)],
        });
        continue;
      }
      const canonical = canonicalPath(resolved);
      if (override.enabled) cfg.disabledSkillPaths.delete(canonical);
      else cfg.disabledSkillPaths.add(canonical);
    }
  }

  if (projectLayers.length > 0) {
    assumptions.push(
      `Applied project Codex configuration from ${projectLayers.join(", ")} assuming the project is trusted; Codex ignores project .codex/config.toml layers in untrusted projects.`,
    );
  }
  if (rootMarkersSeen) {
    assumptions.push(
      "A Codex config sets project_root_markers. Root auto-detection in this version still uses .git; pass --root explicitly to model the intended project boundary.",
    );
  }
  return cfg;
}

function parseCodexConfigLayer(
  ctx: InspectContext,
  configPath: string,
  diagnostics: Diagnostic[],
): ParsedConfigLayer | null {
  const read = readTextForContext(ctx, configPath);
  if (isReadError(read)) return null;
  const parsed: ParsedConfigLayer = { skillOverrides: [], hasProjectRootMarkers: false };
  let section = "";
  let pendingSkill: { path?: string; enabled?: boolean } | null = null;

  const flushSkill = (): void => {
    if (pendingSkill?.path !== undefined && pendingSkill.enabled !== undefined) {
      parsed.skillOverrides.push({ path: pendingSkill.path, enabled: pendingSkill.enabled });
    }
    pendingSkill = null;
  };

  for (const rawLine of read.content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;
    const arrayHeader = /^\[\[\s*([^\]]+)\s*\]\]$/.exec(line);
    if (arrayHeader) {
      flushSkill();
      section = arrayHeader[1]?.trim() ?? "";
      if (section === "skills.config") pendingSkill = {};
      continue;
    }
    const tableHeader = /^\[\s*([^\]]+)\s*\]$/.exec(line);
    if (tableHeader) {
      flushSkill();
      section = tableHeader[1]?.trim() ?? "";
      continue;
    }

    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const key = pair[1] ?? "";
    const value = pair[2]?.trim() ?? "";
    if (section === "skills.config" && pendingSkill !== null) {
      if (key === "path") {
        const configuredPath = parseTomlString(value);
        if (configuredPath !== undefined) pendingSkill.path = configuredPath;
      }
      if (key === "enabled" && /^(?:true|false)$/.test(value)) {
        pendingSkill.enabled = value === "true";
      }
      continue;
    }
    if (section !== "") continue;

    if (key === "project_doc_fallback_filenames") {
      const names = parseTomlStringArray(value);
      if (names === null) {
        reportInvalidConfig(ctx, configPath, diagnostics, key);
        continue;
      }
      const safe: string[] = [];
      for (const name of names) {
        if (isSafeFallbackName(name)) safe.push(name);
        else {
          diagnostics.push({
            code: "codex-config-invalid",
            level: "warning",
            message: `Ignored unsafe project_doc_fallback_filenames entry "${name}"; entries must be plain filenames`,
            paths: [displayFor(ctx, configPath)],
          });
        }
      }
      parsed.fallbackNames = safe;
    } else if (key === "project_doc_max_bytes") {
      if (!/^\d+$/.test(value)) reportInvalidConfig(ctx, configPath, diagnostics, key);
      else parsed.maxBytes = Number.parseInt(value, 10);
    } else if (key === "project_root_markers") {
      parsed.hasProjectRootMarkers = true;
    }
  }
  flushSkill();
  return parsed;
}

function stripTomlComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === null ? char : quote === char ? null : quote;
      continue;
    }
    if (char === "#" && quote === null) return line.slice(0, i);
  }
  return line;
}

function parseTomlString(value: string): string | undefined {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return undefined;
}

function parseTomlStringArray(value: string): string[] | null {
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const inner = value.slice(1, -1);
  if (inner.trim() === "") return [];
  const values: string[] = [];
  for (const part of inner.split(",")) {
    const parsed = parseTomlString(part.trim());
    if (parsed === undefined) return null;
    values.push(parsed);
  }
  return values;
}

function reportInvalidConfig(
  ctx: InspectContext,
  configPath: string,
  diagnostics: Diagnostic[],
  key: string,
): void {
  diagnostics.push({
    code: "codex-config-invalid",
    level: "warning",
    message: `Could not parse ${key} in ${displayFor(ctx, configPath)}`,
    paths: [displayFor(ctx, configPath)],
  });
}

function resolveConfiguredSkillPath(
  configured: string,
  base: string,
  home: string | undefined,
): string | null {
  if (configured === "~") return home ?? null;
  if (configured.startsWith("~/")) return home ? path.resolve(home, configured.slice(2)) : null;
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(base, configured);
}

function canonicalPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export const codexAdapter: AgentAdapter = {
  name: "codex",
  surface: SURFACE,
  inspect(ctx: InspectContext): AdapterResult {
    const sources: PolicySource[] = [];
    const diagnostics: Diagnostic[] = [];
    const assumptions: string[] = [];
    let omittedByCapBytes = 0;
    let order = 0;

    const chain = dirsRootToLeaf(ctx.root, ctx.cwd);
    const cfg = readCodexConfig(ctx, chain, diagnostics, assumptions);

    // 1. Global instructions at $CODEX_HOME (opt-in). The override replaces
    //    AGENTS.md at this global scope just as it does in a project directory.
    if (ctx.includeUser && ctx.env.codexHome) {
      resolveGlobalDoc(ctx, ctx.env.codexHome, sources, () => ++order);
    } else {
      assumptions.push(
        "Global Codex instructions ($CODEX_HOME/AGENTS.override.md or AGENTS.md) were not inspected. Pass --include-user to include them.",
      );
    }

    // 2. Project docs from root down to the launch cwd (NOT the target dir).
    const projectDocCap: ProjectDocCap = { remaining: cfg.maxBytes, omitted: 0 };
    for (const dir of chain) {
      resolveProjectDoc(ctx, dir, cfg, projectDocCap, {
        push: (s) => {
          if (s.state === "active") s.order = ++order;
          sources.push(s);
        },
      });
    }
    omittedByCapBytes += projectDocCap.omitted;

    // 3. Repository skills exist only in `.agents/skills` catalogs on the
    //    root-to-cwd ancestor chain. Do not recursively scan the whole project,
    //    which would leak sibling fixtures or unrelated nested repositories.
    for (const dir of chain) {
      discoverSkillCatalog(
        ctx,
        path.join(dir, ".agents", "skills"),
        ctx.root,
        "repository",
        cfg.disabledSkillPaths,
        sources,
        diagnostics,
      );
    }

    // 4. User and administrator skill catalogs are outside the project and only
    //    inspected with the explicit opt-in.
    if (ctx.includeUser) {
      if (ctx.env.home) {
        discoverSkillCatalog(
          ctx,
          path.join(ctx.env.home, ".agents", "skills"),
          ctx.env.home,
          "user",
          cfg.disabledSkillPaths,
          sources,
          diagnostics,
        );
      } else {
        assumptions.push("HOME is unavailable, so user skills at $HOME/.agents/skills could not be inspected.");
      }

      if (isDir(ADMIN_SKILLS_DIR)) {
        discoverSkillCatalog(
          ctx,
          ADMIN_SKILLS_DIR,
          path.dirname(ADMIN_SKILLS_DIR),
          "admin",
          cfg.disabledSkillPaths,
          sources,
          diagnostics,
        );
      } else {
        assumptions.push(`Admin skills directory ${ADMIN_SKILLS_DIR} is not present on this machine.`);
      }
    } else {
      assumptions.push(
        "User skills ($HOME/.agents/skills), administrator skills (/etc/codex/skills), and user skill enable/disable settings were not inspected. Pass --include-user to include locally visible catalogs and $CODEX_HOME/config.toml.",
      );
      sources.push(
        makeSource({
          path: ADMIN_SKILLS_DIR,
          kind: "codex-skill-catalog",
          state: "unknown-external",
          matchReason:
            "Administrator skills are outside the project and were not inspected without --include-user",
        }),
      );
    }

    sources.push(
      makeSource({
        path: "[Codex bundled system skills]",
        kind: "codex-skill-catalog",
        state: "unknown-external",
        matchReason:
          "Bundled system skills are supplied by the running Codex host and are not exposed as a stable filesystem catalog for this offline inspection",
      }),
    );

    // Same-name skill diagnostic (they do not merge; each stays separate).
    reportDuplicateSkillNames(sources, diagnostics);

    return { surface: SURFACE, sources, diagnostics, assumptions, omittedByCapBytes };
  },
};

function resolveGlobalDoc(
  ctx: InspectContext,
  codexHome: string,
  sources: PolicySource[],
  nextOrder: () => number,
): void {
  const overrideAbs = path.join(codexHome, "AGENTS.override.md");
  const agentsAbs = path.join(codexHome, "AGENTS.md");
  const override = loadFile(ctx, overrideAbs);

  if (override && override.read) {
    sources.push(
      sourceFromFile(override, {
        kind: "codex-agents-override",
        state: "active",
        order: nextOrder(),
        matchReason: "Global AGENTS.override.md at $CODEX_HOME replaces global AGENTS.md",
      }),
    );
    const agents = loadFile(ctx, agentsAbs);
    if (agents && agents.read) {
      sources.push(
        sourceFromFile(agents, {
          kind: "codex-agents-md",
          state: "excluded",
          matchReason: "Replaced by AGENTS.override.md at $CODEX_HOME",
        }),
      );
    }
    return;
  }

  const agents = loadFile(ctx, agentsAbs);
  if (agents && agents.read) {
    sources.push(
      sourceFromFile(agents, {
        kind: "codex-agents-md",
        state: "active",
        order: nextOrder(),
        matchReason: `Global Codex instructions at $CODEX_HOME (${displayFor(ctx, codexHome)})`,
      }),
    );
  }
}

type CappedProjectDoc = {
  file: LoadedFile;
  officialIncluded: number;
  totalBytes: number;
};

function capProjectDoc(file: LoadedFile, cap: ProjectDocCap): CappedProjectDoc {
  const totalBytes = file.read.totalBytes ?? file.read.bytes;
  const officialIncluded = Math.min(totalBytes, cap.remaining);
  const available = Buffer.from(file.read.content, "utf8");
  const included = Math.min(file.read.bytes, available.byteLength, officialIncluded);
  const raw = available.subarray(0, included);
  cap.remaining -= officialIncluded;
  cap.omitted += totalBytes - officialIncluded;
  const content = raw.toString("utf8");
  return {
    officialIncluded,
    totalBytes,
    file: {
      ...file,
      read: {
        content,
        bytes: raw.byteLength,
        totalBytes,
        lines: countLines(content),
        truncated: file.read.truncated || officialIncluded < totalBytes,
        ...(file.read.contentHash !== undefined ? { contentHash: shortHash(raw) } : {}),
      },
    },
  };
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

function isSafeFallbackName(name: string): boolean {
  return (
    name !== "." &&
    name !== ".." &&
    !path.isAbsolute(name) &&
    !/[\\/]/.test(name) &&
    path.basename(name) === name
  );
}

function cappedProjectSource(
  file: LoadedFile,
  cap: ProjectDocCap,
  init: Omit<Parameters<typeof sourceFromFile>[1], "state"> & { state: "active" },
): PolicySource {
  const capped = capProjectDoc(file, cap);
  if (capped.officialIncluded === 0 && capped.totalBytes > 0) {
    return sourceFromFile(capped.file, {
      ...init,
      state: "excluded",
      matchReason: `${init.matchReason}; excluded because the combined project-doc byte cap was already exhausted`,
    });
  }
  return sourceFromFile(capped.file, {
    ...init,
    state: "active",
    matchReason:
      capped.officialIncluded < capped.totalBytes
        ? `${init.matchReason}; only the first ${capped.officialIncluded} of ${capped.totalBytes} bytes fit the combined project-doc cap`
        : init.matchReason,
  });
}

type ProjectDocSink = {
  push: (s: PolicySource) => void;
};

/**
 * Resolve the single project doc that applies in one directory:
 * AGENTS.override.md replaces AGENTS.md; otherwise AGENTS.md; otherwise the
 * first configured fallback name. Empty files are skipped.
 */
function resolveProjectDoc(
  ctx: InspectContext,
  dir: string,
  cfg: CodexConfig,
  cap: ProjectDocCap,
  sink: ProjectDocSink,
): void {
  const overrideAbs = path.join(dir, "AGENTS.override.md");
  const agentsAbs = path.join(dir, "AGENTS.md");
  const override = loadFile(ctx, overrideAbs);

  if (override && override.read) {
    sink.push(
      cappedProjectSource(override, cap, {
        kind: "codex-agents-override",
        state: "active",
        matchReason: `AGENTS.override.md at ${displayFor(ctx, dir) || "."} replaces AGENTS.md in the same directory`,
      }),
    );
    // If a plain AGENTS.md also exists here, it is excluded by the override.
    if (isFile(agentsAbs)) {
      const replaced = loadFile(ctx, agentsAbs);
      if (replaced && replaced.read) {
        sink.push(
          sourceFromFile(replaced, {
            kind: "codex-agents-md",
            state: "excluded",
            matchReason: "Replaced by AGENTS.override.md in the same directory",
          }),
        );
      }
    }
    return;
  }

  const agents = loadFile(ctx, agentsAbs);
  if (agents && agents.read) {
    sink.push(
      cappedProjectSource(agents, cap, {
        kind: "codex-agents-md",
        state: "active",
        matchReason: `AGENTS.md discovered on the root→cwd path (${displayFor(ctx, dir) || "."})`,
      }),
    );
    return;
  }

  // Fallback names, in configured order.
  for (const name of cfg.fallbackNames) {
    if (name === "AGENTS.md" || name === "AGENTS.override.md") continue;
    const fb = loadFile(ctx, path.join(dir, name));
    if (fb && fb.read) {
      sink.push(
        cappedProjectSource(fb, cap, {
          kind: "codex-agents-fallback",
          state: "active",
          matchReason: `Fallback project-doc name "${name}" used because AGENTS.md is absent in ${displayFor(ctx, dir) || "."}`,
        }),
      );
      return;
    }
  }
}

function discoverSkillCatalog(
  ctx: InspectContext,
  skillsRoot: string,
  containmentRoot: string,
  scope: "repository" | "user" | "admin",
  disabledSkillPaths: ReadonlySet<string>,
  sources: PolicySource[],
  diagnostics: Diagnostic[],
): void {
  const res = walkDir(skillsRoot, {
    root: containmentRoot,
    budget: ctx.walkBudget,
    maxDepth: Math.min(MAX_WALK_DEPTH, 2),
    filter: (abs) => isSkillCatalogFile(skillsRoot, abs),
  });
  diagnostics.push(...symlinkDiagnostics(ctx, res));

  const policyFiles = new Map<string, string>();
  const skillFiles: string[] = [];
  for (const entry of res.files) {
    if (path.basename(entry.abs) === "SKILL.md") {
      skillFiles.push(entry.abs);
    } else {
      policyFiles.set(path.dirname(path.dirname(entry.abs)), entry.abs);
    }
  }

  for (const skillFile of skillFiles) {
    const read = readTextForContext(ctx, skillFile);
    if (isReadError(read)) continue;
    const display = displayFor(ctx, skillFile);
    const parsed = parseFrontmatter(read.content);
    diagnostics.push(...validateFrontmatter("codex-skill", parsed, display));
    const fm = parsed.data ?? {};
    const nameField =
      typeof fm["name"] === "string" ? (fm["name"] as string) : path.basename(path.dirname(skillFile));
    if (Object.hasOwn(fm, "allow_implicit_invocation")) {
      diagnostics.push({
        code: "skill-policy-misplaced",
        level: "info",
        message:
          "Codex invocation policy is read from agents/openai.yaml; allow_implicit_invocation in SKILL.md frontmatter is ignored",
        paths: [display],
      });
    }

    const policyAbs = policyFiles.get(path.dirname(skillFile));
    const policy = readSkillPolicy(ctx, policyAbs, diagnostics);
    const manualOnly = policy.allowImplicit === false;
    const disabled = disabledSkillPaths.has(canonicalPath(skillFile));
    sources.push(
      makeSource({
        path: display,
        kind: "codex-skill",
        state: disabled ? "excluded" : manualOnly ? "manual" : "conditional",
        matchReason: disabled
          ? `Skill "${nameField}" is disabled by a skills.config entry`
          : manualOnly
            ? `Skill "${nameField}" sets policy.allow_implicit_invocation: false in ${policy.displayPath}, so it loads only on explicit invocation`
            : `Skill "${nameField}" is available (${scope}); activation depends on explicit or inferred selection`,
        bytes: read.bytes,
        lines: read.lines,
        contentHash: read.contentHash,
      }),
    );
  }
}

function isSkillCatalogFile(skillsRoot: string, abs: string): boolean {
  const parts = path.relative(skillsRoot, abs).split(path.sep);
  return (
    (parts.length === 2 && parts[1] === "SKILL.md") ||
    (parts.length === 3 && parts[1] === "agents" && parts[2] === "openai.yaml")
  );
}

type SkillPolicy = { allowImplicit?: boolean; displayPath?: string };

function readSkillPolicy(
  ctx: InspectContext,
  policyAbs: string | undefined,
  diagnostics: Diagnostic[],
): SkillPolicy {
  if (!policyAbs) return {};
  const displayPath = displayFor(ctx, policyAbs);
  const read = readTextForContext(ctx, policyAbs);
  if (isReadError(read)) {
    diagnostics.push({
      code: "skill-policy-invalid",
      level: "warning",
      message: `Could not read Codex skill policy (${read.message})`,
      paths: [displayPath],
    });
    return { displayPath };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(read.content, { prettyErrors: false });
  } catch (error) {
    diagnostics.push({
      code: "skill-policy-invalid",
      level: "warning",
      message: `Codex skill policy has malformed YAML (${error instanceof Error ? error.message : String(error)})`,
      paths: [displayPath],
    });
    return { displayPath };
  }

  const root = asRecord(parsed);
  const policy = asRecord(root?.["policy"]);
  const value = policy?.["allow_implicit_invocation"];
  if (value !== undefined && typeof value !== "boolean") {
    diagnostics.push({
      code: "skill-policy-invalid",
      level: "warning",
      message: "Codex skill policy field policy.allow_implicit_invocation must be a boolean",
      paths: [displayPath],
    });
    return { displayPath };
  }
  return value === undefined ? { displayPath } : { allowImplicit: value, displayPath };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function reportDuplicateSkillNames(sources: PolicySource[], diagnostics: Diagnostic[]): void {
  const byName = new Map<string, string[]>();
  for (const s of sources) {
    if (s.kind !== "codex-skill") continue;
    const m = /Skill "([^"]+)"/.exec(s.matchReason);
    const name = m?.[1] ?? s.path;
    const list = byName.get(name) ?? [];
    list.push(s.path);
    byName.set(name, list);
  }
  for (const [name, paths] of byName) {
    if (paths.length > 1) {
      diagnostics.push({
        code: "duplicate-skill-name",
        level: "warning",
        message: `Multiple skills share the name "${name}"; Codex does not merge them, each remains a separate skill`,
        paths,
      });
    }
  }
}
