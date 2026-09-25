/**
 * The explicit estimate write, `WorkspaceStore.setEstimate` — the one store method behind
 * `staple estimate`, MCP `set_estimate` and the HTTP `estimate` action.
 *
 * Every row here is written by a real store mutation (create, checkout, status, the write
 * under test); nothing is hand-set. What is pinned:
 *
 *  - it changes the estimate and nothing else: not the status, its version, the claim,
 *    or an attempt's `estimateAtStart`;
 *  - a change emits the SAME `estimate_changed` event and the same journal payload as the
 *    old same-status path, which keeps working;
 *  - an unchanged value is a no-op with no event, no sync operation and no `updatedAt` bump;
 *  - it is refused only where the value is not an estimate, and allowed wherever a status
 *    write would be (another agent's claim, a resolved issue).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { attemptsOfIssue } from "../src/core/telemetry/attempt-records.js";
import { StapleError } from "../src/core/types.js";
import type { DatabaseSync } from "node:sqlite";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-00000e571a7e";
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});
async function sync(...machines: Machine[]): Promise<void> {
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
}

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
const previousHome = process.env.STAPLE_HOME;
beforeEach(() => {
  process.env.STAPLE_HOME = mkdtempSync(join(tmpdir(), "staple-estimate-write-home-"));
  store = memStore();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

type Row = Record<string, unknown>;
const estimateEvents = (issueId: string): Row[] =>
  store.db
    .prepare("SELECT actor, payload FROM events WHERE kind = 'estimate_changed' AND issue_id = ? ORDER BY seq")
    .all(issueId) as Row[];
const eventCount = (): number => (store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
const outboxOf = (db: DatabaseSync): Row[] =>
  db.prepare("SELECT entity, verb, payload FROM sync_outbox ORDER BY client_seq").all() as Row[];

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("setEstimate changes the estimate and nothing else", () => {
  it("sets it on an in-progress issue without restating or moving the status", () => {
    const issue = store.createIssue({ title: "Claimed", estimatedSeconds: 3600 });
    const held = store.checkoutIssue(issue.id, "agent-a");
    const result = store.setEstimate(issue.identifier, 7200, "agent-a");

    expect(result).toMatchObject({ from: 3600, to: 7200, changed: true });
    expect(result.issue.estimatedSeconds).toBe(7200);
    expect(result.issue.status).toBe("in_progress");
    expect(result.issue.statusVersion).toBe(held.statusVersion);
    expect(result.issue.checkoutAgent).toBe("agent-a");
    expect(result.issue.checkoutAt).toBe(held.checkoutAt);
    expect(store.getIssue(issue.id).estimatedSeconds).toBe(7200);
  });

  it("leaves the attempt's estimateAtStart as it read at the start", () => {
    const issue = store.createIssue({ title: "Attempted", estimatedSeconds: 1800 });
    store.checkoutIssue(issue.id, "agent-a");
    store.setEstimate(issue.id, 5400, "agent-a");
    store.setEstimate(issue.id, null, "agent-a");
    const [attempt] = attemptsOfIssue(store.db, issue.id);
    expect(attempt!.estimateAtStart).toEqual({ estimatedSeconds: 1800, source: "own" });
    expect(attempt!.state).toBe("running");
  });

  it("clears with null, and a later set works again", () => {
    const issue = store.createIssue({ title: "Cleared", estimatedSeconds: 600 });
    expect(store.setEstimate(issue.id, null, "a")).toMatchObject({ from: 600, to: null, changed: true });
    expect(store.getIssue(issue.id).estimatedSeconds).toBeNull();
    expect(store.setEstimate(issue.id, 900, "a")).toMatchObject({ from: null, to: 900, changed: true });
  });
});

describe("the same event and journal payload as the old same-status path", () => {
  it("emits estimate_changed {identifier, from, to} with the actor, exactly like a same-status updateIssue", () => {
    const viaVerb = store.createIssue({ title: "Via verb", estimatedSeconds: 3600 });
    const viaStatus = store.createIssue({ title: "Via status", estimatedSeconds: 3600 });

    store.setEstimate(viaVerb.id, 7200, "agent-a");
    store.updateIssue(viaStatus.id, { status: "backlog", estimatedSeconds: 7200 }, "agent-a");

    expect(estimateEvents(viaVerb.id)).toEqual([
      { actor: "agent-a", payload: JSON.stringify({ identifier: viaVerb.identifier, from: 3600, to: 7200 }) },
    ]);
    expect(estimateEvents(viaStatus.id)).toEqual([
      { actor: "agent-a", payload: JSON.stringify({ identifier: viaStatus.identifier, from: 3600, to: 7200 }) },
    ]);
  });

  it("journals the same replicated operation as the old path, and the other device reads the new estimate", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const viaVerb = a.store.createIssue({ title: "Via verb", estimatedSeconds: 3600 });
    const viaStatus = a.store.createIssue({ title: "Via status", estimatedSeconds: 3600 });
    const before = outboxOf(a.db).length;
    a.store.setEstimate(viaVerb.id, 7200, "agent-a");
    const verbOps = outboxOf(a.db).slice(before);
    a.store.updateIssue(viaStatus.id, { status: "backlog", estimatedSeconds: 7200 }, "agent-a");
    const statusOps = outboxOf(a.db).slice(before + verbOps.length);

    // One issue.update each, carrying the same changed columns.
    const shape = (ops: Row[]) =>
      ops.map((op) => ({ entity: op.entity, verb: op.verb, keys: Object.keys(JSON.parse(op.payload as string)).sort() }));
    expect(shape(verbOps)).toEqual(shape(statusOps));
    expect(shape(verbOps)).toEqual([{ entity: "issue", verb: "update", keys: ["estimatedSeconds", "originEvents", "updatedAt"] }]);

    await sync(a, b);
    b.use();
    expect(b.store.getIssue(viaVerb.id).estimatedSeconds).toBe(7200);
    expect(b.store.getIssue(viaStatus.id).estimatedSeconds).toBe(7200);
  });

  it("keeps the old path working: a same-status write with an estimate still sets it and moves nothing", () => {
    const issue = store.createIssue({ title: "Old path", assignee: "agent-a" });
    store.checkoutIssue(issue.id, "agent-a");
    const before = store.getIssue(issue.id);
    const after = store.updateIssue(issue.id, { status: "in_progress", estimatedSeconds: 7200 }, "agent-a");
    expect(after.estimatedSeconds).toBe(7200);
    expect(after.statusVersion).toBe(before.statusVersion);
    expect(after.checkoutAgent).toBe("agent-a");
  });
});

describe("an unchanged value is a no-op", () => {
  it("writes nothing, emits nothing, syncs nothing, and says changed: false", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await sync(a);
    a.use();
    const issue = a.store.createIssue({ title: "Repeat" });
    const opsBefore = outboxOf(a.db).length;
    const first = a.store.setEstimate(issue.id, 7200, "a");
    // The change itself is replicated, so the no-op check below is measuring something.
    expect(outboxOf(a.db).length).toBe(opsBefore + 1);

    const events = (a.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const ops = outboxOf(a.db).length;
    const repeat = a.store.setEstimate(issue.id, 7200, "a");
    expect(repeat).toMatchObject({ from: 7200, to: 7200, changed: false });
    expect(repeat.issue).toEqual(first.issue);
    expect(repeat.issue.updatedAt).toBe(first.issue.updatedAt);
    expect((a.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(events);
    expect(outboxOf(a.db).length).toBe(ops);
  });

  it("clearing an estimate that is already absent is the same no-op", () => {
    const issue = store.createIssue({ title: "Never estimated" });
    const events = eventCount();
    const before = store.getIssue(issue.id);
    expect(store.setEstimate(issue.id, null, "a")).toMatchObject({ from: null, to: null, changed: false });
    expect(eventCount()).toBe(events);
    expect(store.getIssue(issue.id).updatedAt).toBe(before.updatedAt);
  });
});

describe("guards: a value refusal, and nothing a status write does not have", () => {
  it("refuses a value that is not an estimate, with the store's own sentence, writing nothing", () => {
    const issue = store.createIssue({ title: "Bad values", estimatedSeconds: 600 });
    for (const bad of [0, -5, 1.5, 366 * 86_400]) {
      expect(refusal(() => store.setEstimate(issue.id, bad, "a")).code).toBe("validation");
    }
    expect(refusal(() => store.setEstimate(issue.id, 0, "a")).message).toMatch(/positive whole number of seconds/);
    // No value at all is not a clear.
    expect(refusal(() => store.setEstimate(issue.id, undefined as unknown as null, "a")).code).toBe("validation");
    expect(store.getIssue(issue.id).estimatedSeconds).toBe(600);
    expect(estimateEvents(issue.id)).toHaveLength(0);
  });

  it("refuses an unknown issue as not_found", () => {
    expect(refusal(() => store.setEstimate("TST-999", 600, "a")).code).toBe("not_found");
  });

  it("any actor may re-estimate an issue another agent holds, and the claim stays theirs", () => {
    const issue = store.createIssue({ title: "Held by a" });
    store.checkoutIssue(issue.id, "agent-a");
    const result = store.setEstimate(issue.id, 3600, "orchestrator");
    expect(result.issue.checkoutAgent).toBe("agent-a");
    expect(estimateEvents(issue.id)).toEqual([
      { actor: "orchestrator", payload: JSON.stringify({ identifier: issue.identifier, from: null, to: 3600 }) },
    ]);
  });

  it("a resolved issue can be re-estimated, as a same-status write could, and stays resolved", () => {
    const issue = store.createIssue({ title: "Finished" });
    store.checkoutIssue(issue.id, "agent-a");
    const done = store.updateIssue(issue.id, { status: "done" }, "agent-a");
    const result = store.setEstimate(issue.id, 3600, "agent-a");
    expect(result.issue.status).toBe("done");
    expect(result.issue.completedAt).toBe(done.completedAt);
  });
});
