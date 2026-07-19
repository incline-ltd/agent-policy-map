import fs from "node:fs";
import path from "node:path";
import {
  MAX_TOTAL_FILES,
  MAX_WALK_DEPTH,
  MAX_WALK_DIRECTORIES,
  MAX_WALK_ENTRIES,
} from "../constants.js";
import { isInside } from "./paths.js";

export type WalkEntry = {
  /** Absolute path of the file. */
  abs: string;
  /** True when this file itself is a symlink whose target resolves inside `root`. */
  viaSymlink: boolean;
};

export type WalkResult = {
  files: WalkEntry[];
  /** Repeated or cyclic directory symlinks skipped for loop safety. */
  skippedDirSymlinks: string[];
  /** Symlinks whose target escapes `root` and were skipped. */
  skippedEscapingSymlinks: string[];
  truncated: boolean;
  truncationReasons: string[];
  visitedDirectories: number;
  visitedEntries: number;
};

export type WalkOptions = {
  /** Only include files whose basename matches this predicate. */
  filter?: (abs: string) => boolean;
  maxDepth?: number;
  maxFiles?: number;
  maxDirectories?: number;
  maxEntries?: number;
  /** Optional inspection-wide counters shared across multiple walks. */
  budget?: WalkBudget;
  /** Containment root; symlinks resolving outside it are skipped. */
  root: string;
};

/** Aggregate traversal bounds shared by every directory walk in one inspection. */
export class WalkBudget {
  files = 0;
  directories = 0;
  entries = 0;

  constructor(
    readonly maxFiles = MAX_TOTAL_FILES,
    readonly maxDirectories = MAX_WALK_DIRECTORIES,
    readonly maxEntries = MAX_WALK_ENTRIES,
  ) {}

  claimFile(): boolean {
    if (this.files >= this.maxFiles) return false;
    this.files += 1;
    return true;
  }

  claimDirectory(): boolean {
    if (this.directories >= this.maxDirectories) return false;
    this.directories += 1;
    return true;
  }

  claimEntry(): boolean {
    if (this.entries >= this.maxEntries) return false;
    this.entries += 1;
    return true;
  }
}

/**
 * Depth-bounded directory walk that follows contained directory symlinks,
 * rejects escaping targets, and uses canonical visited paths to stay
 * loop-safe. Read-only: it only lists paths.
 */
export function walkDir(start: string, opts: WalkOptions): WalkResult {
  const maxDepth = limit(opts.maxDepth, MAX_WALK_DEPTH);
  const maxFiles = limit(opts.maxFiles, MAX_TOTAL_FILES);
  const maxDirectories = limit(opts.maxDirectories, MAX_WALK_DIRECTORIES);
  const maxEntries = limit(opts.maxEntries, MAX_WALK_ENTRIES);
  const files: WalkEntry[] = [];
  const skippedDirSymlinks: string[] = [];
  const skippedEscapingSymlinks: string[] = [];
  const truncationReasons = new Set<string>();
  let visitedEntries = 0;

  // Compare realpath'd symlink targets against the realpath'd root so a
  // canonicalized target (e.g. /var -> /private/var on macOS) is not mistaken
  // for an escape.
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(opts.root);
  } catch {
    rootReal = opts.root;
  }

  // Track real directory paths already visited while following contained
  // directory symlinks, so aliases and cycles cannot loop forever.
  const visitedDirs = new Set<string>();

  const stack: Array<{ dir: string; depth: number }> = [
    { dir: start, depth: 0 },
  ];

  let stop = false;
  while (stack.length > 0 && !stop) {
    const { dir, depth } = stack.pop()!;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (!isInside(rootReal, real)) {
      skippedEscapingSymlinks.push(dir);
      continue;
    }
    if (visitedDirs.has(real)) continue;
    if (visitedDirs.size >= maxDirectories) {
      truncationReasons.add(`directory limit reached (${maxDirectories})`);
      break;
    }
    if (opts.budget && !opts.budget.claimDirectory()) {
      truncationReasons.add(
        `inspection-wide directory limit reached (${opts.budget.maxDirectories})`,
      );
      break;
    }
    visitedDirs.add(real);

    const entries: fs.Dirent[] = [];
    let handle: fs.Dir | undefined;
    try {
      handle = fs.opendirSync(dir);
      while (visitedEntries < maxEntries) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (opts.budget && !opts.budget.claimEntry()) {
          truncationReasons.add(
            `inspection-wide directory-entry limit reached (${opts.budget.maxEntries})`,
          );
          stop = true;
          break;
        }
        entries.push(entry);
        visitedEntries += 1;
      }
    } catch {
      continue;
    } finally {
      if (handle) {
        try {
          handle.closeSync();
        } catch {
          // The walk is best-effort; an already-closed directory needs no action.
        }
      }
    }
    // Deterministic order.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.realpathSync(abs);
        } catch {
          continue; // dangling symlink
        }
        if (!isInside(rootReal, target)) {
          skippedEscapingSymlinks.push(abs);
          continue;
        }
        let tstat: fs.Stats;
        try {
          tstat = fs.statSync(target);
        } catch {
          continue;
        }
        if (tstat.isDirectory()) {
          if (visitedDirs.has(target)) {
            skippedDirSymlinks.push(abs);
            continue;
          }
          if (depth + 1 <= maxDepth) {
            stack.push({ dir: abs, depth: depth + 1 });
          } else {
            truncationReasons.add(`depth limit reached (${maxDepth})`);
          }
          continue;
        }
        if (tstat.isFile() && (!opts.filter || opts.filter(abs))) {
          if (files.length >= maxFiles) {
            truncationReasons.add(`returned-file limit reached (${maxFiles})`);
            stop = true;
            break;
          }
          if (opts.budget && !opts.budget.claimFile()) {
            truncationReasons.add(
              `inspection-wide returned-file limit reached (${opts.budget.maxFiles})`,
            );
            stop = true;
            break;
          }
          files.push({ abs, viaSymlink: true });
        }
        continue;
      }
      if (ent.isDirectory()) {
        if (depth + 1 <= maxDepth) {
          stack.push({ dir: abs, depth: depth + 1 });
        } else {
          truncationReasons.add(`depth limit reached (${maxDepth})`);
        }
        continue;
      }
      if (ent.isFile() && (!opts.filter || opts.filter(abs))) {
        if (files.length >= maxFiles) {
          truncationReasons.add(`returned-file limit reached (${maxFiles})`);
          stop = true;
          break;
        }
        if (opts.budget && !opts.budget.claimFile()) {
          truncationReasons.add(
            `inspection-wide returned-file limit reached (${opts.budget.maxFiles})`,
          );
          stop = true;
          break;
        }
        files.push({ abs, viaSymlink: false });
      }
    }

    if (visitedEntries >= maxEntries) {
      truncationReasons.add(`directory-entry limit reached (${maxEntries})`);
      stop = true;
    }
  }

  files.sort((a, b) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0));
  return {
    files,
    skippedDirSymlinks,
    skippedEscapingSymlinks,
    truncated: truncationReasons.size > 0,
    truncationReasons: [...truncationReasons],
    visitedDirectories: visitedDirs.size,
    visitedEntries,
  };
}

function limit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
