/**
 * Two devices claiming one unique value, settled the same way on every device.
 *
 * Contract: `docs/sync.md`, "Identifiers and other unique values".
 *
 * An issue's identifier, a project's slug, a retry key, a live external origin: each is
 * `UNIQUE` in every workspace database, and each can be claimed on two devices that have
 * not heard from each other — both mint `STA-5` offline, both create a project called
 * `web`. When the second claim arrives, a receiver cannot apply it as written.
 *
 * ## The earlier claim in the log keeps the value; the later one's own device moves it
 *
 * The log is the one order every device agrees on, so it decides. On a device applying
 * an operation, the holder of the value is either
 *
 *   - an entity whose claim came from the log before this operation — another device's,
 *     or this device's own and already sent earlier. The INCOMING claim is the later one:
 *     it is applied with a stand-in value (`STA-5+1`, `web-2`, a cleared retry key), and
 *     the device that made it will settle it for everybody; or
 *   - an entity this device claimed LATER than this operation — not yet sent, or sent and
 *     given a higher seq. The HOLDER is the later claim: it takes the stand-in here, and
 *     because it is this device's own, this device owes the repository its settlement.
 *
 * Only the device that made a later claim ever settles it, so exactly one device does,
 * and it does it with an ordinary operation: a `renumber` to a number this device's
 * allocator has never handed out, an `update` of the slug, an `update` clearing the
 * retry key or the origin. Every other device applies that operation like any other and
 * lands on the same value; a device that hydrates from the snapshot afterwards reads the
 * settled value from the fold. Nobody is asked to resolve anything, and no conflict is
 * left open: the stand-in's record is closed when the settlement arrives (`apply.ts`).
 *
 * This is the allocator `docs/sync.md` called for, built from the parts that exist: the
 * log's order is the single authority, and the renumber is the settlement. It needs no
 * server-side counter and no change to the push response, and a device on an older build
 * — which does not settle its claims — degrades to what it did before: the stand-in, and
 * an identifier conflict on the record.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Journal, SyncEntity } from "../journal.js";
import { moveIdentifier } from "../identifier-moves.js";
import { newId } from "../ids.js";
import { nowIso } from "../types.js";

/** A later claim of this device's that it yielded, and now settles. */
export interface OwedSettlement {
  readonly entity: "issue" | "project" | "comment" | "relation" | "documentRevision";
  readonly entityId: string;
  /** `status` and `kind`: an issue moved off a status or kind that was removed (`vocabulary-targets.ts`). */
  readonly field: "identifier" | "slug" | "idempotencyKey" | "originId" | "status" | "kind" | "edges" | "revision";
  /** The value it gave up. */
  readonly from: string;
}

const owed = new WeakMap<DatabaseSync, OwedSettlement[]>();

/** Record that this device owes a settlement; drained by {@link settleOwedClaims}. */
export function oweSettlement(db: DatabaseSync, settlement: OwedSettlement): void {
  const list = owed.get(db) ?? [];
  if (!list.some((item) => item.entity === settlement.entity && item.entityId === settlement.entityId && item.field === settlement.field)) {
    list.push(settlement);
  }
  owed.set(db, list);
}

/**
 * Where this device's own claim on `fields` of an entity sits in the log.
 *
 * `Infinity` when the operation that made it has not been sent — it will land after
 * everything already in the log. The acknowledged seq when it has. Null when this device
 * made no claim it can see: the value came from another device, or from an operation of
 * this device's that has since been compacted, both of which put it earlier in the log
 * than anything being applied now.
 */
export function ownClaimSeq(db: DatabaseSync, entity: string, entityId: string, fields: readonly string[]): number | null {
  const rows = db
    .prepare(
      `SELECT payload, acknowledged_seq FROM sync_outbox
        WHERE entity = ? AND entity_id = ? ORDER BY client_seq DESC`,
    )
    .all(entity, entityId) as Array<{ payload: string; acknowledged_seq: number | null }>;
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (fields.some((field) => field in payload)) return row.acknowledged_seq ?? Number.POSITIVE_INFINITY;
  }
  return null;
}

