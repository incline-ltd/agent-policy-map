import fs from "node:fs";
import path from "node:path";

/** Resolve to an absolute, normalized path. */
export function normalizeAbs(p: string, base?: string): string {
  return base ? path.resolve(base, p) : path.resolve(p);
}

/**
 * Return true when `child` is `parent` itself or lives inside it.
 * Both inputs must already be absolute+normalized.
 */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Display path used in output: repo-relative with a leading `./` when inside
 * `cwd`, otherwise the absolute path. Always uses POSIX separators so output
 * is stable across platforms.
 */
export function toDisplayPath(cwd: string, abs: string): string {
  if (isInside(cwd, abs)) {
    const rel = path.relative(cwd, abs);
    if (rel === "") return "./";
    return "./" + rel.split(path.sep).join("/");
  }
  return abs.split(path.sep).join("/");
}

/** Convert an OS path to POSIX form for glob matching. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Path of `child` relative to `from`, in POSIX form (no leading `./`). */
export function relPosix(from: string, child: string): string {
  return toPosix(path.relative(from, child));
}

/**
 * Resolve an existing path through symlinks and return its canonical path only
 * when it stays inside at least one canonical allowed root.
 *
 * Roots may be directories or an explicitly allowed file. Missing paths and
 * filesystem errors are allowed to throw so the read layer can preserve the
 * original errno. A null result means the path exists but escapes every root.
 */
export function realpathContained(
  candidate: string,
  allowedRoots: readonly string[],
): string | null {
  const candidateReal = fs.realpathSync(candidate);
  for (const root of allowedRoots) {
    let rootReal: string;
    try {
      rootReal = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (isInside(rootReal, candidateReal)) return candidateReal;
  }
  return null;
}
