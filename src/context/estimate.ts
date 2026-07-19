import { APPROX_BYTES_PER_TOKEN } from "../constants.js";
import type { ContextEstimate, PolicySource } from "../types.js";

/**
 * Aggregate a context estimate from the discovered sources.
 *
 * `bytes`/`lines`/`approxTokens` cover everything that could load (active +
 * conditional + manual). Excluded and unknown-external sources contribute
 * nothing because they either will not load or cannot be seen locally.
 * `omittedByCapBytes` is content an official cap (e.g. Codex 32 KiB) drops.
 */
export function estimateContext(
  sources: PolicySource[],
  omittedByCapBytes: number,
): ContextEstimate {
  let activeBytes = 0;
  let conditionalBytes = 0;
  let manualBytes = 0;
  let lines = 0;

  for (const s of sources) {
    const b = s.bytes ?? 0;
    const l = s.lines ?? 0;
    switch (s.state) {
      case "active":
        activeBytes += b;
        lines += l;
        break;
      case "conditional":
        conditionalBytes += b;
        lines += l;
        break;
      case "manual":
        manualBytes += b;
        lines += l;
        break;
      case "excluded":
      case "unknown-external":
        break;
    }
  }

  // Sources already report only the content prefix admitted by an official
  // cap. `omittedByCapBytes` remains separate evidence about what was dropped.
  const bytes = activeBytes + conditionalBytes + manualBytes;
  const approxTokens = Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);

  return {
    bytes,
    lines,
    approxTokens,
    activeBytes,
    conditionalBytes,
    manualBytes,
    omittedByCapBytes,
    note: `approxTokens is a rough estimate (~${APPROX_BYTES_PER_TOKEN} bytes/token), not a model token count`,
  };
}
