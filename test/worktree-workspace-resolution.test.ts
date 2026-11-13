/**
 * A linked git worktree has no `.staple/` of its own: the workspace belongs to the
 * main checkout. Resolving by walking up from the worktree finds whatever workspace
 * happens to sit in an ancestor (the machine's home workspace, on a typical host),
 * so a worktree must resolve like its main checkout or refuse.
 *
 * Every repository here is built with real `git init` / `git worktree add`, because
 * the property under test is how git lays a worktree out on disk.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findWorkspace } from "../src/core/workspace.js";
import { StapleError } from "../src/core/types.js";
import { cleanupSandboxes, cli, makeCurrentRepo, type Sandbox } from "./fixtures/migration-support.js";
import { runCliAt, tempDir } from "./fixtures/characterize-support.js";

afterEach(() => cleanupSandboxes());

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=staple", "-c", "user.email=staple@example.invalid", ...args], {
    cwd,
    stdio: "pipe",
  });
}

/** Commit so `git worktree add` has a HEAD to branch from. */
function commit(repo: string): void {
  git(repo, "commit", "--allow-empty", "-q", "-m", "initial");
}

/** A directory in `decoy` (a stand-in for the machine's home workspace) that is not under any repository. */
function worktreeDir(decoy: Sandbox, name: string): string {
  mkdirSync(join(decoy.repo, "trees"), { recursive: true });
  return join(decoy.repo, "trees", name);
}

describe("walk-up resolution in a linked git worktree", () => {
  it("resolves the main checkout's workspace, not an ancestor's", () => {
    const main = makeCurrentRepo("wt-main");
    const decoy = makeCurrentRepo("wt-decoy");
    git(main.repo, "init", "-q");
    commit(main.repo);
    const worktree = worktreeDir(decoy, "feature");
    git(main.repo, "worktree", "add", "-q", worktree);

    const found = findWorkspace(worktree);

    expect(found?.dbPath).toBe(main.currentDb);
    expect(found?.root).toBe(main.repo);
  });

  it("resolves it from a subdirectory of the worktree too", () => {
    const main = makeCurrentRepo("wt-sub-main");
    const decoy = makeCurrentRepo("wt-sub-decoy");
    git(main.repo, "init", "-q");
    commit(main.repo);
    const worktree = worktreeDir(decoy, "feature");
    git(main.repo, "worktree", "add", "-q", worktree);
    const nested = join(worktree, "src", "core");
    mkdirSync(nested, { recursive: true });

    expect(findWorkspace(nested)?.dbPath).toBe(main.currentDb);
  });

  it("resolves a worktree of a submodule-style repository whose main checkout is named by core.worktree", () => {
    // `git submodule` keeps the repository under the superproject's `.git/modules/` and
    // records the checkout in `core.worktree`, relative to that directory. Both of this
    // host's repositories look like this.
    const main = makeCurrentRepo("wt-module-main");
    const decoy = makeCurrentRepo("wt-module-decoy");
    const gitDir = join(tempDir("wt-module-gitdir"), "repo.git");
    git(main.repo, "init", "-q", `--separate-git-dir=${gitDir}`);
    git(main.repo, "config", "--file", join(gitDir, "config"), "core.worktree", relative(gitDir, main.repo));
    commit(main.repo);
    const worktree = worktreeDir(decoy, "feature");
    git(main.repo, "worktree", "add", "-q", worktree);

    expect(findWorkspace(worktree)?.dbPath).toBe(main.currentDb);
  });

  it("prefers a workspace inside the worktree itself", () => {
    const main = makeCurrentRepo("wt-own-main");
    const decoy = makeCurrentRepo("wt-own-decoy");
    git(main.repo, "init", "-q");
    commit(main.repo);
    const worktree = worktreeDir(decoy, "feature");
    git(main.repo, "worktree", "add", "-q", worktree);
    mkdirSync(join(worktree, ".staple"));
    writeFileSync(join(worktree, ".staple", "staple.db"), "");

    expect(findWorkspace(worktree)?.root).toBe(worktree);
  });

  it("refuses rather than use an ancestor's workspace when the main checkout cannot be found", () => {
    // A separate git directory with no `core.worktree` leaves a linked worktree with no
    // way to name its main checkout.
    const decoy = makeCurrentRepo("wt-lost-decoy");
    const main = tempDir("wt-lost-main");
    const gitDir = join(tempDir("wt-lost-gitdir"), "repo.git");
    git(main, "init", "-q", `--separate-git-dir=${gitDir}`);
    commit(main);
    const worktree = worktreeDir(decoy, "feature");
    git(main, "worktree", "add", "-q", worktree);

    const refusal = (() => {
      try {
        findWorkspace(worktree);
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(refusal).toBeInstanceOf(StapleError);
    expect((refusal as StapleError).code).toBe("not_found");
    expect((refusal as StapleError).message).toContain("--ws");
    expect((refusal as StapleError).message).toContain(worktree);
  });

  it("leaves an ordinary checkout walking up as before", () => {
    const decoy = makeCurrentRepo("wt-plain-decoy");
    const repo = join(decoy.repo, "projects", "plain");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");

    expect(findWorkspace(repo)?.dbPath).toBe(decoy.currentDb);
  });

  it("leaves a checkout whose .git is a file but not a linked worktree walking up as before", () => {
    // A submodule's checkout has a `.git` file pointing at its module directory, with no commondir.
    const decoy = makeCurrentRepo("wt-file-decoy");
    const repo = join(decoy.repo, "projects", "submodule");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", `--separate-git-dir=${join(tempDir("wt-file-gitdir"), "repo.git")}`);

    expect(findWorkspace(repo)?.dbPath).toBe(decoy.currentDb);
  });

  it("serves the CLI from inside the worktree without --ws", () => {
    const main = makeCurrentRepo("wt-cli-main");
    const decoy = makeCurrentRepo("wt-cli-decoy");
    expect(cli(main, ["new", "owned by the main checkout"]).status).toBe(0);
    expect(cli(decoy, ["new", "owned by the decoy"]).status).toBe(0);
    git(main.repo, "init", "-q");
    commit(main.repo);
    const worktree = worktreeDir(decoy, "feature");
    git(main.repo, "worktree", "add", "-q", worktree);

    const result = runCliAt(worktree, ["ls", "--json"], main.env);

    expect(result.status).toBe(0);
    const titles = (JSON.parse(result.stdout) as Array<{ title: string }>).map((issue) => issue.title);
    expect(titles).toEqual(["owned by the main checkout"]);
  });
});
