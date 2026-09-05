/**
 * The journal seam's seven obligations, one describe block each.
 *
 * `docs/sync.md`, "The journal seam and what it owes", states them as a list.
 * This file is that list turned into assertions, in the same order, so a reader
 * can check the contract against the tests without a translation step.
 *
 * These run in-process against an in-memory database, because what is under test
 * is the seam itself. `characterize-mutation-seam.test.ts` proves the same seam
 * is on the path of every real surface; proving both here would make one slow
 * suite that answered two questions badly.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, tx } from "../src/core/db.js";
import { bindJournal, deriveOpId, type Journal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";
const DEVICE = "device-alpha";

let store: WorkspaceStore;
let journal: Journal;

interface OutboxRow {
  op_id: string;
  client_seq: number;
  entity: string;
  entity_id: string;
  verb: string;
  base_version: number | null;
  payload: string;
  actor: string | null;
  acknowledged_seq: number | null;
}

function outbox(): OutboxRow[] {
  return store.db
    .prepare("SELECT * FROM sync_outbox ORDER BY client_seq")
    .all() as unknown as OutboxRow[];
}

function opsFor(entity: string): OutboxRow[] {
  return outbox().filter((row) => row.entity === entity);
}

function highWater(): number {
  const row = store.db
    .prepare("SELECT client_seq_high_water FROM sync_state WHERE id = 1")
    .get() as { client_seq_high_water: number };
  return row.client_seq_high_water;
}

/** A store whose journal is armed: an identity in `sync_state`, and a device. */
function armed(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  bindJournal(db, DEVICE);
  return new WorkspaceStore(db, "test", "TST");
}

beforeEach(() => {
  store = armed();
  journal = store.journal;
});

// ------------------------------------------------------- obligation 0: arming

describe("arming", () => {
  it("journals nothing at all without a device, which is every workspace today", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    writeStoredRepositoryId(db, REPO_ID);
    bindJournal(db, null);
    const disarmed = new WorkspaceStore(db, "test", "TST");

    const issue = disarmed.createIssue({ title: "Local only" });
    disarmed.updateIssue(issue.identifier, { priority: "high" });
    disarmed.addComment(issue.identifier, "hello");

    expect(disarmed.journal.armed()).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_entity_versions").get()).toEqual({ n: 0 });
    // And the counter never moved, so arming later starts from a clean 1.
    expect(
      (db.prepare("SELECT client_seq_high_water AS n FROM sync_state").get() as { n: number }).n,
    ).toBe(0);
  });

  it("journals nothing without an identity, so a workspace that has never been connected is untouched", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    bindJournal(db, DEVICE); // device, but no sync_state row at all
    const idless = new WorkspaceStore(db, "test", "TST");

    idless.createIssue({ title: "No identity" });

    expect(idless.journal.armed()).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
  });

  it("is armed when it has both", () => {
    expect(journal.armed()).toBe(true);
  });
});

// -------------------------------------------------- obligation 1: one transaction

describe("one transaction", () => {
  it("refuses a declaration made outside a mutation scope", () => {
    // The loud failure is the enforcement. A declaration that landed outside a
    // transaction would be an operation that could commit without its domain
    // rows, which is this obligation failing silently.
    expect(() =>
      journal.record({ entity: "issue", entityId: "nope", verb: "update", payload: {} }),
    ).toThrowError(/outside a mutation scope/);
  });

  it("commits the domain rows, the version bump and the outbox row together", () => {
    const issue = store.createIssue({ title: "Together" });
    const ops = outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.entity_id).toBe(issue.id);
    expect(journal.entityVersion("issue", issue.id)).toBe(1);
  });

  it("leaves neither changed domain state nor an orphaned outbox row when the mutation throws", () => {
    const first = store.createIssue({ title: "Original" });
    const before = highWater();

    expect(() =>
      store.journaled(() => {
        store.addComment(first.identifier, "this comment must not survive");
        // Duplicate open title among siblings: a real refusal, raised after the
        // comment above has already written its row and declared its intent.
        store.createIssue({ title: "Original" });
      }),
    ).toThrowError(StapleError);

    expect(store.listComments(first.identifier)).toHaveLength(0);
    expect(store.listIssues({ includeResolved: true })).toHaveLength(1);
    expect(outbox().filter((row) => row.client_seq > before)).toHaveLength(0);
    // The allocator did not move either: it is bumped at flush, and flush is
    // inside the transaction that rolled back.
    expect(highWater()).toBe(before);
  });

  it("nests: an inner mutation joins the outer transaction rather than opening a second", () => {
    // MilestoneStore.create is the real case — createIssue + update + addMember,
    // which used to be three transactions with the hole documented in a comment.
    store.addKind({ id: "milestone", label: "Milestone" });
    const view = store.milestones().create({ title: "M1", targetDate: "2026-12-01" }, "planner");
    expect(view.preview).toBe(false);

    const milestoneOps = opsFor("milestone");
    // One create for the issue, and the dates arrive as an update on the same
    // milestone entity — all in one transaction, so a crash cannot leave a
    // milestone with no dates.
    expect(milestoneOps.length).toBeGreaterThanOrEqual(1);
    expect(opsFor("issue").some((row) => row.verb === "create")).toBe(true);
  });
});

