// Standalone CLI smoke test against the built dist. Run after `npm run build`.
// Exits non-zero on the first failed assertion.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(import.meta.url), "../..");
const cli = path.join(root, "dist", "cli.js");
const fix = (...p) => path.join(root, "fixtures", ...p);

if (!existsSync(cli)) {
  console.error("dist/cli.js not found. Run `npm run build` first.");
  process.exit(1);
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok  - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}: ${err.message}`);
  }
}

function runCli(args) {
  return execFileSync("node", [cli, ...args], { encoding: "utf8" });
}

check("help exits 0 with usage", () => {
  const out = runCli([]);
  if (!/Usage:/.test(out)) throw new Error("missing usage");
});

check("codex inspect JSON is a versioned PolicyMap", () => {
  const out = runCli([
    "inspect",
    fix("codex/nested/apps/api/src/auth.ts"),
    "--agent",
    "codex",
    "--cwd",
    fix("codex/nested/apps/api"),
    "--root",
    fix("codex/nested"),
    "--json",
  ]);
  const map = JSON.parse(out);
  if (map.version !== "1") throw new Error("bad version");
  if (map.agent !== "codex") throw new Error("bad agent");
  if (!map.sources.some((s) => s.state === "active")) throw new Error("no active source");
});

check("claude inspect reports import diagnostics", () => {
  const out = runCli([
    "inspect",
    fix("claude/imports/src/app.ts"),
    "--agent",
    "claude",
    "--cwd",
    fix("claude/imports"),
    "--root",
    fix("claude/imports"),
    "--json",
  ]);
  const map = JSON.parse(out);
  const codes = new Set(map.diagnostics.map((d) => d.code));
  for (const want of ["import-cycle", "import-over-depth", "missing-import"]) {
    if (!codes.has(want)) throw new Error(`missing diagnostic ${want}`);
  }
});

check("copilot surface is labelled and precedence is undefined", () => {
  const out = runCli([
    "inspect",
    fix("copilot/basic/src/app.ts"),
    "--agent",
    "copilot",
    "--cwd",
    fix("copilot/basic"),
    "--root",
    fix("copilot/basic"),
    "--json",
  ]);
  const map = JSON.parse(out);
  if (map.surface !== "GitHub Copilot CLI") throw new Error("bad surface");
  if (!map.diagnostics.some((d) => d.code === "no-precedence-defined")) {
    throw new Error("expected no-precedence-defined");
  }
});

check("cursor human output is grouped by state", () => {
  const out = runCli([
    "inspect",
    fix("cursor/modes/src/app.ts"),
    "--agent",
    "cursor",
    "--cwd",
    fix("cursor/modes"),
    "--root",
    fix("cursor/modes"),
  ]);
  for (const heading of ["ACTIVE", "CONDITIONAL", "MANUAL", "EXCLUDED", "UNKNOWN-EXTERNAL"]) {
    if (!out.includes(heading)) throw new Error(`missing heading ${heading}`);
  }
});

check("compare reports meaningful differences across all four surfaces", () => {
  const out = runCli([
    "compare",
    fix("codex/nested/apps/api/src/auth.ts"),
    "--cwd",
    fix("codex/nested/apps/api"),
    "--root",
    fix("codex/nested"),
    "--json",
  ]);
  const comparison = JSON.parse(out);
  if (comparison.command !== "compare") throw new Error("bad command");
  if (comparison.summary.meaningfulDifferences !== 2) {
    throw new Error("unexpected meaningful-difference count");
  }
  const surfaces = Object.values(comparison.agents).map((agent) => agent.surface);
  for (const want of ["Codex CLI", "Claude Code", "Cursor IDE", "GitHub Copilot CLI"]) {
    if (!surfaces.includes(want)) throw new Error(`missing surface ${want}`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
