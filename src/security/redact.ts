import { MAX_EVIDENCE_LEN } from "../constants.js";

const PLACEHOLDER = "[REDACTED]";
const SENSITIVE_ASSIGNMENT_KEY =
  String.raw`(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret)`;

/**
 * Patterns for values that look like credentials. Order matters: more specific
 * token shapes run before generic key/value assignments. These are heuristics
 * to prevent accidental leakage in excerpts, not a secret scanner.
 */
const SECRET_PATTERNS: RegExp[] = [
  // PEM private key blocks (collapse the whole block reference).
  /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g,
  // Provider-specific token shapes.
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{12,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
  // Quoted values may contain spaces, so match through the closing quote
  // before falling back to the single-token unquoted form.
  new RegExp(
    String.raw`\b${SENSITIVE_ASSIGNMENT_KEY}\b\s*[:=]\s*"(?:\\.|[^"\\\r\n])*"`,
    "gi",
  ),
  new RegExp(
    String.raw`\b${SENSITIVE_ASSIGNMENT_KEY}\b\s*[:=]\s*'(?:\\.|[^'\\\r\n])*'`,
    "gi",
  ),
  new RegExp(
    String.raw`\b${SENSITIVE_ASSIGNMENT_KEY}\b\s*[:=]\s*[^\s"']{6,}`,
    "gi",
  ),
];

/** Redact anything that looks like a credential from arbitrary text. */
export function redact(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      // Preserve an assignment's key name for readability, redact the value.
      const assign = match.match(/^([^:=]*[:=]\s*)/);
      if (assign && assign[1]) return assign[1] + PLACEHOLDER;
      return PLACEHOLDER;
    });
  }
  return out;
}

/**
 * Produce a single-line, length-bounded, credential-redacted excerpt suitable
 * for diagnostics output.
 */
export function excerpt(input: string, maxLen = MAX_EVIDENCE_LEN): string {
  const oneLine = redact(input).replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + "…";
}
