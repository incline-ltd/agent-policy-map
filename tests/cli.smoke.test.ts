import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fix, mkTemp, rmTemp, writeFile } from "./helpers.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const CLI = path.join(ROOT, "dist", "cli.js");

type RunResult = { code: number; stdout: string; stderr: string };
type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

function cli(args: string[], options: RunOptions = {}): RunResult {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmTemp(temps.pop()!);
});

function temp(prefix: string): string {
  const dir = mkTemp(prefix);
  temps.push(dir);
  return dir;
}

describe("cli smoke (built dist)", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  }, 60_000);

  it("prints help and exits 0 with no args", () => {
    const r = cli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
  });

  it("inspect produces human output grouped by state", () => {
    const r = cli([
      "inspect",
      fix("cursor/modes/src/app.ts"),
      "--agent",
      "cursor",
      "--cwd",
      fix("cursor/modes"),
      "--root",
      fix("cursor/modes"),
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ACTIVE");
    expect(r.stdout).toContain("Agent:   cursor (Cursor IDE)");
  });

  it("inspect --json emits a valid PolicyMap", () => {
    const r = cli([
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
    expect(r.code).toBe(0);
    const map = JSON.parse(r.stdout);
    expect(map.version).toBe("1");
    expect(map.surface).toBe("GitHub Copilot CLI");
  });

  it("compare produces a cross-agent matrix with evidence", () => {
    const r = cli([
      "compare",
      fix("copilot/basic/src/app.ts"),
      "--cwd",
      fix("copilot/basic"),
      "--root",
      fix("copilot/basic"),
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Codex CLI | Claude Code | Cursor IDE | GitHub Copilot CLI");
    expect(r.stdout).toContain("14 meaningful local differences");
    expect(r.stdout).toContain("WHY THEY DIFFER");
    expect(r.stdout).toContain(
      "claude —: not discovered by this modeled adapter",
    );
    expect(r.stdout).toContain("INSPECTION NOTES");
    expect(r.stdout).toContain("[info] no-precedence-defined");
    expect(r.stdout).not.toContain("Use npm for installs across this repository.");
  });

  it("compare keeps warning diagnostics visible in human output", () => {
    const r = cli([
      "compare",
      fix("codex/nested/apps/api/src/auth.ts"),
      "--cwd",
      fix("codex/nested/apps/api"),
      "--root",
      fix("codex/nested"),
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[warning] possible-conflict");
  });

  it("compare --json emits a versioned comparison contract", () => {
    const r = cli([
      "compare",
      fix("codex/nested/apps/api/src/auth.ts"),
      "--cwd",
      fix("codex/nested/apps/api"),
      "--root",
      fix("codex/nested"),
      "--json",
    ]);
    expect(r.code).toBe(0);
    const comparison = JSON.parse(r.stdout) as {
      version: string;
      command: string;
      summary: { meaningfulDifferences: number };
      agents: Record<string, { surface: string }>;
    };
    expect(comparison.version).toBe("1");
    expect(comparison.command).toBe("compare");
    expect(comparison.summary.meaningfulDifferences).toBe(2);
    expect(Object.keys(comparison.agents)).toEqual([
      "codex",
      "claude",
      "cursor",
      "copilot",
    ]);
  });

  it("compare rejects missing targets and incompatible options", () => {
    const missing = cli(["compare"]);
    const agent = cli(["compare", "x.ts", "--agent", "codex"]);
    const content = cli(["compare", "x.ts", "--show-content"]);

    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/requires a <target>/);
    expect(agent.code).toBe(1);
    expect(agent.stderr).toMatch(/checks all supported agents/);
    expect(content.code).toBe(1);
    expect(content.stderr).toMatch(/not supported for compare/);
  });

  it("compare without explicit context does not print absolute project paths", () => {
    const root = temp("apm-cli-compare-path-");
    const target = path.join(root, "src", "app.ts");
    writeFile(path.join(root, ".git", ".keep"), "");
    writeFile(path.join(root, "AGENTS.md"), "Public fixture policy.\n");
    writeFile(target, "export {};\n");

    const r = cli(["compare", target]);

    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(root);
    expect(r.stdout).toContain("assuming the target's directory");
  });

  it("discover runs without a concrete target", () => {
    const r = cli([
      "discover",
      "--agent",
      "claude",
      "--cwd",
      fix("claude/rules"),
      "--root",
      fix("claude/rules"),
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("discover");
  });

  it("Claude imports include hop 5 and reject hop 6", () => {
    const r = cli([
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
    expect(r.code).toBe(0);
    const map = JSON.parse(r.stdout) as {
      sources: Array<{ path: string }>;
      diagnostics: Array<{ code: string }>;
    };
    expect(map.sources.some((source) => source.path === "./docs/chain5.md")).toBe(true);
    expect(map.sources.some((source) => source.path === "./docs/chain6.md")).toBe(false);
    expect(map.diagnostics.some((diagnostic) => diagnostic.code === "import-over-depth")).toBe(true);
  });

  it("explain resolves a source by id", () => {
    const r = cli([
      "explain",
      "cursor:cursor-mdc:.cursor/rules/always.mdc",
      "--agent",
      "cursor",
      "--target",
      fix("cursor/modes/src/app.ts"),
      "--cwd",
      fix("cursor/modes"),
      "--root",
      fix("cursor/modes"),
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("State:  active");
  });

  it("rejects --show-content for explain instead of silently ignoring it", () => {
    const r = cli([
      "explain",
      "cursor:cursor-mdc:.cursor/rules/always.mdc",
      "--agent",
      "cursor",
      "--target",
      fix("cursor/modes/src/app.ts"),
      "--show-content",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/supported only for inspect and discover/);
  });

  it("fails clearly on an unknown agent", () => {
    const r = cli(["inspect", "x.ts", "--agent", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown agent/);
  });

  it("fails cleanly on an unknown option without printing a stack trace", () => {
    const r = cli(["inspect", "x.ts", "--agent", "claude", "--not-an-option"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Unknown option/);
    expect(r.stderr).not.toMatch(/node:internal|\n\s+at\s/);
  });

  it("--show-content includes redacted content", () => {
    const r = cli([
      "inspect",
      fix("cursor/modes/src/app.ts"),
      "--agent",
      "cursor",
      "--cwd",
      fix("cursor/modes"),
      "--root",
      fix("cursor/modes"),
      "--show-content",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("content (redacted):");
  });

  it("--show-content keeps an absolute target bound to its original project context", () => {
    const base = temp("apm-cli-cross-cwd-");
    const targetRoot = path.join(base, "target-project");
    const callerRoot = path.join(base, "caller-project");
    writeFile(path.join(targetRoot, ".git", ".keep"), "");
    writeFile(path.join(targetRoot, "src", "app.ts"), "export {};\n");
    writeFile(path.join(targetRoot, "AGENTS.md"), "TARGET_PROJECT_POLICY\n");
    writeFile(path.join(callerRoot, ".git", ".keep"), "");
    writeFile(path.join(callerRoot, "src", "app.ts"), "export {};\n");
    writeFile(path.join(callerRoot, "AGENTS.md"), "CALLER_PRIVATE_POLICY\n");

    const r = cli(
      [
        "inspect",
        path.join(targetRoot, "src", "app.ts"),
        "--agent",
        "codex",
        "--show-content",
        "--json",
      ],
      { cwd: callerRoot },
    );

    expect(r.code).toBe(0);
    const map = JSON.parse(r.stdout) as { contents?: Record<string, string> };
    expect(map.contents?.["./AGENTS.md"]).toContain("TARGET_PROJECT_POLICY");
    expect(r.stdout).not.toContain("CALLER_PRIVATE_POLICY");
  });

  it("--show-content does not restore content omitted by the Codex byte cap", () => {
    const base = temp("apm-cli-cap-");
    const home = path.join(base, "home");
    const root = path.join(base, "project");
    const included = "Use npm.\n";
    const omitted = "OMITTED_POLICY_TAIL_7391\n";
    writeFile(
      path.join(home, ".codex", "config.toml"),
      `project_doc_max_bytes = ${Buffer.byteLength(included)}\n`,
    );
    writeFile(path.join(root, "AGENTS.md"), included + omitted);
    writeFile(path.join(root, "src", "app.ts"), "export {};\n");

    const r = cli(
      [
        "inspect",
        path.join(root, "src", "app.ts"),
        "--agent",
        "codex",
        "--cwd",
        root,
        "--root",
        root,
        "--include-user",
        "--show-content",
        "--json",
      ],
      { env: { HOME: home } },
    );

    expect(r.code).toBe(0);
    const map = JSON.parse(r.stdout) as { contents?: Record<string, string> };
    expect(map.contents?.["./AGENTS.md"]).toBe(included);
    expect(r.stdout).not.toContain(omitted.trim());
  });

  it("redacts token-shaped values from public paths, diagnostics, evidence, and ids", () => {
    const root = temp("apm-cli-redaction-");
    const sourceToken = ["sk", "proj", "FAKEFAKEFAKEFAKEFAKE"].join("-");
    const missingToken = ["gh", "p_", "0123456789012345678901234567890123"].join("");
    const cwdToken = ["gl", "pat-", "FAKEFAKEFAKEFAKE"].join("");
    const target = path.join(root, cwdToken, "app.ts");
    writeFile(path.join(root, ".git", ".keep"), "");
    writeFile(target, "export {};\n");
    writeFile(path.join(root, `${sourceToken}.md`), "Imported policy.\n");
    writeFile(
      path.join(root, "CLAUDE.md"),
      `@./${sourceToken}.md\n@./${sourceToken}.md\n@./${missingToken}.md\n`,
    );

    const r = cli([
      "inspect",
      target,
      "--agent",
      "claude",
      "--root",
      root,
      "--json",
    ]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[REDACTED]");
    expect(r.stdout).not.toContain(sourceToken);
    expect(r.stdout).not.toContain(missingToken);
    expect(r.stdout).not.toContain(cwdToken);
  });
});
