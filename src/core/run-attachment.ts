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
  /** The session's pid while one runs. */
  sessionPid: number | null;
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
 * both read "no live driver" and go on. A lock whose owner is gone (its pid is not
 * running on this host) is stale: it is removed and taken. Returns the release function,
 * or the owner that holds it.
 */
export function acquireDriverLock(dbFile: string, runId: string): { release: () => void } | { heldBy: { pid: number; host: string } } {
  const path = join(ensureRunDirectory(dbFile, runId), "driver.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname() }));
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          if (lockOwner(path)?.pid === process.pid) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = lockOwner(path);
      if (owner === null) {
        // A lock being written this instant has no owner yet: held. One left unwritten for
        // seconds belongs to a process that died between creating and writing it: stale.
        if (Date.now() - statSync(path).mtimeMs < 10_000) return { heldBy: { pid: 0, host: "unknown" } };
      } else if (owner.host !== hostname() || pidAlive(owner.pid)) {
        return { heldBy: owner };
      }
      rmSync(path, { force: true });
    }
  }
  return { heldBy: lockOwner(path) ?? { pid: 0, host: "unknown" } };
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
