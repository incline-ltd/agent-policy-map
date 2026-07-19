import type { Diagnostic, PolicyMap } from "../types.js";
import { ADAPTERS } from "../adapters/registry.js";
import { displayFor } from "../adapters/shared.js";
import { assignIds } from "./ids.js";
import { runCrossDiagnostics } from "../diagnostics/index.js";
import { estimateContext } from "../context/estimate.js";
import { buildContext, type BuildContextInput } from "./context.js";
import { redact } from "../security/redact.js";
import type { InspectContext } from "../adapters/types.js";

export type InspectResult = PolicyMap;
export type InspectWithContextResult = { map: PolicyMap; ctx: InspectContext };

/**
 * Full inspection pipeline: resolve context, run the adapter and shared
 * diagnostics, estimate context, redact public strings, assign stable ids,
 * and assemble the versioned PolicyMap.
 */
export function inspect(input: BuildContextInput): PolicyMap {
  return inspectWithContext(input).map;
}

/** Run an inspection and retain its exact resolved context for trusted callers. */
export function inspectWithContext(input: BuildContextInput): InspectWithContextResult {
  const { ctx, assumptions } = buildContext(input);
  const adapter = ADAPTERS[ctx.agent];
  const result = adapter.inspect(ctx);

  const diagnostics: Diagnostic[] = [...ctx.readDiagnostics, ...result.diagnostics];
  diagnostics.push(...runCrossDiagnostics(ctx, result.sources));

  if (result.omittedByCapBytes > 0) {
    diagnostics.push({
      code: "cap-omission",
      level: "info",
      message: `${result.omittedByCapBytes} bytes of project-doc content exceed an official byte cap and would not be loaded`,
    });
  }

  if (ctx.budget.isExceeded) {
    for (const note of ctx.budget.notes) {
      diagnostics.push({
        code: "budget-exceeded",
        level: "warning",
        message: `Inspection bound hit: ${note}. Results may be incomplete.`,
      });
    }
  }

  const context = estimateContext(result.sources, result.omittedByCapBytes);
  const sources = result.sources.map((source) => ({
    ...source,
    path: redact(source.path),
    matchReason: redact(source.matchReason),
  }));
  const sanitizedDiagnostics = diagnostics.map(sanitizeDiagnostic);
  const sanitizedAssumptions = [...assumptions, ...result.assumptions].map(redact);

  // IDs include source paths, so assign them only after every public string has
  // passed through the central credential redactor.
  assignIds(ctx.agent, sources);

  return {
    ctx,
    map: {
      version: "1",
      agent: ctx.agent,
      surface: result.surface,
      target: redact(displayFor(ctx, ctx.targetAbs)),
      cwd: redact(displayFor(ctx, ctx.cwd)),
      assumptions: sanitizedAssumptions,
      sources,
      diagnostics: sortDiagnostics(sanitizedDiagnostics),
      context,
    },
  };
}

function sanitizeDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return {
    ...diagnostic,
    message: redact(diagnostic.message),
    ...(diagnostic.paths !== undefined
      ? { paths: diagnostic.paths.map(redact) }
      : {}),
    ...(diagnostic.evidence !== undefined
      ? { evidence: diagnostic.evidence.map(redact) }
      : {}),
  };
}

const LEVEL_RANK: Record<Diagnostic["level"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function sortDiagnostics(diags: Diagnostic[]): Diagnostic[] {
  return [...diags].sort((a, b) => {
    const l = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    if (l !== 0) return l;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}