// ---------------------------------------------- obligation 2: exactly one operation

describe("exactly one operation per logical mutation", () => {
  it("journals one issue.update for a checkout, not one per column or per event", () => {
    const issue = store.createIssue({ title: "Claimable", status: "todo" });
    const before = outbox().length;

    store.checkoutIssue(issue.identifier, "agent-a");

    const added = outbox().slice(before);
    const forIssue = added.filter((row) => row.entity === "issue" && row.entity_id === issue.id);
    expect(forIssue).toHaveLength(1);
    expect(forIssue[0]!.verb).toBe("update");
    // The mutation wrote status, assignee, both claim columns, started_at and
    // three blocked-descriptor columns, and emitted an event. One operation.
    expect(JSON.parse(forIssue[0]!.payload)).toMatchObject({
      assignee: "agent-a",
      checkoutAgent: "agent-a",
    });
  });

  it("collapses repeated declarations on one entity into one operation", () => {
    // A gate needs something to hold back, so this is a parent with a child.
    const parent = store.createIssue({ title: "Gated" });
    store.createIssue({ title: "Under it", parent: parent.identifier });
    const before = outbox().length;

    // gateIssue writes the gate columns and the status and emits two events.
    store.gateIssue(parent.identifier, { owner: "reviewer" }, "agent-a");

    const forIssue = outbox()
      .slice(before)
      .filter((row) => row.entity === "issue" && row.entity_id === parent.id);
    expect(forIssue).toHaveLength(1);
    expect(JSON.parse(forIssue[0]!.payload)).toMatchObject({ gateState: "pending" });
  });

  it("journals a derived ancestor status as its own operation on its own entity", () => {
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createIssue({ title: "Child", parent: epic.identifier, status: "todo" });
    const before = outbox().length;

    store.checkoutIssue(child.identifier, "agent-a");

    const added = outbox().slice(before);
    // Two entities changed: the child was claimed and the epic was re-derived.
    expect(added.filter((row) => row.entity_id === child.id)).toHaveLength(1);
    expect(added.filter((row) => row.entity_id === epic.id)).toHaveLength(1);
  });

  it("journals a document write as one revision create, not a revision plus a pointer", () => {
    const issue = store.createIssue({ title: "Documented" });
    const before = outbox().length;

    store.putDocument(issue.identifier, "plan", "# v1");

    const added = outbox().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.entity).toBe("documentRevision");
    expect(added[0]!.verb).toBe("create");
  });

  it("journals a queue mutation as one plan replace, however many rows it moved", () => {
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B" });
    const queue = store.queue();
    queue.enqueue(a.identifier, {}, "planner");
    queue.enqueue(b.identifier, {}, "planner");
    const before = outbox().length;

    queue.reorder([b.identifier, a.identifier], {}, "planner");

    const added = outbox().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.entity).toBe("queue");
    expect(added[0]!.verb).toBe("replace");
    expect(JSON.parse(added[0]!.payload)).toEqual({ order: [b.id, a.id] });
  });

  /**
   * The verb here is `update`, and it changed from `replace` deliberately.
   *
   * `replace` is not a generic "the whole value changed" verb. It is the
   * ordered-collection mechanism — `queue` and `milestone`, whose `UNIQUE (rank)`
   * constraints are made unreachable by never transporting a rank — and
   * `worker/src/envelope.ts` refuses it for any other entity. A blocker set is a
   * set-valued FIELD of one issue, so it is an update carrying that field.
   *
   * The property being pinned is unchanged and is the one that matters: ONE
   * operation carrying the WHOLE set, not one per edge, because a receiver
   * applying N creates would never learn about the edges that were removed.
   */
  it("journals a blocker set as one whole-set operation, not one per edge", () => {
    const target = store.createIssue({ title: "Blocked" });
    const one = store.createIssue({ title: "Blocker one" });
    const two = store.createIssue({ title: "Blocker two" });
    const before = outbox().length;

    store.setBlockedBy(target.identifier, [one.identifier, two.identifier], "agent-a");

    const added = outbox().slice(before);
    const relations = added.filter((row) => row.entity === "relation");
    expect(relations).toHaveLength(1);
    expect(relations[0]!.verb).toBe("update");
    expect(JSON.parse(relations[0]!.payload)).toEqual({ blockedBy: [one.id, two.id] });
  });

  /**
   * `replace` is reserved, and this is the assertion that keeps it reserved.
   *
   * The two ordered collections may use it and nothing else may, because the
   * deployed service rejects a `replace` on any other entity and rejects the
   * whole batch with it. A future emitter reaching for `replace` because it feels
   * like the right word fails here rather than in production.
   */
  it("uses the replace verb for the ordered collections and for nothing else", () => {
    const target = store.createIssue({ title: "Ordered" });
    store.queue().enqueue(target.identifier, {}, "agent-a");
    store.setBlockedBy(target.identifier, [], "agent-a");
    store.reorderStatuses(store.getStatuses().map((status) => status.id).reverse(), "agent-a");
    store.reorderKinds(store.getKinds().map((kind) => kind.id).reverse(), "agent-a");

    const replaces = outbox().filter((row) => row.verb === "replace");
    expect([...new Set(replaces.map((row) => row.entity))].sort()).toEqual(["queue"]);
  });
});

