/**
 * The presence index: which attempts this machine started are still open, across every
 * workspace it works in (`docs/execution-telemetry.md`, "Concurrency context"; hub
 * migration 006).
 *
 * It is a cache of the workspace rows, and its rules say so:
 *
 *   - written AFTER the workspace transaction commits, best effort, outside the journal
 *     seam — sync obligation 7 keeps hub writes away from the seam, and a hub write cannot
 *     be atomic with a workspace transaction anyway. A failed or skipped write loses
 *     nothing: the workspace rows are the record;
 *   - refreshed from every change to an attempt this machine opened, a pulled end and a
 *     stored orphan end included (the store after each mutation, `sync.ts` after each
 *     sync). Hub state is machine state and is not journaled, so an apply may write it;
 *   - rows of workspaces that are unregistered, or whose database is gone from its
 *     registered path, are left out of the counts, and a full rebuild reads every
 *     reachable workspace ({@link rebuildPresence});
 *   - it stores open and ended, not the read-time orphan state, so its counts can be too
 *     high. The fields that carry them say `storedOpen`.
 *
 * It opens `hub.db` itself rather than through `hub.ts`, which reaches the store and would
 * close a module cycle through the attempt ledger.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../../config/home.js";
import { openDb } from "../db.js";
import { journalFor, resolveDeviceId } from "../journal.js";
import { migrateHub } from "../schema.js";
import type { PresenceCounts } from "./attempts.js";

interface OwnAttempt {
  id: string;
  account_ref: string | null;
  started_at: string;
  ended_at: string | null;
  state: string;
}

function hubPath(home: string): string {
  return join(home, "hub.db");
}

/** The workspace's registered slug, which keys its rows. Null for one with none. */
function slugOf(db: DatabaseSync): string | null {
  try {
    return (db.prepare("SELECT value FROM meta WHERE key = 'slug'").get() as { value: string } | undefined)?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * The attempts this machine opened in one workspace: this device's, or — on a machine that
 * has never connected — the ones no device opened.
 */
function ownAttempts(db: DatabaseSync, device: string | null): OwnAttempt[] {
  const sql = `SELECT id, json_extract(provider_binding, '$.accountRef') AS account_ref, started_at, ended_at, state
                 FROM attempts WHERE ${device === null ? "device_id IS NULL" : "device_id = ?"}`;
  return (device === null ? db.prepare(sql).all() : db.prepare(sql).all(device)) as unknown as OwnAttempt[];
}

/** Write one workspace's rows to match its attempts: missing ones added, changed ones updated, gone ones removed. */
function writeRows(hub: DatabaseSync, slug: string, attempts: readonly OwnAttempt[]): void {
  const held = new Map(
    (hub.prepare("SELECT attempt_id, account_ref, ended_at FROM attempt_presence WHERE workspace = ?").all(slug) as Array<{
      attempt_id: string;
      account_ref: string | null;
      ended_at: string | null;
    }>).map((row) => [row.attempt_id, row]),
  );
  const upsert = hub.prepare(
    `INSERT INTO attempt_presence (workspace, attempt_id, account_ref, started_at, ended_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workspace, attempt_id) DO UPDATE SET account_ref = excluded.account_ref, started_at = excluded.started_at, ended_at = excluded.ended_at`,
  );
  hub.exec("BEGIN IMMEDIATE");
  try {
    const seen = new Set<string>();
    for (const attempt of attempts) {
      seen.add(attempt.id);
      // An ended attempt with no recorded instant still ended; the index only asks open or not.
      const endedAt = attempt.state === "ended" ? (attempt.ended_at ?? attempt.started_at) : null;
      const row = held.get(attempt.id);
      if (row && row.ended_at === endedAt && row.account_ref === attempt.account_ref) continue;
      upsert.run(slug, attempt.id, attempt.account_ref, attempt.started_at, endedAt);
    }
    const remove = hub.prepare("DELETE FROM attempt_presence WHERE workspace = ? AND attempt_id = ?");
    for (const id of held.keys()) if (!seen.has(id)) remove.run(slug, id);
    hub.exec("COMMIT");
  } catch (error) {
    hub.exec("ROLLBACK");
    throw error;
  }
}

/** Refresh this workspace's rows from its attempts. Best effort: throws nothing. */
export function refreshWorkspacePresence(db: DatabaseSync, home: string = stapleHome()): void {
  try {
    const slug = slugOf(db);
    if (slug === null) return;
    const attempts = ownAttempts(db, journalFor(db).deviceIdentity());
    const path = hubPath(home);
    // A machine with no hub has no registry for the index to live beside.
    if (!existsSync(path)) return;
    const hub = openDb(path);
    try {
      migrateHub(hub);
      writeRows(hub, slug, attempts);
    } finally {
      hub.close();
    }
  } catch {
    // The workspace rows are the record; a failed index write loses nothing.
  }
}

/**
 * Rebuild the whole index from every reachable registered workspace, opened read-only.
 * Returns how many workspaces were read.
 */
export function rebuildPresence(home: string = stapleHome()): number {
  const path = hubPath(home);
  if (!existsSync(path)) return 0;
  const device = resolveDeviceId();
  const hub = openDb(path);
  let read = 0;
  try {
    migrateHub(hub);
    const workspaces = hub.prepare("SELECT slug, path FROM workspaces").all() as Array<{ slug: string; path: string }>;
    for (const workspace of workspaces) {
      if (!workspace.path || !existsSync(workspace.path)) {
        hub.prepare("DELETE FROM attempt_presence WHERE workspace = ?").run(workspace.slug);
        continue;
      }
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(workspace.path, { readOnly: true });
        writeRows(hub, workspace.slug, ownAttempts(db, device));
        read += 1;
      } catch {
        // A database that cannot be opened, or predates attempts: its rows are left out of the counts.
      } finally {
        db?.close();
      }
    }
    hub.prepare("DELETE FROM attempt_presence WHERE workspace NOT IN (SELECT slug FROM workspaces)").run();
  } finally {
    hub.close();
  }
  return read;
}

/**
 * The machine-wide counts for a transition: open rows of registered workspaces whose database
 * is still where it was registered, excluding the attempt the transition belongs to. Read
 * through a read-only handle, inside the workspace's transaction, so it writes nothing.
 * Null when there is no index to read.
 */
export function presenceCounts(home: string = stapleHome()): PresenceCounts | null {
  const path = hubPath(home);
  if (!existsSync(path)) return null;
  return {
    count(exclude, accountRef) {
      const hub = new DatabaseSync(path, { readOnly: true });
      try {
        const table = hub.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attempt_presence'").get();
        if (!table) return null;
        const rows = hub
          .prepare(
            `SELECT p.account_ref AS account, w.path AS path
               FROM attempt_presence p JOIN workspaces w ON w.slug = p.workspace
              WHERE p.ended_at IS NULL AND p.attempt_id <> ?`,
          )
          .all(exclude) as Array<{ account: string | null; path: string }>;
        const reachable = new Map<string, boolean>();
        const live = rows.filter((row) => {
          if (!reachable.has(row.path)) reachable.set(row.path, row.path !== "" && existsSync(row.path));
          return reachable.get(row.path) === true;
        });
        return {
          all: live.length,
          account: accountRef === null ? null : live.filter((row) => row.account === accountRef).length,
        };
      } finally {
        hub.close();
      }
    },
  };
}
