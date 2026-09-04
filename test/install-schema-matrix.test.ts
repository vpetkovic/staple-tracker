/**
 * R1c (STA-165) — the schema contract, proven against the PACKED runtime.
 *
 * `migrations-open-snapshot.test.ts` proves what `openWorkspace` does when it
 * is called from a checkout; `install-real-package.test.ts` proves the built
 * artifact installs and runs. This file closes the gap between them: every
 * case here goes through the launcher `staple install` wrote, which execs the
 * bundle `scripts/build-package.ts` produced, against a disposable copy of a
 * real old-format fixture. A regression that only the bundle has — a migration
 * that did not get compiled in, a snapshot path resolved against the source
 * tree, a `--rollback` the packed `install` command no longer accepts — is
 * invisible to the checkout tests and visible here.
 *
 * The matrix, one `describe` each:
 *
 *   schema 6   opened, nothing pending, preserved byte-for-byte in content
 *   schema 5   upgraded exactly once, one snapshot, every row intact
 *   schema 3   the retired prototype's shape, walked three migrations forward
 *   schema 99  refused before any write: same bytes, no sidecars, no snapshot
 *   WAL-only   rows another process committed only to the WAL are in the snapshot
 *   interrupt  an install that dies between stage and switch leaves one runtime
 *   docs       the commands `docs/migration.md` prints are run verbatim
 *
 * The package build is shared, not repeated: `dist-package/` is what
 * `test/package-tarball.test.ts` builds (or a developer's `npm run
 * build:package`), and like `install-real-package.test.ts` this file SKIPS
 * when it is absent. Vitest runs files in parallel, so the payload can be
 * mid-rebuild when this file loads; `beforeAll` copies it to scratch and
 * proves the copy runs before any case depends on it, retrying briefly so a
 * rebuild in flight is waited out rather than reported as a failure.
 *
 * Nothing here touches the developer's machine: `HOME`, `STAPLE_HOME`, and the
 * launcher directory are all under one scratch root that is removed after
 * every test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.js";
import { SNAPSHOT_DIRNAME } from "../src/core/open.js";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import {
  INSTALL_FROM_PLACEHOLDER,
  ROLLBACK_COMMAND,
  installStatus,
  listInstalledVersions,
  readCurrent,
  stagePayload,
  stagingDir,
  versionDir,
} from "../src/install/index.js";
import { REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { writeFakePayload } from "./fixtures/install-support.js";
import { FIXTURES, fixturePath, rawMeta } from "./fixtures/schema/support.js";

const distPackage = join(REPO_ROOT, "dist-package");
const WAL_ORPHAN_WORKER = join(REPO_ROOT, "test", "fixtures", "schema", "wal-orphan-worker.ts");
const built = existsSync(join(distPackage, "staple.mjs")) && existsSync(join(distPackage, "assets", "index.html"));
const packageVersion = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version as string;

/** Tables the fixtures carry rows in; the upgrade must not disturb a single one. */
const CONTENT_TABLES = ["issues", "relations", "comments", "documents", "document_revisions", "events"];

/** One launcher spawn is ~150ms; the slowest case makes a dozen. */
const CASE_TIMEOUT = 60_000;

let payload: string;
let payloadRoot: string;
let scratch: string;
let userHome: string;
let home: string;
let binDir: string;
let env: Record<string, string>;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sidecars(dbPath: string): string[] {
  return ["-wal", "-shm"].filter((suffix) => existsSync(`${dbPath}${suffix}`));
}

