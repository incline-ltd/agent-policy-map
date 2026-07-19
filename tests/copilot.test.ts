import { describe, it, expect } from "vitest";
import { run, fix, byState, paths, findByPath, hasDiagnostic } from "./helpers.js";

describe("copilot cli adapter", () => {
  const root = fix("copilot/basic");

  function basic(target = fix("copilot/basic/src/app.ts")) {
    return run({ agent: "copilot", target, cwd: root, root });
  }

  it("labels the surface as GitHub Copilot CLI", () => {
    expect(basic().surface).toBe("GitHub Copilot CLI");
  });

  it("activates repo-wide instructions, matching applyTo, and agent files", () => {
    const map = basic();
    expect(findByPath(map, "./.github/copilot-instructions.md")?.state).toBe("active");
    expect(findByPath(map, "./.github/instructions/typescript.instructions.md")?.state).toBe("active");
    expect(findByPath(map, "./AGENTS.md")?.state).toBe("active");
    expect(findByPath(map, "./CLAUDE.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/CLAUDE.md")?.state).toBe("active");
    expect(findByPath(map, "./GEMINI.md")?.state).toBe("active");
  });

  it("checks standard instruction locations down to the target directory", () => {
    const map = basic();
    expect(findByPath(map, "./src/.github/copilot-instructions.md")?.state).toBe("active");
    expect(findByPath(map, "./src/.github/instructions/local.instructions.md")?.state).toBe(
      "active",
    );
    expect(findByPath(map, "./src/AGENTS.md")?.state).toBe("active");
  });

  it("excludes path instructions whose applyTo does not match", () => {
    const map = basic();
    expect(findByPath(map, "./.github/instructions/python.instructions.md")?.state).toBe("excluded");
  });

  it("flags and excludes a path instruction with no required applyTo", () => {
    const map = basic();
    const noApply = findByPath(map, "./.github/instructions/no-applyto.instructions.md");
    expect(noApply?.state).toBe("excluded");
    expect(hasDiagnostic(map, "frontmatter-invalid")).toBe(true);
  });

  it("resolves recursive repository-contained imports and reports cycles", () => {
    const map = basic();
    const imports = map.sources.filter((s) => s.kind === "copilot-import");
    expect(imports.map((s) => s.path)).toEqual([
      "./shared.md",
      "./details/more.md",
      "./agents-shared.md",
      "./claude-shared.md",
      "./dot-claude-shared.md",
    ]);
    expect(imports.every((s) => s.state === "active")).toBe(true);
    expect(hasDiagnostic(map, "import-cycle")).toBe(true);
  });

  it("does not expand references from GEMINI.md or modular instructions", () => {
    const map = basic();
    expect(findByPath(map, "./GEMINI.md")?.state).toBe("active");
    expect(findByPath(map, "./gemini-only.md")).toBeUndefined();
    expect(findByPath(map, "./modular-only.md")).toBeUndefined();
  });

  it("does not expand references from user-level copilot-instructions.md", () => {
    const userHome = fix("copilot/user-home");
    const map = run({
      agent: "copilot",
      target: fix("copilot/basic/src/app.ts"),
      cwd: root,
      root,
      includeUser: true,
      env: { COPILOT_HOME: userHome },
    });

    expect(findByPath(map, fix("copilot/user-home/copilot-instructions.md"))?.state).toBe(
      "active",
    );
    expect(findByPath(map, fix("copilot/user-home/user-main-only.md"))).toBeUndefined();
  });

  it("skips modular repository instructions in intermediate root-to-cwd directories", () => {
    const locationRoot = fix("copilot/locations");
    const map = run({
      agent: "copilot",
      target: fix("copilot/locations/apps/service/src/app.ts"),
      cwd: fix("copilot/locations/apps/service"),
      root: locationRoot,
    });

    expect(findByPath(map, "./.github/instructions/root.instructions.md")?.state).toBe("active");
    expect(
      findByPath(map, "./apps/service/.github/instructions/cwd.instructions.md")?.state,
    ).toBe("active");
    expect(
      findByPath(map, "./apps/service/src/.github/instructions/target.instructions.md")?.state,
    ).toBe("active");
    expect(
      findByPath(map, "./apps/.github/instructions/intermediate.instructions.md"),
    ).toBeUndefined();
    expect(findByPath(map, "./apps/.github/copilot-instructions.md")?.state).toBe("active");
  });

  it("asserts no universal precedence and does not assign order", () => {
    const map = basic();
    expect(hasDiagnostic(map, "no-precedence-defined")).toBe(true);
    for (const s of map.sources) expect(s.order).toBeUndefined();
    expect(map.assumptions.some((a) => /GitHub\.com.*NOT applied/i.test(a))).toBe(true);
  });

  it("marks session-disabled state as unknown-external", () => {
    const map = basic();
    expect(byState(map, "unknown-external").some((s) => s.kind === "copilot-session")).toBe(true);
  });

  it("uses only supported files and references from user and custom locations", () => {
    const env = {
      HOME: fix("home/user"),
      COPILOT_CUSTOM_INSTRUCTIONS_DIRS: fix("home/custom"),
    } as NodeJS.ProcessEnv;
    const withUser = run({
      agent: "copilot",
      target: fix("copilot/basic/src/app.ts"),
      cwd: root,
      root,
      includeUser: true,
      env,
    });
    const userKinds = withUser.sources.map((s) => s.kind);
    expect(userKinds).toContain("copilot-user-instructions");
    // team.instructions.md from the custom dir applies to **/*.ts
    expect(
      withUser.sources.some(
        (s) => s.kind === "copilot-custom-path-instructions" && s.state === "active",
      ),
    ).toBe(true);
    expect(
      withUser.sources.some(
        (s) => s.kind === "copilot-custom-agents-md" && s.state === "active",
      ),
    ).toBe(true);
    expect(findByPath(withUser, fix("home/custom/custom-agents-shared.md"))?.state).toBe("active");
    expect(findByPath(withUser, fix("home/custom/more.md"))).toBeUndefined();
    expect(findByPath(withUser, fix("home/custom/copilot-instructions.md"))).toBeUndefined();
    expect(findByPath(withUser, fix("home/custom/custom-main-only.md"))).toBeUndefined();

    const withoutUser = basic();
    expect(paths(withoutUser.sources).some((p) => p.includes("home/user"))).toBe(false);
  });

  it("deduplicates only documented instruction classes", () => {
    const dedupeRoot = fix("copilot/dedupe");
    const map = run({
      agent: "copilot",
      target: fix("copilot/dedupe/src/app.ts"),
      cwd: dedupeRoot,
      root: dedupeRoot,
    });

    expect(findByPath(map, "./AGENTS.md")?.state).toBe("active");
    expect(findByPath(map, "./CLAUDE.md")?.state).toBe("excluded");
    expect(hasDiagnostic(map, "duplicate-instruction")).toBe(true);

    expect(findByPath(map, "./.github/instructions/a.instructions.md")?.state).toBe("active");
    expect(findByPath(map, "./.github/instructions/b.instructions.md")?.state).toBe("active");

    const imported = paths(map.sources.filter((s) => s.kind === "copilot-import"));
    expect(imported).toContain("./import-a.md");
    expect(imported).toContain("./import-b.md");
  });
});
