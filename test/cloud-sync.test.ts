/**
 * `staple cloud sync` — the engine.
 *
 * Contract: `docs/sync.md`, "Ordering, cursors and epochs". Every describe block
 * below is one of STA-72's acceptance criteria, in the order they are written.
 *
 * The service is `test/fixtures/fake-sync-server.ts`, which re-implements the
 * deployed Worker's semantics rather than agreeing with the client — including
 * the two that clients get wrong: reserved sequence slots leave GAPS, and a
 * `duplicate` carries the seq of the ORIGINAL application. It is handed in as a
 * `fetchImpl`, so nothing here touches a socket and the network-silence harness
 * has nothing to object to.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { syncRepository } from "../src/core/cloud/sync.js";
import { readSyncState } from "../src/core/cloud/sync-state.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";
const ENDPOINT = "https://sync.test.example";

let homes: string[] = [];
let stores: WorkspaceStore[] = [];
let server: FakeSyncServer;

interface Device {
  store: WorkspaceStore;
  home: string;
  deviceId: string;
  sync: (extra?: Record<string, unknown>) => Promise<ReturnType<typeof syncRepository> extends Promise<infer T> ? T : never>;
}

/**
 * A connected workspace on its own machine.
 *
 * Its own home, because all three consents are per-device and the credential is
 * machine-local by contract; two devices sharing a home would be one device.
 */
function device(deviceId: string, token: string): Device {
  const home = mkdtempSync(join(tmpdir(), `staple-sync-home-${deviceId}-`));
  homes.push(home);

  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  bindJournal(db, deviceId);
  const store = new WorkspaceStore(db, "test", "TST");
  stores.push(store);

  credentialStoreFor(home, "file").write(REPO_ID, token);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId,
    label: deviceId,
    credentialMechanism: "file",
    connectedAt: "2026-09-05T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 1,
  });
  server.enroll(deviceId, token);

  return {
    store,
    home,
    deviceId,
    sync: (extra = {}) =>
      syncRepository(store.db, REPO_ID, {
        home,
        fetchImpl: server.fetch,
        sleep: async () => undefined,
        ...extra,
      }),
  };
}

beforeEach(() => {
  server = new FakeSyncServer({ repositoryId: REPO_ID });
});

afterEach(() => {
  for (const store of stores) store.db.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  stores = [];
  homes = [];
});

function titles(store: WorkspaceStore): string[] {
  return (store.db.prepare("SELECT title FROM issues ORDER BY title").all() as Array<{
    title: string;
  }>).map((row) => row.title);
}

// ---------------------------------------------------------------- hydration

describe("a fresh clone hydrates from the same repository manifest", () => {
  it("gives the second device the first device's issues, descriptions and all", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({
      title: "Written on A",
      description: "and this description has to arrive",
      labels: ["alpha"],
      acceptanceCriteria: ["it converges"],
      createdBy: "agent-a",
    });
    await a.sync();

    // The second device is a fresh clone: same repository id, empty database.
    const b = device("device-b", "token-b");
    expect(titles(b.store)).toEqual([]);

    const report = await b.sync();

    expect(report.bootstrap).not.toBeNull();
    expect(report.bootstrap!.resumed).toBe(false);
    expect(titles(b.store)).toEqual(["Written on A"]);

    const hydrated = b.store.db
      .prepare("SELECT description, labels, acceptance_criteria, created_by FROM issues")
      .get() as {
      description: string;
      labels: string;
      acceptance_criteria: string;
      created_by: string;
    };
    expect(hydrated.description).toBe("and this description has to arrive");
    expect(JSON.parse(hydrated.labels)).toEqual(["alpha"]);
    expect(JSON.parse(hydrated.acceptance_criteria)).toEqual(["it converges"]);
    expect(hydrated.created_by).toBe("agent-a");
  });

  it("never copies a database file: everything that moved was an operation", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Operations only" });
    await a.sync();
    const b = device("device-b", "token-b");
    await b.sync();

    /**
     * The claim *"Sync never transports a database file — no `staple.db`, no
     * `-wal`, no `-shm`, no `VACUUM INTO` output"* is asserted structurally: the
     * only routes this engine ever calls are the four operation routes, and a
     * database file has no route to travel on.
     */
    expect([...new Set(server.calls)].sort()).toEqual([
      "GET /v1/capabilities",
      "GET /v1/repos/:id/ops",
      "GET /v1/repos/:id/snapshot",
      "POST /v1/repos/:id/ops",
    ]);
  });

  it("takes a stable cutoff and picks up concurrent writes from the tail", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Before the snapshot" });
    await a.sync();

    const b = device("device-b", "token-b");

    /**
     * A write that lands while B is bootstrapping. The snapshot cutoff is pinned
     * at the watermark B first saw, so this operation is in neither the snapshot
     * nor a page B has read — it is in the TAIL, and the tail cursor the snapshot
     * handed back is exactly where B looks next.
     */
    let injected = false;
    const watching: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      if (!injected && String(input).includes("/snapshot")) {
        injected = true;
        a.store.createIssue({ title: "During the snapshot" });
        await a.sync();
      }
      return response;
    };

    await b.sync({ fetchImpl: watching });
    expect(titles(b.store)).toEqual(["Before the snapshot", "During the snapshot"]);
  });
});

