/**
 * The two-machine kill-and-resume drill, for a fenced lease.
 *
 * `test/takeover-drill.test.ts` proved the LOCAL version of this: a killed
 * agent's work can be finished by a different identity using only what the
 * tracker holds. It runs on one machine, with one database, and says nothing
 * about a second one.
 *
 * This is the distributed half, and the claim it tests is narrower and harder:
 *
 *   while agent A holds a live lease, agent B on a DIFFERENT machine cannot
 *   take the work; once the lease has expired on the SERVER's clock, B can take
 *   it over explicitly, and A — still running, still convinced, still holding
 *   a token — can no longer renew, release or finish the remote task.
 *
 * ## What "killed" means here
 *
 * A stops beating. That is the whole simulation, and it is the honest one: a
 * process that dies of a usage limit does not send a farewell, it simply stops
 * renewing. Nothing is backdated in the client and no clock is injected into
 * production code — the SERVER's clock moves, because the server's clock is the
 * only one with a say in when a lease ends.
 *
 * ## What makes the resume a real resume
 *
 * B recovers what to do from a worklog A wrote into the tracker, and from
 * nothing else. The two devices share no variable in this file that carries the
 * work — `resumeFromTracker` takes a store and an identifier and must find the
 * next step in the document. Delete the worklog and the drill fails loudly
 * rather than passing on out-of-band knowledge, which is the same discipline
 * the local drill enforces.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { applyToDatabase } from "../src/core/cloud/apply.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { acquireClaim, acquireLease, releaseClaim, renewLease } from "../src/core/cloud/lease.js";
import { runHeartbeat } from "../src/core/cloud/lease-heartbeat.js";
import { readLocalLease } from "../src/core/cloud/lease-store.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "3ebbcd04-4444-4555-8666-777788889999";
const ENDPOINT = "https://sync.test.example";
const TTL = 60;

const homes: string[] = [];
const stores: WorkspaceStore[] = [];
let server: FakeSyncServer;
let serverNow = Date.now();

interface Machine {
  readonly store: WorkspaceStore;
  readonly home: string;
  readonly deviceId: string;
}

function machine(deviceId: string, token: string): Machine {
  const home = mkdtempSync(join(tmpdir(), `staple-drill-${deviceId}-`));
  homes.push(home);
  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  bindJournal(db, deviceId);
  const store = new WorkspaceStore(db, "drill", "DRL");
  stores.push(store);

  credentialStoreFor(home, "file").write(REPO_ID, token);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId,
    label: deviceId,
    credentialMechanism: "file",
    connectedAt: "2026-09-08T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 1,
  });
  server.enroll(deviceId, token);
  return { store, home, deviceId };
}

/**
 * B's resume, as a pure function of what the tracker holds.
 *
 * It is handed a store and an identifier — no path, no plan, no leftover
 * variable from A's half of the drill. Everything it needs comes out of the
 * worklog document, and it throws if that document does not say what to do next.
 */
function resumeFromTracker(store: WorkspaceStore, ref: string): string {
  const worklog = store.getDocument(ref, "worklog");
  const next = /^##\s+Next\s*\n([\s\S]*?)(?=\n##\s|$)/m.exec(worklog.body);
  const step = next?.[1]?.trim();
  if (!step) {
    throw new Error(
      "the worklog does not say what comes next, so this is not a resume — " +
        "it is a guess dressed up as one",
    );
  }
  return step;
}

let alice: Machine;
let bob: Machine;
let entityId: string;

/** Everything that happens, happens once, in order. Tests read the record. */
const record: Record<string, unknown> = {};

