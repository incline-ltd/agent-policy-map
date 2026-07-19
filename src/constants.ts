/**
 * Bounds and documented limits.
 *
 * Hard safety bounds protect against pathological trees and content leakage.
 * Documented limits (like Codex's 32 KiB project-doc cap) are separate and are
 * only enforced where official documentation defines them.
 */

/** Hard safety cap on a single file read, independent of any agent doc cap. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Total files a single inspection may open. */
export const MAX_TOTAL_FILES = 5_000;

/** Total bytes a single inspection may read. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Max directory depth for a bounded rules/instructions walk. */
export const MAX_WALK_DEPTH = 32;

/** Max directories a single walk may open. */
export const MAX_WALK_DIRECTORIES = 5_000;

/** Max directory entries a single walk may inspect. */
export const MAX_WALK_ENTRIES = 50_000;

/** Max ancestor levels to walk upward from cwd toward a project root. */
export const MAX_ASCEND_LEVELS = 64;

/** Codex documented default for `project_doc_max_bytes`. */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024; // 32 KiB

/** Codex documented fallback project-doc filenames (besides AGENTS.md). */
export const CODEX_DEFAULT_FALLBACK_NAMES = ["AGENTS.md"] as const;

/**
 * Claude Code documented recursive import limit: imports are followed to a
 * maximum depth of 5 hops.
 */
export const CLAUDE_MAX_IMPORT_HOPS = 5;

/** Number of hex chars kept from the sha256 digest for `contentHash`. */
export const CONTENT_HASH_LEN = 16;

/** Rough bytes-per-token divisor for the labelled token estimate. */
export const APPROX_BYTES_PER_TOKEN = 4;

/** Max length of a redacted excerpt line included as evidence. */
export const MAX_EVIDENCE_LEN = 160;
