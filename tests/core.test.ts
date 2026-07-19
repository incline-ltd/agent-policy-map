import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../src/frontmatter/parse.js";
import { validateFrontmatter } from "../src/frontmatter/validate.js";
import { redact, excerpt } from "../src/security/redact.js";
import { matchPatterns, normalizePatterns } from "../src/match/glob.js";
import { findImports, stripCodeRegions } from "../src/adapters/claude-imports.js";
import { detectConflicts } from "../src/diagnostics/conflicts.js";
import { estimateContext } from "../src/context/estimate.js";
import type { PolicySource } from "../src/types.js";

describe("frontmatter", () => {
  it("parses a valid block and body", () => {
    const p = parseFrontmatter("---\nname: x\ndescription: y\n---\nbody text\n");
    expect(p.hasFrontmatter).toBe(true);
    expect(p.data).toEqual({ name: "x", description: "y" });
    expect(p.body.trim()).toBe("body text");
  });

  it("reports malformed YAML as invalid", () => {
    const p = parseFrontmatter("---\nname: : :\n  bad\n---\n");
    const diags = validateFrontmatter("codex-skill", p, "./SKILL.md");
    expect(diags.some((d) => d.code === "frontmatter-invalid")).toBe(true);
  });

  it("reports a missing required field as invalid", () => {
    const p = parseFrontmatter("---\ndescription: only\n---\n");
    const diags = validateFrontmatter("codex-skill", p, "./SKILL.md");
    expect(diags.some((d) => d.code === "frontmatter-invalid" && /name/.test(d.message))).toBe(true);
  });

  it("keeps undocumented fields but flags them at info level", () => {
    const p = parseFrontmatter("---\ndescription: d\nglobs: '*'\nsomethingNew: 1\n---\n");
    const diags = validateFrontmatter("cursor-mdc", p, "./r.mdc");
    const undoc = diags.find((d) => d.code === "frontmatter-undocumented");
    expect(undoc?.level).toBe("info");
    expect(undoc?.message).toMatch(/somethingNew/);
  });
});

describe("redaction", () => {
  it("redacts common credential shapes", () => {
    const openAiToken = ["sk", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("-");
    const projectToken = ["sk", "proj", "FAKEFAKEFAKEFAKEFAKEFAKE"].join("-");
    const githubToken = ["gh", "p_", "0123456789012345678901234567890123"].join("");

    expect(redact(`token: ${openAiToken}`)).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(redact(projectToken)).toBe("[REDACTED]");
    expect(redact(`key=${githubToken}`)).toContain("[REDACTED]");
    expect(redact("password: hunter2very")).toContain("[REDACTED]");
  });

  it("keeps the assignment key but redacts the value", () => {
    expect(redact("password: hunter2very")).toMatch(/password/i);
  });

  it("redacts complete quoted credential values that contain spaces", () => {
    const output = redact(
      `password = "correct horse battery staple"\nclient_secret: 'alpha beta gamma delta'`,
    );

    expect(output).toContain("password = [REDACTED]");
    expect(output).toContain("client_secret: [REDACTED]");
    expect(output).not.toMatch(/correct|horse|battery|staple|alpha|beta|gamma|delta/);
  });

  it("produces a single bounded line", () => {
    const long = "a".repeat(500);
    const e = excerpt(`token: sk-${long}`, 80);
    expect(e.length).toBeLessThanOrEqual(80);
    expect(e).not.toContain(long);
  });
});

describe("glob matching", () => {
  it("normalizes arrays and comma-separated strings", () => {
    expect(normalizePatterns("*.ts, *.tsx")).toEqual(["*.ts", "*.tsx"]);
    expect(normalizePatterns(["a/**", "b/**"])).toEqual(["a/**", "b/**"]);
    expect(normalizePatterns("src/**/*.{ts,tsx}, tests/**")).toEqual([
      "src/**/*.{ts,tsx}",
      "tests/**",
    ]);
    expect(normalizePatterns(undefined)).toEqual([]);
  });

  it("matches globstars and braces without widening root-relative patterns", () => {
    expect(matchPatterns(["**/*.ts"], "src/a/b.ts").matched).toBe(true);
    expect(matchPatterns(["src/**/*.{ts,tsx}"], "src/a.tsx").matched).toBe(true);
    expect(matchPatterns(["*.ts"], "deep/nested/x.ts").matched).toBe(false);
    expect(matchPatterns(["*.ts"], "deep/nested/x.ts", { matchBase: true }).matched).toBe(true);
    expect(matchPatterns(["**/*.py"], "src/a.ts").matched).toBe(false);
  });
});

describe("claude import scanning", () => {
  it("ignores imports inside fenced and inline code", () => {
    const text = "@./real.md\n```\n@./fenced.md\n```\ninline `@./inline.md` here\n";
    const stripped = stripCodeRegions(text);
    expect(stripped).toContain("@./real.md");
    expect(stripped).not.toContain("@./fenced.md");
    expect(stripped).not.toContain("@./inline.md");
    const refs = findImports(text).map((r) => r.raw);
    expect(refs).toContain("./real.md");
    expect(refs).not.toContain("./fenced.md");
    expect(refs).not.toContain("./inline.md");
  });

  it("does not treat email-like @mentions as imports", () => {
    const refs = findImports("contact user@example please").map((r) => r.raw);
    expect(refs).not.toContain("example");
  });
});

describe("context estimate", () => {
  it("splits already-capped source bytes by state and reports omitted bytes separately", () => {
    const sources: PolicySource[] = [
      { id: "a", path: "./a", kind: "k", state: "active", matchReason: "", bytes: 1000, lines: 10 },
      { id: "b", path: "./b", kind: "k", state: "conditional", matchReason: "", bytes: 400, lines: 4 },
      { id: "c", path: "./c", kind: "k", state: "manual", matchReason: "", bytes: 200, lines: 2 },
      { id: "d", path: "./d", kind: "k", state: "excluded", matchReason: "", bytes: 999, lines: 9 },
    ];
    const est = estimateContext(sources, 300);
    expect(est.activeBytes).toBe(1000);
    expect(est.conditionalBytes).toBe(400);
    expect(est.manualBytes).toBe(200);
    expect(est.bytes).toBe(1600);
    expect(est.omittedByCapBytes).toBe(300);
    expect(est.approxTokens).toBeGreaterThan(0);
  });
});

describe("possible conflict detection", () => {
  it("detects explicit negation regardless of source order", () => {
    for (const entries of [
      [
        { path: "./a.md", content: "Never use npm." },
        { path: "./b.md", content: "Use npm." },
      ],
      [
        { path: "./a.md", content: "Use npm." },
        { path: "./b.md", content: "Never use npm." },
      ],
    ]) {
      expect(detectConflicts(entries).some((d) => d.code === "possible-conflict")).toBe(true);
    }
  });

  it("does not treat a negative instruction as an endorsement", () => {
    const diagnostics = detectConflicts([
      { path: "./a.md", content: "Never use npm." },
      { path: "./b.md", content: "Use pnpm." },
    ]);
    expect(diagnostics).toEqual([]);
  });
});
