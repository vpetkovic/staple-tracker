/**
 * The main-line guard `run drive` keeps around every session: what `master` and `main`
 * point at in the session's repository, read before the session starts and again after it
 * ends. If either moved, the session landed work on the main line, which a driven session
 * must never do (the brief forbids it; landing work is a person's decision). The driver
 * then fails the ticket (`touched_main_line`) and stops the run.
 *
 * Plain file reads, no version-control process: the loose refs
 * (`refs/heads/master`, `refs/heads/main`) and their lines in `packed-refs`, in the
 * repository's common directory, so a linked worktree reads the refs it shares with the
 * main checkout. A directory that is not in a repository has nothing to guard (null).
 *
 * What it can see is the local repository. A session that pushes straight to a remote
 * without moving its local refs is outside it; that is the remote's branch protection's.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MAIN_LINE_BRANCHES = ["master", "main"] as const;

/** Each main-line branch's commit, or null when it does not exist. */
export type MainLineSnapshot = Record<(typeof MAIN_LINE_BRANCHES)[number], string | null>;

/** The repository's common directory for `cwd`, or null outside a repository. */
export function commonDirectory(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      if (statSync(dotGit).isFile()) {
        // A linked worktree or submodule: ".git" is a file naming the real directory.
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (!pointer) return null;
        gitDir = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
      }
      const common = join(gitDir, "commondir");
      if (!existsSync(common)) return gitDir;
      const target = readFileSync(common, "utf8").trim();
      return isAbsolute(target) ? target : resolve(gitDir, target);
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Where the main-line branches point now, or null when `cwd` is not in a repository. */
export function mainLineSnapshot(cwd: string): MainLineSnapshot | null {
  const common = commonDirectory(cwd);
  if (common === null) return null;
  const packed = existsSync(join(common, "packed-refs")) ? readFileSync(join(common, "packed-refs"), "utf8") : "";
  const read = (branch: string): string | null => {
    const loose = join(common, "refs", "heads", branch);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    const line = packed.split("\n").find((entry) => entry.trim().endsWith(` refs/heads/${branch}`));
    return line ? line.trim().split(" ")[0]! : null;
  };
  return { master: read("master"), main: read("main") };
}

/** The branches that moved between two snapshots, as `master a1b2c3d -> e4f5a6b`. */
export function mainLineMoves(before: MainLineSnapshot | null, after: MainLineSnapshot | null): string[] {
  if (before === null || after === null) return [];
  return MAIN_LINE_BRANCHES.filter((branch) => before[branch] !== after[branch]).map(
    (branch) => `${branch} ${before[branch]?.slice(0, 12) ?? "(none)"} -> ${after[branch]?.slice(0, 12) ?? "(none)"}`,
  );
}
