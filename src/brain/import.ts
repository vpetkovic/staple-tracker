/**
 * Import Claude Code auto-memory files (`<claude config dir>/projects/<slug>/memory/*.md`).
 *
 * Read-only on the source. The files come in more than one shape: `type:` at the top
 * level or under `metadata:`, with or without `node_type: memory`, `originSessionId` and
 * `modified`. `MEMORY.md` is an index of the others and is skipped.
 *
 * Scope policy (POC): `user` and `feedback` records become global, because they describe
 * how the user wants agents to work rather than a codebase; `project` and
 * `reference` records keep their folder's project scope. The report measures where that
 * rule is wrong.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stableId, type RememberInput } from "./store.js";
import { GLOBAL_SCOPE, isBrainKind, type BrainKind } from "./types.js";

export interface ParsedMemory {
  path: string;
  projectSlug: string;
  input: RememberInput;
}

export interface ImportPlan {
  memories: ParsedMemory[];
  skipped: Array<{ path: string; reason: string }>;
}

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try {
      return v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** Flat `key: value` fields; a nested key is stored under its own name (`metadata.type` → `type`) unless the top level set it. */
export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith("---")) return { fields: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const raw of text.slice(3, end).split("\n")) {
    const match = /^(\s*)([A-Za-z_][\w-]*):\s?(.*)$/.exec(raw);
    if (!match) continue;
    const [, indent, key, value] = match;
    if (value!.trim() === "") continue;
    const nested = indent!.length > 0;
    if (nested && key! in fields) continue;
    fields[key!] = unquote(value!);
  }
  return { fields, body: text.slice(end + 4).replace(/^\s*\n/, "") };
}

/** `**Why:** …` up to the next bold label or the end. */
export function extractWhy(body: string): string | null {
  const match = /\*\*Why:?\*\*:?\s*([\s\S]*?)(?=\n\s*\*\*[A-Z][^*]*:?\*\*|$)/.exec(body);
  const why = match?.[1]?.trim();
  return why ? why : null;
}

function links(body: string): string[] {
  return [...new Set([...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!.trim()))];
}

export function parseMemoryFile(path: string, projectSlug: string): ParsedMemory | { path: string; reason: string } {
  const text = readFileSync(path, "utf8");
  const { fields, body } = parseFrontmatter(text);
  const kind = fields.type;
  if (!isBrainKind(kind)) return { path, reason: `no recognised type (${kind ?? "missing"})` };
  if (!body.trim()) return { path, reason: "empty body" };
  const modified = fields.modified ?? statSync(path).mtime.toISOString();
  const scope = kind === "user" || kind === "feedback" ? GLOBAL_SCOPE : `project:${projectSlug}`;
  return {
    path,
    projectSlug,
    input: {
      id: stableId(`claude-memory:${path}`),
      kind: kind as BrainKind,
      name: fields.name ?? null,
      description: fields.description ?? null,
      body: body.trim(),
      why: extractWhy(body),
      scope,
      tags: [`from:${projectSlug}`, ...links(body)],
      source: `import:${path}`,
      createdAt: modified,
      verifiedAt: modified,
    },
  };
}

/** Every memory file under a Claude projects directory. */
export function planImport(projectsDir: string): ImportPlan {
  const plan: ImportPlan = { memories: [], skipped: [] };
  if (!existsSync(projectsDir)) return plan;
  for (const slug of readdirSync(projectsDir).sort()) {
    const memoryDir = join(projectsDir, slug, "memory");
    let files: string[];
    try {
      files = readdirSync(memoryDir);
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      const parsed = parseMemoryFile(join(memoryDir, file), slug);
      if ("input" in parsed) plan.memories.push(parsed);
      else plan.skipped.push(parsed);
    }
  }
  return plan;
}
