import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../config/home.js";
import { openDb, tx } from "./db.js";
import { migrateHub } from "./schema.js";
import { derivePrefixBase, parseIdentifier, prefixSuffixForAttempt } from "./ids.js";
import { openWorkspace } from "./open.js";
import { RESOLVED_STATUSES, StapleError, nowIso } from "./types.js";

/** Best-effort cross-workspace fan-out after a resolution; never throws. */
export function notifyHubResolvedSafe(workspaceSlug: string, identifier: string): void {
  try {
    const hub = Hub.open();
    try {
      hub.notifyResolved(workspaceSlug, identifier);
    } finally {
      hub.close();
    }
  } catch {
    // The hub is optional at runtime; local state never depends on it.
  }
}

export interface WorkspaceEntry {
  slug: string;
  prefix: string;
  path: string;
  kind: string;
  addedAt: string;
  lastSeenAt: string | null;
  /** Whether the workspace file exists on this machine right now. */
  available: boolean;
}

export interface CrossLink {
  blockerWs: string;
  blockerIdentifier: string;
  blockedWs: string;
  blockedIdentifier: string;
  type: "blocks";
}

export interface CrossBlockerState {
  identifier: string;
  workspace: string;
  status: string | null; // null => unresolvable (workspace file not on this machine)
  resolved: boolean;
  unresolvable: boolean;
}

/**
 * The hub: registry of workspaces, unique identifier prefixes, and the edges
 * that span workspace files. Derived + linking state only — issues always live
 * in their workspace file, and every hub read degrades gracefully when a
 * registered file is not present on this machine.
 */
export class Hub {
  private constructor(readonly db: DatabaseSync, readonly path: string) {}

  static hubPath(): string {
    // One resolver for the whole process (src/config/home.ts). This used to be
    // `process.env.HOME ?? "~"`, which put the hub in a literal `~` directory
    // beside the cwd whenever HOME was unset, while global workspaces went to
    // the real home — two homes, one machine.
    return join(stapleHome(), "hub.db");
  }

  static open(): Hub {
    const path = Hub.hubPath();
    const db = openDb(path);
    migrateHub(db);
    return new Hub(db, path);
  }

  /**
   * A hub opened for reading only, with no migration and no WAL conversion.
   *
   * `Hub.open()` is not usable by `staple doctor`, and the reason is subtle
   * enough to be worth stating: it calls `migrateHub()`, which STAMPS an
   * unstamped hub — so a doctor that used it would silently repair the very
   * thing A4 asked doctor to WARN about. `openDb()` is not innocent either; it
   * issues `PRAGMA journal_mode=WAL`, which writes to the file header.
   *
   * SQLite's own read-only mode is the honest way to promise "this command
   * changed nothing": a write attempted through this handle fails rather than
   * succeeding quietly. Every query method below works unchanged.
   *
   * Callers must be ready for a schema older than this build's — the reads here
   * are all `SELECT *`, and `doctor` wraps each check so an old hub degrades to
   * one failed check instead of a failed run.
   */
  static openReadOnly(): Hub {
    const path = Hub.hubPath();
    if (!existsSync(path)) {
      throw new StapleError("not_found", `No hub database at ${path}.`);
    }
    return new Hub(new DatabaseSync(path, { readOnly: true }), path);
  }

  close(): void {
    this.db.close();
  }

  // ---------- registry ----------

