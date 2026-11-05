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
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

/**
 * The repository around a directory, read from `.git` on disk rather than by running git:
 * a hook runs on every prompt, and three `git` processes cost more than the whole retrieval.
 * Covers the three layouts that occur: a plain checkout (`.git` directory), a worktree
 * (`.git` file → `gitdir`, whose `commondir` names the shared directory) and a submodule
 * (`.git` file → the parent's `.git/modules/…`, whose checkout is `core.worktree`).
 */
interface GitLayout {
  top: string;
  main: string | null;
  origin: string | null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** One key from a git config file: `[section "sub"]` then `key = value`. */
function configValue(config: string, section: string, key: string): string | null {
  let inSection = false;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inSection = line.replace(/\s+/g, " ").toLowerCase() === section.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const match = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    if (match && match[1]!.toLowerCase() === key.toLowerCase()) return match[2]!.trim().replace(/^"(.*)"$/, "$1");
  }
  return null;
}

export function gitLayout(start: string): GitLayout | null {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, ".git");
    let stat;
    try {
      stat = statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "")?.[1]?.trim();
        if (!pointer) return null;
        gitDir = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
      }
      const commondir = readText(join(gitDir, "commondir"))?.trim();
      const common = commondir ? (isAbsolute(commondir) ? commondir : resolve(gitDir, commondir)) : gitDir;
      const config = readText(join(common, "config")) ?? "";
      let main: string | null = null;
      if (basename(common) === ".git") main = dirname(common);
      else {
        const worktree = configValue(config, "[core]", "worktree");
        if (worktree) {
          const path = isAbsolute(worktree) ? worktree : resolve(common, worktree);
          main = existsSync(path) ? path : null;
        }
      }
      return { top: dir, main, origin: configValue(config, '[remote "origin"]', "url") };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectKeysFor(cwd: string): ProjectKeys {
  const dir = resolve(cwd);
  const candidates = [dir];
  const layout = gitLayout(dir);
  if (layout) {
    candidates.push(layout.top);
    if (layout.main) candidates.push(layout.main);
  }
  const repoName = layout?.origin ? basename(layout.origin).replace(/\.git$/, "") || null : null;
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
