import fs from "node:fs";
import crypto from "node:crypto";
import {
  CONTENT_HASH_LEN,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_TOTAL_FILES,
} from "../constants.js";
import { realpathContained } from "./paths.js";

/**
 * Tracks aggregate read budget across a single inspection so a pathological
 * tree cannot make the tool read unbounded files or bytes.
 */
export class Budget {
  files = 0;
  bytes = 0;
  private exceeded = false;
  readonly notes: string[] = [];

  constructor(
    readonly maxFiles = MAX_TOTAL_FILES,
    readonly maxBytes = MAX_TOTAL_BYTES,
  ) {}

  /** Returns false when a new read would exceed a global cap. */
  canRead(nextBytes: number): boolean {
    if (this.files + 1 > this.maxFiles) {
      this.flag(`file budget exhausted (${this.maxFiles} files)`);
      return false;
    }
    if (this.bytes + nextBytes > this.maxBytes) {
      this.flag(`byte budget exhausted (${this.maxBytes} bytes)`);
      return false;
    }
    return true;
  }

  record(bytes: number): void {
    this.files += 1;
    this.bytes += bytes;
  }

  private flag(note: string): void {
    if (!this.exceeded) {
      this.exceeded = true;
      this.notes.push(note);
    }
  }

  get isExceeded(): boolean {
    return this.exceeded;
  }
}

export type ReadResult = {
  /** File content actually read (never more than the safety cap). */
  content: string;
  /** Number of bytes actually read and represented by `content`. */
  bytes: number;
  /** Full on-disk size, when known. */
  totalBytes?: number;
  /** Line count of the content that was read. */
  lines: number;
  /** True when the file was larger than the per-file safety cap. */
  truncated: boolean;
  /** Short sha256 of `content`; omitted when a hard safety bound truncated the read. */
  contentHash?: string;
};

export type ReadError = {
  error: true;
  code: string;
  message: string;
};

export function isReadError(v: ReadResult | ReadError): v is ReadError {
  return (v as ReadError).error === true;
}

function hash(content: string | NodeJS.ArrayBufferView): string {
  return crypto
    .createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, CONTENT_HASH_LEN);
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * Read a UTF-8 text file with per-file and global bounds. Never follows or
 * executes anything; this is a plain, read-only byte read.
 */
export function readTextBounded(
  abs: string,
  budget: Budget,
  perFileCap = MAX_FILE_BYTES,
  allowedRoots?: readonly string[],
): ReadResult | ReadError {
  let readPath = abs;
  try {
    if (allowedRoots !== undefined) {
      const contained = realpathContained(abs, allowedRoots);
      if (contained === null) {
        return {
          error: true,
          code: "EOUTSIDE",
          message: "path resolves outside the allowed read roots",
        };
      }
      readPath = contained;
    } else {
      // Canonicalize even when a legacy caller has not supplied roots. This
      // removes the final symlink before opening; containment is enforced by
      // callers that provide allowedRoots (all direct instruction reads do).
      readPath = fs.realpathSync(abs);
    }
  } catch (err) {
    return toReadError(err);
  }

  let fd: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(readPath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return { error: true, code: "ENOTFILE", message: "not a regular file" };
    }

    const requestedCap = Number.isFinite(perFileCap)
      ? Math.max(0, Math.floor(perFileCap))
      : MAX_FILE_BYTES;
    const cap = Math.min(requestedCap, MAX_FILE_BYTES);
    const truncated = stat.size > cap;
    const toRead = Math.min(stat.size, cap);
    if (!budget.canRead(toRead)) {
      return {
        error: true,
        code: "EBUDGET",
        message: "read budget exhausted",
      };
    }

    const buffer = Buffer.alloc(toRead);
    let bytesRead = 0;
    while (bytesRead < toRead) {
      const n = fs.readSync(fd, buffer, bytesRead, toRead - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    const raw = bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
    budget.record(raw.byteLength);
    const content = raw.toString("utf8");
    return {
      content,
      bytes: raw.byteLength,
      totalBytes: stat.size,
      lines: countLines(content),
      truncated,
      ...(!truncated ? { contentHash: hash(raw) } : {}),
    };
  } catch (err) {
    return toReadError(err);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the read result/error; there is no useful recovery here.
      }
    }
  }
}

function toReadError(err: unknown): ReadError {
  const e = err as NodeJS.ErrnoException;
  return {
    error: true,
    code: e?.code ?? "EUNKNOWN",
    message: e?.message ?? String(err),
  };
}

/** sha256 (short) of an arbitrary string, used for import de-duplication. */
export function shortHash(content: string | NodeJS.ArrayBufferView): string {
  return hash(content);
}
