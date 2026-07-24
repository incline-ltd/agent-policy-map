import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(import.meta.url), "../..");
const temp = mkdtempSync(path.join(tmpdir(), "agent-policy-map-pack-"));
const packDir = path.join(temp, "pack");
const consumerDir = path.join(temp, "consumer");
const fixtureDir = path.join(temp, "fixture");

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  mkdirSync(path.join(fixtureDir, "src"), { recursive: true });

  run("npm", ["pack", "--silent", "--pack-destination", packDir], root);
  const tarballName = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  assert(tarballName, "npm pack did not produce a tarball");
  const tarball = path.join(packDir, tarballName);

  writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ name: "agent-policy-map-pack-smoke", private: true }, null, 2) + "\n",
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    consumerDir,
  );

  const bin = path.join(
    consumerDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agent-policy-map.cmd" : "agent-policy-map",
  );
  const help = run(bin, ["--help"], consumerDir);
  assert(help.includes("Usage:"), "installed executable did not print CLI usage");

  writeFileSync(path.join(fixtureDir, "AGENTS.md"), "# Public fixture\n\nUse npm for installs.\n");
  writeFileSync(path.join(fixtureDir, "src", "app.ts"), "export {};\n");
  const output = run(
    bin,
    [
      "inspect",
      path.join(fixtureDir, "src", "app.ts"),
      "--agent",
      "codex",
      "--cwd",
      fixtureDir,
      "--root",
      fixtureDir,
      "--json",
    ],
    consumerDir,
  );
  const map = JSON.parse(output);
  assert(map.version === "1", "installed CLI returned the wrong PolicyMap version");
  assert(
    map.sources.some((source) => source.path === "./AGENTS.md" && source.state === "active"),
    "installed CLI did not discover the fixture AGENTS.md",
  );

  const comparisonOutput = run(
    bin,
    [
      "compare",
      path.join(fixtureDir, "src", "app.ts"),
      "--cwd",
      fixtureDir,
      "--root",
      fixtureDir,
      "--json",
    ],
    consumerDir,
  );
  const comparison = JSON.parse(comparisonOutput);
  assert(comparison.command === "compare", "installed CLI returned the wrong comparison command");
  assert(
    comparison.summary.meaningfulDifferences === 1,
    "installed CLI did not report the cross-agent AGENTS.md difference",
  );

  const libraryUrl = pathToFileURL(
    path.join(consumerDir, "node_modules", "agent-policy-map", "dist", "index.js"),
  ).href;
  const library = await import(libraryUrl);
  const libraryMap = library.inspect({
    agent: "codex",
    target: path.join(fixtureDir, "src", "app.ts"),
    cwd: fixtureDir,
    root: fixtureDir,
  });
  assert(libraryMap.version === "1", "installed library export did not return a PolicyMap");
  const libraryComparison = library.compare({
    target: path.join(fixtureDir, "src", "app.ts"),
    cwd: fixtureDir,
    root: fixtureDir,
    env: {},
  });
  assert(
    libraryComparison.command === "compare",
    "installed library export did not return a PolicyComparison",
  );

  process.stdout.write("Packed install smoke passed.\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
