/**
 * Public, programmatic API for agent-policy-map.
 *
 * Everything here is local, read-only, and deterministic. No network, no LLM.
 */
export { inspect } from "./core/inspect.js";
export { compare, type CompareInput } from "./core/compare.js";
export { buildContext, type BuildContextInput } from "./core/context.js";
export { ADAPTERS, AGENT_NAMES, isAgentName } from "./adapters/registry.js";
export { renderHuman, countByState } from "./render/human.js";
export { renderComparisonHuman } from "./render/compare-human.js";
export { renderJson } from "./render/json.js";
export { estimateContext } from "./context/estimate.js";
export { redact, excerpt } from "./security/redact.js";

export type {
  AgentName,
  SourceState,
  PolicySource,
  Diagnostic,
  DiagnosticLevel,
  ContextEstimate,
  PolicyMap,
  ComparisonAgent,
  ComparisonSource,
  PolicyComparison,
} from "./types.js";
export type {
  AdapterResult,
  AgentAdapter,
  Env,
  InspectContext,
  InspectMode,
} from "./adapters/types.js";