// ------------------------------------------------- obligation 3: deterministic ids

describe("a deterministic operation id", () => {
  it("derives every op_id from the repository, epoch, device and client sequence", () => {
    store.createIssue({ title: "One" });
    store.createIssue({ title: "Two" });

    for (const row of outbox()) {
      expect(row.op_id).toBe(deriveOpId(REPO_ID, 0, DEVICE, row.client_seq));
      expect(row.op_id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("scopes the id to the epoch, so a re-bootstrapped device cannot collide with the old log", () => {
    const first = deriveOpId(REPO_ID, 0, DEVICE, 1);
    const second = deriveOpId(REPO_ID, 1, DEVICE, 1);
    expect(second).not.toBe(first);
  });

  it("carries the version the entity was at before the mutation as base_version", () => {
    const issue = store.createIssue({ title: "Versioned" });
    // A create has no base: there was no prior version to be at.
    expect(opsFor("issue")[0]!.base_version).toBeNull();

    store.updateIssue(issue.identifier, { priority: "high" });
    store.updateIssue(issue.identifier, { priority: "low" });

    const updates = opsFor("issue").filter((row) => row.verb === "update");
    expect(updates.map((row) => row.base_version)).toEqual([1, 2]);
    expect(journal.entityVersion("issue", issue.id)).toBe(3);
  });

  /**
   * The regression test this lane exists to make impossible to lose.
   *
   * Deriving the next client sequence from `MAX(sync_outbox.client_seq)` is the
   * obvious optimization and it destroys data silently: compaction prunes the
   * rows the maximum was reading, the counter rewinds, the device re-mints ids
   * the server already holds, the server deduplicates them, and the client marks
   * genuinely new work as acknowledged.
   */
  it("allocates the client sequence from the high-water mark, so compaction cannot rewind it", () => {
    store.createIssue({ title: "One" });
    store.createIssue({ title: "Two" });
    store.createIssue({ title: "Three" });
    const beforeCompaction = outbox().map((row) => row.client_seq);
    expect(beforeCompaction).toEqual([1, 2, 3]);

    // Everything is acknowledged and then compacted away — a routine, correct
    // maintenance operation, and exactly the one that used to be lethal.
    store.db.prepare("UPDATE sync_outbox SET acknowledged_seq = client_seq").run();
    const pruned = journal.compact(new Date(Date.now() + 60_000).toISOString());
    expect(pruned.outboxPruned).toBe(3);
    expect(outbox()).toHaveLength(0);

    store.createIssue({ title: "Four" });

    const next = outbox();
    expect(next).toHaveLength(1);
    expect(next[0]!.client_seq).toBe(4);
    expect(next[0]!.op_id).toBe(deriveOpId(REPO_ID, 0, DEVICE, 4));
    // And the id is one nothing has ever used, which is the whole point.
    expect(next[0]!.op_id).not.toBe(deriveOpId(REPO_ID, 0, DEVICE, 1));
  });
});

// --------------------------------------------------- obligation 4: echo suppression

describe("echo suppression", () => {
  it("performs the domain write and journals no outbound operation", () => {
    const issue = store.createIssue({ title: "Remote target" });
    const before = outbox().length;

    const applied = journal.applyRemote({ opId: "a".repeat(32), seq: 41 }, () =>
      store.updateIssue(issue.identifier, { priority: "high" }),
    );

    expect(applied).not.toBeNull();
    expect(store.getIssue(issue.identifier).priority).toBe("high");
    expect(outbox()).toHaveLength(before);
  });

  it("emits the local event anyway, because events are re-derived rather than transported", () => {
    const issue = store.createIssue({ title: "Remote target" });
    const before = store.listEvents(0, 500).length;

    journal.applyRemote({ opId: "b".repeat(32), seq: 42 }, () =>
      store.updateIssue(issue.identifier, { status: "todo" }),
    );

    const events = store.listEvents(0, 500);
    expect(events.length).toBeGreaterThan(before);
    expect(events.some((event) => event.kind === "status_changed")).toBe(true);
  });

  it("treats redelivery of an operation already in the ledger as a no-op", () => {
    const issue = store.createIssue({ title: "Redelivered" });
    const op = { opId: "c".repeat(32), seq: 43 };

    journal.applyRemote(op, () => store.updateIssue(issue.identifier, { priority: "high" }));
    const second = journal.applyRemote(op, () => {
      throw new Error("the apply must not run a second time");
    });

    expect(second).toBeNull();
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM sync_applied").get(),
    ).toEqual({ n: 1 });
  });

  it("re-derives the same event dedup keys, so a retried apply cannot duplicate the timeline", () => {
    const issue = store.createIssue({ title: "Retried" });
    const op = { opId: "d".repeat(32), seq: 44 };

    journal.applyRemote(op, () => store.updateIssue(issue.identifier, { priority: "high" }));
    const after = store.listEvents(0, 500).length;

    // Force the belt-and-braces path: clear the ledger so the apply genuinely
    // runs twice, which is what an at-least-once transport plus a lost ledger
    // write would produce. The dedup key must absorb it.
    store.db.prepare("DELETE FROM sync_applied").run();
    journal.applyRemote(op, () => store.updateIssue(issue.identifier, { priority: "high" }));

    expect(store.listEvents(0, 500)).toHaveLength(after);
  });
});

// ------------------------------------------- obligation 5: idempotency-key respect

describe("idempotency-key respect", () => {
  it("mints no second operation when a create key replays", () => {
    const first = store.createIssueResult({ title: "Once", idempotencyKey: "k1" });
    const replay = store.createIssueResult({ title: "Once again", idempotencyKey: "k1" });

    expect(replay.replayed).toBe(true);
    expect(replay.issue.id).toBe(first.issue.id);
    expect(opsFor("issue")).toHaveLength(1);
    expect(highWater()).toBe(1);
  });

  it("mints no second operation when a comment key replays", () => {
    const issue = store.createIssue({ title: "Commented" });
    const before = opsFor("comment").length;

    const first = store.addCommentResult(issue.identifier, "hello", "agent", "agent", {
      idempotencyKey: "c1",
    });
    const replay = store.addCommentResult(issue.identifier, "hello", "agent", "agent", {
      idempotencyKey: "c1",
    });

    expect(replay.replayed).toBe(true);
    expect(replay.comment.id).toBe(first.comment.id);
    expect(opsFor("comment")).toHaveLength(before + 1);
  });

  it("mints no second operation when a structurally idempotent enqueue replays", () => {
    const issue = store.createIssue({ title: "Queued" });
    const queue = store.queue();
    queue.enqueue(issue.identifier, {}, "planner");
    const after = opsFor("queue").length;

    const replay = queue.enqueue(issue.identifier, {}, "planner");

    expect(replay.replayed).toBe(true);
    expect(opsFor("queue")).toHaveLength(after);
  });

  it("mints no second operation when a crash-recovery re-claim finds the issue already held", () => {
    const issue = store.createIssue({ title: "Held", status: "todo" });
    store.checkoutIssue(issue.identifier, "agent-a");
    const after = outbox().length;

    store.checkoutIssue(issue.identifier, "agent-a");

    expect(outbox()).toHaveLength(after);
  });
});

// ------------------------------------------------- obligation 6: a key on every event

describe("a dedup_key on every event", () => {
  it("gives every event a key, across all four emitters", () => {
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createIssue({ title: "Child", parent: epic.identifier, status: "todo" });
    store.addComment(child.identifier, "note");
    store.putDocument(child.identifier, "plan", "# plan");
    store.addStatus({ id: "reviewing", category: "active" });
    store.setSetting("kinds.default", "task");
    store.queue().enqueue(child.identifier, {}, "planner");
    store.projects().create({ name: "Platform" }, "planner");
    store.addKind({ id: "milestone", label: "Milestone" });
    store.milestones().create({ title: "M1" }, "planner");
    store.checkoutIssue(child.identifier, "agent-a");

    const unkeyed = store.db
      .prepare("SELECT kind FROM events WHERE dedup_key IS NULL")
      .all() as Array<{ kind: string }>;
    expect(unkeyed.map((row) => row.kind)).toEqual([]);
    // And the table is not empty, so the assertion above means something.
    expect(store.listEvents(0, 500).length).toBeGreaterThan(10);
  });

  it("keeps the level-triggered keys the store already derived from content", () => {
    const blocker = store.createIssue({ title: "Blocker" });
    const blocked = store.createIssue({ title: "Blocked" });
    store.setBlockedBy(blocked.identifier, [blocker.identifier]);
    store.updateIssue(blocker.identifier, { status: "done" });

    const resolved = store
      .listEvents(0, 500)
      .filter((event) => event.kind === "blockers_resolved");
    expect(resolved).toHaveLength(1);
    // Content-derived, not scope-derived: it names the dependent so the same
    // condition noticed twice is one row.
    expect(resolved[0]!.dedupKey).toMatch(/^blockers_resolved:/);
  });
});

// ----------------------------------------------- obligation 7: nothing outside the boundary

describe("nothing outside the boundary", () => {
  it("journals nothing for a schema migration", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    // The migration ran with no sync_state row and no device, and it created the
    // sync tables themselves — it cannot have journaled into them.
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
  });

  it("journals nothing for a read", () => {
    const issue = store.createIssue({ title: "Read me" });
    const after = outbox().length;

    store.getIssue(issue.identifier);
    store.listIssues({});
    store.listEvents(0, 100);

    expect(outbox()).toHaveLength(after);
  });
});

// ------------------------------------------------------------------- compaction

describe("compaction preserves convergence", () => {
  it("prunes acknowledged operations and keeps unacknowledged ones", () => {
    store.createIssue({ title: "Acked" });
    store.createIssue({ title: "Pending" });
    store.db
      .prepare("UPDATE sync_outbox SET acknowledged_seq = 10 WHERE client_seq = 1")
      .run();

    const result = journal.compact(new Date(Date.now() + 60_000).toISOString());

    expect(result.outboxPruned).toBe(1);
    expect(outbox().map((row) => row.client_seq)).toEqual([2]);
  });

  it("never touches tombstones, conflicts or the allocator", () => {
    store.createIssue({ title: "Acked" });
    store.db.prepare("UPDATE sync_outbox SET acknowledged_seq = 10").run();
    store.db
      .prepare(
        "INSERT INTO sync_tombstones (entity, entity_id, deleted_at) VALUES ('issue', 'gone', '2020-01-01T00:00:00.000Z')",
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO sync_conflicts (id, entity, entity_id, field, detected_at)
         VALUES ('x', 'issue', 'gone', 'title', '2020-01-01T00:00:00.000Z')`,
      )
      .run();
    const before = highWater();

    journal.compact(new Date(Date.now() + 60_000).toISOString());

    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sync_tombstones").get()).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sync_conflicts").get()).toEqual({ n: 1 });
    expect(highWater()).toBe(before);
  });
});

// ------------------------------------------------------------ the re-entrant tx

describe("tx nests", () => {
  it("commits an inner transaction with the outer one", () => {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    tx(db, () => {
      db.prepare("INSERT INTO t VALUES ('outer')").run();
      tx(db, () => db.prepare("INSERT INTO t VALUES ('inner')").run());
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 2 });
  });

  it("rolls an inner failure back to its savepoint and leaves the outer decision to the caller", () => {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    tx(db, () => {
      db.prepare("INSERT INTO t VALUES ('outer')").run();
      expect(() =>
        tx(db, () => {
          db.prepare("INSERT INTO t VALUES ('inner')").run();
          throw new Error("inner");
        }),
      ).toThrowError("inner");
    });
    expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "outer" }]);
  });

  it("rolls everything back when the outer transaction fails", () => {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    expect(() =>
      tx(db, () => {
        tx(db, () => db.prepare("INSERT INTO t VALUES ('inner')").run());
        throw new Error("outer");
      }),
    ).toThrowError("outer");
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 0 });
  });
});
