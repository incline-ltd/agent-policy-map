import { AGENT_NAMES } from "../adapters/registry.js";
import type {
  AgentName,
  ComparisonSource,
  PolicyComparison,
  PolicySource,
} from "../types.js";

const AGENT_LABEL: Record<AgentName, string> = {
  codex: "CODEX",
  claude: "CLAUDE",
  cursor: "CURSOR",
  copilot: "COPILOT",
};

const PATH_WIDTH = 44;
const STATE_WIDTH = 17;

function compactPath(value: string): string {
  if (value.length <= PATH_WIDTH) return value;
  const tailLength = 18;
  return `${value.slice(0, PATH_WIDTH - tailLength - 1)}…${value.slice(-tailLength)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function stateCell(sources: PolicySource[]): string {
  if (sources.length === 0) return "—";
  const states = [...new Set(sources.map((source) => source.state))];
  return states.join("/");
}

function isUnknownOnly(source: ComparisonSource): boolean {
  const entries = AGENT_NAMES.flatMap((agent) => source.agents[agent]);
  return (
    entries.length > 0 &&
    entries.every((entry) => entry.state === "unknown-external")
  );
}

function sourceTable(sources: ComparisonSource[]): string[] {
  const out: string[] = [];
  const header = [
    pad("SOURCE", PATH_WIDTH),
    ...AGENT_NAMES.map((agent) => pad(AGENT_LABEL[agent], STATE_WIDTH)),
    "DIFF",
  ].join(" ");
  out.push(header);
  out.push("-".repeat(header.length));

  for (const source of sources) {
    out.push(
      [
        pad(compactPath(source.path), PATH_WIDTH),
        ...AGENT_NAMES.map((agent) =>
          pad(stateCell(source.agents[agent]), STATE_WIDTH),
        ),
        source.meaningfulDifference ? "yes" : "",
      ].join(" "),
    );
  }
  return out;
}

function evidenceLines(sources: ComparisonSource[]): string[] {
  const out: string[] = [];
  for (const source of sources.filter(
    (candidate) => candidate.meaningfulDifference,
  )) {
    out.push(source.path);
    for (const agent of AGENT_NAMES) {
      const entries = source.agents[agent];
      if (entries.length === 0) {
        out.push(`  ${agent} —: not discovered by this modeled adapter`);
        continue;
      }
      for (const entry of entries) {
        out.push(
          `  ${agent} ${entry.state} [${entry.kind}]: ${entry.matchReason}`,
        );
      }
    }
  }
  return out;
}

function inspectionNotes(comparison: PolicyComparison): string[] {
  const out: string[] = [];
  for (const agent of AGENT_NAMES) {
    for (const diagnostic of comparison.agents[agent].diagnostics) {
      out.push(
        `- ${agent} [${diagnostic.level}] ${diagnostic.code}: ${diagnostic.message}`,
      );
    }
    for (const assumption of comparison.agents[agent].assumptions) {
      out.push(`- ${agent} assumption: ${assumption}`);
    }
  }
  return out;
}

/** Render a compact cross-agent matrix plus evidence for meaningful differences. */
export function renderComparisonHuman(comparison: PolicyComparison): string {
  const out: string[] = [];
  const localSources = comparison.sources.filter(
    (source) => !isUnknownOnly(source),
  );
  const unknownSources = comparison.sources.filter(isUnknownOnly);
  const differenceWord =
    comparison.summary.meaningfulDifferences === 1
      ? "difference"
      : "differences";

  out.push(`Target:           ${comparison.target}`);
  out.push(`Launch cwd:       ${comparison.cwd}`);
  out.push(`Containment root: ${comparison.root}`);
  out.push(
    `User scope:       ${comparison.includeUser ? "included" : "project only"}`,
  );
  out.push(
    `Surfaces:         ${AGENT_NAMES.map(
      (agent) => comparison.agents[agent].surface,
    ).join(" | ")}`,
  );
  out.push(
    `Result:           ${comparison.summary.meaningfulDifferences} meaningful local ${differenceWord}`,
  );
  out.push("");

  if (localSources.length > 0) {
    out.push("LOCAL SOURCES");
    out.push(...sourceTable(localSources));
    out.push("");
    out.push("— means this modeled adapter did not discover that source path.");
    out.push(
      "DIFF counts loadable state or represented-content differences; excluded-only rows do not count.",
    );
    out.push("");
  }

  const evidence = evidenceLines(localSources);
  if (evidence.length > 0) {
    out.push("WHY THEY DIFFER");
    out.push(...evidence);
    out.push("");
  }

  if (unknownSources.length > 0) {
    out.push("UNKNOWN EXTERNAL STATE");
    for (const source of unknownSources) {
      for (const agent of AGENT_NAMES) {
        for (const entry of source.agents[agent]) {
          out.push(`- ${agent}: ${source.path} — ${entry.matchReason}`);
        }
      }
    }
    out.push("");
  }

  const notes = inspectionNotes(comparison);
  if (notes.length > 0) {
    out.push("INSPECTION NOTES");
    out.push(...notes);
    out.push("");
  }

  out.push(
    "Static comparison of documented local discovery. It does not prove that a live agent loaded or followed instructions.",
  );
  return out.join("\n");
}