// ------------------------------------------------------------------- resume

describe("bootstrap and incremental sync resume from bounded opaque cursors", () => {
  it("resumes a bootstrap that was killed between pages", async () => {
    // Two entities per snapshot page, advertised by the service, so a six-issue
    // repository genuinely takes several pages to hydrate.
    server = new FakeSyncServer({ repositoryId: REPO_ID, maxSnapshotPageSize: 2 });
    const a = device("device-a", "token-a");
    for (let n = 0; n < 6; n += 1) a.store.createIssue({ title: `Issue ${n}` });
    await a.sync();

    const b = device("device-b", "token-b");

    // Die after the first snapshot page. The page that committed is durable and
    // so is the position; the rest of the bootstrap is not.
    let pages = 0;
    const dying: typeof fetch = async (input, init) => {
      if (String(input).includes("/snapshot")) {
        pages += 1;
        if (pages > 1) throw new Error("the process died here");
      }
      return server.fetch(input, init);
    };

    await expect(b.sync({ fetchImpl: dying, pullLimit: 2 })).rejects.toThrow();

    const midway = readSyncState(b.store.db)!;
    expect(midway.bootstrap, "an interrupted bootstrap records where it got to").not.toBeNull();
    expect(midway.cursor, "and does not pretend the incremental cursor is valid yet").toBeNull();
    expect(titles(b.store).length).toBeGreaterThan(0);
    expect(titles(b.store).length).toBeLessThan(6);

    const report = await b.sync();
    expect(report.bootstrap!.resumed).toBe(true);
    expect(titles(b.store)).toEqual(["Issue 0", "Issue 1", "Issue 2", "Issue 3", "Issue 4", "Issue 5"]);
  });

  it("resumes an incremental pull that was killed mid-drain", async () => {
    const a = device("device-a", "token-a");
    const b = device("device-b", "token-b");
    await b.sync();

    for (let n = 0; n < 5; n += 1) a.store.createIssue({ title: `Later ${n}` });
    await a.sync();

    let pages = 0;
    const dying: typeof fetch = async (input, init) => {
      if (String(input).includes("/ops?") && (init?.method ?? "GET") === "GET") {
        pages += 1;
        if (pages > 1) throw new Error("the process died here");
      }
      return server.fetch(input, init);
    };

    await expect(b.sync({ fetchImpl: dying, pullLimit: 2 })).rejects.toThrow();
    const midway = readSyncState(b.store.db)!;
    expect(midway.cursor).not.toBeNull();
    const partial = titles(b.store).length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(5);

    await b.sync();
    expect(titles(b.store)).toHaveLength(5);
  });

  it("treats the cursor as bytes: it is stored and replayed, never parsed", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "One" });
    await a.sync();
    const b = device("device-b", "token-b");
    await b.sync();

    const cursor = readSyncState(b.store.db)!.cursor!;
    // The client has no opinion about what is inside. The only thing asserted is
    // that whatever came back was kept whole — which is what replaying it needs.
    const seen: string[] = [];
    const capture: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const raw = url.searchParams.get("cursor");
      if (raw !== null) seen.push(raw);
      return server.fetch(input, init);
    };
    await b.sync({ fetchImpl: capture });
    expect(seen).toContain(cursor);
  });
});

