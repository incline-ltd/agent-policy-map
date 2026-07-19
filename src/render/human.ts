import type { DiagnosticLevel, PolicyMap, PolicySource, SourceState } from "../types.js";

const STATE_ORDER: SourceState[] = [
  "active",
  "conditional",
  "manual",
  "excluded",
  "unknown-external",
];

const STATE_HEADING: Record<SourceState, string> = {
  active: "ACTIVE",
  conditional: "CONDITIONAL",
  manual: "MANUAL",
  excluded: "EXCLUDED",
  "unknown-external": "UNKNOWN-EXTERNAL",
};

const LEVEL_LABEL: Record<DiagnosticLevel, string> = {
  error: "error",
  warning: "warn",
  info: "info",
};

function formatBytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

function sourceMeta(s: PolicySource): string {
  const parts: string[] = [];
  if (s.bytes !== undefined) parts.push(formatBytes(s.bytes));
  if (s.lines !== undefined) parts.push(`${s.lines} lines`);
  if (s.contentHash) parts.push(`sha256 ${s.contentHash}`);
  return parts.join(" · ");
}

function sortSources(list: PolicySource[]): PolicySource[] {
  return [...list].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/** Render a PolicyMap as grouped, human-readable text. */
export function renderHuman(map: PolicyMap, contents?: Map<string, string>): string {
  const out: string[] = [];
  out.push(`Agent:   ${map.agent} (${map.surface})`);
  out.push(`Target:  ${map.target}`);
  out.push(`Launch cwd: ${map.cwd}`);
  out.push("");

  const byState = new Map<SourceState, PolicySource[]>();
  for (const s of map.sources) {
    const list = byState.get(s.state) ?? [];
    list.push(s);
    byState.set(s.state, list);
  }

  for (const state of STATE_ORDER) {
    const list = byState.get(state);
    if (!list || list.length === 0) continue;
    out.push(STATE_HEADING[state]);
    for (const s of sortSources(list)) {
      const num = s.order !== undefined ? `${s.order}. ` : "- ";
      out.push(`${num}${s.path}  [${s.kind}]`);
      out.push(`   reason: ${s.matchReason}`);
      const meta = sourceMeta(s);
      if (meta) out.push(`   ${meta}`);
      out.push(`   id: ${s.id}`);
      if (contents && contents.has(s.path)) {
        out.push("   content (redacted):");
        for (const line of contents.get(s.path)!.split("\n")) {
          out.push(`   | ${line}`);
        }
      }
    }
    out.push("");
  }

  if (map.diagnostics.length > 0) {
    out.push("DIAGNOSTICS");
    for (const d of map.diagnostics) {
      out.push(`- [${LEVEL_LABEL[d.level]}] ${d.code}: ${d.message}`);
      if (d.paths && d.paths.length > 0) out.push(`    paths: ${d.paths.join(", ")}`);
      if (d.evidence && d.evidence.length > 0) {
        for (const e of d.evidence) out.push(`    evidence: ${e}`);
      }
    }
    out.push("");
  }

  if (map.assumptions.length > 0) {
    out.push("ASSUMPTIONS");
    for (const a of map.assumptions) out.push(`- ${a}`);
    out.push("");
  }

  const c = map.context;
  out.push("CONTEXT ESTIMATE");
  out.push(
    `- loadable: ${formatBytes(c.bytes)}, ${c.lines} lines, ~${c.approxTokens} tokens (estimate)`,
  );
  out.push(
    `- active: ${formatBytes(c.activeBytes)} · conditional: ${formatBytes(
      c.conditionalBytes,
    )} · manual: ${formatBytes(c.manualBytes)}`,
  );
  if (c.omittedByCapBytes > 0) {
    out.push(`- omitted by official cap: ${formatBytes(c.omittedByCapBytes)}`);
  }
  out.push(`- note: ${c.note}`);

  return out.join("\n");
}

/** Summary counts used by the `discover` command header. */
export function countByState(sources: PolicySource[]): Record<SourceState, number> {
  const counts: Record<SourceState, number> = {
    active: 0,
    conditional: 0,
    manual: 0,
    excluded: 0,
    "unknown-external": 0,
  };
  for (const s of sources) counts[s.state] += 1;
  return counts;
}
