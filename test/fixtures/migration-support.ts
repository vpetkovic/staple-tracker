/**
 * A5 harness: build genuine legacy `.tasks/tasks.db` workspaces and drive
 * migrations through real child processes.
 *
 * The legacy workspaces are built by running the real `staple init` and then
 * renaming its output, rather than by hand-writing a database. That matters:
 * a hand-built fixture proves the migrator handles a file the test author
 * imagined, while a renamed real one proves it handles the file the product
 * actually shipped — including the schema, the meta rows and the hub
 * registration that came with it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bareEnv, runCliAt, tempDir, REPO_ROOT, type CliResult } from "./characterize-support.js";

export const MIGRATE_CHILD = join(REPO_ROOT, "test/fixtures/migrate-child.ts");

/**
 * tsx's `cli.mjs` forks a grandchild to run the loader, so a SIGKILL delivered
 * to the process spawnSync started reaches the launcher, not the code — and the
 * launcher exits normally, reporting `signal: null`. Loading tsx as an import
 * hook instead keeps the migration in the one process we spawned, which is the
 * only way the test can observe the kill it asked for.
 */
const TSX_LOADER = join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");

export interface Sandbox {
  /** A temporary STAPLE_HOME, so the hub under test is never the developer's. */
  home: string;
  /** The repository root. */
  repo: string;
  env: Record<string, string>;
  legacyDb: string;
  currentDb: string;
  journal: string;
}

const trash: string[] = [];

export function cleanupSandboxes(): void {
  while (trash.length > 0) rmSync(trash.pop()!, { recursive: true, force: true });
}

function track(dir: string): string {
  trash.push(dir);
  return dir;
}

/** A repository whose staple state lives in the CURRENT `.staple/staple.db` layout. */
export function makeCurrentRepo(prefix = "a5"): Sandbox {
  const home = track(tempDir(`${prefix}-home`));
  const repo = track(tempDir(`${prefix}-repo`));
  const env = { HOME: home, STAPLE_HOME: home };
  const init = runCliAt(repo, ["init"], env);
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr || init.stdout}`);
  return {
    home,
    repo,
    env,
    legacyDb: join(repo, ".tasks", "tasks.db"),
    currentDb: join(repo, ".staple", "staple.db"),
    journal: join(repo, ".staple", "migration.json"),
  };
}

/**
 * A repository in the LEGACY layout: `staple init`, then the directory and file
 * are renamed to what the previous release wrote, then init runs again so the
 * hub row points at the legacy path exactly as it would have.
 */
export function makeLegacyRepo(prefix = "a5"): Sandbox {
  const box = makeCurrentRepo(prefix);
  renameSync(join(box.repo, ".staple"), join(box.repo, ".tasks"));
  renameSync(join(box.repo, ".tasks", "staple.db"), box.legacyDb);
  for (const suffix of ["-wal", "-shm"]) {
    const from = join(box.repo, ".tasks", `staple.db${suffix}`);
    if (existsSync(from)) renameSync(from, `${box.legacyDb}${suffix}`);
  }
  const reinit = runCliAt(box.repo, ["init"], box.env);
  if (reinit.status !== 0) throw new Error(`re-init failed: ${reinit.stderr || reinit.stdout}`);
  return box;
}

export function cli(box: Sandbox, args: string[], extraEnv: Record<string, string> = {}): CliResult {
  return runCliAt(box.repo, args, { ...box.env, ...extraEnv });
}

/** Create `count` issues through the real CLI, returning their titles. */
export function seedIssues(box: Sandbox, count: number, prefix = "task"): string[] {
  const titles: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const title = `${prefix} ${i}`;
    const result = cli(box, ["new", title]);
    if (result.status !== 0) throw new Error(`new failed: ${result.stderr || result.stdout}`);
    titles.push(title);
  }
  return titles;
}

/** Issue titles as the product reports them, so a comparison is end-to-end. */
export function issueTitles(box: Sandbox): string[] {
  const result = cli(box, ["ls", "--all", "--json"]);
  if (result.status !== 0) throw new Error(`ls failed: ${result.stderr || result.stdout}`);
  return (JSON.parse(result.stdout) as Array<{ title: string }>).map((issue) => issue.title).sort();
}

export interface ChildOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  payload: { ok: boolean; result?: Record<string, unknown>; code?: string; message?: string } | null;
}

/**
 * Run one migration in a child process, optionally killing it at a journal
 * state boundary.
 */
export function migrateInChild(box: Sandbox, crashAt?: string): ChildOutcome {
  const result = spawnSync(process.execPath, ["--import", TSX_LOADER, MIGRATE_CHILD, box.repo], {
    cwd: box.repo,
    env: bareEnv({ ...box.env, ...(crashAt ? { STAPLE_MIGRATE_CRASH_AT: crashAt } : {}) }),
    encoding: "utf8",
    timeout: 30_000,
  });
  const stdout = result.stdout ?? "";
  let payload: ChildOutcome["payload"] = null;
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  if (line?.startsWith("{")) {
    try {
      payload = JSON.parse(line) as ChildOutcome["payload"];
    } catch {
      payload = null;
    }
  }
  return { status: result.status, signal: result.signal, stdout, stderr: result.stderr ?? "", payload };
}

/** Hub rows straight out of the registry file, bypassing every product surface. */
export function hubRows(box: Sandbox): Array<{ slug: string; prefix: string; path: string }> {
  const path = join(box.home, "hub.db");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT slug, prefix, path FROM workspaces ORDER BY slug").all() as Array<{
      slug: string;
      prefix: string;
      path: string;
    }>;
  } finally {
    db.close();
  }
}

export function walSize(dbPath: string): number {
  const wal = `${dbPath}-wal`;
  return existsSync(wal) ? statSync(wal).size : 0;
}

/** Make a directory that is a plausible repository but holds no staple state. */
export function nestedDir(box: Sandbox, ...segments: string[]): string {
  const dir = join(box.repo, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}
