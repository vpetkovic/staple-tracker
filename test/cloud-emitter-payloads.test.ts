/**
 * STA-262: every payload a real emitter puts on the wire is a JSON object, and the
 * service refuses one that is not.
 *
 * `worker/src/envelope.ts` used to admit an array payload, because `typeof [] ===
 * "object"`, while `fold.ts` described it as admitting only the ordered-collection shapes.
 * The array was stored, took a sequence number and folded into nothing. The fix refuses
 * every payload that is not a JSON object — and a refusal is only safe if no legitimate
 * emitter sends one. This file is how that is known rather than assumed.
 *
 * It DRIVES THE EMITTERS. Nothing below writes a payload by hand: a workspace with history
 * from before it was connected (the seed), then every journaled mutation the store, the
 * milestone, project and queue stores, the lease claim and the conflict resolver make —
 * including the three verbs a resolution can emit (`update`, `replace`, `renumber`) —
 * each pushed by the real sync engine into `test/fixtures/fake-sync-server.ts`, which
 * refuses exactly what the Worker refuses. What the fake stored is what the client sent.
 *
 * One payload per entity and verb is then recorded in `worker/test/emitted-payloads.ts`,
 * and `worker/test/push.test.ts` pushes every one of those through the real Worker. The
 * record is compared here, so it cannot drift from what the emitters actually send:
 * change an emitter's payload and this test names what to regenerate.
 *
 *     STAPLE_WRITE_EMITTED_PAYLOADS=1 npx vitest run test/cloud-emitter-payloads.test.ts
 *
 * The hub registry's two entities are the other emitter family, and they already travel
 * this path: `test/cloud-hub-registry-wire.test.ts` asserts the client emits
 * `worker/test/registry-fixture.ts`'s `FIXTURE_OPS`, and `worker/test/registry.test.ts`
 * pushes those through the real Worker.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { acquireClaim, releaseClaim } from "../src/core/cloud/lease.js";
import { syncRepository, type SyncReport } from "../src/core/cloud/sync.js";
import { EMITTED_PAYLOADS } from "../worker/test/emitted-payloads.js";
import { payloadRefusal } from "../worker/test/payload-fixture.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";
const ENDPOINT = "https://sync.test.example";
const FIXTURE = join(process.cwd(), "worker", "test", "emitted-payloads.ts");

let homes: string[] = [];
let stores: WorkspaceStore[] = [];

afterEach(() => {
  for (const store of stores) store.db.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  stores = [];
  homes = [];
});

interface Device {
  readonly store: WorkspaceStore;
  readonly home: string;
  readonly sync: () => Promise<SyncReport>;
  readonly lease: { home: string; fetchImpl: typeof fetch };
}

/**
 * A connected workspace on its own machine. `armed: false` leaves the journal unbound, so
 * what is written before {@link arm} is history the SEED sends, not the seam.
 */
function device(server: FakeSyncServer, deviceId: string, armed = true): Device & { arm: () => void } {
  const home = mkdtempSync(join(tmpdir(), `staple-emit-${deviceId}-`));
  homes.push(home);
  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  bindJournal(db, armed ? deviceId : null);
  const store = new WorkspaceStore(db, "test", "TST");
  stores.push(store);

  credentialStoreFor(home, "file").write(REPO_ID, `token-${deviceId}`);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId,
    label: deviceId,
    credentialMechanism: "file",
    connectedAt: "2026-09-10T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 1,
  });
  server.enroll(deviceId, `token-${deviceId}`);

  return {
    store,
    home,
    arm: () => bindJournal(db, deviceId),
    lease: { home, fetchImpl: server.fetch },
    sync: () =>
      syncRepository(db, REPO_ID, { home, fetchImpl: server.fetch, sleep: async () => undefined }),
  };
}

/**
 * A clock tick between two writes. The journal sends what a write changed (`journal.ts`, the
 * row diff), and a milestone's `updated_at` written in the same millisecond as before is no
 * change — so without this the recorded payloads below would depend on how fast the suite ran.
 */
function later(): void {
  const until = Date.now() + 2;
  while (Date.now() < until) {
    /* a millisecond or two */
  }
}

