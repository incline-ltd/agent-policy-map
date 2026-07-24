import { describe, expect, it } from "vitest";
import path from "node:path";
import { compare } from "../src/core/compare.js";
import type { AgentName, ComparisonSource } from "../src/types.js";
import { fix, mkTemp, rmTemp, writeFile } from "./helpers.js";

function compareFixture(
  fixtureRoot: string,
  target: string,
  cwd = fixtureRoot,
) {
  return compare({
    target,
    cwd,
    root: fixtureRoot,
    env: {},
  });
}

function sourceAt(
  sources: ComparisonSource[],
  sourcePath: string,
): ComparisonSource {
  const source = sources.find((candidate) => candidate.path === sourcePath);
  if (!source) throw new Error(`Missing comparison source ${sourcePath}`);
  return source;
}

function states(source: ComparisonSource, agent: AgentName): string[] {
  return source.agents[agent].map((entry) => entry.state);
}

describe("cross-agent comparison", () => {
  it("compares the four modeled surfaces in stable registry order", () => {
    const root = fix("copilot/basic");
    const result = compareFixture(
      root,
      fix("copilot/basic/src/app.ts"),
    );

    expect(Object.keys(result.agents)).toEqual([
      "codex",
      "claude",
      "cursor",
      "copilot",
    ]);
    expect(Object.values(result.agents).map((agent) => agent.surface)).toEqual([
      "Codex CLI",
      "Claude Code",
      "Cursor IDE",
      "GitHub Copilot CLI",
    ]);
    expect(result.command).toBe("compare");
    expect(result.summary.meaningfulDifferences).toBe(14);
  });

  it("keeps agent-specific discovery and exclusion states honest", () => {
    const root = fix("copilot/basic");
    const result = compareFixture(
      root,
      fix("copilot/basic/src/app.ts"),
    );
    const agents = sourceAt(result.sources, "./AGENTS.md");
    const claude = sourceAt(result.sources, "./CLAUDE.md");
    const excluded = sourceAt(
      result.sources,
      "./.github/instructions/python.instructions.md",
    );

    expect(states(agents, "codex")).toEqual(["active"]);
    expect(states(agents, "claude")).toEqual([]);
    expect(states(agents, "cursor")).toEqual(["active"]);
    expect(states(agents, "copilot")).toEqual(["active"]);
    expect(states(claude, "claude")).toEqual(["active"]);
    expect(states(claude, "copilot")).toEqual(["active"]);
    expect(states(excluded, "copilot")).toEqual(["excluded"]);
    expect(excluded.meaningfulDifference).toBe(false);
  });

  it.each([
    {
      root: "codex/nested",
      cwd: "codex/nested/apps/api",
      target: "codex/nested/apps/api/src/auth.ts",
      differences: 2,
    },
    {
      root: "claude/rules",
      cwd: "claude/rules",
      target: "claude/rules/src/app.ts",
      differences: 4,
    },
    {
      root: "cursor/modes",
      cwd: "cursor/modes",
      target: "cursor/modes/src/app.ts",
      differences: 6,
    },
  ])(
    "finds $differences meaningful differences in $root",
    ({ root, cwd, target, differences }) => {
      const result = compareFixture(fix(root), fix(target), fix(cwd));
      expect(result.summary.meaningfulDifferences).toBe(differences);
    },
  );

  it("is deterministic and never returns instruction content", () => {
    const root = fix("copilot/basic");
    const input = {
      target: fix("copilot/basic/src/app.ts"),
      cwd: root,
      root,
      env: {},
    };
    const first = JSON.stringify(compare(input));
    const second = JSON.stringify(compare(input));

    expect(second).toBe(first);
    expect(first).not.toContain("Use npm for installs across this repository.");
    expect(first).not.toContain('"contents"');
  });

  it("redacts sensitive paths without losing entries that share a redacted path", () => {
    const root = mkTemp("apm-compare-redaction-");
    try {
      const firstToken = ["sk", "proj", "FAKEFAKEFAKEFAKEFAKE"].join("-");
      const secondToken = ["sk", "proj", "OTHEROTHEROTHEROTHEROTHER"].join("-");
      writeFile(path.join(root, "src", "app.ts"), "export {};\n");
      writeFile(path.join(root, `${firstToken}.md`), "First imported policy.\n");
      writeFile(path.join(root, `${secondToken}.md`), "Second imported policy.\n");
      writeFile(
        path.join(root, "CLAUDE.md"),
        `@./${firstToken}.md\n@./${secondToken}.md\n`,
      );

      const result = compare({
        target: path.join(root, "src", "app.ts"),
        cwd: root,
        root,
        env: {},
      });
      const serialized = JSON.stringify(result);
      const redacted = result.sources.find(
        (source) => source.path === "./[REDACTED].md",
      );

      expect(serialized).not.toContain(firstToken);
      expect(serialized).not.toContain(secondToken);
      expect(redacted?.agents.claude).toHaveLength(2);
    } finally {
      rmTemp(root);
    }
  });
});
