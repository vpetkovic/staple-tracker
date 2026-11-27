/**
 * Plan files in the workspace (design/plan.md, "Ideas from files"): which files and folders under
 * the workspace root look like plans a person may import as ideas. It only reads: nothing is
 * imported, moved or edited here. The store (`PlanStore.discoverFiles`) adds what each one is to
 * the tracker (new, imported, changed since import, ignored), and imports what the person picks.
 *
 * Where it looks is the synchronized `plan.discoveryPaths` setting: repo-relative globs, matched
 * in any case, so `plans/**` finds `Plans/` too. `*` matches within one folder name and `**` any
 * depth; a path with no `*` is that file, or everything under that folder.
 *
 * What it leaves out wherever it looks: repository documents (README, AGENTS, CLAUDE, CHANGELOG
 * and their kind), anything whose name starts with `_` (templates), `assets/` folders (they belong
 * to the plan beside them), handoffs, hidden folders and `node_modules`.
 *
 * A folder that holds an `assets/` folder, below where a path starts, is one plan: its main file
 * (named for the folder, else plan, index or readme, else the first) becomes the idea and every
 * file in it is attached.
 *
 * Bounded so a large repository stays cheap: a depth, a count of entries read and a count of
 * plans; past any of them the answer says it was cut short. Links are never followed.
 */
import { closeSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ATTACH_MAX_BYTES, sha256Hex } from "./attachments.js";
import { importFormatOf, readImportFile, type ImportFormat } from "./plan-import.js";
import { normalizeDiscoveryPath } from "./plan-discovery-paths.js";
import { StapleError } from "./types.js";

/** One plan the workspace holds: a file, or a folder with assets imported as one. */
export interface DiscoveredPlan {
  /** Repo-relative, forward slashes, as spelled on disk: the file, or the folder. */
  path: string;
  kind: "file" | "folder";
  /** The file the idea is read from (repo-relative). */
  main: string;
  /** Every file the import attaches, the main one first (repo-relative). */
  files: string[];
  format: ImportFormat;
  title: string;
  /** The status the file states (front matter `status:`, or a Status line near the top), or null. */
  status: string | null;
  /** Whether the plan reads as delivered: its status, or a done/completed/implemented folder. */
  done: boolean;
  /** `sha256:<hex>` of the file, or of the folder's sorted list of paths and hashes. */
  hash: string;
  bytes: number;
  /** Why it cannot be imported as it stands (too large, not text, empty), or null. */
  problem: string | null;
}

export interface DiscoveryLimits {
  depth: number;
  entries: number;
  plans: number;
  /** Files one folder plan may hold. */
  folderFiles: number;
}

export const DISCOVERY_LIMITS: DiscoveryLimits = { depth: 8, entries: 4000, plans: 500, folderFiles: 50 };

export interface Discovery {
  plans: DiscoveredPlan[];
  /** True when a limit stopped the walk: more may be there. */
  truncated: boolean;
}

/** The directory that holds `.staple/` (or the legacy `.tasks/`) for a database path, or null for a global workspace. */
export function workspaceRootOf(dbPath: string): string | null {
  const folder = basename(dirname(dbPath));
  return folder === ".staple" || folder === ".tasks" ? dirname(dirname(dbPath)) : null;
}

/** Repository documents that are not plans, by name without extension. */
const REPOSITORY_DOCS = new Set([
  "readme", "agents", "claude", "gemini", "copilot-instructions", "changelog", "changes", "history", "news", "release-notes", "releases",
  "releasing", "contributing", "code_of_conduct", "code-of-conduct", "security", "support", "license", "licence", "copying", "notice",
  "third-party-notices", "authors", "contributors", "maintainers", "codeowners", "governance",
]);

const SKIPPED_FOLDERS = new Set(["node_modules", "assets", "handoff", "handoffs"]);
const DONE_FOLDERS = new Set(["done", "completed", "implemented"]);
const DONE_WORDS = /^(?:done|complete|completed|implemented|shipped|delivered|finished)\b/i;

interface Pattern {
  segments: string[];
  /** How many leading segments are plain names: where the pattern starts looking. */
  base: number;
}

/** A setting's paths as patterns: a plain path is that file and everything beneath it. */
function patterns(paths: readonly string[]): Pattern[] {
  const out: Pattern[] = [];
  for (const raw of paths) {
    const path = normalizeDiscoveryPath(raw);
    if (path === "") continue;
    const segments = path.split("/");
    const base = segments.findIndex((segment) => segment.includes("*"));
    if (base === -1) {
      out.push({ segments, base: segments.length }, { segments: [...segments, "**"], base: segments.length });
    } else out.push({ segments, base });
  }
  return out;
}

