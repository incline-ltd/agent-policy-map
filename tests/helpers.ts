import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "../src/core/inspect.js";
import type { BuildContextInput } from "../src/core/context.js";
import type { PolicyMap, PolicySource, SourceState } from "../src/types.js";

export const FIXTURES = path.resolve(fileURLToPath(import.meta.url), "../../fixtures");

export function fix(...parts: string[]): string {
  return path.join(FIXTURES, ...parts);
}

/**
 * Run an inspection with an isolated, empty environment by default so tests
 * never read a contributor's real HOME/CODEX_HOME/etc.
 */
export function run(input: Omit<BuildContextInput, "env"> & { env?: NodeJS.ProcessEnv }): PolicyMap {
  return inspect({ ...input, env: input.env ?? {} });
}

export function byState(map: PolicyMap, state: SourceState): PolicySource[] {
  return map.sources.filter((s) => s.state === state);
}

export function paths(sources: PolicySource[]): string[] {
  return sources.map((s) => s.path);
}

export function findByPath(map: PolicyMap, p: string): PolicySource | undefined {
  return map.sources.find((s) => s.path === p);
}

export function hasDiagnostic(map: PolicyMap, code: string): boolean {
  return map.diagnostics.some((d) => d.code === code);
}

export function diagnostic(map: PolicyMap, code: string) {
  return map.diagnostics.find((d) => d.code === code);
}

/** Create a throwaway temp directory; returns its absolute path. */
export function mkTemp(prefix = "apm-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

export function rmTemp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
