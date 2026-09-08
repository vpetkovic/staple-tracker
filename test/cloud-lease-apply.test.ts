/**
 * Pulled lease operations, projected onto the checkout model.
 *
 * Contract: `docs/sync.md` — *"Pulled lease operations project deterministically
 * onto `checkout_agent` and `checkout_at`, so `ls`, `show` and `inbox` keep
 * rendering the fields they already render; the token and the server expiry live
 * in the sync tables, not in new `issues` columns."*
 *
 * Deterministic means the outcome is a function of the operations and their
 * fencing tokens, and of nothing else. No clock is consulted here, in either the
 * code or these tests: the same operations in the same order produce the same
 * two columns on every machine, and an operation carrying a superseded token
 * produces the same result whether it arrives late or not at all.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { applyToDatabase, type ApplyInput } from "../src/core/cloud/apply.js";
import { readLocalLease } from "../src/core/cloud/lease-store.js";

function workspace(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

function leaseOp(
  entityId: string,
  verb: "create" | "update" | "delete",
  payload: Record<string, unknown>,
): ApplyInput {
  return {
    entity: "lease",
    entityId,
    verb,
    payload,
    actor: "agent-remote",
    deviceId: "device-remote",
    at: "2026-09-08T10:00:00.000Z",
    opId: `op-${entityId}-${verb}-${String(payload.fencingToken)}`,
  };
}

function checkoutOf(store: WorkspaceStore, id: string): { agent: string | null; at: string | null } {
  const row = store.db
    .prepare("SELECT checkout_agent AS agent, checkout_at AS at FROM issues WHERE id = ?")
    .get(id) as { agent: string | null; at: string | null };
  return row;
}

describe("a pulled lease.create projects onto the checkout the other surfaces render", () => {
  it("sets checkout_agent and checkout_at from the lease, and records the mirror", () => {
    const store = workspace();
    const id = store.createIssue({ title: "remote work", createdBy: "seed" }).id;

    applyToDatabase(
      store.db,
      leaseOp(id, "create", {
        fencingToken: 7,
        holder: "agent-remote",
        deviceId: "device-remote",
        serverExpiresAt: "2026-09-08T10:05:00.000Z",
        acquiredAt: "2026-09-08T10:00:00.000Z",
      }),
    );

    expect(checkoutOf(store, id)).toEqual({
      agent: "agent-remote",
      at: "2026-09-08T10:00:00.000Z",
    });
    const mirror = readLocalLease(store.db, id)!;
    expect(mirror.fencingToken).toBe(7);
    expect(mirror.serverExpiresAt).toBe("2026-09-08T10:05:00.000Z");
    store.db.close();
  });

  it("is idempotent: the same operation applied twice leaves the same two columns", () => {
    const store = workspace();
    const id = store.createIssue({ title: "remote work", createdBy: "seed" }).id;
    const op = leaseOp(id, "create", {
      fencingToken: 7,
      holder: "agent-remote",
      deviceId: "device-remote",
      serverExpiresAt: "2026-09-08T10:05:00.000Z",
      acquiredAt: "2026-09-08T10:00:00.000Z",
    });

    applyToDatabase(store.db, op);
    const first = checkoutOf(store, id);
    applyToDatabase(store.db, op);

    expect(checkoutOf(store, id)).toEqual(first);
    store.db.close();
  });

  it("defers rather than inventing a row when the issue has not arrived yet", () => {
    const store = workspace();
    expect(() =>
      applyToDatabase(
        store.db,
        leaseOp("00000000-0000-4000-8000-000000000000", "create", {
          fencingToken: 1,
          holder: "agent-remote",
          deviceId: "device-remote",
          serverExpiresAt: "2026-09-08T10:05:00.000Z",
          acquiredAt: "2026-09-08T10:00:00.000Z",
        }),
      ),
    ).toThrow(/issue/);
    store.db.close();
  });
});

describe("fencing decides, not arrival order", () => {
  it("a superseded token cannot reinstate the holder it belonged to", () => {
    const store = workspace();
    const id = store.createIssue({ title: "contested", createdBy: "seed" }).id;

    applyToDatabase(
      store.db,
      leaseOp(id, "create", {
        fencingToken: 9,
        holder: "agent-b",
        deviceId: "device-two",
        serverExpiresAt: "2026-09-08T11:00:00.000Z",
        acquiredAt: "2026-09-08T10:30:00.000Z",
      }),
    );
    // The older acquisition, replayed. A page that did not advance its cursor
    // replays whole, so this is ordinary traffic rather than an exotic case.
    applyToDatabase(
      store.db,
      leaseOp(id, "create", {
        fencingToken: 4,
        holder: "agent-a",
        deviceId: "device-one",
        serverExpiresAt: "2026-09-08T10:05:00.000Z",
        acquiredAt: "2026-09-08T10:00:00.000Z",
      }),
    );

    expect(readLocalLease(store.db, id)!.fencingToken).toBe(9);
    expect(checkoutOf(store, id).agent).toBe("agent-b");
    store.db.close();
  });

  it("a lease.update renews the mirror without moving the checkout", () => {
    const store = workspace();
    const id = store.createIssue({ title: "renewed", createdBy: "seed" }).id;

    applyToDatabase(
      store.db,
      leaseOp(id, "create", {
        fencingToken: 3,
        holder: "agent-a",
        deviceId: "device-one",
        serverExpiresAt: "2026-09-08T10:05:00.000Z",
        acquiredAt: "2026-09-08T10:00:00.000Z",
      }),
    );
    applyToDatabase(
      store.db,
      leaseOp(id, "update", {
        fencingToken: 3,
        holder: "agent-a",
        deviceId: "device-one",
        serverExpiresAt: "2026-09-08T10:10:00.000Z",
        acquiredAt: "2026-09-08T10:00:00.000Z",
        renewedAt: "2026-09-08T10:05:00.000Z",
      }),
    );

    expect(readLocalLease(store.db, id)!.serverExpiresAt).toBe("2026-09-08T10:10:00.000Z");
    expect(checkoutOf(store, id)).toEqual({
      agent: "agent-a",
      at: "2026-09-08T10:00:00.000Z",
    });
    store.db.close();
  });
});

describe("a pulled lease.delete gives the claim back — but only its own", () => {
  it("clears the checkout when the holder it names is still the holder", () => {
    const store = workspace();
    const id = store.createIssue({ title: "finished", createdBy: "seed" }).id;

    applyToDatabase(
      store.db,
      leaseOp(id, "create", {
        fencingToken: 2,
        holder: "agent-a",
        deviceId: "device-one",
        serverExpiresAt: "2026-09-08T10:05:00.000Z",
        acquiredAt: "2026-09-08T10:00:00.000Z",
      }),
    );
    applyToDatabase(store.db, leaseOp(id, "delete", { fencingToken: 2, holder: "agent-a" }));

    expect(readLocalLease(store.db, id)).toBeNull();
    expect(checkoutOf(store, id)).toEqual({ agent: null, at: null });
    store.db.close();
  });

  it("leaves a newer holder's claim alone when a stale release arrives late", () => {
    const store = workspace();
    const id = store.createIssue({ title: "taken over", createdBy: "seed" }).id;

    applyToDatabase(
      store.db,
      leaseOp(id, "create", {
        fencingToken: 5,
        holder: "agent-b",
        deviceId: "device-two",
        serverExpiresAt: "2026-09-08T11:00:00.000Z",
        acquiredAt: "2026-09-08T10:30:00.000Z",
      }),
    );
    // agent-a's release, from before the takeover, arriving now. It must not
    // free work that agent-b is currently doing.
    applyToDatabase(store.db, leaseOp(id, "delete", { fencingToken: 2, holder: "agent-a" }));

    expect(readLocalLease(store.db, id)!.fencingToken).toBe(5);
    expect(checkoutOf(store, id).agent).toBe("agent-b");
    store.db.close();
  });
});
