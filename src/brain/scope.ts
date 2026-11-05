/**
 * Which records belong to the directory an agent starts in.
 *
 * A project scope is `project:<slug>`, where the slug is the directory spelled the way
 * Claude Code names its per-project folders (`<claude config dir>/projects/<slug>`): every character
 * that is not a letter or digit becomes `-`. Imported memories therefore keep the scope
 * they already had, and a record written from a directory gets the same key.
 *
 * One checkout has several spellings. A git worktree, a submodule whose git dir lives in
 * the parent repository, and a repository that moved all name the same project, so a
 * directory resolves to a SET of keys: its own slug, the worktree root's, the main
 * checkout's, and the repository's name from its `origin` remote. The name matches any
 * project slug that ends in `-<name>`, which is how a moved checkout still finds the
 * memories filed under its old path.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { GLOBAL_SCOPE, type BrainScope } from "./types.js";

export function pathSlug(path: string): string {
  return resolve(path).replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectScope(path: string): BrainScope {
  return `project:${pathSlug(path)}`;
}

export interface ProjectKeys {
  /** Exact slugs: the directory, its worktree root, and the main checkout. */
  slugs: string[];
  /** Repository name from `origin`, matched as a slug suffix. Null outside git or without a remote. */
  repoName: string | null;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The main checkout behind a worktree or a submodule's git dir, or null. */
function mainCheckout(cwd: string): string | null {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return null;
  if (basename(common) === ".git") return dirname(common);
  // A submodule's git dir sits under the parent's `.git/modules/…`; its checkout is `core.worktree`.
  const worktree = git(cwd, ["--git-dir", common, "config", "--get", "core.worktree"]);
  if (!worktree) return null;
  const path = isAbsolute(worktree) ? worktree : resolve(common, worktree);
  return existsSync(path) ? path : null;
}

export function projectKeysFor(cwd: string): ProjectKeys {
  const dir = resolve(cwd);
  const candidates = [dir];
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top) candidates.push(top);
  const main = mainCheckout(dir);
  if (main) candidates.push(main);
  const origin = git(dir, ["remote", "get-url", "origin"]);
  const repoName = origin ? basename(origin).replace(/\.git$/, "") || null : null;
  return { slugs: [...new Set(candidates.map(pathSlug))], repoName };
}

/** How a record's scope relates to a directory: its project, global, or neither. */
export function scopeRelation(scope: BrainScope, keys: ProjectKeys): "project" | "global" | null {
  if (scope === GLOBAL_SCOPE) return "global";
  if (!scope.startsWith("project:")) return null;
  const slug = scope.slice("project:".length);
  if (keys.slugs.includes(slug)) return "project";
  if (keys.repoName && slug.endsWith(`-${keys.repoName.replace(/[^a-zA-Z0-9]/g, "-")}`)) return "project";
  return null;
}