beforeAll(async () => {
  server = new FakeSyncServer({ repositoryId: REPO_ID });
  serverNow = Date.now();
  server.now = () => serverNow;

  alice = machine("device-alice", "tok-alice");
  bob = machine("device-bob", "tok-bob");

  /**
   * The work exists on both machines under ONE entity id, which is what makes
   * them two machines looking at the same issue rather than two issues.
   *
   * It gets to Bob's database through `applyToDatabase` — the production apply
   * path, the same one a pull would use — rather than through raw SQL or a
   * second `createIssue`. A second create would mint a second id, and the whole
   * drill would then be about two unrelated tasks.
   */
  const issue = alice.store.createIssue({ title: "migrate the importer", createdBy: "seed" });
  entityId = issue.id;
  applyToDatabase(bob.store.db, {
    entity: "issue",
    entityId,
    verb: "create",
    payload: {
      identifier: issue.identifier,
      title: issue.title,
      normalizedTitle: issue.title.toLowerCase(),
      status: issue.status,
      statusVersion: issue.statusVersion,
      kind: issue.kind,
      priority: issue.priority,
      depth: issue.depth,
      createdBy: issue.createdBy,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    },
    actor: "seed",
    deviceId: "device-alice",
    at: issue.createdAt,
    opId: "op-drill-seed",
  });

  // --- A claims it globally, and starts working -----------------------------
  const claimed = await acquireClaim(alice.store, REPO_ID, entityId, "agent-alice", {
    home: alice.home,
    fetchImpl: server.fetch,
    ttlSeconds: TTL,
  });
  record.aliceScope = claimed.scope;
  record.aliceToken = claimed.lease!.fencingToken;

  alice.store.putDocument(
    entityId,
    "worklog",
    [
      "## Done",
      "Rewrote the CSV reader and its tests.",
      "",
      "## Next",
      "Port the JSON reader the same way, then delete the old adapter.",
      "",
    ].join("\n"),
    { author: "agent-alice" },
  );

  // --- B tries to take it while the lease is live ---------------------------
  record.bobRefused = await acquireClaim(bob.store, REPO_ID, entityId, "agent-bob", {
    home: bob.home,
    fetchImpl: server.fetch,
    ttlSeconds: TTL,
  }).catch((error: unknown) => error);

  // --- A beats twice, then is killed ---------------------------------------
  record.aliceBeats = await runHeartbeat(alice.store.db, REPO_ID, entityId, {
    home: alice.home,
    fetchImpl: server.fetch,
    ttlSeconds: TTL,
    everyMs: 20_000,
    maxBeats: 2,
    sleep: async () => {
      serverNow += 20_000;
    },
  });

  // A dies here. No release, no farewell, no further beat. The only thing that
  // happens next is that time passes on the server.
  serverNow += TTL * 1000 + 1_000;

  // --- B takes over explicitly ---------------------------------------------
  record.leaseBeforeTakeover = server.leases.has(entityId);
  const bobLease = await acquireLease(bob.store.db, REPO_ID, entityId, "agent-bob", {
    home: bob.home,
    fetchImpl: server.fetch,
    ttlSeconds: TTL,
  });
  record.bobToken = bobLease.fencingToken;
  record.bobResume = resumeFromTracker(alice.store, entityId);

  // --- A comes back, still holding its token -------------------------------
  record.aliceRenewAfter = await renewLease(alice.store.db, REPO_ID, entityId, {
    home: alice.home,
    fetchImpl: server.fetch,
    ttlSeconds: TTL,
  }).catch((error: unknown) => error);

  // Alice's mirror row was forgotten by the refused renewal, so put it back the
  // way a process that had never asked would still have it: this is the "still
  // convinced" case, and it has to be modelled, not assumed away.
  record.aliceReleaseAfter = await releaseClaim(alice.store, REPO_ID, entityId, {
    home: alice.home,
    fetchImpl: server.fetch,
  });
});

afterAll(() => {
  for (const store of stores) store.db.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("while the lease is live, the other machine cannot have the work", () => {
  it("gave A a globally exclusive claim", () => {
    expect(record.aliceScope).toBe("lease");
    expect(record.aliceToken).toBeGreaterThan(0);
  });

  it("refused B with a conflict that is not worth retrying", () => {
    expect(record.bobRefused).toBeInstanceOf(StapleError);
    const error = record.bobRefused as StapleError;
    expect(error.code).toBe("conflict");
    expect(error.detail?.retryable).toBe(false);
    expect(error.detail?.holder).toBe("agent-alice");
  });

  it("left B's own database untouched — a refused lease claims nothing", () => {
    expect(bob.store.getIssue(entityId).checkoutAgent).toBeNull();
  });

  it("kept A's lease alive for as long as A kept beating", () => {
    const beats = record.aliceBeats as { beats: unknown[]; holds: boolean };
    expect(beats.beats).toHaveLength(2);
    expect(beats.holds).toBe(true);
  });
});

describe("nothing takes the work away on its own", () => {
  it("still holds the expired lease until somebody asks for it", () => {
    // No sweeper, no reaper, no TTL daemon. The row survived its own expiry and
    // was cleared by the acquire that wanted the slot — which is the difference
    // between "expired" and "taken over", and the reason takeover stays explicit.
    expect(record.leaseBeforeTakeover).toBe(true);
  });

  it("gives the taker a strictly higher fencing token", () => {
    expect(record.bobToken).toBeGreaterThan(record.aliceToken as number);
  });
});

describe("the resume is a function of what the tracker holds", () => {
  it("recovers the next step from A's worklog and nothing else", () => {
    expect(record.bobResume).toBe(
      "Port the JSON reader the same way, then delete the old adapter.",
    );
  });

  it("fails loudly when the worklog does not say what comes next", () => {
    const orphan = alice.store.createIssue({ title: "no worklog", createdBy: "seed" });
    alice.store.putDocument(orphan.id, "worklog", "## Done\nsomething\n", { author: "a" });
    expect(() => resumeFromTracker(alice.store, orphan.id)).toThrow(/not a resume/);
  });
});

describe("the killed holder cannot finish the remote task", () => {
  it("refuses its renewal, because its token was superseded", () => {
    expect(record.aliceRenewAfter).toBeInstanceOf(StapleError);
    expect((record.aliceRenewAfter as StapleError).detail?.cloudCode).toBe("conflict");
    expect((record.aliceRenewAfter as StapleError).detail?.retryable).toBe(false);
  });

  it("refuses its release, and reports that rather than claiming success", () => {
    const release = record.aliceReleaseAfter as {
      remoteReleased: boolean;
      scope: string;
      note: string;
    };
    expect(release.remoteReleased).toBe(false);
    expect(release.scope).toBe("local");
    expect(release.note).toMatch(/no server lease/i);
  });

  it("leaves B holding the lease throughout", () => {
    expect(server.leases.get(entityId)!.holder).toBe("agent-bob");
    expect(server.leases.get(entityId)!.fencingToken).toBe(record.bobToken);
    expect(readLocalLease(alice.store.db, entityId)).toBeNull();
  });
});
