/**
 * Public contract types for agent-policy-map.
 *
 * These mirror the output contract documented in ARCHITECTURE.md. The shape is stable
 * and versioned so machine consumers can rely on it.
 */

export type AgentName = "codex" | "claude" | "cursor" | "copilot";

/**
 * Honest activation states. See README "Honest output states".
 *
 * - `active`: documented discovery and matching make it active for the
 *   simulated context.
 * - `conditional`: the agent, later file access, or model selection decides
 *   whether it loads.
 * - `manual`: requires explicit invocation or selection.
 * - `excluded`: a documented path, scope, setting, or replacement rule
 *   excludes it.
 * - `unknown-external`: relevant account, org, managed, or session state is
 *   not available to a local, read-only tool.
 */
export type SourceState =
  | "active"
  | "conditional"
  | "manual"
  | "excluded"
  | "unknown-external";

export type PolicySource = {
  /** Deterministic, stable identifier for `explain <source-id>`. */
  id: string;
  /** Display path: repo-relative (with leading `./`) when inside cwd, else absolute. */
  path: string;
  /** Source kind, e.g. "agents-md", "codex-skill", "claude-rule", "cursor-mdc". */
  kind: string;
  state: SourceState;
  /** Documented load order, when the agent defines one. Omitted otherwise. */
  order?: number;
  /** Human-readable, evidence-backed reason for the state and match. */
  matchReason: string;
  /** Number of source bytes actually inspected and represented in this map. */
  bytes?: number;
  lines?: number;
  /** Short sha256 of represented bytes; omitted after hard safety truncation. */
  contentHash?: string;
};

export type DiagnosticLevel = "info" | "warning" | "error";

export type Diagnostic = {
  /** Machine-stable code, e.g. "missing-import", "possible-conflict". */
  code: string;
  level: DiagnosticLevel;
  message: string;
  /** Related display paths. */
  paths?: string[];
  /** Short, credential-redacted excerpts backing the finding. */
  evidence?: string[];
};

export type ContextEstimate = {
  bytes: number;
  lines: number;
  /** Approximate token count. Clearly an estimate, not a model token count. */
  approxTokens: number;
  activeBytes: number;
  conditionalBytes: number;
  manualBytes: number;
  /** Bytes omitted because an official cap truncated content (e.g. Codex 32 KiB). */
  omittedByCapBytes: number;
  note: string;
};

export type PolicyMap = {
  version: "1";
  agent: AgentName;
  /** The concrete surface modelled, e.g. "GitHub Copilot CLI". */
  surface: string;
  /** Display path of the target file. */
  target: string;
  /** Display path of the simulated launch working directory. */
  cwd: string;
  assumptions: string[];
  sources: PolicySource[];
  diagnostics: Diagnostic[];
  context: ContextEstimate;
};

export type ComparisonAgent = {
  /** The concrete surface modelled by this adapter. */
  surface: string;
  assumptions: string[];
  diagnostics: Diagnostic[];
  context: ContextEstimate;
};

export type ComparisonSource = {
  /** Redacted display path shared by the grouped source entries. */
  path: string;
  /**
   * True when loadable states or represented local content differ by agent.
   * Excluded-only and unknown-external-only rows are not counted.
   */
  meaningfulDifference: boolean;
  /** Arrays preserve multiple entries that share one display path. */
  agents: Record<AgentName, PolicySource[]>;
};

export type PolicyComparison = {
  version: "1";
  command: "compare";
  target: string;
  cwd: string;
  root: string;
  includeUser: boolean;
  summary: {
    sourcePaths: number;
    meaningfulDifferences: number;
    hasMeaningfulDifferences: boolean;
  };
  sources: ComparisonSource[];
  agents: Record<AgentName, ComparisonAgent>;
};
