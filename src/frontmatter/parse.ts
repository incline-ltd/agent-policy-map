import { parse as parseYaml } from "yaml";

export type Frontmatter = Record<string, unknown>;

export type ParsedFrontmatter = {
  hasFrontmatter: boolean;
  /** Parsed mapping, or null when absent / not a mapping / invalid. */
  data: Frontmatter | null;
  /** Body text after the frontmatter block (or the whole file when absent). */
  body: string;
  /** Raw frontmatter text (without the `---` fences). */
  raw: string;
  /** YAML parse error message, when the block failed to parse. */
  error?: string;
};

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Extract and parse a leading YAML frontmatter block. Never evaluates the
 * content; `yaml.parse` builds plain data only.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  // A leading BOM is tolerated.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = FENCE.exec(src);
  if (!m) {
    return { hasFrontmatter: false, data: null, body: text, raw: "" };
  }
  const raw = m[1] ?? "";
  const body = src.slice(m[0].length);
  let data: Frontmatter | null = null;
  let error: string | undefined;
  try {
    const parsed: unknown = parseYaml(raw, { prettyErrors: false });
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Frontmatter;
    } else if (parsed === null || parsed === undefined) {
      data = {};
    } else {
      error = "frontmatter is not a key/value mapping";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return error === undefined
    ? { hasFrontmatter: true, data, body, raw }
    : { hasFrontmatter: true, data: null, body, raw, error };
}
