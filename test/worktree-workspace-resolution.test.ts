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
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findWorkspace } from "../src/core/workspace.js";
import { findMigrationRoot } from "../src/core/path-migration.js";
import { StapleError } from "../src/core/types.js";
import { cleanupSandboxes, cli, makeCurrentRepo, type Sandbox } from "./fixtures/migration-support.js";
import { bareEnv, MCP_ENTRY, runCliAt, TSX_CLI, tempDir } from "./fixtures/characterize-support.js";

afterEach(() => cleanupSandboxes());

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=staple", "-c", "user.email=staple@example.invalid", "-c", "protocol.file.allow=always", ...args],
    { cwd, stdio: "pipe" },
  );
}

/** Where a submodule-style repository records its checkout. */
type CoreWorktree = "config" | "config.worktree" | "config with a trailing comment";

interface RepoOptions {
  /** Keep the repository's git directory outside the checkout, as `git submodule` does. */
  separateGitDir?: boolean;
  /** Record the checkout in `core.worktree`; requires `separateGitDir`. */
  coreWorktree?: CoreWorktree;
}

/** `git init` and one commit, so a worktree can branch from HEAD. */
function initRepo(repo: string, options: RepoOptions = {}): void {
  const gitDir = join(tempDir("wt-gitdir"), "repo.git");
  git(repo, "init", "-q", ...(options.separateGitDir ? [`--separate-git-dir=${gitDir}`] : []));
  const target = relative(gitDir, repo);
  if (options.coreWorktree === "config") git(repo, "config", "--file", join(gitDir, "config"), "core.worktree", target);
  if (options.coreWorktree === "config.worktree") writeFileSync(join(gitDir, "config.worktree"), `[core]\n\tworktree = ${target}\n`);
  if (options.coreWorktree === "config with a trailing comment") {
    appendFileSync(join(gitDir, "config"), `[core]\n\tworktree = ${target} ; moved\n`);
  }
  git(repo, "commit", "--allow-empty", "-q", "-m", "initial");
}

interface Fixture {
  /** The main checkout, which owns a workspace. */
  main: Sandbox;
  /** Stands in for the machine's home workspace: an ancestor of the worktree, unrelated to its repository. */
  decoy: Sandbox;
  /** A linked worktree of `main`, placed beneath `decoy`. */
  worktree: string;
}

function fixture(prefix: string, options: RepoOptions = {}): Fixture {
  const main = makeCurrentRepo(`${prefix}-main`);
  const decoy = makeCurrentRepo(`${prefix}-decoy`);
  initRepo(main.repo, options);
  const worktree = join(decoy.repo, "trees", "feature");
  mkdirSync(join(decoy.repo, "trees"), { recursive: true });
  git(main.repo, "worktree", "add", "-q", worktree);
  return { main, decoy, worktree };
}

