import { AGENT_NAMES } from "../adapters/registry.js";
import { displayFor } from "../adapters/shared.js";
import type {
  AgentName,
  ComparisonAgent,
  ComparisonSource,
  PolicyComparison,
  PolicyMap,
  PolicySource,
} from "../types.js";
import { redact } from "../security/redact.js";
import type { BuildContextInput } from "./context.js";
import { inspectWithContext } from "./inspect.js";

export type CompareInput = Omit<
  BuildContextInput,
  "agent" | "mode" | "budget"
>;

const LOADABLE_STATES = new Set(["active", "conditional", "manual"]);

function emptyAgentSources(): Record<AgentName, PolicySource[]> {
  return {
    codex: [],
    claude: [],
    cursor: [],
    copilot: [],
  };
}

function loadableSignature(sources: PolicySource[]): string {
  return sources
    .filter((source) => LOADABLE_STATES.has(source.state))
    .map(
      (source) =>
        `${source.state}:${source.bytes ?? ""}:${source.contentHash ?? ""}`,
    )
    .sort()
    .join("|");
}

function isMeaningfulDifference(
  agents: Record<AgentName, PolicySource[]>,
): boolean {
  const signatures = AGENT_NAMES.map((agent) =>
    loadableSignature(agents[agent]),
  );
  return new Set(signatures).size > 1;
}

function pathRank(value: string): number {
  if (value === "." || value.startsWith("./")) return 0;
  if (value === "~" || value.startsWith("~/")) return 1;
  return 2;
}

function sortPaths(a: string, b: string): number {
  const rank = pathRank(a) - pathRank(b);
  if (rank !== 0) return rank;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparisonAgent(map: PolicyMap): ComparisonAgent {
  return {
    surface: map.surface,
    assumptions: map.assumptions,
    diagnostics: map.diagnostics,
    context: map.context,
  };
}

/**
 * Compare all supported agent surfaces for one target without adding a second
 * discovery engine. Every adapter receives a fresh bounded inspection budget.
 */
export function compare(input: CompareInput): PolicyComparison {
  const results = AGENT_NAMES.map((agent) =>
    inspectWithContext({ ...input, agent, mode: "inspect" }),
  );
  const first = results[0];
  if (!first) throw new Error("No agent adapters are registered.");

  const grouped = new Map<string, Record<AgentName, PolicySource[]>>();
  for (const { map } of results) {
    for (const source of map.sources) {
      const agents = grouped.get(source.path) ?? emptyAgentSources();
      agents[map.agent].push(source);
      grouped.set(source.path, agents);
    }
  }

  const sources: ComparisonSource[] = [...grouped.entries()]
    .sort(([a], [b]) => sortPaths(a, b))
    .map(([sourcePath, agents]) => ({
      path: sourcePath,
      meaningfulDifference: isMeaningfulDifference(agents),
      agents,
    }));
  const meaningfulDifferences = sources.filter(
    (source) => source.meaningfulDifference,
  ).length;

  const maps = Object.fromEntries(
    results.map(({ map }) => [map.agent, comparisonAgent(map)]),
  ) as Record<AgentName, ComparisonAgent>;

  return {
    version: "1",
    command: "compare",
    target: first.map.target,
    cwd: first.map.cwd,
    root: redact(displayFor(first.ctx, first.ctx.root)),
    includeUser: input.includeUser ?? false,
    summary: {
      sourcePaths: sources.length,
      meaningfulDifferences,
      hasMeaningfulDifferences: meaningfulDifferences > 0,
    },
    sources,
    agents: maps,
  };
}
