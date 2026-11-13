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
 *                                       repository, or a `--separate-git-dir`) whose `config`
 *                                       names the checkout in `core.worktree`
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { StapleError } from "./types.js";

/** Directory git keeps each linked worktree's private state in, under the common git directory. */
const WORKTREES_DIRNAME = "worktrees";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The `core.worktree` value in a git config file, or null. Only the `[core]` section is read. */
function coreWorktree(configPath: string): string | null {
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
    const value = /^worktree\s*=\s*(.*)$/i.exec(line)?.[1]?.trim();
    if (value) return value.replace(/^"(.*)"$/, "$1");
  }
  return null;
}

function refuse(worktree: string, why: string): StapleError {
  return new StapleError(
    "not_found",
    `${worktree} is a git worktree, but ${why}. Staple will not guess a workspace from the directories above it. ` +
      `Pass --ws <slug> or --db <path>, or run from the main checkout.`,
  );
}

/**
 * The main checkout of the repository that `dir` is a linked worktree of, or `null` when `dir`
 * is not the root of a linked worktree (an ordinary checkout, a submodule's own checkout, or no
 * repository at all).
 *
 * Throws `not_found` when `dir` is a linked worktree whose main checkout cannot be determined.
 */
export function linkedWorktreeMainCheckout(dir: string): string | null {
  const dotGit = join(dir, ".git");
  let isFile = false;
  try {
    isFile = lstatSync(dotGit).isFile();
  } catch {
    return null;
  }
  if (!isFile) return null;

  const gitdirLine = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "")?.[1];
  if (!gitdirLine) return null;
  const gitdir = resolve(dir, gitdirLine);
  // Only `<common>/worktrees/<name>` is a linked worktree; a submodule's `.git` file points
  // at `<super>/.git/modules/<name>`, which is a checkout in its own right.
  if (basename(dirname(gitdir)) !== WORKTREES_DIRNAME) return null;

  const commondir = readText(join(gitdir, "commondir"))?.trim();
  if (!commondir) throw refuse(dir, `its git directory ${gitdir} is missing or has no commondir`);
  const common = resolve(gitdir, commondir);

  let main: string | null = null;
  if (basename(common) === ".git") main = dirname(common);
  else {
    const configured = coreWorktree(join(common, "config"));
    if (configured) main = resolve(common, configured);
  }
  if (main === null) {
    throw refuse(dir, `its repository at ${common} does not say where the main checkout is (no core.worktree)`);
  }
  if (!existsSync(main)) throw refuse(dir, `its main checkout ${main} no longer exists`);
  return main;
}
