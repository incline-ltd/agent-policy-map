import type { Diagnostic } from "../types.js";
import type { ParsedFrontmatter } from "./parse.js";

/**
 * Frontmatter profiles keyed to the documented-fields table in ARCHITECTURE.md.
 * `required` fields missing => invalid. `documented` = valid known fields.
 * Anything else that is valid YAML => undocumented (informational, never
 * rejected). `unsupported` fields are explicitly rejected by official docs.
 */
export type FrontmatterProfile = {
  id: string;
  required: string[];
  documented: string[];
  unsupported: string[];
};

export const PROFILES: Record<string, FrontmatterProfile> = {
  "codex-skill": {
    id: "Codex SKILL.md",
    required: ["name", "description"],
    documented: ["name", "description"],
    unsupported: [],
  },
  "claude-rule": {
    id: "Claude scoped rule",
    required: [],
    documented: ["paths"],
    unsupported: [],
  },
  "cursor-mdc": {
    id: "Cursor .mdc",
    required: [],
    documented: ["description", "globs", "alwaysApply"],
    unsupported: [],
  },
  "copilot-instructions": {
    id: "Copilot *.instructions.md",
    required: ["applyTo"],
    documented: ["applyTo", "excludeAgent"],
    unsupported: [],
  },
};

/**
 * Validate a parsed frontmatter block against a profile, producing diagnostics
 * at the documented levels (invalid / undocumented / unsupported).
 */
export function validateFrontmatter(
  profileId: keyof typeof PROFILES,
  parsed: ParsedFrontmatter,
  displayPath: string,
): Diagnostic[] {
  const profile = PROFILES[profileId];
  if (!profile) return [];
  const out: Diagnostic[] = [];

  if (parsed.error) {
    out.push({
      code: "frontmatter-invalid",
      level: "error",
      message: `${profile.id}: malformed YAML frontmatter (${parsed.error})`,
      paths: [displayPath],
    });
    return out;
  }

  // No frontmatter at all: only an issue when the profile requires fields.
  const data = parsed.data ?? {};
  const keys = Object.keys(data);

  for (const req of profile.required) {
    const v = data[req];
    const missing =
      v === undefined ||
      v === null ||
      (typeof v === "string" && v.trim() === "");
    if (missing) {
      out.push({
        code: "frontmatter-invalid",
        level: "error",
        message: `${profile.id}: required field "${req}" is missing or empty`,
        paths: [displayPath],
      });
    }
  }

  for (const key of keys) {
    if (profile.unsupported.includes(key)) {
      out.push({
        code: "frontmatter-unsupported",
        level: "warning",
        message: `${profile.id}: field "${key}" is explicitly unsupported by official docs`,
        paths: [displayPath],
      });
    } else if (!profile.documented.includes(key)) {
      out.push({
        code: "frontmatter-undocumented",
        level: "info",
        message: `${profile.id}: field "${key}" is not in the official documentation (kept, not rejected)`,
        paths: [displayPath],
      });
    }
  }

  return out;
}
