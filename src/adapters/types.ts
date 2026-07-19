import type { Budget } from "../fs/read.js";
import type { WalkBudget } from "../fs/walk.js";
import type { AgentName, Diagnostic, PolicySource } from "../types.js";

/** Environment inputs, injectable so tests never touch a real home directory. */
export type Env = {
  home?: string;
  codexHome?: string;
  copilotHome?: string;
  copilotCustomInstructionDirs?: string[];
};

export type InspectMode = "inspect" | "discover";

export type InspectContext = {
  agent: AgentName;
  /**
   * "inspect" resolves state for one concrete target. "discover" lists what is
   * discoverable independent of a target, marking target-dependent sources as
   * conditional instead of active/excluded.
   */
  mode: InspectMode;
  /** Absolute, normalized target path (may not exist on disk). */
  targetAbs: string;
  targetExists: boolean;
  /** Absolute, normalized launch working directory. */
  cwd: string;
  /** Absolute containment root; reads never escape it (except opt-in user dirs). */
  root: string;
  /** When true, documented user/home and managed locations are inspected. */
  includeUser: boolean;
  env: Env;
  budget: Budget;
  /** Aggregate traversal counters shared by every adapter walk. */
  walkBudget: WalkBudget;
  /** Shared diagnostics emitted by contained read helpers. */
  readDiagnostics: Diagnostic[];
};

export type AdapterResult = {
  surface: string;
  sources: PolicySource[];
  diagnostics: Diagnostic[];
  assumptions: string[];
  /** Bytes dropped by an official cap, fed into the context estimate. */
  omittedByCapBytes: number;
};

export interface AgentAdapter {
  name: AgentName;
  surface: string;
  inspect(ctx: InspectContext): AdapterResult;
}
