/**
 * Fenced server leases — the client half.
 *
 * Contract: `docs/sync.md`, "Claims: a local checkout is not a global lease".
 * Every describe block below is one of STA-74's acceptance criteria.
 *
 * The service is `test/fixtures/fake-sync-server.ts`, extended with the lease
 * routes and the deployed Worker's semantics: a per-repository monotonic token
 * allocated BEFORE the slot is contested, a slot taken only when free, and one
 * predicate on renew and release covering wrong token, wrong device and expired.
 * It is handed in as a `fetchImpl`, so nothing here touches a socket.
 *
 * ## The clock discipline these tests exist to hold
 *
 * The fixture's `now` is the SERVER's clock and is the only clock any expiry
 * comes from. Where a test needs a lease to expire it moves that one. The
 * client's clock is never moved to make something happen, because the client's
 * clock is never allowed to make anything happen.
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
import {
  acquireClaim,
  acquireLease,
  releaseClaim,
  renewClaim,
} from "../src/core/cloud/lease.js";
import { listLocalLeases, readLocalLease } from "../src/core/cloud/lease-store.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "1c88fb02-2222-4333-8444-555566667777";
const ENDPOINT = "https://sync.test.example";

let homes: string[] = [];
let stores: WorkspaceStore[] = [];
let server: FakeSyncServer;

interface Device {
  readonly store: WorkspaceStore;
  readonly home: string;
  readonly deviceId: string;
}

/** A connected workspace on its own machine, with its own home and credential. */
function device(deviceId: string, token: string, connected = true): Device {
  const home = mkdtempSync(join(tmpdir(), `staple-lease-home-${deviceId}-`));
  homes.push(home);

  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  bindJournal(db, deviceId);
  const store = new WorkspaceStore(db, "test", "TST");
  stores.push(store);

  if (connected) {
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
  }

  return { store, home, deviceId };
}

function seed(store: WorkspaceStore, title: string): string {
  return store.createIssue({ title, createdBy: "seed" }).id;
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

// --------------------------------------------------------------- acquisition

describe("acquisition: one winner, and a conflict nobody should retry", () => {
  it("grants a fenced, server-dated lease and claims the issue locally", async () => {
    const one = device("device-one", "tok-one");
    const id = seed(one.store, "a task");

    const outcome = await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });

    expect(outcome.scope).toBe("lease");
    expect(outcome.lease?.fencingToken).toBeGreaterThan(0);
    expect(outcome.lease?.holder).toBe("agent-a");
    expect(outcome.issue.checkoutAgent).toBe("agent-a");
    expect(outcome.issue.status).toBe("in_progress");
  });

  /**
   * Two machines contest ONE entity id. Device one takes the lease at the entity
   * level — which is the precondition being modelled, "the other machine already
   * holds it" — and device two then runs the whole composed verb and loses.
   *
   * The entity id is device two's own issue id, because the lease is scoped to
   * the entity and the entity is the same issue on both machines. Minting a
   * matching row on device one would test the sync engine, not this.
   */
  it("gives two devices racing for one entity one winner and one non-retryable conflict", async () => {
    const one = device("device-one", "tok-one");
    const two = device("device-two", "tok-two");
    const id = seed(two.store, "contested");

    await acquireLease(one.store.db, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });

    const loser = await acquireClaim(two.store, REPO_ID, id, "agent-b", {
      home: two.home,
      fetchImpl: server.fetch,
    }).catch((error: unknown) => error);

    expect(loser).toBeInstanceOf(StapleError);
    const error = loser as StapleError;
    expect(error.code).toBe("conflict");
    expect(error.detail?.cloudCode).toBe("conflict");
    expect(error.detail?.retryable).toBe(false);
    expect(error.detail?.holder).toBe("agent-a");
  });

  it("leaves the loser's issue unclaimed — a refused lease claims nothing locally", async () => {
    const one = device("device-one", "tok-one");
    const two = device("device-two", "tok-two");
    const id = seed(two.store, "contested");

    await acquireLease(one.store.db, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });
    await expect(
      acquireClaim(two.store, REPO_ID, id, "agent-b", {
        home: two.home,
        fetchImpl: server.fetch,
      }),
    ).rejects.toThrow();

    const issue = two.store.getIssue(id);
    expect(issue.checkoutAgent).toBeNull();
    expect(readLocalLease(two.store.db, id)).toBeNull();
  });

  it("issues strictly increasing fencing tokens, and never reuses one after a release", async () => {
    const one = device("device-one", "tok-one");
    const first = seed(one.store, "one");
    const second = seed(one.store, "two");

    const a = await acquireClaim(one.store, REPO_ID, first, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });
    await releaseClaim(one.store, REPO_ID, first, { home: one.home, fetchImpl: server.fetch });
    const b = await acquireClaim(one.store, REPO_ID, second, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });
    const c = await acquireClaim(one.store, REPO_ID, first, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });

    expect(b.lease!.fencingToken).toBeGreaterThan(a.lease!.fencingToken);
    expect(c.lease!.fencingToken).toBeGreaterThan(b.lease!.fencingToken);
  });

  it("releases the lease it just took when the local claim is refused", async () => {
    const one = device("device-one", "tok-one");
    const blocker = seed(one.store, "the blocker");
    const blocked = seed(one.store, "the blocked");
    one.store.setBlockedBy(blocked, [blocker], "seed");

    await expect(
      acquireClaim(one.store, REPO_ID, blocked, "agent-a", {
        home: one.home,
        fetchImpl: server.fetch,
      }),
    ).rejects.toThrow();

    // The compensating release: a local guard must not strand a remote lease.
    expect(server.leases.has(blocked)).toBe(false);
    expect(readLocalLease(one.store.db, blocked)).toBeNull();
  });
});

