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
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../../config/home.js";
import { openDb } from "../db.js";
import { journalFor, resolveDeviceId } from "../journal.js";
import { migrateHub } from "../schema.js";
import { openedHere } from "./attempt-records.js";
import type { PresenceCounts } from "./attempts.js";

interface OwnAttempt {
  id: string;
  provider: string | null;
  account_ref: string | null;
  session_refs: string;
  started_at: string;
  ended_at: string | null;
  state: string;
}

function hubPath(home: string): string {
  return join(home, "hub.db");
}

/** A path with symlinks resolved when it exists, so `/var` and `/private/var` agree. */
function canonical(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/**
 * The hub row registered for THIS database file, by its path, which keys its rows. Never the
 * slug the workspace stamps in its own `meta`: two databases can claim one slug (a copy, a
 * workspace re-registered elsewhere), and keyed by it they would overwrite each other's rows.
 * Null for a database the hub does not register (in memory, or never registered).
 */
function hubSlugFor(hub: DatabaseSync, db: DatabaseSync): string | null {
  const main = (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find((row) => row.name === "main");
  if (!main || main.file === "") return null;
  const file = canonical(main.file);
  const rows = hub.prepare("SELECT slug, path FROM workspaces WHERE path <> ''").all() as Array<{ slug: string; path: string }>;
  return rows.find((row) => canonical(row.path) === file)?.slug ?? null;
}

/**
 * The attempts this machine opened in one workspace: this device's, or — on a machine that
 * has never connected — the ones no device opened.
 */
function ownAttempts(db: DatabaseSync, device: string | null): OwnAttempt[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.device_id, json_extract(a.provider_binding, '$.provider') AS provider,
              json_extract(a.provider_binding, '$.accountRef') AS account_ref,
              (SELECT json_group_array(ref) FROM (
                 SELECT json_extract(a.harness, '$.sessionRef') AS ref
                 UNION
                 SELECT json_extract(t.detail, '$.sessionRef') FROM attempt_transitions t
                  WHERE t.attempt_id = a.id AND t.kind = 'attempt_session_added'
               ) WHERE ref IS NOT NULL) AS session_refs,
              a.started_at, a.ended_at, a.state
         FROM attempts a WHERE a.device_id IS NULL OR a.device_id = ?`,
    )
    .all(device ?? "") as unknown as Array<OwnAttempt & { device_id: string | null }>;
  // The one rule for "opened on this machine" (`openedHere`): pre-connect attempts included.
  return rows.filter((row) => openedHere(db, { id: row.id, deviceId: row.device_id }, device));
}

/** Write one workspace's rows to match its attempts: missing ones added, changed ones updated, gone ones removed. */
function writeRows(hub: DatabaseSync, slug: string, attempts: readonly OwnAttempt[]): void {
  const held = new Map(
    (hub.prepare("SELECT attempt_id, provider, account_ref, session_refs, ended_at FROM attempt_presence WHERE workspace = ?").all(slug) as Array<{
      attempt_id: string;
      provider: string | null;
      account_ref: string | null;
      session_refs: string;
      ended_at: string | null;
    }>).map((row) => [row.attempt_id, row]),
  );
  const upsert = hub.prepare(
    `INSERT INTO attempt_presence (workspace, attempt_id, provider, account_ref, session_refs, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace, attempt_id) DO UPDATE SET provider = excluded.provider, account_ref = excluded.account_ref,
       session_refs = excluded.session_refs, started_at = excluded.started_at, ended_at = excluded.ended_at`,
  );
  hub.exec("BEGIN IMMEDIATE");
  try {
    const seen = new Set<string>();
    for (const attempt of attempts) {
      seen.add(attempt.id);
      // An ended attempt with no recorded instant still ended; the index only asks open or not.
      const endedAt = attempt.state === "ended" ? (attempt.ended_at ?? attempt.started_at) : null;
      const row = held.get(attempt.id);
      const sessions = attempt.session_refs ?? "[]";
      if (row && row.ended_at === endedAt && row.account_ref === attempt.account_ref && row.provider === attempt.provider && row.session_refs === sessions) continue;
      upsert.run(slug, attempt.id, attempt.provider, attempt.account_ref, sessions, attempt.started_at, endedAt);
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
    const path = hubPath(home);
    // A machine with no hub has no registry for the index to live beside.
    if (!existsSync(path)) return;
    const hub = openDb(path);
    try {
      migrateHub(hub);
      const slug = hubSlugFor(hub, db);
      if (slug === null) return;
      writeRows(hub, slug, ownAttempts(db, journalFor(db).deviceIdentity()));
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