describe("walk-up resolution in a linked git worktree", () => {
  it("resolves the main checkout's workspace, not an ancestor's, from the root and from a subdirectory", () => {
    const { main, worktree } = fixture("wt");
    const nested = join(worktree, "src", "core");
    mkdirSync(nested, { recursive: true });

    for (const dir of [worktree, nested]) {
      const found = findWorkspace(dir);
      expect(found?.dbPath).toBe(main.currentDb);
      expect(found?.root).toBe(main.repo);
    }
  });

  // `git submodule` keeps the repository under the superproject's `.git/modules/` and records the
  // checkout in `core.worktree`, relative to that directory. Both of this host's repositories look like this.
  it.each<CoreWorktree>(["config", "config.worktree", "config with a trailing comment"])(
    "resolves a submodule-style repository whose checkout is named in %s",
    (coreWorktree) => {
      const { main, worktree } = fixture("wt-module", { separateGitDir: true, coreWorktree });

      expect(findWorkspace(worktree)?.dbPath).toBe(main.currentDb);
    },
  );

  it("prefers a workspace inside the worktree itself", () => {
    const { worktree } = fixture("wt-own");
    mkdirSync(join(worktree, ".staple"));
    writeFileSync(join(worktree, ".staple", "staple.db"), "");

    expect(findWorkspace(worktree)?.root).toBe(worktree);
  });

  it("refuses rather than use an ancestor's workspace when the main checkout cannot be found", () => {
    // A separate git directory with no `core.worktree` leaves a linked worktree with no
    // way to name its main checkout.
    const { worktree } = fixture("wt-lost", { separateGitDir: true });

    expect(() => findWorkspace(worktree)).toThrow(StapleError);
    expect(() => findWorkspace(worktree)).toThrow(/--ws/);
    expect(() => findWorkspace(worktree)).toThrow(worktree);
    expect(() => findMigrationRoot(worktree)).toThrow(StapleError);
  });

  it("walks up from a worktree of a bare repository, which has no main checkout", () => {
    // The `project/.bare` + `project/.git` pointer layout, with the workspace in `project/`.
    const project = makeCurrentRepo("wt-bare");
    const seed = tempDir("wt-bare-seed");
    initRepo(seed);
    git(project.repo, "clone", "-q", "--bare", seed, ".bare");
    writeFileSync(join(project.repo, ".git"), "gitdir: ./.bare\n");
    git(project.repo, "worktree", "add", "-q", "-b", "feature", "feature");

    expect(findWorkspace(join(project.repo, "feature"))?.dbPath).toBe(project.currentDb);
  });

  it("walks up as before from a checkout that is not a linked worktree", () => {
    // An ordinary checkout has a `.git` directory; a submodule's has a `.git` file pointing at
    // its module directory, which has no commondir, even when that sits under a `worktrees` directory.
    const decoy = makeCurrentRepo("wt-plain-decoy");
    const ordinary = join(decoy.repo, "projects", "ordinary");
    const submodule = join(decoy.repo, "projects", "submodule");
    const nested = join(decoy.repo, "worktrees", "foo");
    for (const dir of [ordinary, submodule]) mkdirSync(dir, { recursive: true });
    git(ordinary, "init", "-q");
    git(submodule, "init", "-q", `--separate-git-dir=${join(tempDir("wt-plain-gitdir"), "repo.git")}`);
    // The real thing: a submodule added at a path under `worktrees/`.
    const upstream = tempDir("wt-plain-upstream");
    initRepo(upstream);
    git(decoy.repo, "init", "-q");
    git(decoy.repo, "submodule", "add", "-q", upstream, "worktrees/foo");

    for (const dir of [ordinary, submodule, nested]) expect(findWorkspace(dir)?.dbPath).toBe(decoy.currentDb);
  });

  it("points the migration walk at the main checkout too", () => {
    const { main, worktree } = fixture("wt-migrate");

    expect(findMigrationRoot(worktree)).toBe(main.repo);
  });

  it("serves the CLI from inside the worktree without --ws", () => {
    const { main, decoy, worktree } = fixture("wt-cli");
    expect(cli(main, ["new", "owned by the main checkout"]).status).toBe(0);
    expect(cli(decoy, ["new", "owned by the decoy"]).status).toBe(0);

    const result = runCliAt(worktree, ["ls", "--json"], main.env);

    expect(result.status).toBe(0);
    const titles = (JSON.parse(result.stdout) as Array<{ title: string }>).map((issue) => issue.title);
    expect(titles).toEqual(["owned by the main checkout"]);
  });

  it("tells an MCP caller why a worktree is refused, and never to run init there", async () => {
    // `init` in the worktree would create a workspace inside it, forking it from the repository's own.
    const { worktree } = fixture("wt-mcp", { separateGitDir: true });
    const client = new Client({ name: "worktree-refusal", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [TSX_CLI, MCP_ENTRY],
        cwd: worktree,
        env: bareEnv({ STAPLE_HOME: tempDir("wt-mcp-home"), STAPLE_AGENT: "worktree-refusal" }),
        stderr: "ignore",
      }),
    );
    try {
      const result = (await client.callTool({ name: "list_tasks", arguments: {} })) as {
        isError?: boolean;
        content: Array<{ text?: string }>;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("is a git worktree");
      expect(result.content[0]!.text).not.toContain('"init"');
    } finally {
      await client.close();
    }
  }, 40_000);
});