// ------------------------------------------------------- server authority

describe("the expiry is the server's, and the client's clock is metadata", () => {
  it("stores the expiry the server stated, not one derived from the ttl asked for", async () => {
    const one = device("device-one", "tok-one");
    const id = seed(one.store, "a task");
    // The server's clock is an hour ahead of this machine's. A client that
    // computed `now + ttl` would record an hour too early and think it had
    // expired while the server still considered it live.
    const skew = 3_600_000;
    server.now = () => Date.now() + skew;

    const outcome = await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
      ttlSeconds: 60,
    });

    const stored = Date.parse(outcome.lease!.serverExpiresAt);
    expect(stored).toBe(server.leases.get(id)!.expiresAt);
    expect(stored - Date.now()).toBeGreaterThan(skew);
  });

  it("renews against the server even when this machine believes the lease expired", async () => {
    const one = device("device-one", "tok-one");
    const id = seed(one.store, "a task");
    // The client's clock runs far ahead. Its own mirror row therefore looks long
    // expired to it. The renewal must still succeed, because the client does not
    // get a vote on expiry.
    server.now = () => Date.now() - 10_000_000;

    await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
      ttlSeconds: 60,
    });
    const mirror = readLocalLease(one.store.db, id)!;
    expect(Date.parse(mirror.serverExpiresAt)).toBeLessThan(Date.now());

    const renewed = await renewClaim(one.store, REPO_ID, id, {
      home: one.home,
      fetchImpl: server.fetch,
      ttlSeconds: 60,
    });
    expect(renewed.lease.fencingToken).toBe(mirror.fencingToken);
  });

  it("refuses a renewal the server has expired, however live it looks here", async () => {
    const one = device("device-one", "tok-one");
    const id = seed(one.store, "a task");
    let serverNow = Date.now();
    server.now = () => serverNow;

    await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
      ttlSeconds: 60,
    });
    serverNow += 61_000;

    const error = await renewClaim(one.store, REPO_ID, id, {
      home: one.home,
      fetchImpl: server.fetch,
    }).catch((e: unknown) => e as StapleError);

    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).detail?.cloudCode).toBe("conflict");
    expect((error as StapleError).detail?.retryable).toBe(false);
    // The mirror is forgotten: this device demonstrably does not hold it.
    expect(readLocalLease(one.store.db, id)).toBeNull();
  });
});

// ------------------------------------------- expired, stolen and revoked

