import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../config/home.js";
import { openDb, tx } from "./db.js";
import { migrateHub } from "./schema.js";
import { derivePrefixBase, parseIdentifier, prefixSuffixForAttempt } from "./ids.js";
import { openWorkspace } from "./open.js";
import { RESOLVED_STATUSES, StapleError, nowIso } from "./types.js";
import { crossLinkEntityId, type CrossLinkIdentity } from "./cloud/cross-link-key.js";

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

/**
 * The path stored for a row this machine knows OF but does not have.
 *
 * Empty rather than null because `workspaces.path` is `NOT NULL` and has been
 * since version 1, and widening it would mean every existing reader learning
 * about a second spelling of "no path". Empty string is already falsy, already
 * unequal to every real path, and `existsSync("")` is false — so `available`
 * comes out correct with no special case anywhere.
 *
 * The alternative was to invent a plausible path for an absent workspace. That
 * is precisely the failure mode the absent row exists to avoid: a registry that
 * points somewhere is trusted, and a registry that points somewhere WRONG sends
 * repair, prune and `--ws` at a directory that has nothing to do with it.
 */
export const ABSENT_PATH = "";

export interface WorkspaceEntry {
  slug: string;
  prefix: string;
  path: string;
  kind: string;
  addedAt: string;
  lastSeenAt: string | null;
  /** Whether the workspace file exists on this machine right now. */
  available: boolean;
  /**
   * The workspace's sync identity, as the REGISTRY recorded it.
   *
   * Null for a workspace that has never recorded one, and for every row written
   * before hub schema 3. Not authoritative: the manifest on disk is, and
   * `hub-scope.ts` prefers it whenever the workspace is present. This copy earns
   * its place by being readable when the workspace is NOT present, which is the
   * only situation in which adoption has to make a decision.
   */
  repositoryId: string | null;
}

/** One identity this machine has been told it does not want back. */
export interface RegistryOptOut {
  repositoryId: string;
  /** The slug it had when it was dropped. For the sentence, not for matching. */
  slug: string;
  reason: string;
  createdAt: string;
}

export interface CrossLink {
  blockerWs: string;
  blockerIdentifier: string;
  blockedWs: string;
  blockedIdentifier: string;
  type: "blocks";
}

/**
 * This machine's latest act on one cross-link, keyed on its portable identity.
 *
 * Hub migration 004 explains why publishing needs it. `present: false` is a removal
 * made here, and it is kept after it is published as this machine's refusal to take the
 * link back. `present: true` is a (re)link made here that no publish has shared yet.
 */
