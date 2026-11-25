import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../config/home.js";
import { RESOLVED_CATEGORIES, RESOLVED_STATUSES, StapleError } from "./types.js";

/**
 * The hub's cross-repository blockers, read for the pickup and checkout paths of ONE
 * workspace.
 *
 * A workspace store reads these itself, so every surface that asks the resolver
 * (`queue next`, inbox, checkout, MCP, HTTP, runs) sees a link without remembering to
 * inject it. That is why this module touches the hub and the other workspace files
 * through read-only SQLite handles and nothing else: it does not import `Hub` or
 * `openWorkspace` (the store would then import itself through them), it never migrates or
 * re-stamps another workspace's file on a read, and it never creates a hub that is not
 * there. It reads the same facts `Hub.crossBlockersOf` reads, by the same rule: a blocker
 * resolves when its own workspace files its status under done or cancelled, and one this
 * machine cannot read holds the ticket.
 */
export interface HubCrossBlocker {
  identifier: string;
  workspace: string;
  /** Null when the blocker cannot be read here. */
  status: string | null;
  resolved: boolean;
  unresolvable: boolean;
  /** Why an unresolvable blocker cannot be read: its workspace is not here, or it has no such task. */
  missing: "workspace" | "task" | null;
}

interface LinkRow {
  blocker_ws: string;
  blocker_identifier: string;
  blocked_ws: string;
  blocked_identifier: string;
}

