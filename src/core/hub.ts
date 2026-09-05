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

/** What {@link Hub.unregister} would do, without doing it. */
export interface UnregisterPreview {
  entry: WorkspaceEntry;
  /** Every cross-link naming this workspace on either side. */
  crossLinks: CrossLink[];
}

export interface UnregisterResult {
  workspace: WorkspaceEntry;
  /** Empty unless the caller asked for the cascade. */
  removedCrossLinks: CrossLink[];
  /** The prefix this row was holding, now available to {@link Hub.allocatePrefix}. */
  prefixReleased: string;
}

/** A dead row prune found, and whether anything stands in the way of removing it. */
export interface PruneCandidate extends UnregisterPreview {
  /** `"cross_links"` when the row can only be removed with the cascade enabled. */
  blockedBy: "cross_links" | null;
}

export interface PruneResult {
  /** Rows removed — or, when `dryRun`, the rows that WOULD be removed. */
  removed: UnregisterResult[];
  /** Dead rows left in place, with the reason. */
  skipped: PruneCandidate[];
  dryRun: boolean;
}

function crossLinkRowsFor(db: DatabaseSync, slug: string): CrossLink[] {
  const rows = db
    .prepare(
      "SELECT * FROM cross_links WHERE blocker_ws = ? OR blocked_ws = ? ORDER BY id",
    )
    .all(slug, slug) as Array<{
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
 * The entire write side of unregistration — deliberately a free function, and
 * deliberately this narrow.
 *
 * STA-249's hard requirement is that removing a registration "must never delete,
 * move, or open-for-write the workspace database or any file in the workspace
 * directory", and that this be structurally true rather than merely intended.
 * The structure is the signature: this function is handed a database connection
 * and a NAME. It receives no path, no `fs` module and no workspace opener, so it
 * has nothing to reach a workspace file WITH. Making it capable of damage would
 * require widening these parameters first, which is a visible diff in review.
 *
 * (`Hub` itself cannot make that promise: it imports `openWorkspace` for
 * `addCrossLink`, `crossBlockersOf`, `unifiedIssues` and `graph`. Hoisting the
 * removal out of the class is what buys the guarantee.)
 *
 * One transaction, so a refused cascade cannot leave the row gone and its links
 * behind — which is precisely the dangling state the refusal exists to prevent.
 */
export function deleteHubRegistration(
  db: DatabaseSync,
  slug: string,
  options: { withLinks: boolean } = { withLinks: false },
): CrossLink[] {
  return tx(db, () => {
    const links = crossLinkRowsFor(db, slug);
    if (links.length > 0 && !options.withLinks) {
      throw new StapleError("conflict", crossLinkRefusal(slug, links));
    }
    if (links.length > 0) {
      db.prepare("DELETE FROM cross_links WHERE blocker_ws = ? OR blocked_ws = ?").run(slug, slug);
    }
    const outcome = db.prepare("DELETE FROM workspaces WHERE slug = ?").run(slug);
    if (outcome.changes === 0) {
      throw new StapleError("not_found", unknownWorkspaceMessage(slug));
    }
    return links;
  });
}

function unknownWorkspaceMessage(slugOrPrefix: string): string {
  return (
    `No workspace "${slugOrPrefix}" is registered in the hub. ` +
    "Run `staple hub ls` to see the registered slugs and prefixes."
  );
}

/**
 * Why a link is a refusal rather than a silent cascade.
 *
 * A workspace database survives unregistration untouched and `init` re-registers
 * it, so removing a row is recoverable. A cross-link is not: `cross_links` lives
 * only in the hub, so a cascaded delete is the end of that edge. The operator
 * asked to remove a registry row; taking edges with it is a larger action than
 * the one requested, and it is taken only when asked for by name.
 *
 * Leaving them behind is not the alternative. `crossBlockersOf` reports a
 * blocker whose workspace is gone as unresolvable, and the readiness rule reads
 * unresolvable as BLOCKED — so a dangling edge wedges a live issue in a
 * still-registered workspace, permanently, with no surface that says why.
 */
function crossLinkRefusal(slug: string, links: CrossLink[]): string {
  const listed = links
    .map((l) => `${l.blockerIdentifier} blocks ${l.blockedIdentifier}`)
    .join("; ");
  const count = links.length === 1 ? "1 cross-workspace link" : `${links.length} cross-workspace links`;
  return (
    `Workspace "${slug}" is named by ${count} (${listed}). ` +
    "Removing the registration without them would leave every listed edge pointing at an " +
    "unregistered workspace, which reads as an unresolvable blocker and silently blocks the " +
    "issue on the other side. Remove them one at a time with `staple hub unlink <blocker> " +
    "<blocked>`, or pass --with-links to remove them along with the registration."
  );
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

  /** Every cross-link naming this workspace, on either side of the edge. */
  crossLinksFor(slug: string): CrossLink[] {
    return crossLinkRowsFor(this.db, slug);
  }

  /**
   * What {@link unregister} would do to `slugOrPrefix`, as a pure read.
   *
   * Resolution goes through {@link get}, so a slug and either case of a prefix
   * are the same address — an agent that copied a prefix out of a `hub ls` line
   * does not have to know which column it was looking at.
   */
  previewUnregister(slugOrPrefix: string): UnregisterPreview {
    const entry = this.get(slugOrPrefix);
    if (!entry) {
      throw new StapleError("not_found", unknownWorkspaceMessage(slugOrPrefix));
    }
    return { entry, crossLinks: this.crossLinksFor(entry.slug) };
  }

  /**
   * Remove ONE registration named by slug or prefix.
   *
   * This deletes a hub row and nothing else. The workspace database is left
   * exactly as it was — see {@link deleteHubRegistration} for why that is a
   * property of the code's shape rather than a promise.
   *
   * It is not a blacklist, and should not be: the hub is derived state, the
   * authoritative slug and prefix live in the workspace file, and
   * `repairHubRegistration` re-registers a missing row on the next walk-up
   * resolution inside that repository. Unregistering a workspace whose directory
   * still exists therefore lasts until someone runs a command in it, which is
   * the correct behaviour for a registry. For the rows this exists to clean —
   * ones whose path is gone — there is nothing left to re-register.
   */
  unregister(slugOrPrefix: string, options: { withLinks?: boolean } = {}): UnregisterResult {
    const { entry } = this.previewUnregister(slugOrPrefix);
    const removedCrossLinks = deleteHubRegistration(this.db, entry.slug, {
      withLinks: options.withLinks === true,
    });
    return { workspace: entry, removedCrossLinks, prefixReleased: entry.prefix };
  }

  /**
   * Rows whose recorded path is not on this machine.
   *
   * `available` is `existsSync(path)` and nothing more, which is the whole test
   * — and the reason prune must NOT normalise the path first. This hub holds
   * rows spelled `/var/...` for files whose realpath is `/private/var/...`
   * (`findRepointableRows` exists because of it), so comparing path STRINGS says
   * "stale" about a perfectly live workspace. `existsSync` follows symlinks, so
   * both spellings answer yes to the only question prune asks. Spelling is
   * repair's problem, because repair compares paths; prune just asks the
   * filesystem whether the file is there.
   */
  pruneCandidates(options: { withLinks?: boolean } = {}): PruneCandidate[] {
    return this.list()
      .filter((entry) => !entry.available)
      .map((entry) => {
        const crossLinks = this.crossLinksFor(entry.slug);
        const encumbered = crossLinks.length > 0 && options.withLinks !== true;
        return { entry, crossLinks, blockedBy: encumbered ? ("cross_links" as const) : null };
      });
  }

  /**
   * Sweep every dead row. Previews by default; `apply` performs it.
   *
   * A separate verb from {@link unregister} because the two are different
   * operations: unregister names a row the operator has already looked at, while
   * prune acts on a set they have NOT seen — which is why it shows the set first
   * and needs an explicit yes. It is also partial-tolerant where unregister is
   * all-or-nothing: one encumbered row must not block the cleanup of every other
   * row, so each removal is its own transaction and the refusals come back as
   * `skipped` rather than as a thrown error.
   */
  prune(options: { apply?: boolean; withLinks?: boolean } = {}): PruneResult {
    const dryRun = options.apply !== true;
    const removed: UnregisterResult[] = [];
    const skipped: PruneCandidate[] = [];
    for (const candidate of this.pruneCandidates({ withLinks: options.withLinks })) {
      if (candidate.blockedBy !== null) {
        skipped.push(candidate);
        continue;
      }
      const result: UnregisterResult = {
        workspace: candidate.entry,
        removedCrossLinks: candidate.crossLinks,
        prefixReleased: candidate.entry.prefix,
      };
      if (!dryRun) {
        deleteHubRegistration(this.db, candidate.entry.slug, {
          withLinks: options.withLinks === true,
        });
      }
      removed.push(result);
    }
    return { removed, skipped, dryRun };
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

  /**
   * Drop one hub edge. Returns the link it removed, or undefined if there was
   * none — a distinction STA-249 needs rather than merely likes.
   *
   * This is the non-destructive way out of the refusal `unregister` raises while
   * a workspace is still linked, so it is the command an operator reaches for
   * with two identifiers they typed by hand. A version that returned void would
   * report success for a typo, leaving them to wonder why the unregister they
   * were unblocking still refuses. The caller turns undefined into not_found.
   *
   * (Until this ticket the method had no caller on any surface at all.)
   */
  removeCrossLink(blockerIdentifier: string, blockedIdentifier: string): CrossLink | undefined {
    const blocker = blockerIdentifier.toUpperCase();
    const blocked = blockedIdentifier.toUpperCase();
    return tx(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM cross_links WHERE blocker_identifier = ? AND blocked_identifier = ?")
        .get(blocker, blocked) as
        | { blocker_ws: string; blocker_identifier: string; blocked_ws: string; blocked_identifier: string }
        | undefined;
      if (!row) return undefined;
      this.db
        .prepare("DELETE FROM cross_links WHERE blocker_identifier = ? AND blocked_identifier = ?")
        .run(blocker, blocked);
      return {
        blockerWs: row.blocker_ws,
        blockerIdentifier: row.blocker_identifier,
        blockedWs: row.blocked_ws,
        blockedIdentifier: row.blocked_identifier,
        type: "blocks" as const,
      };
    });
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
    nodes: Array<{
      id: string;
      workspace: string;
      title: string;
      status: string;
      kind: string;
      parent: string | null;
    }>;
    edges: Array<{ from: string; to: string; cross: boolean }>;
  } {
    const nodes: Array<{
      id: string;
      workspace: string;
      title: string;
      status: string;
      kind: string;
      parent: string | null;
    }> = [];
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
            // Unconditional, deliberately unlike `parent` below: `kind` is a
            // scalar already on the row, so both graph producers can always
            // send it and the client never has to ask which graph it is
            // looking at before it can draw a kind glyph.
            kind: issue.kind,
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
