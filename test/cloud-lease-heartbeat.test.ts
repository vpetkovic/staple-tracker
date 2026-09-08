/**
 * The heartbeat: bounded, observable, and with no clock authority.
 *
 * Contract: `docs/sync.md` — *"Renewal is a bounded, observable heartbeat."*
 *
 * The distinction every test here holds: **the client's timer decides when to
 * ask; the server decides whether the lease still exists.** So the loop is
 * bounded by a beat count and a wall budget (both the client's business), and it
 * stops on a `conflict` (entirely the server's business) without ever comparing
 * a stored expiry against a local clock to reach that conclusion itself.
 *
 * `sleep` is injected and resolves immediately, so a suite that exercises fifty
 * beats takes no longer than one.
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
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { acquireLease } from "../src/core/cloud/lease.js";
import { runHeartbeat } from "../src/core/cloud/lease-heartbeat.js";
import { readLocalLease } from "../src/core/cloud/lease-store.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "2d99ac03-3333-4444-8555-666677778888";
const ENDPOINT = "https://sync.test.example";
const DEVICE = "device-beat";

let home: string;
let store: WorkspaceStore;
let server: FakeSyncServer;
let entityId: string;

const nowait = async (): Promise<void> => undefined;

beforeEach(async () => {
  server = new FakeSyncServer({ repositoryId: REPO_ID });
  home = mkdtempSync(join(tmpdir(), "staple-beat-home-"));

  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  bindJournal(db, DEVICE);
  store = new WorkspaceStore(db, "test", "TST");

  credentialStoreFor(home, "file").write(REPO_ID, "tok-beat");
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId: DEVICE,
    label: "beat",
    credentialMechanism: "file",
    connectedAt: "2026-09-08T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 1,
  });
  server.enroll(DEVICE, "tok-beat");

  entityId = store.createIssue({ title: "long work", createdBy: "seed" }).id;
  await acquireLease(store.db, REPO_ID, entityId, "agent-a", {
    home,
    fetchImpl: server.fetch,
    ttlSeconds: 60,
  });
});

afterEach(() => {
  store.db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("bounded", () => {
  it("stops at the beat count it was given, and reports why", async () => {
    const report = await runHeartbeat(store.db, REPO_ID, entityId, {
      home,
      fetchImpl: server.fetch,
      everyMs: 1_000,
      maxBeats: 4,
      sleep: nowait,
    });

    expect(report.beats).toHaveLength(4);
    expect(report.stopped).toBe("beats");
    expect(report.holds).toBe(true);
    expect(report.beats.every((beat) => beat.outcome === "renewed")).toBe(true);
  });

  it("stops when the wall budget is spent, however many beats are left", async () => {
    // The injected clock advances only when the loop consults it, so the budget
    // is exhausted deterministically rather than by racing a real timer.
    let clock = 0;
    const report = await runHeartbeat(store.db, REPO_ID, entityId, {
      home,
      fetchImpl: server.fetch,
      everyMs: 1_000,
      maxBeats: 1_000,
      budgetMs: 3_000,
      sleep: async () => {
        clock += 1_000;
      },
      now: () => clock,
    });

    expect(report.stopped).toBe("budget");
    expect(report.beats.length).toBeLessThan(1_000);
    expect(report.beats.length).toBeGreaterThan(0);
  });

  it("has a bound even when the caller names neither one", async () => {
    const report = await runHeartbeat(store.db, REPO_ID, entityId, {
      home,
      fetchImpl: server.fetch,
      everyMs: 1_000,
      sleep: nowait,
    });
    // The point is not the number; it is that the loop terminates on its own.
    expect(report.beats.length).toBeGreaterThan(0);
    expect(["beats", "budget"]).toContain(report.stopped);
  });
});

describe("observable", () => {
  it("reports every beat as it happens, with the server's expiry on each", async () => {
    const seen: string[] = [];
    let serverNow = Date.now();
    server.now = () => serverNow;

    const report = await runHeartbeat(store.db, REPO_ID, entityId, {
      home,
      fetchImpl: server.fetch,
      everyMs: 1_000,
      maxBeats: 3,
      ttlSeconds: 60,
      sleep: async () => {
        serverNow += 1_000;
      },
      onBeat: (beat) => seen.push(`${beat.n}:${beat.outcome}`),
    });

    expect(seen).toEqual(["1:renewed", "2:renewed", "3:renewed"]);
    const expiries = report.beats.map((beat) => beat.serverExpiresAt);
    expect(new Set(expiries).size).toBe(3);
    // Each beat's expiry is the one the SERVER stated on that beat.
    expect(Date.parse(expiries[2]!)).toBe(server.leases.get(entityId)!.expiresAt);
  });
});

describe("it never claims authority the server did not give it", () => {
  it("stops the moment a renewal is refused, and forgets the lease", async () => {
    let serverNow = Date.now();
    server.now = () => serverNow;

    const report = await runHeartbeat(store.db, REPO_ID, entityId, {
      home,
      fetchImpl: server.fetch,
      everyMs: 1_000,
      maxBeats: 10,
      ttlSeconds: 60,
      // The gap between beats is longer than the TTL, so the lease expires on
      // the server before the second beat asks for it. The server's clock is
      // the one that moved; this machine's was never touched.
      sleep: async () => {
        serverNow += 61_000;
      },
    });

    expect(report.stopped).toBe("refused");
    expect(report.holds).toBe(false);
    expect(report.beats.map((beat) => beat.outcome)).toEqual(["renewed", "refused"]);
    expect(readLocalLease(store.db, entityId)).toBeNull();
  });

  it("keeps beating through an unreachable service — offline is not eviction", async () => {
    let calls = 0;
    const flaky: typeof fetch = (async (input, init) => {
      calls += 1;
      if (calls === 2) throw new TypeError("fetch failed");
      return server.fetch(input as string, init);
    }) as typeof fetch;

    const report = await runHeartbeat(store.db, REPO_ID, entityId, {
      home,
      fetchImpl: flaky,
      everyMs: 1_000,
      maxBeats: 3,
      sleep: nowait,
    });

    expect(report.beats.map((beat) => beat.outcome)).toEqual([
      "renewed",
      "offline",
      "renewed",
    ]);
    // A service this device could not reach says nothing about who holds the
    // lease. The mirror row survives, and so does the loop.
    expect(report.stopped).toBe("beats");
    expect(readLocalLease(store.db, entityId)).not.toBeNull();
  });

  it("renews even when this machine's clock says the lease is long dead", async () => {
    // The server is an hour behind, so every expiry it hands back is already in
    // the past by this machine's reckoning. A client that checked its own clock
    // before beating would refuse to beat at all.
    server.now = () => Date.now() - 3_600_000;

    const report = await runHeartbeat(store.db, REPO_ID, entityId, {
      home,
      fetchImpl: server.fetch,
      everyMs: 1_000,
      maxBeats: 2,
      ttlSeconds: 60,
      sleep: nowait,
    });

    expect(report.stopped).toBe("beats");
    expect(report.holds).toBe(true);
    // Every beat renewed, and every expiry recorded is in this machine's past.
    // The lease is nonetheless live, because the only clock that decides that
    // is the one that wrote those timestamps.
    expect(report.beats.map((beat) => beat.outcome)).toEqual(["renewed", "renewed"]);
    expect(Date.parse(readLocalLease(store.db, entityId)!.serverExpiresAt)).toBeLessThan(
      Date.now(),
    );
  });
});

describe("cancellable", () => {
  it("stops on the signal, without one more request", async () => {
    const controller = new AbortController();
    const report = await runHeartbeat(store.db, REPO_ID, entityId, {
      home,
      fetchImpl: server.fetch,
      everyMs: 1_000,
      maxBeats: 100,
      sleep: async () => {
        controller.abort();
      },
      signal: controller.signal,
    });

    expect(report.stopped).toBe("cancelled");
    expect(report.beats).toHaveLength(1);
    expect(report.holds).toBe(true);
  });
});