export interface CrossLinkChange extends CrossLinkIdentity {
  readonly key: string;
  readonly present: boolean;
  readonly published: boolean;
  /** Also the row's version: settling checks it, so a newer act is never settled by an older publish. */
  readonly changedAt: string;
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
          repository_id: string | null;
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
      available: row.path !== ABSENT_PATH && existsSync(row.path),
      repositoryId: row.repository_id ?? null,
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
      repository_id: string | null;
    }>;
    return rows.map((r) => ({
      slug: r.slug,
      prefix: r.prefix,
      path: r.path,
      kind: r.kind,
      addedAt: r.added_at,
      lastSeenAt: r.last_seen_at,
      available: r.path !== ABSENT_PATH && existsSync(r.path),
      repositoryId: r.repository_id ?? null,
    }));
  }

  // ---------- identity, absent rows and the opt-out list ----------

  /**
   * This hub's own id, minted once and kept in `meta`.
   *
   * The hub needs an identity for the same reason a repository does: it is the
   * thing a backup is OF, and a backup that cannot say what it is a backup of
   * cannot be safely restored onto a machine that already has a hub. Minted
   * lazily so that no existing hub grows one until something actually asks.
   */
  hubId(): string {
    const stored = this.storedHubId();
    if (stored !== null) return stored;
    const minted = randomUUID();
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('hub_id', ?)").run(minted);
    return minted;
  }

  /**
   * The stored hub id, or null when this hub has never needed one.
   *
   * Separate from {@link hubId} because reading and MINTING are different acts, and
   * several callers need the first without the second. Adoption is the one that
   * matters: a machine about to take on an existing registry identity has to be able
   * to ask whether it already has one, and asking through `hubId()` would mint the
   * very value it was checking for the absence of.
   */
  storedHubId(): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'hub_id'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /**
   * Take on an existing hub identity, rather than minting a fresh one.
   *
   * ## Why this has to exist, and what it means about what a hub id is
   *
   * `hubId()` mints, which is right for the first machine and wrong for every later
   * one. A replacement machine that minted its own id would be scoped to an empty
   * repository on the service and could never read what the lost machine published —
   * so "restorable after a machine is lost" would be false no matter how good the
   * rest of the mechanism was.
   *
   * Which forces the question of what the id actually identifies, and the honest
   * answer is **the registry, not the machine**. It names one person's set of
   * workspaces; the machine is named by `deviceId`, which already exists, is already
   * hub-wide, and is already separate. Two machines belonging to one person share a
   * hub id on purpose — that sharing is the entire mechanism by which the second
   * learns what the first has.
   *
   * That makes this exactly `repo-identity.ts`'s story one level up: the identity is
   * adopted from outside, never re-minted, because *"an unknown id is far more likely
   * to be a copied manifest than a new repository"* and a second id for one thing is
   * a fork nothing later reports.
   *
   * ## The refusal
   *
   * Refuses when a DIFFERENT id is already stored, because replacing one silently is
   * how a machine ends up orphaning a registry it was already publishing to — the old
   * log keeps existing, nothing points at it, and the workspaces recorded there are
   * simply gone from every surface. Idempotent for the same id, so a repeated adopt is
   * not an error.
   *
   * `force` exists because the refusal is sometimes wrong: an id that was minted
   * lazily and never used names nothing, and refusing to replace it would be refusing
   * on the strength of a value that has never left the machine. The caller decides,
   * because the caller is the one that can see whether a connection record exists for
   * the old id — see `hub-registry-service.ts`, `adoptRegistryIdentity`.
   */
  adoptHubId(hubId: string, options: { force?: boolean } = {}): void {
    const trimmed = hubId.trim();
    if (trimmed.length === 0) {
      throw new StapleError("validation", "A hub id is required. Nothing was changed.");
    }
    const stored = this.storedHubId();
    if (stored === trimmed) return;
    if (stored !== null && options.force !== true) {
      throw new StapleError(
        "conflict",
        `This machine's hub already has the identity ${stored}, and adopting ${trimmed} would ` +
          "point it at a different registry. Whatever was published under the old identity would " +
          "still exist on the service with nothing pointing at it. Nothing was changed.",
      );
    }
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('hub_id', ?)")
      .run(trimmed);
  }

  /** The row holding this sync identity, if this machine has one. */
  findByRepositoryId(repositoryId: string): WorkspaceEntry | undefined {
    return this.list().find((w) => w.repositoryId === repositoryId);
  }

  /**
   * Record the identity a workspace turned out to have.
   *
   * Separate from {@link register} because it is a different KIND of statement:
   * register says "this workspace is here, at this path", and this says "the
   * thing at that path calls itself X". They are learned at different moments —
   * the manifest is often absent when a workspace is first registered and
   * appears only when it is connected — and conflating them would mean either
   * refusing to register a workspace with no manifest or re-registering it every
   * time one showed up.
   */
  recordRepositoryId(slug: string, repositoryId: string | null): void {
    this.db
      .prepare("UPDATE workspaces SET repository_id = ? WHERE slug = ?")
      .run(repositoryId, slug);
    /**
     * Binding an identity to a live row retires any opt-out about it (STA-283).
     *
     * The invariant this keeps is "an opt-out never coexists with a registered row for
     * the same identity", and it is worth stating because the two are contradictory
     * records of the same fact: the opt-out says this machine does not want that
     * workspace, and the row says it has it.
     *
     * Nothing cleared one before, and `adoptRegistry`'s `declined` branch asked the
     * opt-out set BEFORE it asked the hub — so a workspace that came back was declined
     * for ever, and could never learn a slug or kind change from the registry either.
     * Pruning a row therefore bought a publish fix with a permanent, invisible adoption
     * failure.
     *
     * This is the right seam because it is where an identity becomes bound to a row that
     * is actually here: `initWorkspace` on the next command inside the repository, and
     * `reconcileRepositoryIds`. It also matches what `unregister` already documents about
     * a workspace whose directory still exists — the row "lasts until someone runs a
     * command in it", and after this so does the opt-out, which is the same decision
     * reached the same way.
     *
     * Only for a real identity. `recordRepositoryId(slug, null)` is how a row FORGETS
     * its identity, and forgetting is not wanting it back.
     */
    if (repositoryId !== null) this.clearOptOut(repositoryId);
  }

  /**
   * Add a row for a workspace this machine knows of but does not have.
   *
   * The prefix is taken as a FACT, exactly as {@link repointPath} takes it: it
   * was allocated by whichever machine first registered this workspace, it is
   * stamped into that workspace's database, and it is not this machine's to
   * reassign. Allocation is therefore deliberately absent from this path — an
   * absent row that minted its own prefix would be a different workspace wearing
   * the same name.
   */
  registerAbsent(entry: {
    slug: string;
    prefix: string;
    kind: string;
    repositoryId: string | null;
    addedAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (slug, prefix, path, kind, added_at, last_seen_at, repository_id)
         VALUES (?,?,?,?,?,NULL,?)`,
      )
            /**
       * `||`, not `??`. An empty string is not a timestamp, and `??` passes it through — from
       * the hub column into `exportRegistry`, onto the wire, into a backup, through a restore
       * and into a second machine's adopt. `||` treats it as absent, which it is.
       */
      .run(entry.slug, entry.prefix, ABSENT_PATH, entry.kind, entry.addedAt || nowIso(), entry.repositoryId);
  }

  /**
   * Remember that this machine does not want an identity back.
   *
   * Written by unregister, read by adoption, and never published. See hub
   * migration 003 for why it is a table beside the registry rather than a flag
   * inside it.
   */
  addOptOut(repositoryId: string, slug: string, reason = "unregistered"): void {
    this.db
      .prepare(
        `INSERT INTO registry_optouts (repository_id, slug, reason, created_at)
         VALUES (?,?,?,?)
         ON CONFLICT(repository_id) DO UPDATE SET slug = excluded.slug, reason = excluded.reason`,
      )
      .run(repositoryId, slug, reason, nowIso());
  }

  listOptOuts(): RegistryOptOut[] {
    const rows = this.db
      .prepare("SELECT * FROM registry_optouts ORDER BY created_at, repository_id")
      .all() as Array<{ repository_id: string; slug: string; reason: string; created_at: string }>;
    return rows.map((r) => ({
      repositoryId: r.repository_id,
      slug: r.slug,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  /** Undo an opt-out, so the next adoption may bring the workspace back. */
  clearOptOut(repositoryId: string): boolean {
    return (
      this.db.prepare("DELETE FROM registry_optouts WHERE repository_id = ?").run(repositoryId)
        .changes > 0
    );
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
    // Removing the row is the whole of the REMOTE effect, because there is none:
    // a registry entry this machine drops stays on every other machine, and
    // nothing here reaches the service. What the opt-out adds is the LOCAL
    // durability the operator plainly meant — without it, the next adoption
    // would put the row straight back and the removal would read as broken.
    //
    // Only recorded when there is an identity to key it on. A workspace with no
    // manifest cannot be matched by adoption either, so there is nothing for an
    // opt-out to suppress.
    if (entry.repositoryId !== null) {
      this.addOptOut(entry.repositoryId, entry.slug);
    }
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
        /**
         * Record the opt-out, exactly as {@link unregister} does (STA-283).
         *
         * These two are the only row deleters in the tree. Prune IS an unregister, the
         * same decision reached by noticing the path is gone rather than by naming the
         * row, so it records the same thing. The opt-out is what makes the removal survive
         * the next adopt, and what stops publish from listing the pruned workspace as one
         * this machine doesn't have.
         */
        if (candidate.entry.repositoryId !== null) {
          this.addOptOut(candidate.entry.repositoryId, candidate.entry.slug, "pruned");
        }
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
   *
   * This is a person's act, so it is recorded as this machine's latest change to
   * the link (hub migration 004). It clears a removal made here, and it is what
   * lets the next registry publish put back a link the service holds as retracted.
   * Adoption uses {@link adoptCrossLink} instead, because a link arriving from the
   * service is not a decision made on this machine.
   */
  addCrossLink(blockerIdentifier: string, blockedIdentifier: string): CrossLink {
    return this.insertCrossLink(blockerIdentifier, blockedIdentifier, true);
  }

  /**
   * Take on a link the published registry holds. Same checks as {@link addCrossLink},
   * but nothing is recorded: publishing it back would only restate what the service
   * already says.
   */
  adoptCrossLink(blockerIdentifier: string, blockedIdentifier: string): CrossLink {
    return this.insertCrossLink(blockerIdentifier, blockedIdentifier, false);
  }

  /**
   * Whether {@link addCrossLink} would accept this link, without writing anything.
   *
   * Runs the same resolution, identifier check and cycle check, so an adopt preview
   * refuses exactly what the apply would refuse.
   */
  checkCrossLink(blockerIdentifier: string, blockedIdentifier: string): void {
    this.validateCrossLink(blockerIdentifier, blockedIdentifier);
  }

  private validateCrossLink(
    blockerIdentifier: string,
    blockedIdentifier: string,
  ): { blocker: { entry: WorkspaceEntry; identifier: string }; blocked: { entry: WorkspaceEntry; identifier: string } } {
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
    return { blocker, blocked };
  }

  private insertCrossLink(
    blockerIdentifier: string,
    blockedIdentifier: string,
    record: boolean,
  ): CrossLink {
    const { blocker, blocked } = this.validateCrossLink(blockerIdentifier, blockedIdentifier);
    const link: CrossLink = {
      blockerWs: blocker.entry.slug,
      blockerIdentifier: blocker.identifier,
      blockedWs: blocked.entry.slug,
      blockedIdentifier: blocked.identifier,
      type: "blocks",
    };
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO cross_links
             (blocker_ws, blocker_identifier, blocked_ws, blocked_identifier, type, created_at)
           VALUES (?,?,?,?, 'blocks', ?)`,
        )
        .run(link.blockerWs, link.blockerIdentifier, link.blockedWs, link.blockedIdentifier, nowIso());
      if (record) this.recordCrossLinkChange(link, true);
    });
    return link;
  }

  /**
   * The portable identity of a local link, or null when either workspace has no
   * recorded `repositoryId`. A link like that was never publishable, so it has
   * nothing to record.
   */
  crossLinkIdentityOf(link: {
    blockerWs: string;
    blockerIdentifier: string;
    blockedWs: string;
    blockedIdentifier: string;
  }): CrossLinkIdentity | null {
    const blockerRepositoryId = this.findBySlug(link.blockerWs)?.repositoryId ?? null;
    const blockedRepositoryId = this.findBySlug(link.blockedWs)?.repositoryId ?? null;
    if (blockerRepositoryId === null || blockedRepositoryId === null) return null;
    return {
      blockerRepositoryId,
      blockerIdentifier: link.blockerIdentifier,
      blockedRepositoryId,
      blockedIdentifier: link.blockedIdentifier,
    };
  }

  private recordCrossLinkChange(link: CrossLink, present: boolean): void {
    const identity = this.crossLinkIdentityOf(link);
    if (identity === null) return;
    this.db
      .prepare(
        `INSERT INTO cross_link_changes
           (link_key, blocker_repository_id, blocker_identifier, blocked_repository_id,
            blocked_identifier, present, published, changed_at)
         VALUES (?,?,?,?,?,?,0,?)
         ON CONFLICT(link_key) DO UPDATE SET
           present = excluded.present, published = 0, changed_at = excluded.changed_at`,
      )
      .run(
        crossLinkEntityId(identity),
        identity.blockerRepositoryId,
        identity.blockerIdentifier,
        identity.blockedRepositoryId,
        identity.blockedIdentifier,
        present ? 1 : 0,
        nowIso(),
      );
  }

  /** Every cross-link change this machine has recorded. See {@link CrossLinkChange}. */
  listCrossLinkChanges(): CrossLinkChange[] {
    const rows = this.db
      .prepare("SELECT * FROM cross_link_changes ORDER BY changed_at, link_key")
      .all() as Array<{
      link_key: string;
      blocker_repository_id: string;
      blocker_identifier: string;
      blocked_repository_id: string;
      blocked_identifier: string;
      present: number;
      published: number;
      changed_at: string;
    }>;
    return rows.map((r) => ({
      key: r.link_key,
      blockerRepositoryId: r.blocker_repository_id,
      blockerIdentifier: r.blocker_identifier,
      blockedRepositoryId: r.blocked_repository_id,
      blockedIdentifier: r.blocked_identifier,
      present: r.present === 1,
      published: r.published === 1,
      changedAt: r.changed_at,
    }));
  }

  /**
   * Record that a publish has dealt with these changes: a removal is marked published,
   * and a (re)link is forgotten.
   *
   * Each row is settled only if it still holds the act the publish saw (`present` and
   * `changedAt`). A link or unlink made while the publish was in flight is newer than
   * what was sent, so it is left for the next publish.
   */
  settleCrossLinkChanges(changes: readonly CrossLinkChange[]): void {
    tx(this.db, () => {
      for (const change of changes) {
        if (change.present) {
          this.db
            .prepare(
              "DELETE FROM cross_link_changes WHERE link_key = ? AND present = 1 AND changed_at = ?",
            )
            .run(change.key, change.changedAt);
        } else {
          this.db
            .prepare(
              `UPDATE cross_link_changes SET published = 1
                WHERE link_key = ? AND present = 0 AND changed_at = ?`,
            )
            .run(change.key, change.changedAt);
        }
      }
    });
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
   *
   * The removal is recorded (hub migration 004), so every caller records it:
   * `staple hub unlink`, MCP and the UI. That record is what lets the next registry
   * publish retract the link, and what stops an adopt from bringing it back here.
   */
  removeCrossLink(blockerIdentifier: string, blockedIdentifier: string): CrossLink | undefined {
    return this.deleteCrossLink(blockerIdentifier, blockedIdentifier, true);
  }

  /**
   * Remove a link because the published registry retracted it. Unlike
   * {@link removeCrossLink}, nothing is recorded: this machine did not decide to remove
   * it, so it must not refuse the link if another machine links it again.
   */
  dropRetractedCrossLink(blockerIdentifier: string, blockedIdentifier: string): CrossLink | undefined {
    return this.deleteCrossLink(blockerIdentifier, blockedIdentifier, false);
  }

  private deleteCrossLink(
    blockerIdentifier: string,
    blockedIdentifier: string,
    record: boolean,
  ): CrossLink | undefined {
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
      const link: CrossLink = {
        blockerWs: row.blocker_ws,
        blockerIdentifier: row.blocker_identifier,
        blockedWs: row.blocked_ws,
        blockedIdentifier: row.blocked_identifier,
        type: "blocks",
      };
      if (record) this.recordCrossLinkChange(link, false);
      return link;
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