/** Everything the workspace client can journal, in one place so a new emitter lands here. */
function exerciseTheSeam(store: WorkspaceStore): void {
  const actor = "emitter";

  // Issues: create (every field), update, the blocker set, comments, documents.
  const epic = store.createIssue({
    title: "Epic",
    description: "with a description",
    kind: "epic",
    priority: "high",
    labels: ["alpha", "beta"],
    acceptanceCriteria: ["it converges"],
    estimatedSeconds: 3600,
    createdBy: actor,
  });
  const child = store.createChild(epic.identifier, { title: "Child", assignee: actor });
  const blocker = store.createIssue({ title: "Blocker" });
  store.updateIssue(child.identifier, { title: "Child, renamed", priority: "low", labels: [] }, actor);
  store.setBlockedBy(child.identifier, [blocker.identifier], actor);
  store.setBlockedBy(child.identifier, [], actor);
  store.addComment(child.identifier, "a comment", actor, "agent");
  store.putDocument(child.identifier, "plan", "# plan\n", { author: actor, title: "Plan" });
  store.putDocument(child.identifier, "plan", "# plan, v2\n", { author: actor, baseRevision: 1 });
  store.checkoutIssue(blocker.identifier, actor);
  store.releaseIssue(blocker.identifier, actor);
  store.gateIssue(epic.identifier, { owner: "vp", comment: "please look" }, actor);
  store.approveGate(epic.identifier, { comment: "approved" }, "vp");

  // The vocabularies and settings.
  store.addStatus({ id: "triage", category: "unstarted" }, actor);
  store.renameStatus("triage", "Triage", actor);
  store.recategorizeStatus("triage", "ready", actor);
  store.reorderStatuses(store.getStatuses().map((status) => status.id).reverse(), actor);
  store.removeStatus("triage", {}, actor);
  store.addKind({ id: "experiment" }, actor);
  store.renameKind("experiment", "Experiment", actor);
  store.reorderKinds(store.getKinds().map((kind) => kind.id).reverse(), actor);
  store.removeKind("experiment", {}, actor);
  store.setSetting("queue.policy", "strict", actor);
  store.resetSetting("queue.policy", actor);

  // Projects.
  const project = store.projects().create({ name: "Project" }, actor);
  store.projects().update(project.id, { name: "Project, renamed" }, actor);
  store.projects().assign(child.identifier, project.id, actor);
  store.projects().remove(project.id, actor);

  // Milestones: dates, and every membership mutator (each replicates as the whole list).
  const milestone = store.milestones().create({ title: "M1", targetDate: "2026-12-01" }, actor);
  const milestoneRef = milestone.preview ? "" : milestone.milestone.identifier;
  later();
  store.milestones().update(milestoneRef, { startDate: "2026-10-01" }, actor);
  later();
  store.milestones().addMember(milestoneRef, epic.identifier, {}, actor);
  later();
  store.milestones().addMember(milestoneRef, blocker.identifier, {}, actor);
  later();
  store.milestones().reorderMembers(milestoneRef, [blocker.identifier, epic.identifier], {}, actor);
  later();
  store.milestones().removeMember(milestoneRef, blocker.identifier, {}, actor);
  // From an epic: the dates and the membership land in ONE scope, so the journal
  // coalesces them into one `replace` carrying both (`mergeVerb`).
  const second = store.createIssue({ title: "Second epic", kind: "epic" });
  store.milestones().create({ title: "M2", fromEpic: second.identifier, targetDate: "2027-01-01" }, actor);

  // The plan: every queue mutator, each of which replicates as the whole order.
  const queue = store.queue();
  queue.enqueue(epic.identifier, {}, actor);
  queue.enqueue(blocker.identifier, {}, actor);
  queue.reorder(queue.entries().map((entry) => entry.identifier).reverse(), {}, actor);
  queue.dequeue(blocker.identifier, {}, actor);
}

/** A workspace's history from before it was connected: what the seed reads. */
function history(store: WorkspaceStore): void {
  const epic = store.createIssue({ title: "Old epic", kind: "epic", labels: ["old"] });
  const child = store.createChild(epic.identifier, { title: "Old child" });
  const blocker = store.createIssue({ title: "Old blocker" });
  store.setBlockedBy(child.identifier, [blocker.identifier], "past");
  store.addComment(child.identifier, "an old comment", "past");
  store.putDocument(child.identifier, "notes", "old notes", { author: "past" });
  store.addStatus({ id: "parked", category: "blocked" }, "past");
  store.addKind({ id: "research" }, "past");
  store.addKind({ id: "milestone", label: "Milestone" }, "past");
  store.reorderStatuses(store.getStatuses().map((status) => status.id).reverse(), "past");
  store.setSetting("kinds.default", "research", "past");
  const project = store.projects().create({ name: "Old project" }, "past");
  store.projects().assign(child.identifier, project.id, "past");
  const milestone = store.milestones().create({ title: "Old milestone", startDate: "2026-01-01" }, "past");
  const ref = milestone.preview ? "" : milestone.milestone.identifier;
  later();
  store.milestones().addMember(ref, epic.identifier, {}, "past");
  store.queue().enqueue(child.identifier, {}, "past");
}

