import type { AgentName, PolicySource } from "../types.js";

function slug(p: string): string {
  return p
    .replace(/^\.\//, "")
    .replace(/^[()]|[()]$/g, "")
    .replace(/[^A-Za-z0-9._/~-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
}

/**
 * Assign deterministic, globally unique ids in place. Same-name skills in
 * different directories get different ids because the path differs; genuine
 * collisions get a numeric suffix.
 */
export function assignIds(agent: AgentName, sources: PolicySource[]): void {
  const used = new Set<string>();
  for (const s of sources) {
    const base = `${agent}:${s.kind}:${slug(s.path)}`;
    let id = base;
    let n = 2;
    while (used.has(id)) {
      id = `${base}#${n++}`;
    }
    used.add(id);
    s.id = id;
  }
}