function openReadOnly(path: string): DatabaseSync | null {
  if (path === "" || !existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

/** This machine's hub, read-only, or null when it has none or it predates the links. */
function openHub(home: string): DatabaseSync | null {
  const db = openReadOnly(join(home, "hub.db"));
  if (db === null) return null;
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cross_links', 'workspaces')")
      .all();
    if (tables.length === 2) return db;
  } catch {
    // Not a database this build can read: treated as no hub, below.
  }
  db.close();
  return null;
}

/**
 * Run `fn` over this machine's hub, or answer `empty` without one. The hub is optional at
 * runtime, exactly as `notifyHubResolvedSafe` treats it: a hub that cannot be opened or read
 * holds nothing back, rather than failing every pickup and checkout in the workspace. Only a
 * refusal (`StapleError`, the cycle check's) passes through.
 */
function withHub<T>(home: string, empty: T, fn: (hub: DatabaseSync) => T): T {
  let hub: DatabaseSync | null = null;
  try {
    hub = openHub(home);
    return hub === null ? empty : fn(hub);
  } catch (error) {
    if (error instanceof StapleError) throw error;
    return empty;
  } finally {
    hub?.close();
  }
}

/** Is this status finished, by the workspace's own category when it has one? */
function isResolved(status: string, category: string | null): boolean {
  if (category !== null) return (RESOLVED_CATEGORIES as readonly string[]).includes(category);
  return (RESOLVED_STATUSES as readonly string[]).includes(status);
}

/** `identifier -> {status, category}` for the named issues of one workspace file. */
function statusesIn(db: DatabaseSync, identifiers: readonly string[]): Map<string, { status: string; category: string | null }> {
  const marks = identifiers.map(() => "?").join(",");
  const categorized =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_statuses'").get() !== undefined;
  const rows = db
    .prepare(
      categorized
        ? `SELECT i.identifier, i.status, s.category FROM issues i
             LEFT JOIN workspace_statuses s ON s.id = i.status WHERE i.identifier IN (${marks})`
        : `SELECT identifier, status, NULL AS category FROM issues WHERE identifier IN (${marks})`,
    )
    .all(...identifiers) as Array<{ identifier: string; status: string; category: string | null }>;
  return new Map(rows.map((row) => [row.identifier, { status: row.status, category: row.category }]));
}

function workspacePath(hub: DatabaseSync, slug: string): string | null {
  const row = hub.prepare("SELECT path FROM workspaces WHERE slug = ?").get(slug) as { path: string } | undefined;
  return row?.path ?? null;
}

/** Each `[blocker, blocked]` identifier pair a workspace's local `blocks` edges hold. */
export function localEdgesOf(db: DatabaseSync): Array<[string, string]> {
  const rows = db
    .prepare(
      `SELECT b.identifier AS blocker, d.identifier AS blocked
         FROM relations r
         JOIN issues b ON b.id = r.blocker_id
         JOIN issues d ON d.id = r.blocked_id
        WHERE r.type = 'blocks'`,
    )
    .all() as Array<{ blocker: string; blocked: string }>;
  return rows.map((row) => [row.blocker, row.blocked]);
}

/**
 * Every cross-repository blocker of every issue in workspace `slug`, keyed by the blocked
 * identifier. Empty when there is no hub, or no link ends in this workspace. Each blocker
 * workspace is opened once, however many links name it.
 */
export function readCrossBlockers(slug: string, home: string = stapleHome()): Map<string, HubCrossBlocker[]> {
  const out = new Map<string, HubCrossBlocker[]>();
  return withHub(home, out, (hub) => {
    const links = hub
      .prepare("SELECT * FROM cross_links WHERE blocked_ws = ? ORDER BY id")
      .all(slug) as unknown as LinkRow[];
    if (links.length === 0) return out;
    const statuses = new Map<string, Map<string, { status: string; category: string | null }> | null>();
    for (const blockerWs of new Set(links.map((link) => link.blocker_ws))) {
      const path = workspacePath(hub, blockerWs);
      const db = path === null ? null : openReadOnly(path);
      if (db === null) {
        statuses.set(blockerWs, null);
        continue;
      }
      try {
        const named = links.filter((link) => link.blocker_ws === blockerWs).map((link) => link.blocker_identifier);
        statuses.set(blockerWs, statusesIn(db, named));
      } catch {
        statuses.set(blockerWs, null);
      } finally {
        db.close();
      }
    }
    for (const link of links) {
      const inWorkspace = statuses.get(link.blocker_ws) ?? null;
      const read = inWorkspace?.get(link.blocker_identifier) ?? null;
      const status = read?.status ?? null;
      const blocker: HubCrossBlocker = {
        identifier: link.blocker_identifier,
        workspace: link.blocker_ws,
        status,
        resolved: read !== null && isResolved(read.status, read.category),
        unresolvable: status === null,
        missing: inWorkspace === null ? "workspace" : status === null ? "task" : null,
      };
      out.set(link.blocked_identifier, [...(out.get(link.blocked_identifier) ?? []), blocker]);
    }
    return out;
  });
}

/** The blockers that still hold a ticket: unresolved, or not readable on this machine. */
export function holdingCrossBlockers<T extends { resolved: boolean; unresolvable: boolean }>(blockers: readonly T[]): T[] {
  return blockers.filter((blocker) => !blocker.resolved || blocker.unresolvable);
}

/** One blocker as a sentence names it: `APP-3 in app`, and why it cannot be resolved when it cannot. */
export function describeCrossBlocker(blocker: { identifier: string; workspace?: string; unresolvable: boolean }): string {
  const where = blocker.workspace ? `${blocker.identifier} in ${blocker.workspace}` : blocker.identifier;
  return blocker.unresolvable ? `${where} (cannot be resolved on this machine)` : where;
}

/**
 * Refuse a `blocks` edge that would close a loop through the hub: a cycle that mixes local
 * and cross-repository edges, which neither the workspace's own check (local edges only)
 * nor a check over the hub's links alone can see.
 *
 * The graph is every cross link, plus the local edges of every workspace a link names.
 * `own` replaces one workspace's local edges with the caller's: a store mid-write passes
 * the edges its own connection holds, which another connection would not see yet.
 * `proposed` are the edges being added, as `[blocker, blocked]` identifiers.
 */
export function assertNoHubCycle(
  proposed: ReadonlyArray<readonly [string, string]>,
  options: { own?: { slug: string; edges: ReadonlyArray<readonly [string, string]> }; home?: string; hub?: DatabaseSync } = {},
): void {
  if (proposed.length === 0) return;
  const check = (hub: DatabaseSync): void => {
    const links = hub.prepare("SELECT * FROM cross_links ORDER BY id").all() as unknown as LinkRow[];
    if (links.length === 0) return;
    // A local edge can only close a loop through the hub if a link touches its workspace.
    const own = options.own;
    if (own && !links.some((link) => link.blocker_ws === own.slug || link.blocked_ws === own.slug)) return;
    const adjacency = new Map<string, string[]>();
    const add = (from: string, to: string): void => {
      adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
    };
    for (const link of links) add(link.blocker_identifier, link.blocked_identifier);
    const slugs = new Set(links.flatMap((link) => [link.blocker_ws, link.blocked_ws]));
    if (options.own) slugs.add(options.own.slug);
    for (const slug of slugs) {
      if (options.own && slug === options.own.slug) {
        for (const [from, to] of options.own.edges) add(from, to);
        continue;
      }
      const path = workspacePath(hub, slug);
      const db = path === null ? null : openReadOnly(path);
      if (db === null) continue;
      try {
        for (const [from, to] of localEdgesOf(db)) add(from, to);
      } catch {
        // A file this build cannot read contributes no edges; the link checks still run.
      } finally {
        db.close();
      }
    }
    for (const [blocker, blocked] of proposed) {
      // The new edge closes a loop iff the blocked issue already reaches its blocker.
      const path = pathBetween(adjacency, blocked, blocker);
      if (path !== null) {
        throw new StapleError(
          "cycle",
          `Blocking relations cannot contain cycles: ${[blocker, ...path].join(" blocks ")} across repositories`,
        );
      }
    }
  };
  if (options.hub) {
    check(options.hub);
    return;
  }
  withHub(options.home ?? stapleHome(), undefined, check);
}

function pathBetween(adjacency: ReadonlyMap<string, readonly string[]>, from: string, to: string): string[] | null {
  const previous = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) {
      const path: string[] = [];
      for (let step: string | null = current; step !== null; step = previous.get(step) ?? null) path.unshift(step);
      return path;
    }
    for (const next of adjacency.get(current) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  return null;
}