function snapshotsBeside(dbPath: string): string[] {
  const dir = join(dirname(dbPath), SNAPSHOT_DIRNAME);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function stamp(dbPath: string): string | null {
  return rawMeta(dbPath, "schema_version");
}

function readOnly<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * The content of a workspace, table by table, over a fixed column set. Taken
 * BEFORE an upgrade with the fixture's own columns, and again AFTER over those
 * same columns, so the comparison is "every old row, every old value" and a
 * column the migration appended does not make it fail.
 */
function contentOver(dbPath: string, columns: Record<string, string[]>): Record<string, unknown[]> {
  return readOnly(dbPath, (db) => {
    const out: Record<string, unknown[]> = {};
    for (const [table, cols] of Object.entries(columns)) {
      out[table] = db.prepare(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY rowid`).all();
    }
    return out;
  });
}

function columnsOf(dbPath: string): Record<string, string[]> {
  return readOnly(dbPath, (db) => {
    const out: Record<string, string[]> = {};
    for (const table of CONTENT_TABLES) {
      out[table] = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    }
    return out;
  });
}

function issueCount(dbPath: string): number {
  return readOnly(dbPath, (db) => (db.prepare("SELECT count(*) AS c FROM issues").get() as { c: number }).c);
}

/**
 * sha256 of a `VACUUM INTO` copy: the logical content, independent of the
 * header rewrite and WAL conversion an open performs on the file itself.
 * Two copies of the same content are byte-identical, so this is a fair
 * "nothing in it changed" for a file the runtime is allowed to touch.
 */
function contentSha(dbPath: string): string {
  const out = join(scratch, `vacuum-${process.hrtime.bigint()}.db`);
  readOnly(dbPath, (db) => db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`));
  try {
    return sha256(out);
  } finally {
    rmSync(out, { force: true });
  }
}

/** A repository directory holding a disposable copy of one fixture. */
function fixtureRepo(name: string, label = name.replace(/\.sqlite$/, "")): { repo: string; db: string } {
  const repo = join(scratch, `repo-${label}`);
  mkdirSync(join(repo, ".staple"), { recursive: true });
  const db = join(repo, ".staple", "staple.db");
  copyFileSync(fixturePath(name), db);
  return { repo, db };
}

/** Run the installed launcher the way a shell would. */
function launcher(args: string[], cwd = scratch) {
  return spawnSync(join(binDir, "staple"), args, { cwd, env, encoding: "utf8", timeout: 30_000 });
}

/** Run a payload's entrypoint directly — what `npx staple-cli …` executes. */
function bundle(entry: string, args: string[], cwd = scratch) {
  return spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
}

/** `npx staple-cli install --yes`: the packed runtime installs the version it is running. */
function installPacked(from = payload) {
  const run = bundle(join(from, "staple.mjs"), ["install", "--yes"]);
  expect(run.stderr, run.stdout).toBe("");
  expect(run.status).toBe(0);
  return run;
}

function identifiers(stdout: string): string[] {
  return (JSON.parse(stdout) as Array<{ identifier: string }>).map((i) => i.identifier).sort();
}

/** The snapshot path the open printed, from its one stderr line. */
function snapshotFromStderr(stderr: string): string {
  const match = /pre-upgrade snapshot retained at (\S+)/.exec(stderr);
  if (!match) throw new Error(`no snapshot line in stderr: ${JSON.stringify(stderr)}`);
  return match[1]!;
}

/** The same real bundle under another version label — a "newer release" with no other difference. */
function relabelledPayload(version: string): string {
  const dir = join(payloadRoot, version);
  cpSync(payload, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  return dir;
}

/**
 * Every command line inside a ```bash fence in docs/migration.md, comments
 * stripped. `documented(prefix)` is how a case runs one: the line is the
 * doc's, verbatim, so a command that stops being documented fails the case
 * that depended on it, and a command that stops working fails the doc.
 */
function documentedCommands(): string[] {
  const text = readFileSync(join(REPO_ROOT, "docs", "migration.md"), "utf8");
  const lines: string[] = [];
  for (const [, body] of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const raw of body!.split("\n")) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (line.length > 0) lines.push(line);
    }
  }
  return lines;
}

function documented(prefix: string): string {
  const line = documentedCommands().find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`docs/migration.md no longer documents \`${prefix}\` in a bash fence`);
  return line;
}

/** Substitute the doc's `<placeholders>`; refuse to run a line with one left. */
function fill(line: string, values: Record<string, string>): string {
  let out = line;
  for (const [placeholder, value] of Object.entries(values)) out = out.split(placeholder).join(value);
  if (/<[^>]+>/.test(out)) throw new Error(`unfilled placeholder in documented command: ${out}`);
  return out;
}

/** Run a documented line through a shell with the launcher first on PATH. */
function shell(line: string, cwd = scratch) {
  return spawnSync("sh", ["-c", line], { cwd, env, encoding: "utf8", timeout: 30_000 });
}

describe.skipIf(!built)("the packed runtime against every workspace schema on disk (STA-165)", () => {
  beforeAll(async () => {
    payloadRoot = tempDir("schema-matrix-payload");
    payload = join(payloadRoot, "dist-package");
    // A stable copy of the artifact. Another test file may be rebuilding
    // dist-package/ right now; copy, prove the copy runs, and if it does not,
    // wait for the rebuild to land rather than fail on a half-written bundle.
    let lastError = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      rmSync(payload, { recursive: true, force: true });
      try {
        cpSync(distPackage, payload, { recursive: true, preserveTimestamps: true });
        const probe = spawnSync(process.execPath, [join(payload, "staple.mjs"), "--version"], {
          encoding: "utf8",
          env: bareEnv(),
        });
        if (probe.status === 0 && probe.stdout.trim() === packageVersion) return;
        lastError = `exit ${probe.status}: ${probe.stderr}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`dist-package/ never settled into a runnable payload: ${lastError}`);
  }, 30_000);

  afterAll(() => {
    removeDir(payloadRoot);
  });

  beforeEach(() => {
    scratch = tempDir("schema-matrix");
    userHome = join(scratch, "user");
    home = join(scratch, "home");
    // `defaultBinDir()` inside the runtime is `$HOME/.local/bin`; putting the
    // launcher there is what lets `staple doctor` and `install status` name it.
    binDir = join(userHome, ".local", "bin");
    env = bareEnv({ HOME: userHome, STAPLE_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` });
  });

  afterEach(() => {
    removeDir(scratch);
  });

  describe("a schema-6 workspace is opened and preserved", () => {
    it("opens with nothing pending, no snapshot, and the same content afterwards", () => {
      installPacked();
      const { repo, db } = fixtureRepo(FIXTURES.workspaceV6);
      const columns = columnsOf(db);
      const before = { content: contentSha(db), rows: contentOver(db, columns) };

      const run = launcher(["ls", "--all", "--json"], repo);

      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(identifiers(run.stdout)).toEqual(["LEG-1", "LEG-2"]);
      expect(stamp(db)).toBe("6");
      expect(WORKSPACE_LATEST_VERSION).toBe(6);
      expect(contentSha(db)).toBe(before.content);
      expect(contentOver(db, columns)).toEqual(before.rows);
      expect(snapshotsBeside(db)).toEqual([]);
      expect(existsSync(join(dirname(db), SNAPSHOT_DIRNAME))).toBe(false);
      // The installed runtime's own diagnosis agrees: every schema matches.
      const doctor = launcher(["doctor", "--json"], repo);
      const schema = (JSON.parse(doctor.stdout) as { checks: Array<{ id: string; status: string; data: { code: unknown } }> })
        .checks.find((check) => check.id === "schema")!;
      expect(schema.status).toBe("pass");
      expect(schema.data.code).toBeNull();
    }, CASE_TIMEOUT);
  });

  describe("a schema-5 workspace is upgraded exactly once", () => {
    it("stamps 5 -> 6 with one snapshot, keeps every row, and the second open takes no second snapshot", () => {
      installPacked();
      const { repo, db } = fixtureRepo(FIXTURES.workspaceV5);
      const columns = columnsOf(db);
      const before = contentOver(db, columns);

      const first = launcher(["ls", "--all", "--json"], repo);

      expect(first.status).toBe(0);
      expect(first.stderr).toContain(`upgrading workspace ${db} from schema 5 to ${WORKSPACE_LATEST_VERSION}`);
      const snapshot = snapshotFromStderr(first.stderr);
      expect(dirname(snapshot)).toBe(join(dirname(db), SNAPSHOT_DIRNAME));
      expect(snapshotsBeside(db)).toEqual([`staple.db.schema-5.${snapshot.split(".schema-5.")[1]}`]);
      expect(identifiers(first.stdout)).toEqual(["LEG-1", "LEG-2"]);
      // The file moved on; every old row and value came with it.
      expect(stamp(db)).toBe(String(WORKSPACE_LATEST_VERSION));
      expect(contentOver(db, columns)).toEqual(before);
      // The snapshot is the file as it was: old stamp, same rows, self-contained.
      expect(stamp(snapshot)).toBe("5");
      expect(contentOver(snapshot, columns)).toEqual(before);
      expect(sidecars(snapshot)).toEqual([]);

      const second = launcher(["ls", "--all", "--json"], repo);

      expect(second.stderr).toBe("");
      expect(second.status).toBe(0);
      expect(identifiers(second.stdout)).toEqual(["LEG-1", "LEG-2"]);
      expect(snapshotsBeside(db)).toHaveLength(1);
      expect(stamp(db)).toBe(String(WORKSPACE_LATEST_VERSION));
    }, CASE_TIMEOUT);
  });

  describe("a schema-3 workspace — the retired prototype's shape — is walked all the way forward", () => {
    it("upgrades 3 -> 6 in one open, snapshotting the schema-3 file first, with every row intact", () => {
      // `generate.ts` builds fixtures by migration prefix, so `workspace-v3.sqlite`
      // was written the same way the others were: migrations 001-003 and nothing
      // later, then real rows, then stamped '3'.
      installPacked();
      const { repo, db } = fixtureRepo(FIXTURES.workspaceV3);
      expect(stamp(db)).toBe("3");
      const columns = columnsOf(db);
      const before = contentOver(db, columns);

      const run = launcher(["ls", "--all", "--json"], repo);

      expect(run.stderr).toContain(`upgrading workspace ${db} from schema 3 to ${WORKSPACE_LATEST_VERSION}`);
      expect(run.status).toBe(0);
      expect(identifiers(run.stdout)).toEqual(["LEG-1", "LEG-2"]);
      const snapshot = snapshotFromStderr(run.stderr);
      expect(snapshotsBeside(db)).toEqual([`staple.db.schema-3.${snapshot.split(".schema-3.")[1]}`]);
      expect(stamp(snapshot)).toBe("3");
      expect(stamp(db)).toBe(String(WORKSPACE_LATEST_VERSION));
      expect(contentOver(db, columns)).toEqual(before);
      expect(contentOver(snapshot, columns)).toEqual(before);
      // Once. The prototype's three missing migrations do not mean three snapshots.
      expect(launcher(["ls", "--all", "--json"], repo).stderr).toBe("");
      expect(snapshotsBeside(db)).toHaveLength(1);
    }, CASE_TIMEOUT);
  });

  describe("a workspace from the future is refused before any write", () => {
    it("exits 4 naming both versions and the repair, and leaves the file byte-identical with no sidecar and no snapshot", () => {
      installPacked();
      const { repo, db } = fixtureRepo(FIXTURES.workspaceV99);
      const before = sha256(db);

      const read = launcher(["ls"], repo);
      expect(read.status).toBe(4);
      expect(read.stdout).toBe("");
      expect(read.stderr).toContain("error(conflict)");
      expect(read.stderr).toContain(`This workspace database (${db}) was created by a newer version of staple`);
      expect(read.stderr).toContain(`schema version 99; this build understands ${WORKSPACE_LATEST_VERSION}`);
      expect(read.stderr).toContain(`Repair: ${INSTALL_FROM_PLACEHOLDER}`);

      // A command that would write is refused at the same point, for the same reason.
      const write = launcher(["new", "Should never land"], repo);
      expect(write.status).toBe(4);
      expect(write.stderr).toContain("schema version 99");

      expect(sha256(db)).toBe(before);
      expect(sidecars(db)).toEqual([]);
      expect(snapshotsBeside(db)).toEqual([]);
      expect(readdirSync(dirname(db))).toEqual(["staple.db"]);
    }, CASE_TIMEOUT);
  });

  describe("a WAL-backed workspace whose latest rows exist only in the WAL", () => {
    it("snapshots through the WAL, and the snapshot restores every committed row", () => {
      installPacked();
      const { repo, db } = fixtureRepo(FIXTURES.workspaceV5);
      const columns = columnsOf(db);

      // A writer in THIS process, still open when the launcher runs: its commit
      // is in the `-wal` sidecar and has never been checkpointed into the file.
      const writer = openDb(db);
      let snapshot: string;
      try {
        const now = "2026-02-01T00:00:00.000Z";
        writer
          .prepare(
            `INSERT INTO issues (id, identifier, title, normalized_title, status, status_version,
                                 priority, depth, labels, origin_kind, created_at, updated_at)
             VALUES ('iss-wal-only', 'LEG-3', 'Only in the WAL', 'only in the wal', 'todo', 0,
                     'low', 0, '[]', 'manual', ?, ?)`,
          )
          .run(now, now);
        expect(statSync(`${db}-wal`).size).toBeGreaterThan(0);
        // The main file alone does not have the row; only a reader that goes
        // through the WAL sees three. A file copy would have lost LEG-3.
        const mainFileOnly = join(scratch, "main-file-only.db");
        copyFileSync(db, mainFileOnly);
        expect(issueCount(mainFileOnly)).toBe(2);
        expect(issueCount(db)).toBe(3);
        const committed = contentOver(db, columns);

        const run = launcher(["ls", "--all", "--json"], repo);

        expect(run.status).toBe(0);
        expect(identifiers(run.stdout)).toEqual(["LEG-1", "LEG-2", "LEG-3"]);
        snapshot = snapshotFromStderr(run.stderr);
        expect(stamp(snapshot)).toBe("5");
        expect(contentOver(snapshot, columns)).toEqual(committed);
        expect(contentOver(db, columns)).toEqual(committed);
      } finally {
        writer.close();
      }

      // "Restores": put the snapshot at a database path and open it for real.
      const restored = join(scratch, "repo-restored");
      mkdirSync(join(restored, ".staple"), { recursive: true });
      copyFileSync(snapshot, join(restored, ".staple", "staple.db"));
      const reopened = launcher(["ls", "--all", "--json"], restored);
      expect(reopened.status).toBe(0);
      expect(identifiers(reopened.stdout)).toEqual(["LEG-1", "LEG-2", "LEG-3"]);
    }, CASE_TIMEOUT);
  });

  describe("an installation interrupted between stage and switch", () => {
    /**
     * Exactly one runtime is selected, it verifies, the launcher execs THAT
     * directory, and what it execs opens schema 6. The bundle under both
     * labels is the same build, so `--version` cannot tell them apart; the
     * running build's own report of the path it was started from can.
     */
    function expectOneUsableRuntime(version: string): void {
      expect(readCurrent(home)!.version).toBe(version);
      const status = installStatus({ home, binDir, env });
      expect(status.ok).toBe(true);
      expect(status.version).toBe(version);
      expect(status.launcher.target).toBe(join(versionDir(home, version), "staple.mjs"));
      expect(launcher(["--version"]).stdout.trim()).toBe(packageVersion);

      const { repo, db } = fixtureRepo(FIXTURES.workspaceV6, `v6-${process.hrtime.bigint()}`);
      const run = launcher(["ls", "--all", "--json"], repo);
      expect(run.stderr).toBe("");
      expect(identifiers(run.stdout)).toEqual(["LEG-1", "LEG-2"]);
      expect(snapshotsBeside(db)).toEqual([]);
      const doctor = launcher(["doctor", "--json"], repo);
      const schema = (
        JSON.parse(doctor.stdout) as {
          checks: Array<{ id: string; data: { code: unknown; running: { source: string; path: string } } }>;
        }
      ).checks.find((check) => check.id === "schema")!;
      expect(schema.data.running).toMatchObject({ source: "installed", path: versionDir(home, version) });
      expect(schema.data.code).toBeNull();
    }

    it("that FAILS after staging leaves the previous runtime selected and staging empty", () => {
      installPacked();
      expectOneUsableRuntime(packageVersion);
      const newer = relabelledPayload("0.1.1-next");
      // `promote` renames the staged tree onto `versions/<v>`; a file already
      // there is the one thing it refuses (src/install/runtime.ts). The real
      // runtime's `install` therefore dies after stage and before the switch.
      mkdirSync(dirname(versionDir(home, "0.1.1-next")), { recursive: true });
      writeFileSync(versionDir(home, "0.1.1-next"), "in the way\n");
      const pointerBefore = readFileSync(join(home, "runtime", "current.json"), "utf8");

      const failed = launcher(["install", "--from", newer, "--yes"]);

      expect(failed.status).toBe(4);
      expect(failed.stderr).toContain("exists and is not a directory");
      expect(readFileSync(join(home, "runtime", "current.json"), "utf8")).toBe(pointerBefore);
      expect(readdirSync(stagingDir(home))).toEqual([]);
      expect(listInstalledVersions(home)).toEqual([packageVersion]);
      expectOneUsableRuntime(packageVersion);
    }, CASE_TIMEOUT);

    it("that DIES after promoting leaves one selected runtime, and the next install completes from there", () => {
      installPacked();
      const newer = relabelledPayload("0.1.1-next");
      // The on-disk state a crash between step 2 (promote) and step 4 (switch)
      // leaves: the new version directory exists, verified, and nothing points
      // at it — plus the staged tree an even earlier crash would leave behind.
      renameSync(stagePayload({ home, from: newer }).path, versionDir(home, "0.1.1-next"));
      stagePayload({ home, from: newer });
      expect(readdirSync(stagingDir(home))).toHaveLength(1);
      expect(listInstalledVersions(home)).toEqual([packageVersion, "0.1.1-next"]);

      expectOneUsableRuntime(packageVersion);
      const status = launcher(["install", "status"]);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`version    ${packageVersion}\n`);
      expect(status.stdout).toContain("previous   (none)");

      const completed = launcher(["install", "--from", newer, "--yes"]);

      expect(completed.stderr).toBe("");
      expect(completed.status).toBe(0);
      expect(completed.stdout).toContain("Installed staple 0.1.1-next");
      expect(readdirSync(stagingDir(home))).toEqual([]);
      expect(readCurrent(home)!.previousVersion).toBe(packageVersion);
      expectOneUsableRuntime("0.1.1-next");
      // And the runtime it replaced is a normal rollback target now.
      expect(launcher(["install", "--rollback", "--yes"]).status).toBe(0);
      expectOneUsableRuntime(packageVersion);
    }, CASE_TIMEOUT);
  });

  describe("the commands docs/migration.md prints", () => {
    it("names the same commands the runtime does", () => {
      expect(documented("staple install --from")).toBe(INSTALL_FROM_PLACEHOLDER);
      expect(documented("staple install --rollback")).toBe(ROLLBACK_COMMAND);
      expect(documented("staple doctor")).toBe("staple doctor");
      expect(documented("staple install status")).toBe("staple install status");
    });

    it("are run verbatim: the refusal, doctor's repair, the install, the rollback, the restore, the roll-forward", () => {
      // The runtime a user upgraded FROM. There is no packed schema-5 bundle
      // to install, so the rollback target is a payload that declares 5; what
      // rollback proves is the pointer switch and that no database is touched,
      // which is all `install --rollback` claims to do.
      const older = writeFakePayload(join(payloadRoot, "0.0.9"), "0.0.9", { workspaceSchema: 5 });
      expect(bundle(join(payload, "staple.mjs"), ["install", "--from", older, "--yes"]).status).toBe(0);
      installPacked();
      expect(readCurrent(home)!.previousVersion).toBe("0.0.9");

      // 1. The error message, then the command it points at.
      const future = fixtureRepo(FIXTURES.workspaceV99);
      const refused = shell("staple ls", future.repo);
      expect(refused.status).toBe(4);
      expect(refused.stderr).toContain(`Repair: ${documented("staple install --from")}`);

      const doctor = shell(documented("staple doctor"), future.repo);
      expect(doctor.status).toBe(1);
      expect(doctor.stdout).toContain("\nREPAIRS\n");
      expect(doctor.stdout).toContain(`    ${documented("staple install --from")}\n`);
      expect(doctor.stdout).toContain(`${documented("staple install --rollback")} restores staple 0.0.9`);

      // 2. The install command, with the placeholder filled by a real payload.
      const installed = shell(fill(documented("staple install --from"), { "<dir|tarball>": payload }), future.repo);
      expect(installed.stderr).toBe("");
      expect(installed.status).toBe(0);
      expect(installed.stdout).toContain(`Installed staple ${packageVersion}`);
      expect(installed.stdout).toContain(`Rollback   \`${documented("staple install --rollback")}\` returns to 0.0.9`);
      // Honest outcome: no payload on this machine declares 99, so the
      // refusal stands — exactly what doctor said.
      expect(shell("staple ls", future.repo).status).toBe(4);

      // 3. An upgrade, then the documented way back.
      const { repo, db } = fixtureRepo(FIXTURES.workspaceV5);
      const columns = columnsOf(db);
      const before = contentOver(db, columns);
      const upgraded = shell("staple ls --all --json", repo);
      expect(upgraded.status).toBe(0);
      const snapshot = snapshotFromStderr(upgraded.stderr);
      expect(stamp(db)).toBe(String(WORKSPACE_LATEST_VERSION));
      const migratedSha = sha256(db);

      const status = shell(documented("staple install status"), repo);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`previous   0.0.9  retained at ${versionDir(home, "0.0.9")}\n`);

      const rolledBack = shell(documented("staple install --rollback"), repo);
      expect(rolledBack.status).toBe(0);
      expect(rolledBack.stdout).toContain("Rolled back to staple 0.0.9");
      expect(rolledBack.stdout).toContain("no database was changed");
      expect(readCurrent(home)!.version).toBe("0.0.9");
      expect(shell("staple --version").stdout.trim()).toBe("0.0.9");
      expect(sha256(db)).toBe(migratedSha);

      // The hazard the restore procedure exists for: a process that died
      // mid-session left a `-wal` holding a row committed against schema 6.
      const orphan = spawnSync(process.execPath, [TSX_CLI, WAL_ORPHAN_WORKER, db, "LEG-9"], {
        encoding: "utf8",
        env: bareEnv(),
      });
      expect(orphan.stdout.trim(), orphan.stderr).toBe("committed");
      expect(sidecars(db)).toEqual(["-wal", "-shm"]);
      expect(issueCount(db)).toBe(3);

      const restore = { "<db>": db, "<snapshot>": snapshot };
      for (const prefix of ["mv <db> ", "mv <db>-wal", "mv <db>-shm", "cp <snapshot>"]) {
        const step = shell(fill(documented(prefix), restore), repo);
        expect(step.stderr).toBe("");
        expect(step.status).toBe(0);
      }
      expect(stamp(db)).toBe("5");
      expect(sidecars(db)).toEqual([]);
      expect(contentOver(db, columns)).toEqual(before);
      // The orphaned frame went aside with the newer file, not into the restored one.
      expect(issueCount(db)).toBe(2);
      expect(stamp(`${db}.migrated`)).toBe(String(WORKSPACE_LATEST_VERSION));
      expect(existsSync(`${db}-wal.migrated`)).toBe(true);
      expect(existsSync(snapshot)).toBe(true);

      // 4. Roll forward: the documented rollback again, run by the retained
      // newer runtime itself (the fake older payload cannot run `install`),
      // and the restored workspace is upgraded afresh with a new snapshot.
      const retained = join(versionDir(home, packageVersion), "staple.mjs");
      const forward = shell(
        documented("staple install --rollback").replace(/^staple /, `${JSON.stringify(process.execPath)} ${JSON.stringify(retained)} `),
        repo,
      );
      expect(forward.status).toBe(0);
      expect(forward.stdout).toContain(`Rolled back to staple ${packageVersion}`);
      expect(shell("staple --version").stdout.trim()).toBe(packageVersion);
      const reopened = shell("staple ls --all --json", repo);
      expect(reopened.status).toBe(0);
      expect(identifiers(reopened.stdout)).toEqual(["LEG-1", "LEG-2"]);
      expect(stamp(db)).toBe(String(WORKSPACE_LATEST_VERSION));
      expect(snapshotsBeside(db)).toHaveLength(2);
      expect(contentOver(db, columns)).toEqual(before);
    }, CASE_TIMEOUT);
  });
});
