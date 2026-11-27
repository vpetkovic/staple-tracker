/**
 * A file a person or an agent imports as an idea (design/plan.md, "Ideas from files"): a plan
 * written as Markdown, or a chat export or design kept as HTML or JSX. Pure: it reads the file and
 * answers what the idea is made of; the store captures it and attaches the original under Files.
 *
 * Markdown maps to the idea's sections (`parsePlanMarkdown`). HTML and JSX are read only for a
 * title; the rest stays in the original, which an agent reads when it classifies the idea.
 */
import { assertAttachable } from "./attachments.js";
import { emptySections, parsePlanMarkdown, type ImportResult } from "./plan-sections.js";
import { StapleError } from "./types.js";

/** What a file is read as, from its extension. */
export type ImportFormat = "markdown" | "html" | "jsx";

const FORMATS: ReadonlyArray<{ format: ImportFormat; extensions: readonly string[] }> = [
  { format: "markdown", extensions: [".md", ".markdown"] },
  { format: "html", extensions: [".html", ".htm"] },
  { format: "jsx", extensions: [".jsx"] },
];

/** The extensions an import takes, as the refusal and the file picker name them. */
export const IMPORT_EXTENSIONS: readonly string[] = FORMATS.flatMap((entry) => entry.extensions);

export interface ImportFile {
  format: ImportFormat;
  /** The bytes as given: what is attached. */
  bytes: Uint8Array;
  parsed: ImportResult;
}

/** The format a file name says, or null for one an import does not take. */
export function importFormatOf(name: string): ImportFormat | null {
  const lower = name.trim().toLowerCase();
  return FORMATS.find((entry) => entry.extensions.some((extension) => lower.endsWith(extension)))?.format ?? null;
}

/**
 * Read one file to import. Refused, before anything is written, when its name is not a .md, .html
 * or .jsx file, when it is not UTF-8 text, when it is empty, or when it is over the file cap.
 */
export function readImportFile(name: string, content: string | Uint8Array): ImportFile {
  const format = importFormatOf(name);
  if (format === null) {
    throw new StapleError("validation", `An idea is imported from a .md, .html or .jsx file; "${name}" is none of these.`, { filename: name, accepted: IMPORT_EXTENSIONS });
  }
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  assertAttachable(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StapleError("validation", `"${name}" is not UTF-8 text, so it cannot be imported as an idea.`, { filename: name });
  }
  if (text.trim() === "") throw new StapleError("validation", `"${name}" is empty: there is nothing to import.`, { filename: name });
  const fallback = stem(name);
  const parsed = format === "markdown" ? parsePlanMarkdown(text, fallback) : { ...titleOnly(format === "html" ? (htmlTitle(text) ?? fallback) : fallback) };
  return { format, bytes, parsed };
}

/** The name without its folder or extension: the title a file with none of its own gets. */
function stem(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  const bare = (dot > 0 ? base.slice(0, dot) : base).trim();
  return bare || "Imported idea";
}

function titleOnly(title: string): ImportResult {
  return { title, brief: null, sections: { ...emptySections(), breakdown: [] }, questions: [], decisions: [], warnings: [] };
}

/** An HTML page's own title: its `<title>`, else its first `<h1>`, as plain text; null for none. */
export function htmlTitle(html: string): string | null {
  for (const pattern of [/<title\b[^>]*>([\s\S]*?)<\/title>/i, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i]) {
    const match = pattern.exec(html);
    if (!match) continue;
    const text = decodeEntities(match[1]!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}