/**
 * Where this device's own claim on an issue's live external origin sits in the log.
 *
 * An issue claims a live origin when it is written with one — created with it, or given
 * it — and when it is reopened from done or cancelled while it carries one, because a
 * live origin is one on an open issue (`issues_live_origin_uq`). A move between two open
 * statuses is not a claim: taken for one, backlog to todo on the earlier holder beat a
 * later import on another device, and both gave the origin up. A reopen is known by the
 * operation that made it (`reopens`, `WorkspaceStore.updateIssue`): inferred from this
 * device's own outbox, a reopen of an issue another device had closed was not counted,
 * and the devices never agreed who held the origin.
 */
export function ownOriginClaimSeq(db: DatabaseSync, issueId: string): number | null {
  const rows = db
    .prepare(
      `SELECT payload, acknowledged_seq FROM sync_outbox
        WHERE entity = 'issue' AND entity_id = ? ORDER BY client_seq DESC`,
    )
    .all(issueId) as Array<{ payload: string; acknowledged_seq: number | null }>;
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const writesOrigin = ["originKind", "origin_kind", "originId", "origin_id"].some((field) => field in payload);
    if (writesOrigin || payload.reopens === true) return row.acknowledged_seq ?? Number.POSITIVE_INFINITY;
  }
  return null;
}

/** A document revision this device wrote: the first operation of its own that carried it. */
export interface OwnRevision {
  readonly body: unknown;
  readonly author: unknown;
  readonly createdAt: unknown;
  /** Where it sits in the log: its acknowledged seq, or `Infinity` unsent. */
  readonly seq: number;
  /** The number it was written as. */
  readonly claimed: number;
  /** Its place in this device's outbox. */
  readonly order: number;
}

/**
 * The revisions of one document this device wrote, from its outbox, each by the first
 * operation that carried it — its write; a later one is the same revision sent again under
 * the number it moved to (`settleOne`).
 */
export function ownRevisions(db: DatabaseSync, issueId: string, key: string): OwnRevision[] {
  const prefix = `${issueId}/${key}/`;
  const rows = db
    .prepare(
      `SELECT client_seq, payload, acknowledged_seq FROM sync_outbox
        WHERE entity = 'documentRevision' AND verb = 'create' AND substr(entity_id, 1, ?) = ?
        ORDER BY client_seq`,
    )
    .all(prefix.length, prefix) as Array<{ client_seq: number; payload: string; acknowledged_seq: number | null }>;
  const out: OwnRevision[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof payload.revision !== "number") continue;
    const revision = { body: payload.body, author: payload.author ?? null, createdAt: payload.createdAt };
    if (ownRevisionOf(out, revision) !== null) continue;
    out.push({ ...revision, seq: row.acknowledged_seq ?? Number.POSITIVE_INFINITY, claimed: payload.revision, order: row.client_seq });
  }
  return out;
}

/**
 * The revision of this device's own that `row` is, or null: the same body, author and time.
 * Its time too, unlike `sameRevision` — this device wrote both, so they are identical, and a
 * revision another device wrote with the same text is not this device's.
 */
export function ownRevisionOf(own: readonly OwnRevision[], row: { body: unknown; author: unknown; createdAt: unknown }): OwnRevision | null {
  return own.find((mine) => mine.body === row.body && mine.author === (row.author ?? null) && mine.createdAt === row.createdAt) ?? null;
}

/**
 * True when the local holder of a value made the LATER claim and so must yield it.
 *
 * `incoming` is where the arriving claim sits in the log; null for a local apply (a
 * conflict resolution on this device), which is a decision and yields to nothing.
 */
export function holderYields(
  db: DatabaseSync,
  entity: string,
  holderId: string,
  fields: readonly string[],
  incoming: number | null,
  own: (db: DatabaseSync, holderId: string) => number | null = (inner, id) => ownClaimSeq(inner, entity, id, fields),
): boolean {
  if (incoming === null) return false;
  const mine = own(db, holderId);
  return mine !== null && mine > incoming;
}

