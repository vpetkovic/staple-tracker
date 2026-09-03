import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { ISSUE_KINDS, ISSUE_STATUSES } from "../src/core/types.js";

/**
 * O7a (STA-140) — the workspace vocabulary is DATA.
 *
 * Two claims are under test here and they are different in kind.
 *
 * The first is CRUD: statuses and kinds can be added, renamed, reordered and
 * removed, and removal is guarded twice over. That part is ordinary.
 *
 * The second is the one the ticket exists for, and it is the reason most of this
 * file is about issues rather than about settings rows: every semantic in the
 * store must key off a status's CATEGORY and off the configured ORDER, never off
 * a literal id. The way to prove that is not to read the source — it is to
 * RENAME EVERY BUILT-IN STATUS AWAY and then check that checkout, release,
 * derived parent rungs, resolved detection, the inbox partition and the list
 * order all still behave. If any of them had a string literal left in it, the
 * renamed workspace breaks and these tests go red.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
beforeEach(() => {
  store = memStore();
});

const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

// --------------------------------------------------------------------- seed

describe("the seeded vocabulary", () => {
  it("seeds exactly the built-in statuses, in seed order, with their categories", () => {
    expect(idsOf(store.getStatuses())).toEqual([...ISSUE_STATUSES]);
    expect(store.getStatuses().map((s) => `${s.id}:${s.category}`)).toEqual([
      "backlog:unstarted",
      "todo:ready",
      "in_progress:active",
      "in_review:review",
      "done:done",
      "blocked:blocked",
      "cancelled:cancelled",
    ]);
    expect(store.getStatuses().every((s) => s.isBuiltin)).toBe(true);
  });

  it("seeds the kind vocabulary O1a consumes", () => {
    expect(idsOf(store.getKinds())).toEqual([...ISSUE_KINDS]);
    expect(store.getKinds().every((k) => k.isBuiltin)).toBe(true);
  });

  /**
   * The fresh-create fast path executes a `sqlite_master` dump, which carries no
   * rows — so a database that took that path would come up with two empty tables
   * if `migrateWorkspace` did not seed after the runner. This is that assertion,
   * and it is the one that fails if somebody "simplifies" the double seed away.
   */
  it("seeds on the consolidated fresh-create path, not only on the walk", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM workspace_statuses) AS s,
                (SELECT COUNT(*) FROM workspace_kinds) AS k`,
      )
      .get() as { s: number; k: number };
    expect(counts).toEqual({ s: ISSUE_STATUSES.length, k: ISSUE_KINDS.length });
    db.close();
  });

  it("does not write a settings_revision row until something changes", () => {
    const keys = () =>
      (store.db.prepare("SELECT key FROM meta ORDER BY key").all() as Array<{ key: string }>).map(
        (r) => r.key,
      );
    expect(keys()).not.toContain("settings_revision");
    store.renameStatus("todo", "Ready");
    expect(keys()).toContain("settings_revision");
  });
});

// ---------------------------------------------------------------- CRUD

describe("editing statuses", () => {
  it("adds a status after a named one without renumbering the rest", () => {
    const before = store.getStatuses().map((s) => s.sortOrder);
    store.addStatus({ id: "awaiting_approval", category: "gated", after: "in_review" });
    expect(idsOf(store.getStatuses())).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "awaiting_approval",
      "done",
      "blocked",
      "cancelled",
    ]);
    // The pre-existing rows kept their sort_order — `after` is arithmetic in the
    // gap, not a rewrite of the column.
    expect(store.getStatuses().filter((s) => s.isBuiltin).map((s) => s.sortOrder)).toEqual(before);
  });

  it("appends when no --after is given, and title-cases a missing label", () => {
    store.addStatus({ id: "on_hold", category: "blocked" });
    const added = store.getStatuses().at(-1)!;
    expect(added).toMatchObject({ id: "on_hold", label: "On Hold", category: "blocked", isBuiltin: false });
  });

  it("refuses a duplicate id, an unusable id and an unknown category", () => {
    expect(() => store.addStatus({ id: "todo", category: "ready" })).toThrowError(/already exists/);
    expect(() => store.addStatus({ id: "Not Valid", category: "ready" })).toThrowError(/not a usable status id/);
    expect(() => store.addStatus({ id: "whatever", category: "purple" })).toThrowError(
      /Unknown status category/,
    );
  });

  it("renames the label and leaves the id — the thing every row references — alone", () => {
    store.renameStatus("in_progress", "Doing");
    expect(store.getStatuses().find((s) => s.id === "in_progress")?.label).toBe("Doing");
    expect(idsOf(store.getStatuses())).toEqual([...ISSUE_STATUSES]);
  });

  it("reorders, and refuses a partial or duplicated order rather than guessing", () => {
    store.reorderStatuses([
      "in_progress",
      "in_review",
      "blocked",
      "todo",
      "backlog",
      "done",
      "cancelled",
    ]);
    expect(idsOf(store.getStatuses())).toEqual([
      "in_progress",
      "in_review",
      "blocked",
      "todo",
      "backlog",
      "done",
      "cancelled",
    ]);
    expect(() => store.reorderStatuses(["todo", "backlog"])).toThrowError(/must list every status/);
    expect(() => store.reorderStatuses([...ISSUE_STATUSES, "todo"])).toThrowError(/appears twice/);
    expect(() => store.reorderStatuses([...ISSUE_STATUSES, "nope"])).toThrowError(/Unknown status/);
  });

  it("moves a status to another category, which is how you change its behaviour", () => {
    store.recategorizeStatus("in_review", "gated");
    expect(store.categoryOf("in_review")).toBe("gated");
  });
});

describe("removing a status", () => {
  it("removes an unused custom status cleanly", () => {
    store.addStatus({ id: "on_hold", category: "blocked" });
    expect(store.removeStatus("on_hold")).toEqual({ migrated: 0 });
    expect(idsOf(store.getStatuses())).toEqual([...ISSUE_STATUSES]);
  });

  it("refuses while issues still carry it, and names how many", () => {
    store.addStatus({ id: "on_hold", category: "blocked" });
    const issue = store.createIssue({ title: "parked" });
    store.updateIssue(issue.id, { status: "on_hold" });
    expect(() => store.removeStatus("on_hold")).toThrowError(/1 issue still has status "on_hold"/);
    // …and the status is still there: a refused remove writes nothing.
    expect(idsOf(store.getStatuses())).toContain("on_hold");
  });

  it("migrates every row that carried it when --migrate-to is given", () => {
    store.addStatus({ id: "on_hold", category: "blocked" });
    const a = store.createIssue({ title: "one" });
    const b = store.createIssue({ title: "two" });
    store.updateIssue(a.id, { status: "on_hold" });
    store.updateIssue(b.id, { status: "on_hold" });

    expect(store.removeStatus("on_hold", { migrateTo: "backlog" })).toEqual({ migrated: 2 });
    expect(store.getIssue(a.id).status).toBe("backlog");
    expect(store.getIssue(b.id).status).toBe("backlog");
    expect(idsOf(store.getStatuses())).not.toContain("on_hold");
  });

  /**
   * The guard that keeps the workspace COHERENT rather than merely tidy: staple
   * itself writes into these categories (checkout -> active, release -> ready,
   * done -> done), so emptying one leaves a workspace that cannot complete a task.
   * `review` and `gated` are absent from the required set on purpose — nothing
   * can enter a category with no members, so emptying those is a real choice.
   */
  it("refuses to empty a category the code writes into, even with --migrate-to", () => {
    for (const id of ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"]) {
      expect(() => store.removeStatus(id, { migrateTo: "todo" }), id).toThrowError(
        /only status in the .* category/,
      );
    }
    // in_review is not required, so it goes.
    expect(() => store.removeStatus("in_review")).not.toThrow();
  });

  it("allows removing a required category's member while a sibling remains", () => {
    store.addStatus({ id: "queued", category: "ready", after: "todo" });
    expect(() => store.removeStatus("todo")).not.toThrow();
    expect(store.primaryStatusFor("ready")).toBe("queued");
  });
});

describe("editing kinds", () => {
  it("adds, renames, reorders and removes", () => {
    store.addKind({ id: "milestone" });
    expect(store.getKinds().at(-1)).toMatchObject({ id: "milestone", label: "Milestone", isBuiltin: false });
    store.renameKind("spike", "Spike / Research");
    expect(store.getKinds().find((k) => k.id === "spike")?.label).toBe("Spike / Research");
    store.reorderKinds(["task", "bug", "chore", "spike", "epic", "milestone"]);
    expect(idsOf(store.getKinds())).toEqual(["task", "bug", "chore", "spike", "epic", "milestone"]);
    expect(store.removeKind("milestone")).toEqual({ migrated: 0 });
    expect(idsOf(store.getKinds())).not.toContain("milestone");
  });

  /**
   * The counter O7a left probing for a column that did not exist yet. O1a
   * (STA-124) added `issues.kind`, so this now reads real rows — which is the
   * whole point of having written it as a probe rather than a hardcoded 0.
   */
  it("counts real kind usage now that issues carry a kind", () => {
    expect(store.kindUsageCount("task")).toBe(0);
    store.createIssue({ title: "anything" });
    expect(store.kindUsageCount("task")).toBe(1);
    store.createIssue({ title: "a defect", kind: "bug" });
    expect(store.kindUsageCount("task")).toBe(1);
    expect(store.kindUsageCount("bug")).toBe(1);
  });

  /**
   * The guard O7a wrote against a future it could not yet exercise: removing a
   * kind that rows still reference must refuse rather than orphan them.
   */
  it("refuses to remove a kind issues still carry, and migrates on request", () => {
    store.createIssue({ title: "a defect", kind: "bug" });
    expect(() => store.removeKind("bug")).toThrowError(/1 issue still has kind "bug"/);
    expect(store.removeKind("bug", { migrateTo: "chore" })).toEqual({ migrated: 1 });
    expect(store.kindUsageCount("chore")).toBe(1);
    expect(idsOf(store.getKinds())).not.toContain("bug");
  });

  it("keeps at least one kind", () => {
    for (const id of ["epic", "bug", "chore", "spike"]) store.removeKind(id);
    expect(() => store.removeKind("task")).toThrowError(/only kind left/);
  });

  it("has no categories, and says so instead of silently ignoring one", () => {
    expect(() => store.applyKindOps([{ op: "recategorize", id: "task", category: "ready" }])).toThrowError(
      /Kinds have no category/,
    );
  });
});

describe("batched ops", () => {
  it("applies in order, so a later op sees an earlier one's row", () => {
    const result = store.applyStatusOps([
      { op: "add", id: "awaiting_approval", category: "gated", after: "in_review" },
      { op: "rename", id: "awaiting_approval", label: "Waiting on a human" },
    ]);
    expect(result.find((s) => s.id === "awaiting_approval")?.label).toBe("Waiting on a human");
  });

  it("is all-or-nothing: a failing op undoes the ops before it", () => {
    expect(() =>
      store.applyStatusOps([
        { op: "add", id: "awaiting_approval", category: "gated" },
        { op: "add", id: "todo", category: "ready" }, // duplicate -> throws
      ]),
    ).toThrowError(/already exists/);
    expect(idsOf(store.getStatuses())).toEqual([...ISSUE_STATUSES]);
  });
});

// ------------------------------------------------------- the cache contract

describe("the settings cache", () => {
  it("serves a memo but never a stale one after another connection writes", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const a = new WorkspaceStore(db, "test", "TST");
    const b = new WorkspaceStore(db, "test", "TST");

    // Warm both memos against the same file.
    expect(idsOf(a.getStatuses())).toEqual([...ISSUE_STATUSES]);
    expect(idsOf(b.getStatuses())).toEqual([...ISSUE_STATUSES]);

    a.addStatus({ id: "on_hold", category: "blocked" });

    // B never touched its own cache, and must still see the new row: the memo is
    // keyed on meta.settings_revision, not on "did I write".
    expect(idsOf(b.getStatuses())).toContain("on_hold");
    db.close();
  });
});

// ----------------------------------------------- semantics follow the config

/**
 * The workspace nothing in `store.ts` can have hardcoded: every built-in id is
 * gone, replaced by a same-category status under a different name. If a single
 * guard still compares against `"in_progress"` or `"done"`, everything below
 * fails.
 */
function renamedWorkspace(): WorkspaceStore {
  const s = memStore();
  s.applyStatusOps([
    { op: "add", id: "icebox", category: "unstarted" },
    { op: "add", id: "queued", category: "ready" },
    { op: "add", id: "doing", category: "active" },
    { op: "add", id: "reviewing", category: "review" },
    { op: "add", id: "shipped", category: "done" },
    { op: "add", id: "stuck", category: "blocked" },
    { op: "add", id: "dropped", category: "cancelled" },
    { op: "remove", id: "backlog", migrateTo: "icebox" },
    { op: "remove", id: "todo", migrateTo: "queued" },
    { op: "remove", id: "in_progress", migrateTo: "doing" },
    { op: "remove", id: "in_review", migrateTo: "reviewing" },
    { op: "remove", id: "done", migrateTo: "shipped" },
    { op: "remove", id: "blocked", migrateTo: "stuck" },
    { op: "remove", id: "cancelled", migrateTo: "dropped" },
    { op: "reorder", ids: ["icebox", "queued", "doing", "reviewing", "shipped", "stuck", "dropped"] },
  ]);
  return s;
}

describe("every semantic keys off category, not off the built-in ids", () => {
  beforeEach(() => {
    store = renamedWorkspace();
  });

  it("creates into the configured unstarted/ready statuses", () => {
    expect(store.createIssue({ title: "unassigned" }).status).toBe("icebox");
    expect(store.createIssue({ title: "assigned", assignee: "a" }).status).toBe("queued");
  });

  it("claims into the configured active status and releases into the ready one", () => {
    const issue = store.createIssue({ title: "work" });
    expect(store.checkoutIssue(issue.id, "agent-a").status).toBe("doing");
    expect(store.claimActivity(issue.id)?.heldBy).toBe("agent-a");
    expect(store.releaseIssue(issue.id, "agent-a").status).toBe("queued");
  });

  it("claims from unstarted, ready and blocked — and refuses from review", () => {
    expect(store.checkoutExpectedStatuses()).toEqual(["queued", "icebox", "stuck"]);
    const parked = store.createIssue({ title: "parked", status: "stuck" });
    expect(store.checkoutIssue(parked.id, "agent-a").status).toBe("doing");

    const reviewing = store.createIssue({ title: "reviewing", status: "reviewing" });
    expect(() => store.checkoutIssue(reviewing.id, "agent-a")).toThrowError(/Checkout refused/);
  });

  it("treats the configured done/cancelled statuses as resolved", () => {
    expect(store.isResolvedStatus("shipped")).toBe(true);
    expect(store.isResolvedStatus("dropped")).toBe(true);
    expect(store.isResolvedStatus("stuck")).toBe(false);

    const blocker = store.createIssue({ title: "blocker" });
    const dependent = store.createIssue({ title: "dependent" });
    store.setBlockedBy(dependent.id, [blocker.id]);
    expect(store.unresolvedBlockersOf(dependent.id)).toHaveLength(1);
    store.updateIssue(blocker.id, { status: "shipped" });
    expect(store.unresolvedBlockersOf(dependent.id)).toHaveLength(0);
  });

  it("stamps completedAt/cancelledAt/startedAt by category", () => {
    const done = store.createIssue({ title: "d", assignee: "a" });
    store.updateIssue(done.id, { status: "shipped" });
    expect(store.getIssue(done.id).completedAt).not.toBeNull();

    const gone = store.createIssue({ title: "c" });
    store.updateIssue(gone.id, { status: "dropped" });
    expect(store.getIssue(gone.id).cancelledAt).not.toBeNull();

    const live = store.createIssue({ title: "l", assignee: "a" });
    store.updateIssue(live.id, { status: "doing" });
    expect(store.getIssue(live.id).startedAt).not.toBeNull();
  });

  it("still requires an assignee to enter the active category", () => {
    const issue = store.createIssue({ title: "work" });
    expect(() => store.updateIssue(issue.id, { status: "doing" })).toThrowError(/requires an assignee/);
  });

  it("derives a parent through the renamed ladder", () => {
    const epic = store.createIssue({ title: "epic" });
    const child = store.createIssue({ title: "child", parent: epic.id });

    // rung 3: an open unstarted child puts the epic in the workable band, and
    // the band writes the UNSTARTED status, never the ready one.
    expect(store.getIssue(epic.id).status).toBe("icebox");

    // rung 1: work starts underneath.
    store.checkoutIssue(child.id, "agent-a");
    expect(store.getIssue(epic.id).status).toBe("doing");

    // rung 2: review.
    store.updateIssue(child.id, { status: "reviewing" });
    expect(store.getIssue(epic.id).status).toBe("reviewing");

    // rung 4: everything open underneath is blocked.
    store.updateIssue(child.id, { status: "stuck" });
    expect(store.getIssue(epic.id).status).toBe("stuck");

    // rung 6: nothing open left, so the epic closes — into whatever this
    // workspace calls done, never into the literal `done`.
    store.updateIssue(child.id, { status: "shipped" });
    expect(store.getIssue(epic.id).status).toBe("shipped");
    expect(store.getIssue(epic.id).completedAt).not.toBeNull();

    // rung 5 is the same, in the workspace's own cancelled status.
    const other = store.createIssue({ title: "other epic" });
    const dropped = store.createIssue({ title: "dropped child", parent: other.id });
    store.updateIssue(dropped.id, { status: "dropped" });
    expect(store.getIssue(other.id).status).toBe("dropped");
  });

  it("partitions the inbox by category, gated included", () => {
    store.addStatus({ id: "awaiting_approval", category: "gated" });
    const ready = store.createIssue({ title: "ready", status: "queued" });
    const parked = store.createIssue({ title: "parked", status: "stuck" });
    const gated = store.createIssue({ title: "gated", status: "awaiting_approval" });

    const inbox = store.inbox();
    expect(inbox.ready.map((i) => i.id)).toContain(ready.id);
    expect(inbox.blocked.map((i) => i.id)).toEqual(
      expect.arrayContaining([parked.id, gated.id]),
    );
    expect(inbox.ready.map((i) => i.id)).not.toContain(gated.id);
  });

  it("counts children under the CONFIGURED status keys", () => {
    const epic = store.createIssue({ title: "epic" });
    store.createIssue({ title: "child", parent: epic.id, status: "queued" });
    const counts = store.timing(epic.id).childStatusCounts;
    expect(Object.keys(counts).sort()).toEqual(
      ["doing", "dropped", "icebox", "queued", "reviewing", "shipped", "stuck"].sort(),
    );
    expect(counts.queued).toBe(1);
  });

  it("rejects a status the workspace does not configure", () => {
    expect(() => store.createIssue({ title: "x", status: "in_progress" })).toThrowError(
      /Unknown status "in_progress"/,
    );
  });
});

describe("configured order drives the list", () => {
  it("sorts by category tier first, and by configured order within a tier", () => {
    // Two READY statuses. Their relative order is configuration; their position
    // below `active` is not, and a reorder must not be able to change it.
    store.addStatus({ id: "queued", category: "ready", after: "todo" });
    const later = store.createIssue({ title: "later", status: "queued" });
    const soon = store.createIssue({ title: "soon", status: "todo" });
    const live = store.createIssue({ title: "live", assignee: "a", status: "todo" });
    store.checkoutIssue(live.id, "a");

    const order = () => store.listIssues().map((i) => i.id);
    expect(order()).toEqual([live.id, soon.id, later.id]);

    // Flip the two ready statuses; the ready pair swaps, `active` stays on top.
    store.reorderStatuses([
      "backlog",
      "queued",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "blocked",
      "cancelled",
    ]);
    expect(order()).toEqual([live.id, later.id, soon.id]);
  });

  it("exposes the pickup and open orders it sorted by", () => {
    expect(store.inboxPickupOrder()).toEqual(["in_progress", "in_review", "todo", "backlog"]);
    expect(store.openStatusOrder()).toEqual([
      "in_progress",
      "in_review",
      "blocked",
      "todo",
      "backlog",
    ]);
    store.addStatus({ id: "awaiting_approval", category: "gated" });
    // `gated` sits between review and blocked: parked, but not yet a dependency.
    expect(store.openStatusOrder()).toEqual([
      "in_progress",
      "in_review",
      "awaiting_approval",
      "blocked",
      "todo",
      "backlog",
    ]);
  });
});
