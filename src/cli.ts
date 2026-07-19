#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import type { PolicyMap, PolicySource } from "./types.js";
import type { InspectContext } from "./adapters/types.js";
import { inspect, inspectWithContext } from "./core/inspect.js";
import { renderHuman } from "./render/human.js";
import { renderJson } from "./render/json.js";
import { AGENT_NAMES, isAgentName } from "./adapters/registry.js";
import { redact } from "./security/redact.js";
import { readTextForContext } from "./adapters/shared.js";
import { isReadError } from "./fs/read.js";

const USAGE = `agent-policy-map — explain which coding-agent instructions apply to a file, and why.

Usage:
  agent-policy-map inspect <target> --agent <codex|claude|cursor|copilot> [options]
  agent-policy-map discover --agent <agent> [options]
  agent-policy-map explain <source-id> --agent <agent> --target <file> [options]

Options:
  --agent <name>     One of: ${AGENT_NAMES.join(", ")}
  --cwd <path>       Simulated launch working directory (Codex discovery depends on it)
  --root <path>      Containment root (defaults to nearest .git ancestor, else cwd)
  --include-user     Also inspect documented user/home and managed locations
  --show-content     Include redacted local content for inspect/discover
  --json             Machine-readable JSON output
  -h, --help         Show this help

This tool is local, read-only, and deterministic. It never executes or follows
discovered instructions, and never performs network requests.`;

type Cli = {
  values: {
    agent?: string;
    cwd?: string;
    root?: string;
    target?: string;
    json?: boolean;
    "include-user"?: boolean;
    "show-content"?: boolean;
    help?: boolean;
  };
  positionals: string[];
};

function parse(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      cwd: { type: "string" },
      root: { type: "string" },
      target: { type: "string" },
      json: { type: "boolean", default: false },
      "include-user": { type: "boolean", default: false },
      "show-content": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return { values, positionals } as Cli;
}

function fail(message: string): never {
  process.stderr.write(`error: ${redact(message)}\n\n`);
  process.stderr.write("Run `agent-policy-map --help` for usage.\n");
  process.exit(1);
}

function requireAgent(agent: string | undefined): "codex" | "claude" | "cursor" | "copilot" {
  if (!agent) fail("--agent is required");
  if (!isAgentName(agent!)) fail(`unknown agent "${agent}". Use one of: ${AGENT_NAMES.join(", ")}`);
  return agent as "codex" | "claude" | "cursor" | "copilot";
}

/** Resolve a display path (`./x`, `~/x`, or absolute) back to an absolute path. */
function displayToAbs(root: string, home: string | undefined, display: string): string | null {
  if (display.startsWith("(")) return null;
  if (display.startsWith("~/")) return home ? path.join(home, display.slice(2)) : null;
  if (display === "~") return home ?? null;
  if (path.isAbsolute(display)) return display;
  return path.resolve(root, display.replace(/^\.\//, ""));
}

const LOADABLE = new Set(["active", "conditional", "manual"]);

/** Read and redact content for loadable sources (only when --show-content). */
function collectContents(
  sources: PolicySource[],
  ctx: InspectContext,
): Map<string, string> {
  const contents = new Map<string, string>();
  for (const s of sources) {
    if (!LOADABLE.has(s.state) || !s.contentHash) continue;
    const abs = displayToAbs(ctx.root, ctx.env.home, s.path);
    if (!abs) continue;
    const read = readTextForContext(ctx, abs, s.bytes);
    if (isReadError(read)) continue;
    contents.set(s.path, redact(read.content));
  }
  return contents;
}

function emit(map: PolicyMap, cli: Cli, ctx: InspectContext): void {
  let contents: Map<string, string> | undefined;
  if (cli.values["show-content"]) {
    contents = collectContents(map.sources, ctx);
  }
  if (cli.values.json) {
    const extra =
      contents && contents.size > 0
        ? { contents: Object.fromEntries(contents) }
        : undefined;
    process.stdout.write(renderJson(map, extra) + "\n");
  } else {
    process.stdout.write(renderHuman(map, contents) + "\n");
  }
}

function commonInput(cli: Cli, agent: ReturnType<typeof requireAgent>, target: string) {
  return {
    agent,
    target,
    includeUser: cli.values["include-user"] ?? false,
    ...(cli.values.cwd !== undefined ? { cwd: cli.values.cwd } : {}),
    ...(cli.values.root !== undefined ? { root: cli.values.root } : {}),
  };
}

function runInspect(cli: Cli): void {
  const target = cli.positionals[1];
  if (!target) fail("inspect requires a <target> file path");
  const agent = requireAgent(cli.values.agent);
  const { map, ctx } = inspectWithContext({
    ...commonInput(cli, agent, target!),
    mode: "inspect",
  });
  emit(map, cli, ctx);
}

function runDiscover(cli: Cli): void {
  const agent = requireAgent(cli.values.agent);
  const cwd = cli.values.cwd ?? process.cwd();
  const { map, ctx } = inspectWithContext({
    agent,
    target: cwd,
    cwd,
    includeUser: cli.values["include-user"] ?? false,
    ...(cli.values.root !== undefined ? { root: cli.values.root } : {}),
    mode: "discover",
  });
  map.target = "(discover: all files under cwd)";
  emit(map, cli, ctx);
}

function runExplain(cli: Cli): void {
  if (cli.values["show-content"]) {
    fail("--show-content is supported only for inspect and discover");
  }
  const id = cli.positionals[1];
  if (!id) fail("explain requires a <source-id>");
  const agent = requireAgent(cli.values.agent);
  const target = cli.values.target;
  if (!target) fail("explain requires --target <file> (plus --agent, and --cwd/--root to match inspect)");
  const map = inspect({ ...commonInput(cli, agent, target!), mode: "inspect" });
  const source = map.sources.find((s) => s.id === id);
  if (!source) {
    fail(
      `no source with id "${id}" for this context. Run \`agent-policy-map inspect ${target} --agent ${agent}\` to list ids.`,
    );
  }
  const related = map.diagnostics.filter((d) => d.paths?.includes(source!.path));

  if (cli.values.json) {
    process.stdout.write(
      JSON.stringify(
        { version: "1", agent: map.agent, surface: map.surface, source, relatedDiagnostics: related },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const out: string[] = [];
  out.push(`Source: ${source!.id}`);
  out.push(`Path:   ${source!.path}`);
  out.push(`Kind:   ${source!.kind}`);
  out.push(`State:  ${source!.state}`);
  if (source!.order !== undefined) out.push(`Order:  ${source!.order}`);
  out.push(`Reason: ${source!.matchReason}`);
  if (source!.bytes !== undefined) out.push(`Size:   ${source!.bytes} bytes, ${source!.lines} lines`);
  if (source!.contentHash) out.push(`Hash:   sha256 ${source!.contentHash}`);
  if (related.length > 0) {
    out.push("Related diagnostics:");
    for (const d of related) out.push(`- [${d.level}] ${d.code}: ${d.message}`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  let cli: Cli;
  try {
    cli = parse(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid command-line options");
  }
  const command = cli.positionals[0];

  if (cli.values.help || !command) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  switch (command) {
    case "inspect":
      runInspect(cli);
      break;
    case "discover":
      runDiscover(cli);
      break;
    case "explain":
      runExplain(cli);
      break;
    default:
      fail(`unknown command "${command}". Expected inspect, discover, or explain.`);
  }
}

main();