/**
 * The scenario. Returns what the service stored, which is exactly what the client sent:
 * the fake refuses a non-object payload, so an emitter sending one fails the sync here.
 */
async function everythingTheClientSends(): Promise<FakeSyncServer> {
  const server = new FakeSyncServer({ repositoryId: REPO_ID });
  // Lease payloads carry server time. A fixed clock keeps the recorded ones comparable.
  server.now = () => Date.parse("2026-09-10T12:00:00.000Z");

  // A: history first, then connected — the seed — then every seam emitter.
  const a = device(server, "device-a", false);
  history(a.store);
  a.arm();
  await a.sync();
  exerciseTheSeam(a.store);
  await a.sync();

  // A lease claim and its release, through the real lease path.
  const claimable = a.store.createIssue({ title: "Claimable" });
  await a.sync();
  await acquireClaim(a.store, REPO_ID, claimable.identifier, "emitter", a.lease);
  await releaseClaim(a.store, REPO_ID, claimable.identifier, a.lease);
  await a.sync();

  // B joins, and the two diverge on a field, on the plan and on an identifier.
  const b = device(server, "device-b");
  await b.sync();
  const contested = a.store.createIssue({ title: "Contested" });
  a.store.queue().enqueue(contested.identifier, {}, "a");
  await a.sync();
  await b.sync();
  a.store.updateIssue(contested.identifier, { title: "Title from A" }, "a");
  b.store.updateIssue(contested.identifier, { title: "Title from B" }, "b");
  const planA = a.store.queue().entries().map((entry) => entry.identifier);
  a.store.queue().reorder([...planA].reverse(), {}, "a");
  b.store.queue().dequeue(contested.identifier, {}, "b");
  a.store.createIssue({ title: "Created offline on A" });
  b.store.createIssue({ title: "Created offline on B" });
  await a.sync();
  await b.sync();
  await a.sync();

  // Every conflict A holds, settled — which journals the settled entity under the
  // resolution's own verb, and the `conflict` record itself. The two issues created offline
  // under one number are not among them: the device whose claim landed second renumbered
  // its own (`src/core/cloud/claims.ts`), and that `issue.renumber` is in what was sent.
  const open = listConflicts(a.store.db).filter((conflict) => conflict.resolvedAt === null);
  expect(open.map((conflict) => conflict.field).sort()).toEqual(["order", "title"]);
  // In a fixed order: the record keeps the first payload per entity and verb, and two
  // conflict ids are hashes that sort differently from run to run.
  for (const conflict of [...listConflicts(a.store.db)].sort((x, y) => x.field.localeCompare(y.field))) {
    if (conflict.resolvedAt !== null) continue;
    resolveConflict(a.store.db, { id: conflict.id, choice: "remote", actor: "vp" });
  }
  await a.sync();
  await b.sync();
  return server;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Replace the values that differ run to run — minted ids and wall-clock times. */
function stable(value: unknown): unknown {
  if (typeof value === "string") {
    if (UUID.test(value)) return "00000000-0000-4000-8000-000000000000";
    if (ISO.test(value)) return "2026-09-10T00:00:00.000Z";
    return value;
  }
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    // Keys too: a plan's `entries` is keyed by issue id. Numbered in order of appearance,
    // so two ids stay two keys.
    let n = 0;
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        UUID.test(key) ? `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}` : key,
        stable(inner),
      ]),
    );
  }
  return value;
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("every payload a real emitter sends is a JSON object", () => {
  it("drives every emitter through the real client into the fake, and every payload is an object", async () => {
    const server = await everythingTheClientSends();

    const notObjects = server.ops.filter((op) => !isPlainObject(op.payload));
    expect(notObjects).toEqual([]);

    // The ones the ticket is about are all here, carrying their list under a KEY.
    const combos = new Set(server.ops.map((op) => `${op.entity}.${op.verb}`));
    for (const combo of ["queue.replace", "milestone.replace", "relation.update", "issue.renumber"]) {
      expect(combos, combo).toContain(combo);
    }
    const listKey = (combo: string) =>
      server.ops
        .filter((op) => `${op.entity}.${op.verb}` === combo)
        .map((op) => Object.keys(op.payload as Record<string, unknown>).sort().join(","));
    // The plan's order, with who queued each entry, when and why beside it — a conflict
    // resolution too, from the side it chose (conflicts.ts, "the entries a plan record keeps").
    expect(new Set(listKey("queue.replace"))).toEqual(new Set(["entries,order"]));
    // A blocker set, with who made each edge and when beside it.
    expect(new Set(listKey("relation.update"))).toEqual(new Set(["blockedBy,edges"]));
    expect(listKey("status.update")).toContain("order");
    expect(listKey("kind.update")).toContain("order");
    expect(listKey("milestone.replace").every((keys) => keys.split(",").includes("members"))).toBe(true);
    // And a `replace` is not only its collection: a milestone made from an epic journals
    // its dates and its membership in one scope, coalesced into one `replace`. The fold
    // merges the other keys like any verb's (worker/src/fold.ts).
    // And when it last changed (the row diff, `journal.ts`).
    expect(listKey("milestone.replace")).toContain("entries,members,startDate,targetDate,updatedAt");
  }, 60_000);

  it("matches the record the Worker suite pushes, one payload per entity and verb", async () => {
    const server = await everythingTheClientSends();

    const recorded: Array<{ entity: string; verb: string; payload: unknown }> = [];
    const seen = new Set<string>();
    for (const op of server.ops) {
      const combo = `${op.entity}.${op.verb}`;
      if (seen.has(combo)) continue;
      seen.add(combo);
      recorded.push({ entity: op.entity, verb: op.verb, payload: stable(op.payload) });
    }
    recorded.sort((x, y) => `${x.entity}.${x.verb}`.localeCompare(`${y.entity}.${y.verb}`));

    if (process.env.STAPLE_WRITE_EMITTED_PAYLOADS === "1") {
      const header = readFileSync(FIXTURE, "utf8").split("export const EMITTED_PAYLOADS")[0];
      writeFileSync(
        FIXTURE,
        `${header}export const EMITTED_PAYLOADS: ReadonlyArray<{\n  entity: string;\n  verb: string;\n` +
          `  payload: Record<string, unknown>;\n}> = ${JSON.stringify(recorded, null, 2)};\n`,
      );
      // The module above was imported before this rewrote it; the next run compares.
      return;
    }

    expect(
      EMITTED_PAYLOADS,
      "worker/test/emitted-payloads.ts no longer matches what the emitters send. Regenerate it " +
        "with STAPLE_WRITE_EMITTED_PAYLOADS=1 npx vitest run test/cloud-emitter-payloads.test.ts, " +
        "then run `npm run test:worker` so the Worker proves it still accepts them.",
    ).toEqual(recorded);
  }, 60_000);
});