// --------------------------------------------------------------------- push

describe("push is idempotent across a lost acknowledgement", () => {
  it("re-sends byte-identical operation ids and the service absorbs them", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Sent once, acknowledged never" });

    // The batch is accepted and the response is lost on the way back. The
    // operations are on the server; this device does not know it.
    const losing: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      if ((init?.method ?? "GET") === "POST") throw new Error("the acknowledgement was lost");
      return response;
    };
    await expect(a.sync({ fetchImpl: losing, attempts: 1 })).rejects.toThrow();

    const stillPending = a.store.db
      .prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL")
      .get() as { n: number };
    expect(stillPending.n, "nothing may be marked acknowledged on a lost response").toBeGreaterThan(0);

    const opsBefore = server.ops.length;
    const report = await a.sync();

    expect(report.pushed.duplicate).toBeGreaterThan(0);
    expect(report.pushed.applied).toBe(0);
    expect(server.ops.length, "the retry stored nothing new").toBe(opsBefore);
    expect(report.pending).toBe(0);
  });

  it("acknowledges a duplicate with the seq of its ORIGINAL application", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Original" });
    await a.sync();

    const original = a.store.db
      .prepare("SELECT op_id, acknowledged_seq FROM sync_outbox ORDER BY client_seq")
      .all() as Array<{ op_id: string; acknowledged_seq: number }>;

    // Force a replay: unacknowledge everything and push again.
    a.store.db.prepare("UPDATE sync_outbox SET acknowledged_seq = NULL").run();
    // Move the watermark on so a NEW seq would be obviously different.
    const b = device("device-b", "token-b");
    b.store.createIssue({ title: "Something else entirely" });
    await b.sync();

    await a.sync();
    const replayed = a.store.db
      .prepare("SELECT op_id, acknowledged_seq FROM sync_outbox ORDER BY client_seq")
      .all() as Array<{ op_id: string; acknowledged_seq: number }>;

    expect(replayed).toEqual(original);
  });

  it("sizes batches from what the service advertises, not from a constant", async () => {
    server = new FakeSyncServer({ repositoryId: REPO_ID, maxBatchSize: 3 });
    const a = device("device-a", "token-a");
    for (let n = 0; n < 7; n += 1) a.store.createIssue({ title: `Batched ${n}` });

    await a.sync();
    const pushes = server.calls.filter((call) => call === "POST /v1/repos/:id/ops").length;

    // Seven creates plus their ancestor recomputes, in batches of three. The
    // exact count depends on how many operations the mutations journal; what is
    // pinned is that it took MORE than one, which it only can if the client read
    // the advertised size rather than assuming 200.
    expect(pushes).toBeGreaterThan(1);
    expect(a.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL").get()).toEqual({
      n: 0,
    });
  });
});

// ---------------------------------------------------------------- gap safety

