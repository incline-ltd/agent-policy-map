import fs from "node:fs";
import path from "node:path";
import { MAX_ASCEND_LEVELS } from "../constants.js";
import { Budget } from "../fs/read.js";
import { WalkBudget } from "../fs/walk.js";
import { isInside, normalizeAbs } from "../fs/paths.js";
import type { AgentName } from "../types.js";
import type { Env, InspectContext, InspectMode } from "../adapters/types.js";

export type BuildContextInput = {
  agent: AgentName;
  target: string;
  cwd?: string;
  root?: string;
  includeUser?: boolean;
  mode?: InspectMode;
  env?: NodeJS.ProcessEnv;
  budget?: Budget;
};

export type BuiltContext = {
  ctx: InspectContext;
  assumptions: string[];
};

/** Find the nearest ancestor of `from` (inclusive) that contains a `.git` entry. */
function detectRoot(from: string): string | null {
  let cur = from;
  for (let i = 0; i < MAX_ASCEND_LEVELS; i++) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function buildEnv(raw: NodeJS.ProcessEnv): Env {
  const home = raw["HOME"] ?? raw["USERPROFILE"];
  const codexHome = raw["CODEX_HOME"] ?? (home ? path.join(home, ".codex") : undefined);
  const copilotHome = raw["COPILOT_HOME"] ?? (home ? path.join(home, ".copilot") : undefined);
  const customRaw = raw["COPILOT_CUSTOM_INSTRUCTIONS_DIRS"];
  const customDirs = customRaw
    ? customRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;
  const env: Env = {};
  if (home !== undefined) env.home = home;
  if (codexHome !== undefined) env.codexHome = codexHome;
  if (copilotHome !== undefined) env.copilotHome = copilotHome;
  if (customDirs !== undefined) env.copilotCustomInstructionDirs = customDirs;
  return env;
}

/**
 * Resolve target, cwd, root, and environment into a normalized InspectContext,
 * collecting the assumptions that resolution required.
 */
export function buildContext(input: BuildContextInput): BuiltContext {
  const assumptions: string[] = [];
  const targetAbs = normalizeAbs(input.target);
  let targetExists = false;
  try {
    targetExists = fs.lstatSync(targetAbs).isFile();
  } catch {
    targetExists = false;
  }

  let cwd: string;
  if (input.cwd !== undefined) {
    cwd = normalizeAbs(input.cwd);
  } else {
    cwd = path.dirname(targetAbs);
    assumptions.push(
      input.agent === "codex"
        ? "No --cwd given. Codex discovery depends on the launch working directory; assuming the target's directory. Pass --cwd to model a different launch directory."
        : "No --cwd given; assuming the target's directory.",
    );
  }

  let root: string;
  if (input.root !== undefined) {
    root = normalizeAbs(input.root);
  } else {
    const detected = detectRoot(cwd);
    if (detected) {
      root = detected;
    } else {
      root = cwd;
      assumptions.push(
        "No project root marker (.git) found at or above cwd; using cwd as the containment root.",
      );
    }
  }

  // Guarantee cwd is inside root; otherwise fall back to cwd as root.
  if (!isInside(root, cwd)) {
    root = cwd;
    assumptions.push(
      "Provided root does not contain cwd; using cwd as the containment root.",
    );
  }

  if (!targetExists && (input.mode ?? "inspect") === "inspect") {
    assumptions.push(
      "The target does not exist on disk; path-based matching is still evaluated against its path.",
    );
  }

  const ctx: InspectContext = {
    agent: input.agent,
    mode: input.mode ?? "inspect",
    targetAbs,
    targetExists,
    cwd,
    root,
    includeUser: input.includeUser ?? false,
    env: buildEnv(input.env ?? process.env),
    budget: input.budget ?? new Budget(),
    walkBudget: new WalkBudget(),
    readDiagnostics: [],
  };

  return { ctx, assumptions };
}