const segmentRegex = new Map<string, RegExp>();
function segmentMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern.toLowerCase() === name.toLowerCase();
  let regex = segmentRegex.get(pattern);
  if (regex === undefined) {
    regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`, "i");
    segmentRegex.set(pattern, regex);
  }
  return regex.test(name);
}

/** Whether a pattern matches a whole path. */
function matches(pattern: readonly string[], path: readonly string[], i = 0, j = 0): boolean {
  if (i === pattern.length) return j === path.length;
  if (pattern[i] === "**") return matches(pattern, path, i + 1, j) || (j < path.length && matches(pattern, path, i, j + 1));
  return j < path.length && segmentMatches(pattern[i]!, path[j]!) && matches(pattern, path, i + 1, j + 1);
}

/** Whether a pattern could match something beneath a folder. */
function reaches(pattern: readonly string[], folder: readonly string[], i = 0, j = 0): boolean {
  if (j === folder.length) return i < pattern.length;
  if (i === pattern.length) return false;
  if (pattern[i] === "**") return reaches(pattern, folder, i + 1, j) || reaches(pattern, folder, i, j + 1);
  return segmentMatches(pattern[i]!, folder[j]!) && reaches(pattern, folder, i + 1, j + 1);
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/** Whether a file is never a plan on its own: a repository document, a template or a handoff. */
function skippedFile(name: string): boolean {
  const stem = stemOf(name);
  return name.startsWith("_") || name.startsWith(".") || REPOSITORY_DOCS.has(stem) || stem.startsWith("handoff");
}

function skippedFolder(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_") || SKIPPED_FOLDERS.has(name.toLowerCase());
}

/** The status a plan states near its top: YAML front matter `status:`, or a `Status:` line (bold or not). */
export function planStatus(text: string): string | null {
  const body = text.replace(/\r\n?/g, "\n");
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(body);
  const clean = (value: string) => {
    const out = value.replace(/^["'\s]+|["'\s]+$/g, "").replace(/[*_`]/g, "").trim();
    return out === "" ? null : out.length > 60 ? `${out.slice(0, 59)}…` : out;
  };
  if (front) {
    const line = /^status\s*:\s*(.+)$/im.exec(front[1]!);
    if (line) return clean(line[1]!);
  }
  const lines = (front ? body.slice(front[0].length) : body).split("\n").slice(0, 40);
  for (const line of lines) {
    const match = /^\s*(?:>\s*)?(?:[-*]\s+)?(?:\*\*|__)?status(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/i.exec(line)
      ?? /^\s*\|\s*\**status\**\s*\|\s*([^|]+)\|/i.exec(line);
    if (match) return clean(match[1]!);
  }
  return null;
}

/** Whether a stated status says the plan was delivered. */
export function doneStatus(status: string | null): boolean {
  return status !== null && DONE_WORDS.test(status.replace(/^[^a-z]+/i, ""));
}

function entriesOf(dir: string, budget: { entries: number; truncated: boolean }): Dirent[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.length > budget.entries) {
    budget.truncated = true;
    entries = entries.slice(0, Math.max(0, budget.entries));
  }
  budget.entries -= entries.length;
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A file's bytes when it is at most the attachment cap; null past it. */
function readCapped(path: string): Uint8Array | null {
  const size = statSync(path).size;
  if (size > ATTACH_MAX_BYTES) return null;
  const bytes = new Uint8Array(size);
  const fd = openSync(path, "r");
  try {
    let at = 0;
    while (at < size) {
      const read = readSync(fd, bytes, at, size - at, at);
      if (read === 0) break;
      at += read;
    }
    return at === size ? bytes : bytes.subarray(0, at);
  } finally {
    closeSync(fd);
  }
}

/** The main file of a folder plan: named for the folder, else plan, index or readme, else the first Markdown, else the first file. */
function mainOf(folder: string, names: readonly string[]): string {
  const own = stemOf(folder);
  const markdown = names.filter((name) => importFormatOf(name) === "markdown");
  return (
    names.find((name) => stemOf(name) === own) ??
    markdown.find((name) => ["plan", "index", "readme"].includes(stemOf(name))) ??
    markdown[0] ??
    names[0]!
  );
}

/** Every file in a folder plan (repo-relative, sorted), up to the folder's limit; null past it. */
function folderFiles(root: string, rel: string, limit: number, budget: { entries: number; truncated: boolean }): string[] | null {
  const out: string[] = [];
  const walk = (folder: string, depth: number): boolean => {
    for (const entry of entriesOf(join(root, folder), budget)) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < 4 && !walk(path, depth + 1)) return false;
      } else if (entry.isFile()) {
        out.push(path);
        if (out.length > limit) return false;
      }
    }
    return true;
  };
  return walk(rel, 0) ? out.sort() : null;
}

