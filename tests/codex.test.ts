import path from "node:path";
import fs from "node:fs";
import { describe, it, expect } from "vitest";
import {
  run,
  fix,
  byState,
  paths,
  findByPath,
  hasDiagnostic,
  diagnostic,
  mkTemp,
  writeFile,
  rmTemp,
} from "./helpers.js";

describe("codex adapter", () => {
  it("replaces AGENTS.md with AGENTS.override.md in the same directory", () => {
    const root = fix("codex/override-basic");
    const map = run({
      agent: "codex",
      target: fix("codex/override-basic/src/app.ts"),
      cwd: root,
      root,
    });
    const override = findByPath(map, "./AGENTS.override.md");
    const agents = findByPath(map, "./AGENTS.md");
    expect(override?.state).toBe("active");
    expect(agents?.state).toBe("excluded");
    expect(agents?.matchReason).toMatch(/replaced by AGENTS\.override\.md/i);
  });

  it("discovers project docs from root to launch cwd with documented order", () => {
    const root = fix("codex/nested");
    const map = run({
      agent: "codex",
      target: fix("codex/nested/apps/api/src/auth.ts"),
      cwd: fix("codex/nested/apps/api"),
      root,
    });
    const active = byState(map, "active");
    expect(paths(active)).toEqual(["./AGENTS.md", "./apps/api/AGENTS.md"]);
    expect(active[0]?.order).toBe(1);
    expect(active[1]?.order).toBe(2);
  });

  it("uses the target directory as cwd when --cwd is omitted, and says so", () => {
    const root = fix("codex/nested");
    const map = run({
      agent: "codex",
      target: fix("codex/nested/apps/api/src/auth.ts"),
      root,
    });
    // cwd defaults to the target's dir (apps/api/src), so both AGENTS docs are on the path.
    expect(map.assumptions.some((a) => /launch working directory/i.test(a))).toBe(true);
    expect(paths(byState(map, "active"))).toContain("./apps/api/AGENTS.md");
  });

  it("discovers only .agents/skills and reads manual-only policy from agents/openai.yaml", () => {
    const root = fix("codex/skills");
    const map = run({
      agent: "codex",
      target: fix("codex/skills/src/service.ts"),
      cwd: root,
      root,
    });
    const conditional = byState(map, "conditional").filter((s) => s.kind === "codex-skill");
    const manual = byState(map, "manual").filter((s) => s.kind === "codex-skill");
    expect(paths(manual)).toEqual(["./.agents/skills/deploy/SKILL.md"]);
    expect(manual[0]?.matchReason).toMatch(/agents\/openai\.yaml/i);
    expect(paths(conditional)).toContain("./.agents/skills/legacy-frontmatter-policy/SKILL.md");
    expect(map.sources.some((s) => /\.codex\/skills/.test(s.path))).toBe(false);
    expect(hasDiagnostic(map, "skill-policy-misplaced")).toBe(true);
    expect(hasDiagnostic(map, "duplicate-skill-name")).toBe(true);
    expect(hasDiagnostic(map, "frontmatter-invalid")).toBe(true);
  });

  it("discovers repository skills only from catalogs on the root-to-cwd ancestor chain", () => {
    const root = fix("codex/skill-chain");
    const map = run({
      agent: "codex",
      target: fix("codex/skill-chain/apps/api/src/service.ts"),
      cwd: fix("codex/skill-chain/apps/api"),
      root,
    });
    const skills = map.sources.filter((s) => s.kind === "codex-skill");
    expect(paths(skills)).toEqual([
      "./.agents/skills/root-skill/SKILL.md",
      "./apps/.agents/skills/apps-skill/SKILL.md",
      "./apps/api/.agents/skills/api-skill/SKILL.md",
    ]);
    expect(paths(skills).some((p) => /off-chain|legacy-skill/.test(p))).toBe(false);
  });

  it("follows contained skill symlinks and rejects skill symlinks that escape the project", () => {
    const temp = mkTemp("apm-codex-symlink-skill-");
    try {
      const root = path.join(temp, "project");
      const outside = path.join(temp, "outside");
      const skills = path.join(root, ".agents", "skills");
      writeFile(path.join(root, "shared", "linked", "SKILL.md"), "---\nname: linked\ndescription: linked skill\n---\n");
      writeFile(path.join(outside, "escaped", "SKILL.md"), "---\nname: escaped\ndescription: must not load\n---\n");
      writeFile(path.join(root, "src", "service.ts"), "export const service = true;\n");
      fs.mkdirSync(skills, { recursive: true });
      fs.symlinkSync(path.join(root, "shared", "linked"), path.join(skills, "linked"), "dir");
      fs.symlinkSync(path.join(outside, "escaped"), path.join(skills, "escaped"), "dir");

      const map = run({
        agent: "codex",
        target: path.join(root, "src", "service.ts"),
        cwd: root,
        root,
      });

      expect(findByPath(map, "./.agents/skills/linked/SKILL.md")?.state).toBe("conditional");
      expect(map.sources.some((source) => source.path.includes("escaped"))).toBe(false);
      expect(hasDiagnostic(map, "symlink-escape")).toBe(true);
    } finally {
      rmTemp(temp);
    }
  });

  it("marks the uninspected administrator skill catalog as unknown-external", () => {
    const root = fix("codex/skills");
    const map = run({ agent: "codex", target: fix("codex/skills/src/service.ts"), cwd: root, root });
    const catalog = byState(map, "unknown-external").find((s) => s.kind === "codex-skill-catalog");
    expect(catalog?.path).toBe("/etc/codex/skills");
    expect(catalog?.matchReason).toMatch(/--include-user/);
    expect(findByPath(map, "[Codex bundled system skills]")?.state).toBe("unknown-external");
  });

  it("marks a repository skill excluded when user Codex config disables it", () => {
    const temp = mkTemp("apm-codex-disabled-skill-");
    try {
      const home = path.join(temp, "home");
      const codexHome = path.join(home, ".codex");
      const root = path.join(temp, "project");
      const skill = path.join(root, ".agents", "skills", "deploy", "SKILL.md");
      writeFile(skill, "---\nname: deploy\ndescription: Deploy safely\n---\n");
      writeFile(path.join(root, "src", "service.ts"), "export const service = true;\n");
      writeFile(
        path.join(codexHome, "config.toml"),
        `[[skills.config]]\npath = ${JSON.stringify(skill)}\nenabled = false\n`,
      );

      const map = run({
        agent: "codex",
        target: path.join(root, "src", "service.ts"),
        cwd: root,
        root,
        includeUser: true,
        env: { HOME: home, CODEX_HOME: codexHome },
      });

      const source = findByPath(map, "./.agents/skills/deploy/SKILL.md");
      expect(source?.state).toBe("excluded");
      expect(source?.matchReason).toMatch(/disabled by a skills\.config entry/i);
    } finally {
      rmTemp(temp);
    }
  });

  it("lets global AGENTS.override.md replace AGENTS.md and reads user skills from HOME/.agents", () => {
    const root = fix("codex/skills");
    const env = { HOME: fix("home/user") } as NodeJS.ProcessEnv;
    const withUser = run({
      agent: "codex",
      target: fix("codex/skills/src/service.ts"),
      cwd: root,
      root,
      includeUser: true,
      env,
    });
    expect(paths(byState(withUser, "active"))).toContain("~/.codex/AGENTS.override.md");
    expect(findByPath(withUser, "~/.codex/AGENTS.md")?.state).toBe("excluded");
    expect(findByPath(withUser, "~/.agents/skills/personal-notes/SKILL.md")?.state).toBe(
      "conditional",
    );

    const withoutUser = run({
      agent: "codex",
      target: fix("codex/skills/src/service.ts"),
      cwd: root,
      root,
    });
    expect(withoutUser.sources.some((s) => s.path.startsWith("~/"))).toBe(false);
  });

  it("applies project_doc_max_bytes across the combined root-to-cwd project docs", () => {
    const temp = mkTemp("apm-codex-combined-cap-");
    try {
      const home = path.join(temp, "home");
      const root = path.join(temp, "project");
      const cwd = path.join(root, "apps", "api");
      const rootDoc = "Root policy.\n";
      const nestedDoc = "Nested policy.\n";
      const cap = 20;

      writeFile(path.join(home, ".codex", "config.toml"), `project_doc_max_bytes = ${cap}\n`);
      writeFile(path.join(root, "AGENTS.md"), rootDoc);
      writeFile(path.join(cwd, "AGENTS.md"), nestedDoc);
      writeFile(path.join(cwd, "src", "service.ts"), "export const service = true;\n");

      const map = run({
        agent: "codex",
        target: path.join(cwd, "src", "service.ts"),
        cwd,
        root,
        includeUser: true,
        env: { HOME: home },
      });
      const totalProjectBytes = Buffer.byteLength(rootDoc) + Buffer.byteLength(nestedDoc);
      const projectDocs = map.sources.filter(
        (source) => source.kind === "codex-agents-md" && source.state === "active",
      );
      expect(map.context.omittedByCapBytes).toBe(totalProjectBytes - cap);
      expect(map.context.activeBytes).toBe(cap);
      expect(projectDocs.reduce((sum, source) => sum + (source.bytes ?? 0), 0)).toBe(cap);
      expect(map.context.lines).toBe(
        projectDocs.reduce((sum, source) => sum + (source.lines ?? 0), 0),
      );
      expect(hasDiagnostic(map, "cap-omission")).toBe(true);
    } finally {
      rmTemp(temp);
    }
  });

  it("does not diagnose conflicts found only after the combined project-doc cap", () => {
    const temp = mkTemp("apm-codex-cap-conflict-");
    try {
      const home = path.join(temp, "home");
      const root = path.join(home, "project");
      const cwd = path.join(root, "apps", "api");
      const rootDoc = "Use npm.\n";
      writeFile(
        path.join(home, ".codex", "config.toml"),
        `project_doc_max_bytes = ${Buffer.byteLength(rootDoc)}\n`,
      );
      writeFile(path.join(root, "AGENTS.md"), rootDoc);
      writeFile(path.join(cwd, "AGENTS.md"), "Use pnpm.\n");
      writeFile(path.join(cwd, "src", "service.ts"), "export const service = true;\n");

      const map = run({
        agent: "codex",
        target: path.join(cwd, "src", "service.ts"),
        cwd,
        root,
        includeUser: true,
        env: { HOME: home },
      });

      expect(findByPath(map, "./apps/api/AGENTS.md")?.state).toBe("excluded");
      expect(hasDiagnostic(map, "possible-conflict")).toBe(false);
    } finally {
      rmTemp(temp);
    }
  });

  it("rejects fallback filenames that contain traversal or separators", () => {
    const temp = mkTemp("apm-codex-fallback-");
    try {
      const home = path.join(temp, "home");
      const root = path.join(home, "project");
      writeFile(
        path.join(home, ".codex", "config.toml"),
        'project_doc_fallback_filenames = ["../outside.md", "nested/policy.md"]\n',
      );
      writeFile(path.join(home, "outside.md"), "Never read this file.\n");
      writeFile(path.join(root, "nested", "policy.md"), "Never read this file either.\n");
      writeFile(path.join(root, "src", "service.ts"), "export const service = true;\n");

      const map = run({
        agent: "codex",
        target: path.join(root, "src", "service.ts"),
        cwd: root,
        root,
        includeUser: true,
        env: { HOME: home },
      });

      expect(hasDiagnostic(map, "codex-config-invalid")).toBe(true);
      expect(map.sources.some((source) => /outside|nested\/policy/.test(source.path))).toBe(false);
    } finally {
      rmTemp(temp);
    }
  });

  it("applies trusted project Codex config and ignores comments inside quoted values", () => {
    const temp = mkTemp("apm-codex-project-config-");
    try {
      const root = path.join(temp, "project");
      writeFile(
        path.join(root, ".codex", "config.toml"),
        'project_doc_fallback_filenames = ["POLICY#TEAM.md"] # project fallback\n',
      );
      writeFile(path.join(root, "POLICY#TEAM.md"), "Use the project policy.\n");
      writeFile(path.join(root, "src", "service.ts"), "export const service = true;\n");

      const map = run({
        agent: "codex",
        target: path.join(root, "src", "service.ts"),
        cwd: root,
        root,
      });

      expect(findByPath(map, "./POLICY#TEAM.md")?.state).toBe("active");
      expect(map.assumptions.some((assumption) => /assuming the project is trusted/i.test(assumption))).toBe(true);
    } finally {
      rmTemp(temp);
    }
  });

  it("reports a possible package-manager conflict with evidence", () => {
    const root = fix("codex/nested");
    const map = run({
      agent: "codex",
      target: fix("codex/nested/apps/api/src/auth.ts"),
      cwd: fix("codex/nested/apps/api"),
      root,
    });
    const conflict = diagnostic(map, "possible-conflict");
    expect(conflict).toBeDefined();
    expect(conflict?.evidence?.length).toBe(2);
    expect(conflict?.message).toMatch(/npm/);
    expect(conflict?.message).toMatch(/pnpm/);
  });
});
