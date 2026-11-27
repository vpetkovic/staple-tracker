/**
 * What plan-file discovery reads besides the files (design/plan.md, "Ideas from files"): where to
 * look, and what the person has ignored. Both are synchronized to every device; the paths are
 * repo-relative so every checkout reads them the same. Pure: no filesystem, no database.
 *
 * Where to look is one registered workspace setting, `plan.discoveryPaths`: the person edits it
 * as a whole, and two devices that change it offline raise a conflict like any setting.
 *
 * Each ignore is its own `setting` entity, keyed by the path and the content it had then
 * (`ignoredFileKey`), not an entry in one list: two devices that ignore different files offline,
 * or the same path while their checkouts hold different content, write different entities, so every
 * ignore lands with no conflict. Two that ignore the same content at the same path write the same
 * entity with the same value. Ending an ignore deletes it (a tombstone, as a reset setting has). Like the repository's prefix, these keys ride the setting entity every build
 * applies and are not registered settings: `staple settings` does not list them.
 */
import { createHash } from "node:crypto";

/** Where discovery looks when the person has not changed it: Markdown in the root, and everything under plans/ (in any case). */
export const DEFAULT_DISCOVERY_PATHS: readonly string[] = ["*.md", "plans/**"];

/** How many paths the setting holds: discovery stays bounded on a large repository. */
export const MAX_DISCOVERY_PATHS = 50;

/** The setting key prefix one ignored plan file travels under. */
export const IGNORED_FILE_SETTING_PREFIX = "plan.ignoredFile:";

/** The setting key one ignore travels under, from its path and hash: the same on every device. */
export function ignoredFileKey(entry: IgnoredPlanFile): string {
  return `${IGNORED_FILE_SETTING_PREFIX}${createHash("sha256").update(`${normalizeDiscoveryPath(entry.path)}\0${entry.hash}`).digest("hex").slice(0, 32)}`;
}

/** One file or folder the person ignored: where it was, and what it held then. */
export interface IgnoredPlanFile {
  path: string;
  hash: string;
}

const HASH = /^sha256:[0-9a-f]{64}$/;

/** A discovery path in its one spelling: forward slashes, no `./` and no trailing slash. */
export function normalizeDiscoveryPath(path: string): string {
  return path.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
}

/** Why one path is not a repo-relative path or glob, or null. */
export function discoveryPathEntryProblem(path: string): string | null {
  const clean = normalizeDiscoveryPath(path);
  if (clean === "") return "a path is empty";
  if (clean.length > 200) return `"${clean.slice(0, 40)}…" is longer than 200 characters`;
  if (clean.startsWith("/") || /^[a-z]:/i.test(clean)) return `"${clean}" is absolute; a discovery path is relative to the workspace root`;
  if (clean.includes("\\")) return `"${clean}" uses a backslash; write paths with forward slashes`;
  if (/[\0\n\r]/.test(clean)) return `"${clean}" holds a control character`;
  if (clean.split("/").some((segment) => segment === "..")) return `"${clean}" leaves the workspace root`;
  return null;
}

/** Why a value is not a list of discovery paths, or null. */
export function discoveryPathsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "a JSON list of repo-relative paths or globs, such as [\"*.md\", \"plans/**\"]";
  if (value.length > MAX_DISCOVERY_PATHS) return `at most ${MAX_DISCOVERY_PATHS} paths`;
  for (const entry of value) {
    if (typeof entry !== "string") return "every path is a string";
    const problem = discoveryPathEntryProblem(entry);
    if (problem !== null) return problem;
  }
  return null;
}

/** Whether a stored value is one ignored file: a repo-relative path and a sha256 hash. */
export function isIgnoredPlanFile(value: unknown): value is IgnoredPlanFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { path, hash } = value as Record<string, unknown>;
  return typeof path === "string" && discoveryPathEntryProblem(path) === null && typeof hash === "string" && HASH.test(hash);
}

/** The paths a stored value names, each in its one spelling and once. */
export function discoveryPaths(value: unknown): string[] {
  const list = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [...DEFAULT_DISCOVERY_PATHS];
  return [...new Set(list.map(normalizeDiscoveryPath).filter((entry) => entry !== ""))];
}