describe("seq is strictly increasing and gaps are legal", () => {
  it("applies a log whose sequence has holes without noticing them", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "First" });
    await a.sync();

    // Replay the same batch twice more. Each replay reserves slots for every
    // operation and uses none of them, so the log grows holes exactly the way a
    // real one does — the run that produced [1, 2, 3, 7, 9] against the deployed
    // service.
    a.store.db.prepare("UPDATE sync_outbox SET acknowledged_seq = NULL").run();
    await a.sync();
    a.store.db.prepare("UPDATE sync_outbox SET acknowledged_seq = NULL").run();
    await a.sync();

    a.store.createIssue({ title: "After the holes" });
    await a.sync();

    const seqs = server.ops.map((op) => op.seq).sort((x, y) => x - y);
    expect(seqs.length).toBeGreaterThan(1);
    const dense = seqs.every((seq, index) => index === 0 || seq === seqs[index - 1]! + 1);
    expect(dense, "the fixture must actually produce a gap or this test proves nothing").toBe(false);

    const b = device("device-b", "token-b");
    await b.sync();
    expect(titles(b.store)).toEqual(["After the holes", "First"]);

    // And the same is true incrementally, not only through a snapshot fold.
    const c = device("device-c", "token-c");
    await c.sync({ pullLimit: 1 });
    expect(titles(c.store)).toEqual(["After the holes", "First"]);
  });
});

// -------------------------------------------------------------------- epochs

describe("an epoch is a discontinuity, and it is never a silent reset", () => {
  it("re-bootstraps rather than replaying history into a live database", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Before the restore" });
    await a.sync();

    const b = device("device-b", "token-b");
    await b.sync();
    expect(titles(b.store)).toEqual(["Before the restore"]);

    // A restore. Non-truncating: the old operations stay in the log.
    server.bumpEpoch();
    const c = device("device-c", "token-c");
    c.store.createIssue({ title: "After the restore" });
    await c.sync();

    const report = await b.sync();
    expect(report.epoch).toBe(2);
    expect(report.bootstrap, "a superseded cursor forces a bootstrap").not.toBeNull();
    expect(titles(b.store)).toEqual(["After the restore", "Before the restore"]);
  });

  /**
   * The deadlock this guards against is silent, which is why it gets its own
   * test rather than being folded into the one above.
   *
   * Push runs before pull. A device with queued work whose epoch has moved gets
   * `epoch_changed` from the PUSH, and if that aborts the sync it never reaches
   * the pull that would have re-bootstrapped it. Every subsequent run does the
   * same thing. The repository becomes permanently unreachable from that device,
   * and the symptom is an error that reads like a transient one.
   */
  it("re-bootstraps when the epoch moves under a device that has work queued", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Before the restore" });
    await a.sync();

    const b = device("device-b", "token-b");
    await b.sync();

    // B goes offline, does work, and a restore happens while it is away.
    b.store.createIssue({ title: "Queued on B across a restore" });
    server.bumpEpoch();

    const report = await b.sync();

    expect(report.epoch).toBe(2);
    expect(report.bootstrap, "the push had to force one").not.toBeNull();
    expect(report.pending, "B's queued work reached the new epoch").toBe(0);
    expect(report.pushed.attempted).toBeGreaterThan(0);

    // And the other device sees it, which is the proof it was really pushed
    // rather than merely marked acknowledged.
    await a.sync();
    expect(titles(a.store)).toContain("Queued on B across a restore");
  });
});

// ------------------------------------------------------------------ refusals

describe("unsupported protocol and schema refuse before anything changes", () => {
  it("refuses a protocol outside the advertised range and sends nothing else", async () => {
    server = new FakeSyncServer({ repositoryId: REPO_ID, protocol: { min: 4, max: 9 } });
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Never sent" });

    await expect(a.sync()).rejects.toMatchObject({
      detail: { cloudCode: "protocol_unsupported", min: 4, max: 9 },
    });

    expect(server.calls).toEqual(["GET /v1/capabilities"]);
    expect(server.ops).toHaveLength(0);
    expect(
      a.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL").get(),
    ).toEqual({ n: 1 });
  });

  it("refuses a page stamped with a newer schema, whole, applying none of it", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "From the present" });
    await a.sync();

    // B is already hydrated, so its next sync is an incremental PULL — which is
    // the only path a schema stamp travels on. A snapshot is folded state and
    // carries none, so this refusal is a property of the tail.
    const b = device("device-b", "token-b");
    await b.sync();
    const settled = titles(b.store);
    const cursorBefore = readSyncState(b.store.db)!.cursor;

    // A device on a newer build writes an operation this one cannot apply.
    a.store.createIssue({ title: "Written under a newer schema" });
    await a.sync();
    for (const op of server.ops) op.schema = 99;

    await expect(b.sync()).rejects.toMatchObject({ detail: { cloudCode: "schema_ahead" } });

    // Nothing from that page landed, and the cursor did not move — so the next
    // sync, on an upgraded build, retries it rather than skipping it.
    expect(titles(b.store)).toEqual(settled);
    expect(readSyncState(b.store.db)!.cursor).toBe(cursorBefore);
  });
});

