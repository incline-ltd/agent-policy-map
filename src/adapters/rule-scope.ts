import path from "node:path";

/** Return the directory scoped by a nested `<tool>/rules/**` file. */
export function ruleScope(ruleAbs: string, toolDir: ".claude" | ".cursor"): string | null {
  let dir = path.dirname(ruleAbs);
  for (;;) {
    if (path.basename(dir) === "rules" && path.basename(path.dirname(dir)) === toolDir) {
      return path.dirname(path.dirname(dir));
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