/**
 * Journal a settlement for every later claim of this device's that yielded while
 * operations were applied — then forget them.
 *
 * Runs after a page, a snapshot or a seed has been applied, inside the same transaction
 * and OUTSIDE the applier's suppressed scope, so what it records is journaled like any
 * mutation made here: a new operation, sent on this sync's next push.
 */
export function settleOwedClaims(db: DatabaseSync, journal: Journal): number {
  const list = owed.get(db) ?? [];
  owed.delete(db);
  if (list.length === 0) return 0;
  let settled = 0;
  journal.run(() => {
    for (const item of list) {
      if (settleOne(db, journal, item)) settled += 1;
    }
  });
  return settled;
}

function settleOne(db: DatabaseSync, journal: Journal, item: OwedSettlement): boolean {
  const at = nowIso();
  const record = (entity: SyncEntity, verb: "renumber" | "update", payload: Record<string, unknown>): void =>
    journal.record({ entity, entityId: item.entityId, verb, payload, actor: "staple" });

  if (item.entity === "issue" && item.field === "identifier") {
    const row = db.prepare("SELECT identifier FROM issues WHERE id = ?").get(item.entityId) as
      | { identifier: string }
      | undefined;
    if (!row) return false;
    const to = freshIdentifier(db, item.from);
    moveIdentifier(db, item.entityId, to, at);
    record("issue", "renumber", { identifier: to });
    /**
     * The old number is in whatever this device's people wrote before it moved. It keeps
     * resolving here (`identifier-moves.ts`); the comment is the record every other
     * device receives. A search for the old number finds the issue through the alias
     * (`WorkspaceStore.issuesQuery`).
     */
    const commentId = newId();
    // Replicated, so every sentence of it has to be true on every device: the one that kept
    // the number, this one, and one that joins next year.
    const body =
      `Renumbered from ${item.from} to ${to}: more than one device created ${item.from} before seeing ` +
      `the others', and the repository keeps the one created first; every other is renumbered by the ` +
      `device that created it. A reference to ${item.from} made before ${at} on the device where this ` +
      `issue was created means this issue.`;
    db.prepare(
      `INSERT INTO comments (id, issue_id, author, author_type, body, created_at)
       VALUES (?, ?, 'staple', 'system', ?, ?)`,
    ).run(commentId, item.entityId, body, at);
    journal.record({
      entity: "comment",
      entityId: commentId,
      verb: "create",
      payload: { issueId: item.entityId, author: "staple", authorType: "system", body, createdAt: at },
      actor: "staple",
    });
    return true;
  }

  if (item.entity === "project" && item.field === "slug") {
    const row = db.prepare("SELECT slug FROM projects WHERE id = ?").get(item.entityId) as { slug: string } | undefined;
    if (!row) return false;
    record("project", "update", { slug: row.slug });
    return true;
  }

  if (item.field === "idempotencyKey") {
    record(item.entity, "update", { idempotencyKey: null });
    return true;
  }
  if (item.entity === "issue" && item.field === "originId") {
    record("issue", "update", { originId: null });
    return true;
  }
  if (item.entity === "relation" && item.field === "edges") {
    const rows = db
      .prepare("SELECT blocker_id, created_by, created_at FROM relations WHERE blocked_id = ? AND type = 'blocks' ORDER BY blocker_id")
      .all(item.entityId) as Array<{ blocker_id: string; created_by: string | null; created_at: string }>;
    record("relation", "update", {
      blockedBy: rows.map((row) => row.blocker_id),
      edges: Object.fromEntries(rows.map((row) => [row.blocker_id, { createdBy: row.created_by, createdAt: row.created_at }])),
    });
    return true;
  }
  /**
   * A revision of this device's that yielded its number to an earlier one (`apply.ts`): sent
   * again under the number it holds now, so a device on an older build — which keeps the
   * first revision to arrive under a number — receives its text too. Every device of this
   * build already holds it there, and takes this as the same revision. Only while the number
   * holds this device's own: a later yield may have moved it on, and that sent it again there.
   */
  if (item.entity === "documentRevision" && item.field === "revision") {
    const slash = item.entityId.lastIndexOf("/");
    const document = item.entityId.slice(0, slash);
    const split = document.indexOf("/");
    const issueId = document.slice(0, split);
    const key = document.slice(split + 1);
    const revision = Number(item.entityId.slice(slash + 1));
    const row = db
      .prepare("SELECT body, author, change_summary, created_at FROM document_revisions WHERE issue_id = ? AND key = ? AND revision = ?")
      .get(issueId, key, revision) as { body: string; author: string | null; change_summary: string | null; created_at: string } | undefined;
    if (!row || ownRevisionOf(ownRevisions(db, issueId, key), { body: row.body, author: row.author, createdAt: row.created_at }) === null) return false;
    journal.record({
      entity: "documentRevision",
      entityId: item.entityId,
      verb: "create",
      payload: { issueId, key, revision, body: row.body, title: null, changeSummary: row.change_summary, author: row.author, createdAt: row.created_at },
      actor: row.author,
    });
    return true;
  }
  if (item.entity === "issue" && (item.field === "status" || item.field === "kind")) {
    const row = db.prepare(`SELECT ${item.field} AS value FROM issues WHERE id = ?`).get(item.entityId) as
      | { value: string }
      | undefined;
    if (!row || row.value === item.from) return false;
    record("issue", "update", { [item.field]: row.value });
    return true;
  }
  return false;
}