// -------------------------------------------------------------------- offline

describe("network failure is bounded and local work keeps working", () => {
  it("reports offline, changes nothing, and leaves the queue intact", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Queued while the link is down" });

    const dead: typeof fetch = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { name: "TypeError" });
    };

    await expect(a.sync({ fetchImpl: dead })).rejects.toMatchObject({
      detail: { cloudCode: "offline", retryable: true },
    });

    // The local database is the only read and write path, and it still is.
    const after = a.store.createIssue({ title: "And another, while still offline" });
    expect(after.title).toBe("And another, while still offline");
    expect(titles(a.store)).toEqual([
      "And another, while still offline",
      "Queued while the link is down",
    ]);
    expect(
      a.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL").get(),
    ).toEqual({ n: 2 });
  });

  it("retries a transient failure a bounded number of times and then gives up", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Rate limited" });

    server.failNext = {
      route: "POST /v1/repos/:id/ops",
      times: 2,
      status: 429,
      code: "rate_limited",
    };
    // Two failures then success, with three attempts allowed.
    await expect(a.sync({ attempts: 3 })).resolves.toMatchObject({ pending: 0 });

    const b = device("device-b", "token-b");
    b.store.createIssue({ title: "Rate limited for ever" });
    server.failNext = {
      route: "POST /v1/repos/:id/ops",
      times: 99,
      status: 503,
      code: "unavailable",
    };
    await expect(b.sync({ attempts: 2 })).rejects.toBeInstanceOf(StapleError);
  });

  it("does not retry a decision a human has to make", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "Forbidden" });
    server.failNext = {
      route: "POST /v1/repos/:id/ops",
      times: 99,
      status: 403,
      code: "forbidden",
    };

    await expect(a.sync({ attempts: 5 })).rejects.toMatchObject({
      detail: { cloudCode: "forbidden", retryable: false },
    });
    // One attempt, not five. Retrying a refusal turns one bad request into a
    // sustained one.
    expect(server.calls.filter((call) => call === "POST /v1/repos/:id/ops")).toHaveLength(1);
  });
});

// ------------------------------------------------------------------- consent

describe("sync is a consent that connect did not grant", () => {
  it("refuses on a workspace that has an identity but no connection record", async () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    writeStoredRepositoryId(db, REPO_ID);
    const store = new WorkspaceStore(db, "test", "TST");
    stores.push(store);
    const home = mkdtempSync(join(tmpdir(), "staple-sync-unconnected-"));
    homes.push(home);

    await expect(
      syncRepository(store.db, REPO_ID, { home, fetchImpl: server.fetch }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(server.calls, "an unconnected repository resolves no hostname").toEqual([]);
  });

  it("refuses when the database and the manifest name different repositories", async () => {
    const a = device("device-a", "token-a");
    // What a copied directory or a hand-edited manifest looks like: the database
    // believes it is one repository and the manifest names another.
    a.store.db
      .prepare("UPDATE sync_state SET repository_id = ? WHERE id = 1")
      .run("11111111-2222-4333-8444-555566667777");

    await expect(a.sync()).rejects.toMatchObject({ code: "conflict" });
    expect(server.calls, "nothing is contacted before the identity is checked").toEqual([]);
  });
});