/** Read a plan's parts as discovery sees them: title, status, hash and any problem. */
function describe(root: string, path: string, kind: "file" | "folder", main: string, files: string[] | null, folderLimit: number): DiscoveredPlan {
  const format = importFormatOf(main)!;
  const plan: DiscoveredPlan = { path, kind, main, files: files ?? [main], format, title: basename(path), status: null, done: false, hash: "", bytes: 0, problem: null };
  plan.done = path.split("/").some((segment) => DONE_FOLDERS.has(segment.toLowerCase()));
  if (files === null) {
    plan.problem = `holds more than ${folderLimit} files`;
    plan.hash = `sha256:${sha256Hex(new TextEncoder().encode(`folder:${path}`))}`;
    return plan;
  }
  const hashes = new Map<string, string>();
  for (const file of plan.files) {
    const bytes = readCapped(join(root, file));
    if (bytes === null) {
      const size = statSync(join(root, file)).size;
      plan.bytes += size;
      plan.problem ??= `${file} is over ${ATTACH_MAX_BYTES / (1024 * 1024)} MiB`;
      hashes.set(file, sha256Hex(new TextEncoder().encode(`size:${size}`)));
      continue;
    }
    plan.bytes += bytes.byteLength;
    hashes.set(file, sha256Hex(bytes));
    if (file !== main) continue;
    try {
      // A folder plan's title falls back to the folder's name, not its main file's.
      const name = kind === "folder" ? `${basename(path)}${main.slice(main.lastIndexOf("."))}` : basename(main);
      plan.title = readImportFile(name, bytes).parsed.title;
      if (format === "markdown") plan.status = planStatus(new TextDecoder().decode(bytes));
    } catch (error) {
      plan.problem ??= error instanceof StapleError ? error.message : String(error);
    }
  }
  if (plan.problem === null && plan.bytes > ATTACH_MAX_BYTES) plan.problem = `its files are over ${ATTACH_MAX_BYTES / (1024 * 1024)} MiB together`;
  plan.hash = kind === "file"
    ? `sha256:${hashes.get(main)!}`
    : `sha256:${sha256Hex(new TextEncoder().encode([...hashes].map(([file, hex]) => `${file.slice(path.length + 1)}\0${hex}\n`).sort().join("")))}`;
  plan.done ||= doneStatus(plan.status);
  return plan;
}

/**
 * The plans under `root` that `paths` reach, sorted by path. Reads the files to hash and title
 * them; writes nothing.
 */
export function discoverPlanFiles(root: string, paths: readonly string[], limits: DiscoveryLimits = DISCOVERY_LIMITS): Discovery {
  const list = patterns(paths);
  const budget = { entries: limits.entries, truncated: false };
  const plans: DiscoveredPlan[] = [];
  const full = () => {
    if (plans.length < limits.plans) return false;
    budget.truncated = true;
    return true;
  };
  const visit = (folder: string[], depth: number): void => {
    const rel = folder.join("/");
    const entries = entriesOf(rel === "" ? root : join(root, rel), budget);
    // A folder with assets below where a path starts is one plan.
    if (folder.length > 0 && entries.some((entry) => entry.isDirectory() && entry.name.toLowerCase() === "assets")) {
      const own = entries.filter((entry) => entry.isFile() && importFormatOf(entry.name) !== null).map((entry) => entry.name);
      const reached = own.some((name) => list.some((pattern) => folder.length > pattern.base && matches(pattern.segments, [...folder, name])));
      if (reached) {
        if (full()) return;
        const main = `${rel}/${mainOf(folder.at(-1)!, own)}`;
        const files = folderFiles(root, rel, limits.folderFiles, budget);
        plans.push(describe(root, rel, "folder", main, files && [main, ...files.filter((file) => file !== main)], limits.folderFiles));
        return;
      }
    }
    for (const entry of entries) {
      if (full()) return;
      const path = [...folder, entry.name];
      if (entry.isDirectory()) {
        if (skippedFolder(entry.name)) continue;
        if (depth + 1 > limits.depth) {
          budget.truncated = true;
          continue;
        }
        if (list.some((pattern) => reaches(pattern.segments, path))) visit(path, depth + 1);
      } else if (entry.isFile()) {
        if (skippedFile(entry.name) || importFormatOf(entry.name) === null) continue;
        if (!list.some((pattern) => matches(pattern.segments, path))) continue;
        const file = path.join("/");
        plans.push(describe(root, file, "file", file, [file], limits.folderFiles));
      }
    }
  };
  visit([], 0);
  return { plans: plans.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), truncated: budget.truncated };
}
