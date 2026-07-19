import { describe, it, expect } from "vitest";
import { run, fix, byState, paths, findByPath } from "./helpers.js";

describe("cursor adapter", () => {
  const modesRoot = fix("cursor/modes");

  function modes() {
    return run({
      agent: "cursor",
      target: fix("cursor/modes/src/app.ts"),
      cwd: modesRoot,
      root: modesRoot,
    });
  }

  it("resolves the four activation modes", () => {
    const map = modes();
    expect(map.surface).toBe("Cursor IDE");
    expect(findByPath(map, "./.cursor/rules/always.mdc")?.state).toBe("active");
    expect(findByPath(map, "./.cursor/rules/auto.mdc")?.state).toBe("active"); // matches **/*.ts
    expect(findByPath(map, "./.cursor/rules/agent.mdc")?.state).toBe("conditional");
    expect(findByPath(map, "./.cursor/rules/manual.mdc")?.state).toBe("manual");
    expect(findByPath(map, "./.cursor/rules/backend/typescript.mdc")?.state).toBe("active");
  });

  it("excludes plain .md files under .cursor/rules", () => {
    const map = modes();
    const notes = findByPath(map, "./.cursor/rules/notes.md");
    expect(notes?.state).toBe("excluded");
    expect(notes?.kind).toBe("cursor-plain-md");
  });

  it("excludes an auto-attached rule whose globs do not match the target", () => {
    const root = fix("cursor/modes");
    const map = run({
      agent: "cursor",
      target: fix("cursor/modes/src/app.py"), // .py: does not match **/*.ts
      cwd: root,
      root,
    });
    expect(findByPath(map, "./.cursor/rules/auto.mdc")?.state).toBe("excluded");
  });

  it("resolves @filename references alongside active rules", () => {
    const map = modes();
    const ref = findByPath(map, "./helper.md");
    expect(ref?.kind).toBe("cursor-reference");
    expect(ref?.state).toBe("active");
  });

  it("marks user/team rules as unknown-external", () => {
    const map = modes();
    expect(byState(map, "unknown-external").some((s) => s.kind === "cursor-external-rules")).toBe(true);
  });

  it("does not assert an order between active .mdc rules", () => {
    const map = modes();
    for (const s of map.sources.filter((s) => s.kind === "cursor-mdc")) {
      expect(s.order).toBeUndefined();
    }
    expect(map.assumptions.some((a) => /does not define an order/i.test(a))).toBe(true);
  });

  it("discovers root and nested AGENTS.md", () => {
    const root = fix("cursor/nested");
    const map = run({
      agent: "cursor",
      target: fix("cursor/nested/packages/lib/src/index.ts"),
      cwd: root,
      root,
    });
    const agentDocs = paths(map.sources.filter((s) => s.kind === "cursor-agents-md"));
    expect(agentDocs).toContain("./AGENTS.md");
    expect(agentDocs).toContain("./packages/lib/AGENTS.md");
  });

  it("loads nested .cursor/rules only for targets in that subtree", () => {
    const root = fix("cursor/nested");
    const inLibrary = run({
      agent: "cursor",
      target: fix("cursor/nested/packages/lib/src/index.ts"),
      cwd: root,
      root,
    });
    expect(findByPath(inLibrary, "./.cursor/rules/root.mdc")?.state).toBe("active");
    expect(
      findByPath(inLibrary, "./packages/lib/.cursor/rules/local.mdc")?.state,
    ).toBe("active");

    const inApp = run({
      agent: "cursor",
      target: fix("cursor/nested/packages/app/src/index.ts"),
      cwd: root,
      root,
    });
    expect(findByPath(inApp, "./.cursor/rules/root.mdc")?.state).toBe("active");
    expect(findByPath(inApp, "./packages/lib/.cursor/rules/local.mdc")).toBeUndefined();
  });
});
