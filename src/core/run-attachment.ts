/**
 * Where a run's driver leaves its traces on disk: `<.staple>/runs/<run-id>/`, next to the
 * workspace database.
 *
 * `staple run drive` is a long-running local process. What it says about itself (its pid,
 * its host, a heartbeat, the ticket its session is on) and each session's brief and logs
 * live in this directory, not in the database:
 *
 *   - It needs no migration. A run is machine-local already (`run-store.ts`), and so is the
 *     process driving it; a file beside the database is exactly as local as a column.
 *   - A heartbeat written every few seconds would otherwise be a write transaction every
 *     few seconds against the database the session is working in.
 *
 * `runs/` carries its own `.gitignore` of `*`: the workspace's `.staple/.gitignore` ignores
 * only the database files, and session logs must never be committable.
 *
 * `run status` reads `driver.json` ({@link readDriver}) so any surface can show that a
 * driver is attached. A driver that exits removes it; one that crashes leaves it, and the
 * pid check ({@link DriverAttachment.alive}) says it is gone.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** What a driver writes about itself. */
export interface DriverRecord {
  pid: number;
  host: string;
  /** The provider row or `custom`. */
  agent: string;
  startedAt: string;
  heartbeatAt: string;
  /** The ticket a session is working now; null between sessions. */
  ticket: string | null;
  /** The session's pid while one runs (it leads its own process group). */
  sessionPid: number | null;
  /** When that session started; null between sessions. */
  sessionStartedAt?: string | null;
  logDir: string;
}

/** {@link DriverRecord} as `run status` answers it. */
export interface DriverAttachment extends DriverRecord {
  /** Whether the pid is running: null when the driver is on another host and this one cannot tell. */
  alive: boolean | null;
}

/** The database file a connection has open, or null for an in-memory database. */
export function databaseFile(db: DatabaseSync): string | null {
  const rows = db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
  const file = rows.find((row) => row.name === "main")?.file ?? "";
  return file === "" ? null : file;
}

/** `<dir of the database>/runs/<run-id>`: the run's driver file, briefs and session logs. */
export function runDirectory(dbFile: string, runId: string): string {
  return join(dirname(dbFile), "runs", runId);
}

/** Create the run directory, and the self-ignoring `runs/` above it. */
export function ensureRunDirectory(dbFile: string, runId: string): string {
  const dir = runDirectory(dbFile, runId);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dirname(dir), ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# Autopilot run drivers: briefs, session logs, driver.json. Machine-local.\n*\n");
  return dir;
}

/**
 * Written whole and renamed into place, so a reader never sees half a heartbeat. The
 * temporary name carries the pid: two processes writing at once never share one.
 */
export function writeDriver(dbFile: string, runId: string, record: DriverRecord): void {
  const path = join(ensureRunDirectory(dbFile, runId), "driver.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * One driver per run: `driver.lock`, created with O_EXCL and holding the owner's pid and
 * host. Two `run drive` processes starting at once cannot both create it, so they cannot
 * both read "no live driver" and go on. Returns the release function, or the owner that
 * holds it.
 *
 * ## Taking over a stale lock
 *
 * A lock whose owner is gone (its pid is not running on this host) is stale. Removing it
 * and creating a new one is a race: two processes both judge it stale, one removes it and
 * creates its own, and the other then removes THAT one and creates a second. So the
 * judgement and the replacement happen under a second lock, `driver.lock.takeover`, also
 * O_EXCL: one process at a time re-reads the owner under it, and only a still-stale lock is
 * replaced, written whole to a temporary file and renamed over it (atomic). While the stale
 * file stands nobody can create a lock beside it, and once it is replaced every other
 * process reads a live owner. A takeover lock whose own writer is gone is removed; a file
 * that vanishes between two reads (a release, a takeover) is read again, never a crash.
 */
export function acquireDriverLock(dbFile: string, runId: string): { release: () => void } | { heldBy: { pid: number; host: string } } {
  const path = join(ensureRunDirectory(dbFile, runId), "driver.lock");
  const mine = { pid: process.pid, host: hostname() };
  const owned = { release: () => {
    if (lockOwner(path)?.pid === process.pid && lockOwner(path)?.host === mine.host) rmSync(path, { force: true });
  } };
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify(mine));
      } finally {
        closeSync(fd);
      }
      return owned;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const verdict = judge(path);
    if (verdict === "gone") continue;
    if (verdict !== "stale") return { heldBy: verdict };
    const taken = takeOver(path, mine);
    if (taken === "retry") continue;
    if (taken === "mine") return owned;
    return { heldBy: taken };
  }
  return { heldBy: lockOwner(path) ?? { pid: 0, host: "unknown" } };
}

/** The lock's state: its live owner, `stale`, or `gone` (removed since the caller looked). */
function judge(path: string): { pid: number; host: string } | "stale" | "gone" {
  const owner = lockOwner(path);
  if (owner !== null) return owner.host !== hostname() || pidAlive(owner.pid) ? owner : "stale";
  // No owner yet: being written this instant (held), or left unwritten by a process that died
  // between creating and writing it (stale, after a few seconds).
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
  return Date.now() - mtimeMs < 10_000 ? { pid: 0, host: "unknown" } : "stale";
}

/** Replace a stale lock with `mine`, under the takeover lock: `mine`, the live owner, or `retry`. */
function takeOver(path: string, mine: { pid: number; host: string }): "mine" | "retry" | { pid: number; host: string } {
  const guard = `${path}.takeover`;
  try {
    const fd = openSync(guard, "wx");
    try {
      writeSync(fd, JSON.stringify(mine));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another process is taking over. One whose writer is gone left it behind: clear it.
    const holder = lockOwner(guard);
    const abandoned =
      holder !== null
        ? holder.host === hostname() && !pidAlive(holder.pid)
        : (() => {
            try {
              return Date.now() - statSync(guard).mtimeMs >= 10_000;
            } catch {
              return false;
            }
          })();
    if (abandoned) rmSync(guard, { force: true });
    sleepSync(20);
    return "retry";
  }
  try {
    // Under the takeover lock, the judgement is the only one being made.
    const verdict = judge(path);
    if (verdict === "gone") return "retry";
    if (verdict !== "stale") return verdict;
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(mine));
    renameSync(tmp, path);
    const now = lockOwner(path);
    return now !== null && now.pid === mine.pid && now.host === mine.host ? "mine" : now ?? "retry";
  } finally {
    rmSync(guard, { force: true });
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockOwner(path: string): { pid: number; host: string } | null {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8")) as { pid: number; host: string };
    return typeof owner.pid === "number" && typeof owner.host === "string" ? owner : null;
  } catch {
    return null;
  }
}

/** Whether any process of the group `pgid` is still running. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function clearDriver(dbFile: string, runId: string): void {
  rmSync(join(runDirectory(dbFile, runId), "driver.json"), { force: true });
}

/** The run's driver, or null when none has attached (or the last one exited cleanly). */
export function readDriver(dbFile: string | null, runId: string): DriverAttachment | null {
  if (dbFile === null) return null;
  const path = join(runDirectory(dbFile, runId), "driver.json");
  if (!existsSync(path)) return null;
  let record: DriverRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as DriverRecord;
  } catch {
    return null;
  }
  return { ...record, alive: record.host === hostname() ? pidAlive(record.pid) : null };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
