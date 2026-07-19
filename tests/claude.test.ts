import { describe, it, expect } from "vitest";
import { run, fix, byState, paths, findByPath, hasDiagnostic } from "./helpers.js";

describe("claude adapter", () => {
  const importsRoot = fix("claude/imports");

  it("resolves relative imports and ignores fenced/inline imports", () => {
    const map = run({
      agent: "claude",
      target: fix("claude/imports/src/app.ts"),
      cwd: importsRoot,
      root: importsRoot,
    });
    const importPaths = paths(map.sources.filter((s) => s.kind === "claude-import"));
    expect(importPaths).toContain("./docs/rel.md");
    // Fenced and inline code imports must not be followed.
    expect(importPaths).not.toContain("./docs/should-not-import.md");
    expect(importPaths).not.toContain("./docs/also-ignored.md");
  });

  it("follows imports up to 5 hops and reports over-depth", () => {
    const map = run({
      agent: "claude",
      target: fix("claude/imports/src/app.ts"),
      cwd: importsRoot,
      root: importsRoot,
    });
    const importPaths = paths(map.sources.filter((s) => s.kind === "claude-import"));
    expect(importPaths).toContain("./docs/chain5.md");
    expect(importPaths).not.toContain("./docs/chain6.md");
    expect(hasDiagnostic(map, "import-over-depth")).toBe(true);
  });

  it("detects import cycles and missing imports", () => {
    const map = run({
      agent: "claude",
      target: fix("claude/imports/src/app.ts"),
      cwd: importsRoot,
      root: importsRoot,
    });
    expect(hasDiagnostic(map, "import-cycle")).toBe(true);
    expect(hasDiagnostic(map, "missing-import")).toBe(true);
  });

  it("treats unconditional rules as active and non-matching path rules as excluded", () => {
    const root = fix("claude/rules");
    const map = run({
      agent: "claude",
      target: fix("claude/rules/src/app.ts"),
      cwd: root,
      root,
    });
    expect(findByPath(map, "./.claude/rules/global.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/rules/typescript.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/rules/backend/typescript.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/rules/python.md")?.state).toBe("excluded");
  });

  it("excludes memory matched by claudeMdExcludes", () => {
    const root = fix("claude/excludes");
    const map = run({
      agent: "claude",
      target: fix("claude/excludes/vendor/lib.ts"),
      cwd: root,
      root,
    });
    expect(findByPath(map, "./CLAUDE.md")?.state).toBe("active");
    const vendor = findByPath(map, "./vendor/CLAUDE.md");
    expect(vendor?.state).toBe("excluded");
    expect(vendor?.matchReason).toMatch(/claudeMdExcludes/);
    expect(findByPath(map, "./vendor/.claude/rules/ignored.md")?.state).toBe("excluded");
  });

  it("reports ambiguous same-scope CLAUDE.md and .claude/CLAUDE.md without inventing order", () => {
    const root = fix("claude/ambiguous");
    const map = run({
      agent: "claude",
      target: fix("claude/ambiguous/src/app.ts"),
      cwd: root,
      root,
    });
    expect(hasDiagnostic(map, "ambiguous-precedence")).toBe(true);
    // Both are present and active; neither is asserted to win.
    expect(findByPath(map, "./CLAUDE.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/CLAUDE.md")?.state).toBe("active");
    expect(findByPath(map, "./CLAUDE.md")?.order).toBeUndefined();
    expect(findByPath(map, "./.claude/CLAUDE.md")?.order).toBeUndefined();
  });

  it("loads user rules only with opt-in and reports project-rule priority", () => {
    const root = fix("claude/rules");
    const map = run({
      agent: "claude",
      target: fix("claude/rules/src/app.ts"),
      cwd: root,
      root,
      includeUser: true,
      env: { HOME: fix("home/user") },
    });
    const userRule = findByPath(map, "~/.claude/rules/typescript.md");
    expect(userRule?.state).toBe("active");
    expect(userRule?.matchReason).toMatch(/project rules take priority/i);
  });

  it("marks managed and session state as unknown-external by default", () => {
    const root = fix("claude/rules");
    const map = run({ agent: "claude", target: fix("claude/rules/src/app.ts"), cwd: root, root });
    const unknown = byState(map, "unknown-external");
    expect(unknown.some((s) => s.kind === "claude-managed")).toBe(true);
    expect(unknown.some((s) => s.kind === "claude-session")).toBe(true);
  });

  it("does not read imports that resolve outside the project root", () => {
    const map = run({
      agent: "claude",
      target: fix("claude/imports/src/app.ts"),
      cwd: importsRoot,
      root: importsRoot,
    });
    // No external import in this fixture, but the safety property is asserted in safety.test.ts.
    expect(map.diagnostics.every((d) => d.code !== "external-import")).toBe(true);
  });
});