describe("the fake refuses an array payload exactly as the Worker does", () => {
  /** A push shaped as the client shapes it, straight at the fake. */
  async function push(server: FakeSyncServer, ops: Record<string, unknown>[]) {
    const response = await server.fetch(`${ENDPOINT}/v1/repos/${REPO_ID}/ops`, {
      method: "POST",
      headers: { "Staple-Protocol": "1", Authorization: "Bearer token-x", "Staple-Device": "device-x" },
      body: JSON.stringify({ protocol: 1, deviceId: "device-x", ops }),
    });
    return { status: response.status, body: await response.json() };
  }

  function op(clientSeq: number, over: Record<string, unknown>): Record<string, unknown> {
    return {
      opId: `op-${clientSeq}`,
      repoId: REPO_ID,
      protocol: 1,
      schema: 10,
      entity: "issue",
      entityId: "issue-1",
      verb: "update",
      baseVersion: 1,
      payload: { status: "done" },
      deviceId: "device-x",
      actor: "x",
      clientSeq,
      createdAt: "2026-09-10T00:00:00.000Z",
      ...over,
    };
  }

  it("refuses it for every verb, names the operation, and stores nothing", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    server.enroll("device-x", "token-x");

    const arrays = [
      { entity: "queue", entityId: "queue", verb: "replace", payload: ["issue-1"] },
      { entity: "milestone", entityId: "m-1", verb: "replace", payload: [] },
      { entity: "issue", verb: "create", baseVersion: null, payload: [{ title: "t" }] },
      { entity: "issue", verb: "update", payload: ["status", "done"] },
      { entity: "issue", verb: "renumber", payload: ["TST-2"] },
      { entity: "issue", verb: "delete", payload: [] },
    ];
    for (const [index, shape] of arrays.entries()) {
      expect(await push(server, [op(index + 1, shape)])).toEqual(payloadRefusal(0));
    }
    expect(await push(server, [op(10, {}), op(11, { payload: ["a"] })])).toEqual(payloadRefusal(1));
    for (const payload of [null, "a string", 7]) {
      expect(await push(server, [op(20, { payload })])).toEqual(payloadRefusal(0));
    }

    expect(server.ops).toEqual([]);
    expect(server.lastSeq).toBe(0);
  });
});
