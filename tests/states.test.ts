import { describe, it, expect } from "vitest";
import { run, fix } from "./helpers.js";
import { renderHuman } from "../src/render/human.js";
import { renderJson } from "../src/render/json.js";
import type { SourceState } from "../src/types.js";

const ALL_STATES: SourceState[] = [
  "active",
  "conditional",
  "manual",
  "excluded",
  "unknown-external",
];

describe("output states", () => {
  function cursorModes() {
    const root = fix("cursor/modes");
    return run({ agent: "cursor", target: fix("cursor/modes/src/app.ts"), cwd: root, root });
  }

  it("can produce every documented state in a single inspection", () => {
    const map = cursorModes();
    const present = new Set(map.sources.map((s) => s.state));
    for (const state of ALL_STATES) {
      expect(present.has(state), `expected a source in state "${state}"`).toBe(true);
    }
  });

  it("is deterministic across repeated runs", () => {
    const a = renderJson(cursorModes());
    const b = renderJson(cursorModes());
    expect(a).toBe(b);
  });

  it("produces valid JSON with the versioned contract and stable ids", () => {
    const map = cursorModes();
    const parsed = JSON.parse(renderJson(map));
    expect(parsed.version).toBe("1");
    expect(parsed.agent).toBe("cursor");
    const ids = map.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // ids are unique
    for (const id of ids) expect(id.startsWith("cursor:")).toBe(true);
  });

  it("never includes full instruction content in JSON by default", () => {
    const map = cursorModes();
    const json = renderJson(map);
    // The rule bodies are not present; only hashes/metadata are.
    expect(json).not.toContain("always attached. See @helper.md");
    expect(json).toContain("contentHash");
  });

  it("renders grouped human output with state headings", () => {
    const text = renderHuman(cursorModes());
    expect(text).toContain("ACTIVE");
    expect(text).toContain("CONDITIONAL");
    expect(text).toContain("MANUAL");
    expect(text).toContain("EXCLUDED");
    expect(text).toContain("UNKNOWN-EXTERNAL");
    expect(text).toContain("CONTEXT ESTIMATE");
  });

  it("includes redacted content only when explicitly requested", () => {
    const map = cursorModes();
    const contents = new Map<string, string>();
    contents.set("./.cursor/rules/always.mdc", "redacted body");
    const text = renderHuman(map, contents);
    expect(text).toContain("content (redacted):");
  });
});
