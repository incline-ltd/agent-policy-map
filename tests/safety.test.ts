import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { run, fix, mkTemp, rmTemp, writeFile, hasDiagnostic } from "./helpers.js";
import { walkDir, WalkBudget } from "../src/fs/walk.js";
import { Budget, readTextBounded, isReadError } from "../src/fs/read.js";
import { buildContext } from "../src/core/context.js";
import { readTextForContext, symlinkDiagnostics } from "../src/adapters/shared.js";
import { CODEX_PROJECT_DOC_MAX_BYTES, MAX_FILE_BYTES } from "../src/constants.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmTemp(temps.pop()!);
});
function temp(): string {
  const d = mkTemp();
  temps.push(d);
  return d;
}

describe("safety", () => {
  it("handles a missing target without crashing and records the assumption", () => {
    const root = fix("claude/rules");
    const map = run({
      agent: "claude",
      target: fix("claude/rules/src/does-not-exist.ts"),
      cwd: root,
      root,
    });
    expect(map.assumptions.some((a) => /does not exist/i.test(a))).toBe(true);
    expect(map.version).toBe("1");
  });

  it("never reads an import that escapes the project root (path traversal)", () => {
    const dir = temp();
    const root = path.join(dir, "project");
    // A secret file OUTSIDE the project root.
    writeFile(path.join(dir, "secret.md"), "TOP SECRET should never be read");
    writeFile(
      path.join(root, "CLAUDE.md"),
      "# memory\n\n@../secret.md\n",
    );
    writeFile(path.join(root, "src", "app.ts"), "export const x = 1;\n");

    const map = run({
      agent: "claude",
      target: path.join(root, "src", "app.ts"),
      cwd: root,
      root,
    });

    expect(hasDiagnostic(map, "external-import")).toBe(true);
    // The external file is represented as unknown-external and never read.
    const ext = map.sources.find((s) => s.matchReason.includes("outside the project root"));
    expect(ext?.state).toBe("unknown-external");
    expect(ext?.contentHash).toBeUndefined();
    expect(ext?.bytes).toBeUndefined();
  });

  it("does not read a direct instruction-file symlink that escapes the project root", () => {
    const dir = temp();
    const root = path.join(dir, "project");
    writeFile(path.join(dir, "outside.md"), "outside project instructions\n");
    writeFile(path.join(root, "src", "app.ts"), "export const x = 1;\n");
    fs.symlinkSync(path.join(dir, "outside.md"), path.join(root, "AGENTS.md"));

    const map = run({
      agent: "codex",
      target: path.join(root, "src", "app.ts"),
      cwd: root,
      root,
    });

    expect(map.sources.some((s) => s.path === "./AGENTS.md")).toBe(false);
    expect(hasDiagnostic(map, "symlink-escape")).toBe(true);
  });

  it("keeps project symlinks project-contained even when user scope is enabled", () => {
    const home = temp();
    const root = path.join(home, "project");
    writeFile(path.join(home, "outside.md"), "outside project instructions\n");
    writeFile(path.join(root, "src", "app.ts"), "export const x = 1;\n");
    fs.symlinkSync(path.join(home, "outside.md"), path.join(root, "AGENTS.md"));

    const map = run({
      agent: "codex",
      target: path.join(root, "src", "app.ts"),
      cwd: root,
      root,
      includeUser: true,
      env: { HOME: home },
    });

    expect(map.sources.some((s) => s.path === "./AGENTS.md")).toBe(false);
    expect(hasDiagnostic(map, "symlink-escape")).toBe(true);
  });

  it("allows a direct instruction-file symlink whose target stays inside the project", () => {
    const root = temp();
    writeFile(path.join(root, "instructions", "root.md"), "inside project instructions\n");
    writeFile(path.join(root, "src", "app.ts"), "export const x = 1;\n");
    fs.symlinkSync(path.join(root, "instructions", "root.md"), path.join(root, "AGENTS.md"));

    const map = run({
      agent: "codex",
      target: path.join(root, "src", "app.ts"),
      cwd: root,
      root,
    });

    expect(map.sources.find((s) => s.path === "./AGENTS.md")?.state).toBe("active");
  });

  it("allows configured user roots only with opt-in and rejects arbitrary external files", () => {
    const dir = temp();
    const root = path.join(dir, "project");
    const custom = path.join(dir, "copilot-custom");
    const arbitrary = path.join(dir, "arbitrary.md");
    writeFile(path.join(root, "src", "app.ts"), "export const x = 1;\n");
    writeFile(path.join(custom, "team.instructions.md"), "custom instructions\n");
    writeFile(arbitrary, "not an allowed user location\n");

    const { ctx: optedIn } = buildContext({
      agent: "copilot",
      target: path.join(root, "src", "app.ts"),
      cwd: root,
      root,
      includeUser: true,
      env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: custom },
    });
    const allowed = readTextForContext(optedIn, path.join(custom, "team.instructions.md"));
    const rejected = readTextForContext(optedIn, arbitrary);

    expect(isReadError(allowed)).toBe(false);
    expect(isReadError(rejected) && rejected.code).toBe("EOUTSIDE");

    const { ctx: notOptedIn } = buildContext({
      agent: "copilot",
      target: path.join(root, "src", "app.ts"),
      cwd: root,
      root,
      env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: custom },
    });
    const withoutOptIn = readTextForContext(
      notOptedIn,
      path.join(custom, "team.instructions.md"),
    );
    expect(isReadError(withoutOptIn) && withoutOptIn.code).toBe("EOUTSIDE");
  });

  it("does not follow directory symlink loops and reports them", () => {
    const dir = temp();
    const rulesDir = path.join(dir, ".cursor", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    writeFile(path.join(rulesDir, "a.mdc"), "---\nalwaysApply: true\n---\nok\n");
    // Create a symlink loop: rules/loop -> rules
    fs.symlinkSync(rulesDir, path.join(rulesDir, "loop"), "dir");
    writeFile(path.join(dir, "src", "app.ts"), "export const x = 1;\n");

    const start = Date.now();
    const map = run({
      agent: "cursor",
      target: path.join(dir, "src", "app.ts"),
      cwd: dir,
      root: dir,
    });
    expect(Date.now() - start).toBeLessThan(3000); // did not hang
    expect(hasDiagnostic(map, "symlink-skipped")).toBe(true);
    // The real rule is still discovered.
    expect(map.sources.some((s) => s.path.endsWith("a.mdc"))).toBe(true);
  });

  it("walkDir is loop-safe on a self-referential symlink", () => {
    const dir = temp();
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.symlinkSync(dir, path.join(dir, "sub", "back"), "dir");
    writeFile(path.join(dir, "sub", "file.md"), "x");
    const res = walkDir(dir, { root: dir, filter: (a) => a.endsWith(".md") });
    expect(res.files.some((f) => f.abs.endsWith("file.md"))).toBe(true);
    expect(res.skippedDirSymlinks.length).toBeGreaterThan(0);
  });

  it("bounds returned files and surfaces truncation as a diagnostic", () => {
    const root = temp();
    for (let i = 0; i < 5; i++) writeFile(path.join(root, `file-${i}.md`), "x");

    const res = walkDir(root, {
      root,
      maxFiles: 2,
      maxEntries: 20,
      filter: (abs) => abs.endsWith(".md"),
    });
    const { ctx } = buildContext({
      agent: "claude",
      target: path.join(root, "target.ts"),
      cwd: root,
      root,
      env: {},
    });

    expect(res.files).toHaveLength(2);
    expect(res.truncated).toBe(true);
    expect(res.truncationReasons.some((reason) => /returned-file limit/.test(reason))).toBe(true);
    expect(symlinkDiagnostics(ctx, res).some((d) => d.code === "walk-truncated")).toBe(true);
  });

  it("bounds directory-entry traversal", () => {
    const root = temp();
    for (let i = 0; i < 10; i++) writeFile(path.join(root, `entry-${i}.md`), "x");

    const res = walkDir(root, { root, maxEntries: 3, maxFiles: 10 });

    expect(res.visitedEntries).toBe(3);
    expect(res.files.length).toBeLessThanOrEqual(3);
    expect(res.truncationReasons.some((reason) => /directory-entry limit/.test(reason))).toBe(true);
  });

  it("bounds opened directories", () => {
    const root = temp();
    for (let i = 0; i < 5; i++) writeFile(path.join(root, `dir-${i}`, "file.md"), "x");

    const res = walkDir(root, {
      root,
      maxDirectories: 2,
      maxEntries: 20,
      maxFiles: 20,
    });

    expect(res.visitedDirectories).toBe(2);
    expect(res.truncationReasons.some((reason) => /directory limit/.test(reason))).toBe(true);
  });

  it("shares traversal limits across multiple directory walks", () => {
    const root = temp();
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    writeFile(path.join(first, "a.md"), "a");
    writeFile(path.join(first, "b.md"), "b");
    writeFile(path.join(second, "c.md"), "c");
    const budget = new WalkBudget(2, 10, 20);

    const firstResult = walkDir(first, { root, budget });
    const secondResult = walkDir(second, { root, budget });

    expect(firstResult.files).toHaveLength(2);
    expect(secondResult.files).toHaveLength(0);
    expect(
      secondResult.truncationReasons.some((reason) =>
        /inspection-wide returned-file/.test(reason),
      ),
    ).toBe(true);
  });

  it("truncates a file larger than the per-file cap", () => {
    const dir = temp();
    const big = path.join(dir, "big.md");
    writeFile(big, "x".repeat(1000));
    const read = readTextBounded(big, new Budget(), 100);
    expect(isReadError(read)).toBe(false);
    if (!isReadError(read)) {
      expect(read.truncated).toBe(true);
      expect(read.content.length).toBe(100);
      expect(read.bytes).toBe(100);
      expect(read.totalBytes).toBe(1000);
      expect(read.contentHash).toBeUndefined();
    }
  });

  it("reports partial inspection without counting or hashing unread bytes", () => {
    const root = temp();
    const totalBytes = MAX_FILE_BYTES + 17;
    writeFile(path.join(root, "CLAUDE.md"), "x".repeat(totalBytes));
    writeFile(path.join(root, "src", "app.ts"), "export const x = 1;\n");

    const map = run({
      agent: "claude",
      target: path.join(root, "src", "app.ts"),
      cwd: root,
      root,
    });
    const source = map.sources.find((candidate) => candidate.path === "./CLAUDE.md");
    const diagnostic = map.diagnostics.find((candidate) => candidate.code === "file-truncated");

    expect(source?.bytes).toBe(MAX_FILE_BYTES);
    expect(source?.contentHash).toBeUndefined();
    expect(map.context.bytes).toBe(MAX_FILE_BYTES);
    expect(diagnostic?.paths).toEqual(["./CLAUDE.md"]);
    expect(diagnostic?.message).toContain(`${MAX_FILE_BYTES} of ${totalBytes} bytes`);
  });

  it("stops reading when the global budget is exhausted", () => {
    const root = fix("claude/imports");
    const map = run({
      agent: "claude",
      target: fix("claude/imports/src/app.ts"),
      cwd: root,
      root,
      budget: new Budget(2, 100),
    });
    expect(hasDiagnostic(map, "budget-exceeded")).toBe(true);
  });

  it("reports content omitted by the Codex 32 KiB project-doc cap", () => {
    const dir = temp();
    writeFile(path.join(dir, "AGENTS.md"), "a".repeat(40 * 1024));
    writeFile(path.join(dir, "src", "app.ts"), "export const x = 1;\n");
    const map = run({ agent: "codex", target: path.join(dir, "src", "app.ts"), cwd: dir, root: dir });
    expect(map.context.omittedByCapBytes).toBeGreaterThan(0);
    expect(hasDiagnostic(map, "cap-omission")).toBe(true);
  });

  it("keeps hard-read truncation explicit when applying the Codex project-doc cap", () => {
    const dir = temp();
    const totalBytes = MAX_FILE_BYTES + 17;
    writeFile(path.join(dir, "AGENTS.md"), "a".repeat(totalBytes));
    writeFile(path.join(dir, "src", "app.ts"), "export const x = 1;\n");

    const map = run({
      agent: "codex",
      target: path.join(dir, "src", "app.ts"),
      cwd: dir,
      root: dir,
    });
    const source = map.sources.find((candidate) => candidate.path === "./AGENTS.md");

    expect(source?.bytes).toBe(CODEX_PROJECT_DOC_MAX_BYTES);
    expect(source?.contentHash).toBeUndefined();
    expect(map.context.omittedByCapBytes).toBe(totalBytes - CODEX_PROJECT_DOC_MAX_BYTES);
    expect(hasDiagnostic(map, "file-truncated")).toBe(true);
  });
});