  /** Mint a hub-unique prefix from a slug: BASE, BASEA, BASEAA, ... */
  allocatePrefix(slug: string): string {
    const base = derivePrefixBase(slug);
    const taken = new Set(
      (this.db.prepare("SELECT prefix FROM workspaces").all() as Array<{ prefix: string }>).map(
        (r) => r.prefix,
      ),
    );
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const candidate = `${base}${prefixSuffixForAttempt(attempt)}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new StapleError("conflict", `Could not allocate a unique prefix for "${slug}"`);
  }

  register(entry: { slug: string; prefix: string; path: string; kind: string }): void {
    tx(this.db, () => {
      const existing = this.db
        .prepare("SELECT slug, prefix FROM workspaces WHERE slug = ?")
        .get(entry.slug) as { slug: string; prefix: string } | undefined;
      if (existing && existing.prefix !== entry.prefix) {
        throw new StapleError(
          "conflict",
          `Workspace "${entry.slug}" is registered with prefix ${existing.prefix}, not ${entry.prefix}`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO workspaces (slug, prefix, path, kind, added_at, last_seen_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(slug) DO UPDATE SET path = excluded.path, last_seen_at = excluded.last_seen_at`,
        )
        .run(entry.slug, entry.prefix, entry.path, entry.kind, nowIso(), nowIso());
    });
  }

  /**
   * One row by slug, without the `existsSync` probe {@link list} does per row.
   *
   * Repair runs on every repository resolution, so it has to be cheap: this is a
   * single indexed lookup on the primary key and no filesystem work at all.
   */
  findBySlug(slug: string): WorkspaceEntry | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE slug = ?").get(slug) as
      | {
          slug: string;
          prefix: string;
          path: string;
          kind: string;
          added_at: string;
          last_seen_at: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      slug: row.slug,
      prefix: row.prefix,
      path: row.path,
      kind: row.kind,
      addedAt: row.added_at,
      lastSeenAt: row.last_seen_at,
      available: existsSync(row.path),
    };
  }

  /** The slug that already holds a prefix, if any — the guard against stealing one. */
  slugHoldingPrefix(prefix: string): string | undefined {
    const row = this.db.prepare("SELECT slug FROM workspaces WHERE prefix = ?").get(prefix) as
      | { slug: string }
      | undefined;
    return row?.slug;
  }

  /**
   * Point an existing registration at a path it has moved to.
   *
   * Deliberately narrower than {@link register}: it takes the prefix as a FACT
   * read out of the workspace database rather than as a value to assign, and it
   * refuses rather than reassigns when the registry disagrees. Plan §4: "Repair
   * may update a stale path and `last_seen_at`. It may not allocate a new prefix
   * or overwrite a slug registered with another prefix."
   */
  repointPath(entry: { slug: string; prefix: string; path: string; kind: string }): void {
    tx(this.db, () => {
      const existing = this.db
        .prepare("SELECT prefix FROM workspaces WHERE slug = ?")
        .get(entry.slug) as { prefix: string } | undefined;
      if (existing && existing.prefix !== entry.prefix) {
        throw new StapleError(
          "conflict",
          `Workspace "${entry.slug}" is registered with prefix ${existing.prefix}, not ${entry.prefix}`,
        );
      }
      if (!existing) {
        // A registration that vanished (a deleted hub, a restored backup). The
        // prefix is not allocated here — it is the one already stamped into the
        // workspace database, so re-registering cannot renumber anything.
        const holder = this.db.prepare("SELECT slug FROM workspaces WHERE prefix = ?").get(entry.prefix) as
          | { slug: string }
          | undefined;
        if (holder) {
          throw new StapleError(
            "conflict",
            `Prefix ${entry.prefix} is registered to workspace "${holder.slug}", so "${entry.slug}" cannot claim it`,
          );
        }
      }
      this.db
        .prepare(
          `INSERT INTO workspaces (slug, prefix, path, kind, added_at, last_seen_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(slug) DO UPDATE SET path = excluded.path, last_seen_at = excluded.last_seen_at`,
        )
        .run(entry.slug, entry.prefix, entry.path, entry.kind, nowIso(), nowIso());
    });
  }

  list(): WorkspaceEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces ORDER BY slug")
      .all() as Array<{
      slug: string;
      prefix: string;
      path: string;
      kind: string;
      added_at: string;
      last_seen_at: string | null;
    }>;
    return rows.map((r) => ({
      slug: r.slug,
      prefix: r.prefix,
      path: r.path,
      kind: r.kind,
      addedAt: r.added_at,
      lastSeenAt: r.last_seen_at,
      available: existsSync(r.path),
    }));
  }

  get(slugOrPrefix: string): WorkspaceEntry | undefined {
    return this.list().find(
      (w) => w.slug === slugOrPrefix || w.prefix === slugOrPrefix.toUpperCase(),
    );
  }

  /** Resolve an identifier like GAR-42 to its owning workspace entry. */
  resolveIdentifier(identifier: string): { entry: WorkspaceEntry; identifier: string } {
    const parsed = parseIdentifier(identifier);
    if (!parsed) {
      throw new StapleError("validation", `"${identifier}" is not an identifier (expected PREFIX-N)`);
    }
    const entry = this.list().find((w) => w.prefix === parsed.prefix);
    if (!entry) {
      throw new StapleError("not_found", `No workspace with prefix ${parsed.prefix} in the hub`);
    }
    return { entry, identifier: `${parsed.prefix}-${parsed.number}` };
  }

  // ---------- cross-workspace links ----------

  /**
   * blocker blocks blocked, across workspace files. Both identifiers must
   * resolve to registered workspaces; existence inside each file is validated
   * when the file is present (best-effort by design).
   */
  addCrossLink(blockerIdentifier: string, blockedIdentifier: string): CrossLink {
    const blocker = this.resolveIdentifier(blockerIdentifier);
    const blocked = this.resolveIdentifier(blockedIdentifier);
    if (blocker.entry.slug === blocked.entry.slug) {
      throw new StapleError(
        "validation",
        `Both issues are in workspace "${blocker.entry.slug}" — use the workspace-local blocked-by instead`,
      );
    }
    for (const side of [blocker, blocked]) {
      if (side.entry.available) {
        const ws = openWorkspace(side.entry.path);
        try {
          ws.store.getIssue(side.identifier);
        } finally {
          ws.store.db.close();
        }
      }
    }
    // Cross-file cycle guard over the hub edges (workspace-local edges cannot
    // close a cross-file loop unless a hub edge participates in it too — a
    // documented prototype simplification).
    this.assertNoCrossCycle(blocker.identifier, blocked.identifier);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO cross_links
           (blocker_ws, blocker_identifier, blocked_ws, blocked_identifier, type, created_at)
         VALUES (?,?,?,?, 'blocks', ?)`,
      )
      .run(blocker.entry.slug, blocker.identifier, blocked.entry.slug, blocked.identifier, nowIso());
    return {
      blockerWs: blocker.entry.slug,
      blockerIdentifier: blocker.identifier,
      blockedWs: blocked.entry.slug,
      blockedIdentifier: blocked.identifier,
      type: "blocks",
    };
  }

  private assertNoCrossCycle(newBlocker: string, newBlocked: string): void {
    const edges = this.listCrossLinks();
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      const list = adjacency.get(edge.blockerIdentifier) ?? [];
      list.push(edge.blockedIdentifier);
      adjacency.set(edge.blockerIdentifier, list);
    }
    // Path from newBlocked back to newBlocker would close a loop.
    const queue = [newBlocked];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === newBlocker) {
        throw new StapleError("cycle", "Cross-workspace blocking relations cannot contain cycles");
      }
      if (visited.has(current)) continue;
      visited.add(current);
      queue.push(...(adjacency.get(current) ?? []));
    }
  }

  removeCrossLink(blockerIdentifier: string, blockedIdentifier: string): void {
    this.db
      .prepare(
        "DELETE FROM cross_links WHERE blocker_identifier = ? AND blocked_identifier = ?",
      )
      .run(blockerIdentifier.toUpperCase(), blockedIdentifier.toUpperCase());
  }

  listCrossLinks(): CrossLink[] {
    const rows = this.db
      .prepare("SELECT * FROM cross_links ORDER BY id")
      .all() as Array<{
      blocker_ws: string;
      blocker_identifier: string;
      blocked_ws: string;
      blocked_identifier: string;
    }>;
    return rows.map((r) => ({
      blockerWs: r.blocker_ws,
      blockerIdentifier: r.blocker_identifier,
      blockedWs: r.blocked_ws,
      blockedIdentifier: r.blocked_identifier,
      type: "blocks" as const,
    }));
  }

  /**
   * Cross-workspace readiness for one issue. A blocker whose workspace file is
   * missing on this machine reports unresolvable => treat as blocked (the
   * graceful-degradation rule from the evaluation).
   */
  crossBlockersOf(identifier: string): CrossBlockerState[] {
    const target = this.resolveIdentifier(identifier);
    const links = this.db
      .prepare("SELECT * FROM cross_links WHERE blocked_ws = ? AND blocked_identifier = ?")
      .all(target.entry.slug, target.identifier) as Array<{
      blocker_ws: string;
      blocker_identifier: string;
    }>;
    return links.map((link) => {
      const entry = this.get(link.blocker_ws);
      if (!entry || !entry.available) {
        return {
          identifier: link.blocker_identifier,
          workspace: link.blocker_ws,
          status: null,
          resolved: false,
          unresolvable: true,
        };
      }
      const ws = openWorkspace(entry.path);
      try {
        const issue = ws.store.getIssue(link.blocker_identifier);
        return {
          identifier: link.blocker_identifier,
          workspace: link.blocker_ws,
          status: issue.status,
          resolved: (RESOLVED_STATUSES as readonly string[]).includes(issue.status),
          unresolvable: false,
        };
      } catch {
        return {
          identifier: link.blocker_identifier,
          workspace: link.blocker_ws,
          status: null,
          resolved: false,
          unresolvable: true,
        };
      } finally {
        ws.store.db.close();
      }
    });
  }

  /**
   * Called after an issue resolves: emits a level-triggered hub event for each
   * cross-workspace dependent whose cross blockers are now all resolved.
   */
  notifyResolved(workspaceSlug: string, identifier: string): void {
    const dependents = this.db
      .prepare("SELECT blocked_ws, blocked_identifier FROM cross_links WHERE blocker_ws = ? AND blocker_identifier = ?")
      .all(workspaceSlug, identifier.toUpperCase()) as Array<{
      blocked_ws: string;
      blocked_identifier: string;
    }>;
    for (const dependent of dependents) {
      const states = this.crossBlockersOf(dependent.blocked_identifier);
      if (states.length === 0 || states.some((s) => !s.resolved)) continue;
      const digest = createHash("sha256")
        .update(states.map((s) => s.identifier).sort().join(","))
        .digest("hex")
        .slice(0, 32);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO hub_events (kind, payload, dedup_key, created_at)
           VALUES ('cross_blockers_resolved', ?, ?, ?)`,
        )
        .run(
          JSON.stringify({
            workspace: dependent.blocked_ws,
            identifier: dependent.blocked_identifier,
            blockers: states.map((s) => s.identifier),
          }),
          `cross_blockers_resolved:${dependent.blocked_identifier}:${digest}`,
          nowIso(),
        );
    }
  }

  listHubEvents(since = 0, limit = 200): Array<{
    seq: number;
    kind: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM hub_events WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(since, limit) as Array<{ seq: number; kind: string; payload: string; created_at: string }>;
    return rows.map((r) => ({
      seq: r.seq,
      kind: r.kind,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  // ---------- holistic views ----------

  /**
   * Unified open-issue view across every available workspace. Prototype note:
   * reads each file through its own connection (simple + safe); the ATTACH
   * union in one connection is the optimization documented in the evaluation.
   */
  unifiedIssues(filter: { assignee?: string } = {}): Array<{
    workspace: string;
    prefix: string;
    issue: ReturnType<Hub["readWorkspaceIssues"]>[number];
  }> {
    const out: Array<{ workspace: string; prefix: string; issue: never }> = [];
    for (const entry of this.list()) {
      if (!entry.available) continue;
      for (const issue of this.readWorkspaceIssues(entry, filter)) {
        out.push({ workspace: entry.slug, prefix: entry.prefix, issue: issue as never });
      }
    }
    return out;
  }

  private readWorkspaceIssues(entry: WorkspaceEntry, filter: { assignee?: string }) {
    const ws = openWorkspace(entry.path);
    try {
      return ws.store.listIssues(filter.assignee ? { assignee: filter.assignee } : {});
    } finally {
      ws.store.db.close();
    }
  }

  /** Cross-workspace dependency graph: nodes + both local and hub edges. */
  graph(): {
    nodes: Array<{ id: string; workspace: string; title: string; status: string; parent: string | null }>;
    edges: Array<{ from: string; to: string; cross: boolean }>;
  } {
    const nodes: Array<{ id: string; workspace: string; title: string; status: string; parent: string | null }> = [];
    const edges: Array<{ from: string; to: string; cross: boolean }> = [];
    for (const entry of this.list()) {
      if (!entry.available) continue;
      const ws = openWorkspace(entry.path);
      try {
        const issues = ws.store.listIssues({ includeResolved: true });
        // parent is the parent's IDENTIFIER (like every other id in this payload),
        // mapped from the rows already in hand — same contract as the single-
        // workspace graph route, so epic clusters work in hub mode too. Parents
        // never span workspaces, so the map is per-workspace by construction.
        const identifierOf = new Map(issues.map((issue) => [issue.id, issue.identifier]));
        for (const issue of issues) {
          nodes.push({
            id: issue.identifier,
            workspace: entry.slug,
            title: issue.title,
            status: issue.status,
            parent: issue.parentId ? (identifierOf.get(issue.parentId) ?? null) : null,
          });
        }
        for (const edge of ws.store.edges()) {
          edges.push({ from: edge.blocker, to: edge.blocked, cross: false });
        }
      } finally {
        ws.store.db.close();
      }
    }
    for (const link of this.listCrossLinks()) {
      edges.push({ from: link.blockerIdentifier, to: link.blockedIdentifier, cross: true });
    }
    return { nodes, edges };
  }
}
