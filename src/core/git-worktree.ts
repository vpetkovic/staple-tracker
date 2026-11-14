/**
 * Linked git worktrees and the checkout they belong to.
 *
 * A workspace lives in a repository's main checkout. A linked worktree (`git worktree add`)
 * is a second working directory for the same repository and carries no `.staple/` of its own,
 * so walking up from it would reach whatever workspace sits in an ancestor directory.
 *
 * Everything is read from the files git writes, with no `git` process: this runs on every
 * resolution, and a missing `git` binary must not change which workspace a command opens.
 *
 *   <worktree>/.git                     file: `gitdir: <common>/worktrees/<name>`
 *   <common>/worktrees/<name>/commondir  file: path from that directory to <common>
 *   <common>                            `<main>/.git`, or a module directory (a submodule's
 *                                       repository) whose `config` (or `config.worktree`) names
 *                                       the checkout in `core.worktree`; a bare repository has
 *                                       no main checkout
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { StapleError } from "./types.js";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A `[core]` variable from a git config file: the first assignment, unquoted and without a trailing comment. */
function coreValue(configPath: string, key: string): string | null {
  const text = readText(configPath);
  if (text === null) return null;
  let inCore = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\s\]"]+)/.exec(line);
    if (section) {
      inCore = section[1]!.toLowerCase() === "core";
      continue;
    }
    if (!inCore) continue;
    const rest = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (rest?.[1]?.toLowerCase() !== key) continue;
    const value = rest[2]!;
    return value.startsWith('"') ? (/^"([^"]*)"/.exec(value)?.[1] ?? null) : value.replace(/\s*[;#].*$/, "");
  }
  return null;
}

/** The checkout `common` belongs to, or null when it names none. */
function mainCheckoutOf(common: string): string | null {
  const configured = coreValue(join(common, "config.worktree"), "worktree") ?? coreValue(join(common, "config"), "worktree");
  if (configured) return resolve(common, configured);
  return basename(common) === ".git" ? dirname(common) : null;
}

function refuse(worktree: string, why: string): StapleError {
  return new StapleError(
    "not_found",
    `${worktree} is a git worktree, but ${why}. Staple will not guess a workspace from the directories above it. ` +
      `Name the workspace explicitly (--ws or --db on the CLI, "ws" on an MCP call), or run from the main checkout.`,
    { worktreeRefusal: worktree },
  );
}

/**
 * The main checkout of the repository `dir` is a linked worktree of, or `null` when `dir` is not
 * the root of one, or its repository is bare (so there is no checkout to follow). Throws
 * `not_found` when `dir` is a linked worktree whose main checkout cannot be determined.
 */
export function linkedWorktreeMainCheckout(dir: string): string | null {
  const dotGit = join(dir, ".git");
  // Most directories on a walk have no `.git`; `throwIfNoEntry` keeps that case free of exceptions.
  if (!statSync(dotGit, { throwIfNoEntry: false })?.isFile()) return null;

  const gitdirLine = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "")?.[1];
  if (!gitdirLine) return null;
  const gitdir = resolve(dir, gitdirLine);
  // Only `<common>/worktrees/<name>` is a linked worktree; a submodule's `.git` file points at
  // `<super>/.git/modules/<name>` (which may itself sit under a directory called `worktrees`).
  if (basename(dirname(gitdir)) !== "worktrees") return null;
  if (!existsSync(gitdir)) throw refuse(dir, `its git directory ${gitdir} no longer exists`);

  const commondir = readText(join(gitdir, "commondir"))?.trim();
  if (!commondir) return null;
  const common = resolve(gitdir, commondir);

  // A bare repository has no main checkout, so its worktrees resolve by position like any directory.
  const bare = coreValue(join(common, "config.worktree"), "bare") ?? coreValue(join(common, "config"), "bare");
  if (bare === "true") return null;
  const main = mainCheckoutOf(common);
  if (main === null) {
    throw refuse(dir, `its repository at ${common} does not say where the main checkout is (no core.worktree)`);
  }
  if (!existsSync(main)) throw refuse(dir, `its main checkout ${main} no longer exists`);
  return main;
}