describe("an expired, stolen or revoked holder cannot finish the remote task", () => {
  it("refuses a release from a device whose lease was taken over", async () => {
    const one = device("device-one", "tok-one");
    const two = device("device-two", "tok-two");
    const id = seed(one.store, "a task");
    let serverNow = Date.now();
    server.now = () => serverNow;

    await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
      ttlSeconds: 60,
    });
    serverNow += 61_000;
    // The takeover: a fresh acquire clears the expired slot and mints a HIGHER
    // token. Nothing swept; the acquire that wanted the slot did the clearing.
    await acquireLease(two.store.db, REPO_ID, id, "agent-b", {
      home: two.home,
      fetchImpl: server.fetch,
    });

    const report = await releaseClaim(one.store, REPO_ID, id, {
      home: one.home,
      fetchImpl: server.fetch,
    });

    expect(report.remoteReleased).toBe(false);
    expect(report.scope).toBe("local");
    expect(report.note).toMatch(/not released/i);
    // The winner still holds it. A stale token can never write.
    expect(server.leases.get(id)!.holder).toBe("agent-b");
  });

  it("refuses a revoked device, and says so rather than reporting a release", async () => {
    const one = device("device-one", "tok-one");
    const id = seed(one.store, "a task");

    await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });
    server.revoke("device-one");

    const report = await releaseClaim(one.store, REPO_ID, id, {
      home: one.home,
      fetchImpl: server.fetch,
    });

    expect(report.remoteReleased).toBe(false);
    expect(report.reason).toBe("revoked");
    expect(server.leases.has(id)).toBe(true);
  });

  it("refuses a renewal from a revoked device", async () => {
    const one = device("device-one", "tok-one");
    const id = seed(one.store, "a task");
    await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });
    server.revoke("device-one");

    await expect(
      renewClaim(one.store, REPO_ID, id, { home: one.home, fetchImpl: server.fetch }),
    ).rejects.toMatchObject({ detail: { cloudCode: "revoked" } });
  });

  it("still lets the local claim be released — local work is never held hostage", async () => {
    const one = device("device-one", "tok-one");
    const id = seed(one.store, "a task");
    await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });
    server.revoke("device-one");

    await releaseClaim(one.store, REPO_ID, id, { home: one.home, fetchImpl: server.fetch });
    expect(one.store.getIssue(id).checkoutAgent).toBeNull();
  });
});

// ----------------------------------------------------------- release, happy

describe("release", () => {
  it("presents the token, drops the mirror row and releases the local claim", async () => {
    const one = device("device-one", "tok-one");
    const id = seed(one.store, "a task");
    await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: server.fetch,
    });

    const report = await releaseClaim(one.store, REPO_ID, id, {
      home: one.home,
      fetchImpl: server.fetch,
    });

    expect(report.remoteReleased).toBe(true);
    expect(server.leases.has(id)).toBe(false);
    expect(readLocalLease(one.store.db, id)).toBeNull();
    expect(one.store.getIssue(id).checkoutAgent).toBeNull();
    expect(listLocalLeases(one.store.db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- offline

describe("a disconnected workspace claims locally and says exactly that", () => {
  it("acquires local-only, labels the scope and never resolves an endpoint", async () => {
    const one = device("device-one", "tok-one", false);
    const id = seed(one.store, "a task");
    /**
     * `fetchImpl` throws. A disconnected acquire that reached for the network at
     * all — even to discover there was nothing to reach — would fail here, which
     * is a stronger statement than counting calls that were never made.
     */
    const outcome = await acquireClaim(one.store, REPO_ID, id, "agent-a", {
      home: one.home,
      fetchImpl: (() => {
        throw new Error("a disconnected workspace must not call out");
      }) as unknown as typeof fetch,
    });

    expect(outcome.scope).toBe("local");
    expect(outcome.lease).toBeNull();
    expect(outcome.note).toMatch(/this database only/i);
    // It says what it is NOT. An agent that reads `local` and behaves as though
    // it read `lease` is the failure the field exists to prevent, so the note
    // denies global exclusivity in words rather than merely omitting a claim
    // to it.
    expect(outcome.note).toMatch(/no global exclusivity/i);
    expect(outcome.issue.checkoutAgent).toBe("agent-a");
  });

  it("releases local-only, and reports no remote lease rather than a released one", async () => {
    const one = device("device-one", "tok-one", false);
    const id = seed(one.store, "a task");
    const forbidden = (() => {
      throw new Error("a disconnected workspace must not call out");
    }) as unknown as typeof fetch;

    await acquireClaim(one.store, REPO_ID, id, "agent-a", { home: one.home, fetchImpl: forbidden });
    const report = await releaseClaim(one.store, REPO_ID, id, {
      home: one.home,
      fetchImpl: forbidden,
    });

    expect(report.scope).toBe("local");
    expect(report.remoteReleased).toBe(false);
    expect(report.reason).toBe("disconnected");
    expect(one.store.getIssue(id).checkoutAgent).toBeNull();
  });

  it("keeps the STA-47 local stale-claim behaviour untouched", async () => {
    const one = device("device-one", "tok-one", false);
    const id = seed(one.store, "a task");
    const forbidden = (() => {
      throw new Error("must not call out");
    }) as unknown as typeof fetch;

    await acquireClaim(one.store, REPO_ID, id, "agent-a", { home: one.home, fetchImpl: forbidden });
    // A fresher holder on THIS machine is still refused, exactly as today.
    expect(() => one.store.checkoutIssue(id, "agent-b")).toThrow(StapleError);
    // And an explicit takeover still works, with no server involved at all.
    const stolen = one.store.checkoutIssue(id, "agent-b", undefined, { stealIfIdleSeconds: 0 });
    expect(stolen.checkoutAgent).toBe("agent-b");
  });
});