/**
 * Close every open identifier record whose issue no longer holds the stand-in it records.
 *
 * `apply.ts` closes the record when the settling renumber arrives. A database that applied
 * that renumber on a build from before this one moved the issue and left the record open —
 * measured live: a device on an older build reported "1 unresolved conflict" about an
 * issue every device had long since agreed on. Once it runs this build, its next sync
 * closes it: the issue moved off the stand-in, so somebody settled it, and nothing is left
 * to decide. A record whose issue still sits on its stand-in stays open — that claim is
 * still unsettled (its device is on an older build, and a person may resolve it).
 */
export function closeSettledIdentifierConflicts(db: DatabaseSync): number {
  const at = nowIso();
  const result = db
    .prepare(
      `UPDATE sync_conflicts
          SET resolved_at = ?, resolved_by = 'staple',
              resolution = (SELECT json_quote(i.identifier) FROM issues i WHERE i.id = sync_conflicts.entity_id)
        WHERE entity = 'issue' AND field = 'identifier' AND resolved_at IS NULL
          AND EXISTS (
            SELECT 1 FROM issues i
             WHERE i.id = sync_conflicts.entity_id AND json_quote(i.identifier) <> sync_conflicts.local_value
          )`,
    )
    .run(at);
  return Number(result.changes);
}

/**
 * An identifier this device has never handed out, in the namespace of the one given up.
 *
 * From `meta.next_issue_number`, the local allocator, which the applier keeps clear of
 * every identifier present here — the allocator the device would have used for a new
 * issue. A number some other device minted offline meanwhile is a fresh claim, settled
 * by the same rule when it arrives.
 */
function freshIdentifier(db: DatabaseSync, given: string): string {
  const base = given.replace(/\+\d+$/, "");
  const dash = base.lastIndexOf("-");
  const prefix = dash < 0 ? base : base.slice(0, dash);
  let next = Number(
    (db.prepare("SELECT value FROM meta WHERE key = 'next_issue_number'").get() as { value: string } | undefined)?.value ??
      "1",
  );
  const pattern = `${prefix}-%`;
  for (const row of db.prepare("SELECT identifier FROM issues WHERE identifier LIKE ?").all(pattern) as Array<{
    identifier: string;
  }>) {
    const number = Number(row.identifier.slice(prefix.length + 1));
    if (Number.isInteger(number) && number >= next) next = number + 1;
  }
  const to = `${prefix}-${next}`;
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('next_issue_number', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(next + 1));
  return to;
}
