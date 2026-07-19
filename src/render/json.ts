import type { PolicyMap } from "../types.js";

/** Stable JSON serialization of the PolicyMap (no full instruction content). */
export function renderJson(map: PolicyMap, extra?: Record<string, unknown>): string {
  return JSON.stringify(extra ? { ...map, ...extra } : map, null, 2);
}
