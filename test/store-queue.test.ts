import { beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import type { QueueStore } from "../src/core/queue-store.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

/**
 * STA-167 — the pickup queue in the store, the storage half of docs/queue.md.
 *
 * What is pinned here is what needs a database: that the plan is its own data
 * and not a derivation, that its order is durable and total, that the sparse
 * rank encoding inserts at the midpoint and renumbers when a gap runs out, that
 * `meta.queue_revision` refuses a stale base and leaves the order standing, that
 * an entry keys on `issues.id` and so survives everything except deletion, and
 * that the written lifecycle — kept, hidden, reopened, pruned — is what the
 * table actually does. Every test name below is the one docs/queue.md says pins
 * the paragraph.
 *
 * What is NOT here: the resolver, eligibility, container expansion, the unqueued
 * band, `strict` and the override. Those are R2c's (STA-168) and get their own
 * files; this one stops at the data they read.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
let queue: QueueStore;
beforeEach(() => {
  store = memStore();
  queue = store.queue();
});

function refused(fn: () => unknown, code: string): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe(code);
    return error as StapleError;
  }
  throw new Error(`expected a ${code} error`);
}

function issue(title: string, input: Record<string, unknown> = {}): string {
  return store.createIssue({ title, ...input }).identifier;
}

function order(options: { all?: boolean } = {}): string[] {
  return queue.entries(options).map((entry) => entry.identifier);
}

function ranks(): number[] {
  return queue.entries({ all: true }).map((entry) => entry.rank);
}

function eventsOf(kinds: readonly string[]): Array<{ kind: string; actor: string | null; payload: Record<string, unknown> }> {
  return store
    .listEvents(0, 1000)
    .filter((event) => kinds.includes(event.kind))
    .map((event) => ({ kind: event.kind, actor: event.actor, payload: event.payload }));
}

/** Walk a leaf to `done`, the way the guards insist on. */
function land(ref: string, to: "done" | "cancelled" = "done"): void {
  if (to === "done") {
    store.updateIssue(ref, { assignee: "someone" }, "someone");
    store.updateIssue(ref, { status: "in_progress" }, "someone");
  }
  store.updateIssue(ref, { status: to }, "someone");
}

describe("the plan is its own data", () => {
  it("plan order ignores priority, created_at and configured status order", () => {
    // Created oldest-first, and in DESCENDING importance, so presentation sort
    // (priority, then created_at) would produce exactly a, b, c.
    const a = issue("a", { priority: "critical", status: "todo" });
    const b = issue("b", { priority: "high" });
    const c = issue("c", { priority: "low" });

    queue.enqueue(c, {}, "vp");
    queue.enqueue(a, {}, "vp");
    queue.enqueue(b, {}, "vp");
    expect(order()).toEqual([c, a, b]);

    // Reordering the STATUS vocabulary is a statement about statuses, not about
    // what comes first, so the plan does not move.
    store.reorderStatuses(
      ["done", "cancelled", "blocked", "awaiting_approval", "in_review", "in_progress", "todo", "backlog"],
      "vp",
    );
    expect(order()).toEqual([c, a, b]);

    // Nor does changing a priority or a status.
    store.updateIssue(c, { priority: "low" }, "vp");
    store.updateIssue(b, { status: "todo" }, "vp");
    expect(order()).toEqual([c, a, b]);
  });

  it("survives restart with a stable total order", () => {
    const dir = mkdtempSync(join(tmpdir(), "staple-queue-"));
    try {
      const path = join(dir, "tasks.db");
      const first = openDb(path);
      migrateWorkspace(first);
      const one = new WorkspaceStore(first, "test", "TST");
      const refs = ["a", "b", "c"].map((title) => one.createIssue({ title }).identifier);
      one.queue().enqueue(refs[2]!, {}, "vp");
      one.queue().enqueue(refs[0]!, {}, "vp");
      one.queue().enqueue(refs[1]!, { before: refs[0] }, "vp");
      const before = one.queue().entries();
      const revision = one.queue().revision();
      first.close();

      const second = openDb(path);
      const two = new WorkspaceStore(second, "test", "TST");
      try {
        expect(two.queue().entries()).toEqual(before);
        expect(two.queue().entries().map((e) => e.identifier)).toEqual([refs[2], refs[1], refs[0]]);
        expect(two.queue().revision()).toBe(revision);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rank encoding", () => {
  it("insert between neighbours takes the midpoint", () => {
    const [a, b, c] = ["a", "b", "c"].map((title) => issue(title)) as [string, string, string];
    queue.enqueue(a, {}, "vp");
    queue.enqueue(b, {}, "vp");
    expect(ranks()).toEqual([1024, 2048]);
    // Between: the midpoint, rounded down. Append: max + step. Prepend: half the head.
    queue.enqueue(c, { after: a }, "vp");
    expect(order()).toEqual([a, c, b]);
    expect(ranks()).toEqual([1024, 1536, 2048]);

    const head = issue("head");
    queue.enqueue(head, { at: 1 }, "vp");
    expect(ranks()).toEqual([512, 1024, 1536, 2048]);

    const tail = issue("tail");
    queue.enqueue(tail, {}, "vp");
    expect(ranks()).toEqual([512, 1024, 1536, 2048, 3072]);
  });

  it("renumbers when the gap is exhausted, in one transaction", () => {
    const a = issue("a");
    const b = issue("b");
    queue.enqueue(a, {}, "vp");
    queue.enqueue(b, {}, "vp");
    // Repeatedly slot in front of the previous wedge: 1536, 1280, 1152 … ten
    // halvings and the gap between 1024 and 1025 is gone.
    const wedges = Array.from({ length: 10 }, (_, index) => issue(`wedge ${index}`));
    let target = b;
    for (const wedge of wedges) {
      queue.enqueue(wedge, { before: target }, "vp");
      target = wedge;
    }
    const before = queue.entries().map((entry) => entry.identifier);
    expect(ranks().slice(0, 3)).toEqual([1024, 1025, 1026]);

    const last = issue("last");
    const revisionBefore = queue.revision();
    queue.enqueue(last, { before: target }, "vp");

    // The renumber rewrote every existing rank to a multiple of the step and the
    // insert took the midpoint of its new neighbours — both in the same write,
    // so ONE revision bump for the pair, and an order that is the old one with
    // the new row slotted in.
    expect(queue.revision()).toBe(revisionBefore + 1);
    expect(ranks()).toEqual([1024, 1536, ...Array.from({ length: 11 }, (_, index) => (index + 2) * 1024)]);
    const expected = [...before];
    expected.splice(expected.indexOf(target), 0, last);
    expect(order()).toEqual(expected);
  });

  it("concurrent inserts never produce duplicate ranks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "staple-queue-race-"));
    try {
      const path = join(dir, "tasks.db");
      const setup = openDb(path);
      migrateWorkspace(setup);
      const seed = new WorkspaceStore(setup, "test", "TST");
      const refs = Array.from({ length: 12 }, (_, index) => seed.createIssue({ title: `t${index}` }).identifier);
      setup.close();

      // Two real processes, two connections, both slotting at the HEAD so every
      // insert has to compute a midpoint against whatever the other one just
      // wrote. `UNIQUE (rank)` plus `BEGIN IMMEDIATE` is the only thing stopping
      // them from reading the same neighbours and picking the same number.
      const results = await Promise.all([
        raceWorker(path, refs.slice(0, 6)),
        raceWorker(path, refs.slice(6)),
      ]);
      expect(results.filter((r) => !r.ok), JSON.stringify(results, null, 2)).toEqual([]);

      const db = openDb(path);
      try {
        const entries = new WorkspaceStore(db, "test", "TST").queue().entries();
        expect(entries).toHaveLength(refs.length);
        expect(new Set(entries.map((entry) => entry.rank)).size).toBe(refs.length);
        expect(entries.map((entry) => entry.rank)).toEqual(
          [...entries.map((entry) => entry.rank)].sort((x, y) => x - y),
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

const RACE_WORKER = join(dirname(fileURLToPath(import.meta.url)), "fixtures/queue/enqueue-worker.ts");
const TSX_CLI = join(dirname(fileURLToPath(import.meta.url)), "../node_modules/tsx/dist/cli.mjs");

/** One process that enqueues `refs` at the head of the plan, starting with the other one. */
function raceWorker(path: string, refs: readonly string[]): Promise<{ ok: boolean; message?: string }> {
  const startAt = Date.now() + 2_500;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, RACE_WORKER, path, String(startAt), refs.join(",")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", () => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        reject(new Error(`worker produced no result. stderr:\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as { ok: boolean; message?: string });
    });
  });
}

describe("revision and CAS", () => {
  it("a stale baseRevision is refused with revision_conflict and leaves the order unchanged", () => {
    const [a, b, c] = ["a", "b", "c"].map((title) => issue(title)) as [string, string, string];
    for (const ref of [a, b, c]) queue.enqueue(ref, {}, "vp");
    const stale = queue.revision() - 1;

    for (const mutation of [
      () => queue.enqueue(issue("late"), { at: 1, baseRevision: stale }, "vp"),
      () => queue.dequeue(a, { baseRevision: stale }, "vp"),
      () => queue.move(a, { at: 3, baseRevision: stale }, "vp"),
      () => queue.reorder([c, b, a], { baseRevision: stale }, "vp"),
    ]) {
      const error = refused(mutation, "revision_conflict");
      expect(error.detail).toEqual({ currentRevision: 3 });
      expect(error.message).toBe("The queue is at revision 3, not 2. Re-read the queue and retry.");
    }
    // Refused means nothing happened: same order, same revision, no event.
    expect(order()).toEqual([a, b, c]);
    expect(queue.revision()).toBe(3);
    expect(eventsOf(["queue_moved", "queue_dequeued", "queue_reordered"])).toEqual([]);

    // The current base is accepted, and it moves on.
    queue.move(a, { at: 3, baseRevision: 3 }, "vp");
    expect(order()).toEqual([b, c, a]);
    expect(queue.revision()).toBe(4);
  });

  it("bulk reorder is atomic and bumps the revision once", () => {
    const refs = ["a", "b", "c", "d"].map((title) => issue(title));
    for (const ref of refs) queue.enqueue(ref, {}, "vp");
    const base = queue.revision();

    const reversed = [...refs].reverse();
    const plan = queue.reorder(reversed, { baseRevision: base }, "vp");
    expect(plan.entries.map((entry) => entry.identifier)).toEqual(reversed);
    expect(plan.revision).toBe(base + 1);
    // One event for the whole permutation, not one per row, and clean ranks.
    expect(eventsOf(["queue_reordered"])).toEqual([
      { kind: "queue_reordered", actor: "vp", payload: { order: reversed, revision: base + 1 } },
    ]);
    expect(ranks()).toEqual([1024, 2048, 3072, 4096]);

    // A partial or repeating order is refused by name and changes nothing.
    expect(refused(() => queue.reorder(refs.slice(0, 2), {}, "vp"), "validation").message).toContain(
      "reorder needs every queue entry",
    );
    refused(() => queue.reorder([refs[0]!, refs[0]!, refs[1]!, refs[2]!], {}, "vp"), "validation");
    refused(() => queue.reorder([...refs.slice(1), issue("unqueued")], {}, "vp"), "validation");
    expect(order()).toEqual(reversed);
    expect(queue.revision()).toBe(base + 1);
  });
});

describe("lifecycle of an entry", () => {
  it("a resolved entry is kept and hidden", () => {
    const [a, b] = ["a", "b"].map((title) => issue(title)) as [string, string];
    queue.enqueue(a, {}, "vp");
    queue.enqueue(b, {}, "vp");
    land(a);
    const revision = queue.revision();

    // Nothing removed it and nothing renumbered: it is still row 1.
    expect(order({ all: true })).toEqual([a, b]);
    expect(queue.entries({ all: true }).map((entry) => [entry.identifier, entry.resolved, entry.planPosition])).toEqual([
      [a, true, 1],
      [b, false, 2],
    ]);
    // Hidden from the default listing, and hiding it does NOT renumber what follows.
    expect(order()).toEqual([b]);
    expect(queue.entries()[0]!.planPosition).toBe(2);
    // Resolving is not a queue mutation.
    expect(queue.revision()).toBe(revision);
  });

  it("a reopened issue resumes its plan position", () => {
    const [a, b] = ["a", "b"].map((title) => issue(title)) as [string, string];
    queue.enqueue(a, {}, "vp");
    queue.enqueue(b, {}, "vp");
    land(a, "cancelled");
    expect(order()).toEqual([b]);
    store.updateIssue(a, { status: "todo" }, "vp");
    // Nothing to re-queue: the entry never left, so it is row 1 again.
    expect(order()).toEqual([a, b]);
    expect(queue.entries()[0]).toMatchObject({ identifier: a, planPosition: 1, resolved: false });
  });

  it("prune removes only resolved entries and emits per-row events", () => {
    const [a, b, c] = ["a", "b", "c"].map((title) => issue(title)) as [string, string, string];
    for (const ref of [a, b, c]) queue.enqueue(ref, {}, "vp");
    land(a);
    land(c, "cancelled");
    const base = queue.revision();

    const plan = queue.prune({}, "vp");
    expect(plan.entries.map((entry) => entry.identifier)).toEqual([b]);
    expect(plan.revision).toBe(base + 1);
    expect(eventsOf(["queue_dequeued"])).toEqual([
      { kind: "queue_dequeued", actor: "vp", payload: { identifier: a, position: 1, reason: "pruned", revision: base + 1 } },
      { kind: "queue_dequeued", actor: "vp", payload: { identifier: c, position: 3, reason: "pruned", revision: base + 1 } },
    ]);
    // A pruned row is gone for good: reopening it does not bring the entry back.
    store.updateIssue(a, { status: "todo" }, "vp");
    expect(order()).toEqual([b]);
    // Pruning a clean queue is a no-op, revision included.
    expect(queue.prune({}, "vp").revision).toBe(base + 1);
    expect(eventsOf(["queue_dequeued"])).toHaveLength(2);
  });

  it("enqueue of a present issue is a no-op replay", () => {
    const [a, b] = ["a", "b"].map((title) => issue(title)) as [string, string];
    queue.enqueue(a, {}, "vp");
    queue.enqueue(b, {}, "vp");
    const base = queue.revision();

    const replay = queue.enqueue(a, {}, "someone-else");
    expect(replay.replayed).toBe(true);
    expect(replay.revision).toBe(base);
    expect(order()).toEqual([a, b]);
    // No second event, and the original attribution stands.
    expect(eventsOf(["queue_enqueued"])).toHaveLength(2);
    expect(queue.entries()[0]!.addedBy).toBe("vp");
  });

  it("enqueue with a position of a present issue is a move", () => {
    const [a, b] = ["a", "b"].map((title) => issue(title)) as [string, string];
    queue.enqueue(a, { note: "first" }, "vp");
    queue.enqueue(b, {}, "vp");

    const moved = queue.enqueue(a, { after: b }, "someone-else");
    expect(moved.replayed).toBe(false);
    expect(order()).toEqual([b, a]);
    expect(eventsOf(["queue_moved"])).toEqual([
      {
        kind: "queue_moved",
        actor: "someone-else",
        payload: { identifier: a, fromPosition: 1, toPosition: 2, rank: 3072, revision: 3 },
      },
    ]);
    // Moving a row does not make the mover its author, and the note travels.
    expect(queue.entries()[1]).toMatchObject({ addedBy: "vp", note: "first" });
  });

  it("a container and its descendant may both be queued", () => {
    const epic = issue("S", { kind: "epic" });
    const child = store.createChild(epic, { title: "S1" }).identifier;
    queue.enqueue(epic, {}, "vp");
    queue.enqueue(child, {}, "vp");
    // The plan holds both, in the order they were put there. Which one an agent
    // is handed is the resolver's problem, not the table's.
    expect(order()).toEqual([epic, child]);
    expect(queue.entries().map((entry) => [entry.identifier, entry.kind, entry.parent])).toEqual([
      [epic, "epic", null],
      [child, "task", epic],
    ]);
  });

  it("an entry survives rename, status change and re-parent", () => {
    const e1 = issue("E1", { kind: "epic" });
    const e2 = issue("E2", { kind: "epic" });
    const t = store.createChild(e1, { title: "T" }).identifier;
    const other = issue("other");
    queue.enqueue(t, {}, "vp");
    queue.enqueue(other, {}, "vp");
    const rank = queue.entries()[0]!.rank;

    store.updateIssue(t, { title: "T renamed" }, "vp");
    store.updateIssue(t, { status: "todo" }, "vp");
    // No re-parent API in the store; the point is that the row keys on `issues.id`.
    store.db.prepare("UPDATE issues SET parent_id = ? WHERE id = ?").run(store.getIssue(e2).id, store.getIssue(t).id);

    expect(queue.entries()[0]).toMatchObject({
      identifier: t,
      title: "T renamed",
      status: "todo",
      parent: e2,
      planPosition: 1,
      rank,
    });
    expect(order()).toEqual([t, other]);
  });

  it("deleting an issue deletes its entry", () => {
    const [a, b, c] = ["a", "b", "c"].map((title) => issue(title)) as [string, string, string];
    for (const ref of [a, b, c]) queue.enqueue(ref, {}, "vp");
    // The store has no deleteIssue; the cascade is the schema's, so raw SQL on this scratch db.
    store.db.prepare("DELETE FROM issues WHERE id = ?").run(store.getIssue(b).id);
    expect(order()).toEqual([a, c]);
    // The survivors keep their ranks — a delete is not a reorder.
    expect(ranks()).toEqual([1024, 3072]);
  });

  it("refuses a foreign identifier and names its workspace", () => {
    const error = refused(() => queue.enqueue("WOR-12", {}, "vp"), "validation");
    expect(error.message).toBe(
      "WOR-12 belongs to workspace prefix WOR, not test (TST); a queue holds only its own workspace's issues.",
    );
    expect(error.detail).toEqual({ identifier: "WOR-12", prefix: "WOR", workspace: "test" });
    // An unknown local identifier is the ordinary not_found, not this.
    refused(() => queue.enqueue("TST-999", {}, "vp"), "not_found");
  });
});

describe("refusals that are not about revisions", () => {
  it("names the row that is not in the queue", () => {
    const a = issue("a");
    const b = issue("b");
    queue.enqueue(a, {}, "vp");
    expect(refused(() => queue.dequeue(b, {}, "vp"), "not_found").message).toBe(`${b} is not in the queue.`);
    expect(refused(() => queue.move(b, { at: 1 }, "vp"), "not_found").message).toBe(`${b} is not in the queue.`);
    expect(refused(() => queue.enqueue(b, { before: b }, "vp"), "not_found").message).toBe(
      `${b} is not in the queue.`,
    );
  });

  it("needs a position to move and a 1-based one to place", () => {
    const a = issue("a");
    queue.enqueue(a, {}, "vp");
    expect(refused(() => queue.move(a, {}, "vp"), "validation").message).toBe(
      `mv ${a} needs one of --before, --after or --at.`,
    );
    for (const at of [0, -1, 1.5]) {
      expect(refused(() => queue.enqueue(issue(`x${at}`), { at }, "vp"), "validation").message).toBe(
        `--at is a 1-based position; got ${at}.`,
      );
    }
    // Past the end is not an error: `--at 99` on a two-row plan appends.
    queue.enqueue(issue("far"), { at: 99 }, "vp");
    expect(queue.entries()).toHaveLength(2);
  });
});

describe("events", () => {
  it("every mutation carries the actor and the resulting revision", () => {
    const [a, b] = ["a", "b"].map((title) => issue(title)) as [string, string];
    queue.enqueue(a, { note: "why" }, "vp");
    queue.enqueue(b, { at: 1 }, "claude-1");
    queue.move(a, { at: 1 }, "claude-1");
    queue.reorder([b, a], {}, "vp");
    queue.dequeue(b, {}, "vp");

    expect(eventsOf(["queue_enqueued", "queue_moved", "queue_reordered", "queue_dequeued"])).toEqual([
      { kind: "queue_enqueued", actor: "vp", payload: { identifier: a, rank: 1024, position: 1, revision: 1 } },
      { kind: "queue_enqueued", actor: "claude-1", payload: { identifier: b, rank: 512, position: 1, revision: 2 } },
      {
        kind: "queue_moved",
        actor: "claude-1",
        payload: { identifier: a, fromPosition: 2, toPosition: 1, rank: 256, revision: 3 },
      },
      { kind: "queue_reordered", actor: "vp", payload: { order: [b, a], revision: 4 } },
      { kind: "queue_dequeued", actor: "vp", payload: { identifier: b, position: 1, reason: "removed", revision: 5 } },
    ]);

    // The row event is ON the issue; the plan-wide one belongs to no issue.
    const events = store.listEvents(0, 1000).filter((event) => event.kind.startsWith("queue_"));
    expect(events.map((event) => event.issueId === null)).toEqual([false, false, false, true, false]);
    // None of them moves a status, so none is a status-moving event.
    expect(store.getIssue(a).status).toBe("backlog");
  });
});
