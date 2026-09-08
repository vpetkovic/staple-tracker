/**
 * The ONE typed contract, tested where it is defined.
 *
 * *"CLI MCP HTTP and UI derive status and error data from one typed contract."*
 * `test/cloud-surfaces.test.ts` proves the four surfaces agree with each other;
 * this file proves the thing they all agree WITH is right on its own — the
 * builder, the failure taxonomy, the human rendering, and the claim-scope
 * resolver — without booting a server or spawning a CLI for any of it.
 *
 * The split matters. A parity suite that also owned the semantics would pass
 * happily with all four surfaces agreeing on a wrong answer, which is the
 * failure mode of every "do these agree?" test written on its own.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { localCloudStatus } from "../src/core/cloud/status.js";
import { recordLocalLease } from "../src/core/cloud/lease-store.js";
import {
  cloudSurfaceReport,
  describeReport,
  noIdentityReport,
  type CloudSurfaceReport,
} from "../src/core/cloud/surface.js";
import { claimScopeResolver } from "../src/core/cloud/scope.js";

const ENDPOINT = "https://staple-sync-dev.example.workers.dev";
const DEVICE = "device-here";

let home: string;
let repoDir: string;
let repositoryId: string;
let db: DatabaseSync;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-surface-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "staple-surface-repo-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ dir: repoDir, slug: "surface" });
  db = ws.store.db;
  repositoryId = readStoredRepositoryId(db)!;
});

afterEach(() => {
  db?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

/** Forge a connection record and a credential, the way network-silence.test.ts does. */
function connect(over: { auto?: boolean; backup?: boolean; credential?: boolean } = {}): void {
  const dir = join(home, "cloud");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (over.credential !== false) {
    writeFileSync(join(dir, `${repositoryId}.token`), "stpl_fake\n", { mode: 0o600 });
  }
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId,
    endpoint: ENDPOINT,
    deviceId: DEVICE,
    label: "laptop",
    credentialMechanism: "file",
    connectedAt: "2026-09-05T00:00:00.000Z",
    protocol: 1,
    auto: over.auto === true,
    backup: over.backup === true,
  });
}

function report(): CloudSurfaceReport {
  return cloudSurfaceReport(localCloudStatus(home, repositoryId), db);
}

// ------------------------------------------------------------------ the shape

describe("the report is one shape in every state", () => {
  /**
   * Every state produces every key. A surface that renders `report.pending`
   * must not have to ask whether `pending` exists in this state — the moment it
   * does, the four surfaces start growing four different guards, which is the
   * duplication this contract removes.
   */
  const KEYS = [
    "state",
    "mode",
    "detail",
    "repositoryId",
    "endpoint",
    "deviceId",
    "label",
    "credentialMechanism",
    "credentialPresent",
    "auto",
    "backup",
    "connectedAt",
    "checked",
    "pending",
    "cursor",
    "epoch",
    "lastSyncAt",
    "conflicts",
    "leases",
    "warnings",
    "failure",
    "hint",
  ];

  it("disconnected carries the full key set", () => {
    expect(Object.keys(report()).sort()).toEqual([...KEYS].sort());
  });

  it("connected carries the same key set, not a superset", () => {
    connect();
    expect(Object.keys(report()).sort()).toEqual([...KEYS].sort());
  });

  it("the no-identity report carries the same key set too", () => {
    expect(Object.keys(noIdentityReport()).sort()).toEqual([...KEYS].sort());
  });
});

// ------------------------------------------------------------------ the modes

describe("mode is derived, never restated", () => {
  it("disconnected", () => {
    const r = report();
    expect(r.state).toBe("disconnected");
    expect(r.mode).toBe("disconnected");
    expect(r.hint).toBe("staple cloud connect");
    expect(r.failure).toBeNull();
  });

  it("manual is what a fresh connection gets, always", () => {
    connect();
    const r = report();
    expect(r.state).toBe("manual");
    expect(r.mode).toBe("manual");
    expect(r.auto).toBe(false);
    // A connected repository is not being prompted to connect.
    expect(r.hint).toBeNull();
    expect(r.failure).toBeNull();
  });

  it("automatic is a second, separate consent", () => {
    connect({ auto: true });
    const r = report();
    expect(r.state).toBe("automatic");
    expect(r.mode).toBe("automatic");
    expect(r.auto).toBe(true);
    // Automatic sync consent is not backup consent.
    expect(r.backup).toBe(false);
  });

  /**
   * `auth_failed` is the one non-local state reachable without a network call:
   * a connection record whose credential has been deleted out from under it.
   * It must report as a FAILURE with a remedy, not as a mode.
   */
  it("a connection whose credential vanished is an actionable failure", () => {
    connect({ credential: false });
    const r = report();
    expect(r.state).toBe("auth_failed");
    expect(r.credentialPresent).toBe(false);
    // Still connected in the sense that matters for what a surface may offer.
    expect(r.mode).toBe("manual");
    expect(r.failure).not.toBeNull();
    expect(r.failure!.code).toBe("auth_failed");
    expect(r.failure!.remedy).toContain("staple cloud connect");
  });
});

// -------------------------------------------------------- actionable failures

describe("failures name a remedy, because a failure without one is a complaint", () => {
  it("offline says local work is unaffected and does not send anyone to re-connect", () => {
    connect();
    const r = cloudSurfaceReport({ ...localCloudStatus(home, repositoryId), state: "offline", checked: true }, db);
    expect(r.failure!.code).toBe("offline");
    expect(r.failure!.remedy).toContain("staple cloud sync");
    // Offline is not a credential problem, so it must not tell a human to reconnect.
    expect(r.failure!.remedy).not.toContain("connect");
  });

  it("revoked sends the human to connect, because that is the only remedy", () => {
    connect();
    const r = cloudSurfaceReport({ ...localCloudStatus(home, repositoryId), state: "revoked", checked: true }, db);
    expect(r.failure!.code).toBe("revoked");
    expect(r.failure!.remedy).toContain("staple cloud connect");
  });

  it("a healthy connected repository has no failure at all", () => {
    connect();
    expect(report().failure).toBeNull();
  });
});

// ------------------------------------------------------------- the counters

describe("status reports the numbers the criteria name", () => {
  it("pending, cursor, epoch and lastSyncAt come off the local sync tables", () => {
    connect();
    db.prepare(
      `UPDATE sync_state SET cursor = 'cur-7', epoch = 3, head_seq = 41,
              last_sync_at = '2026-09-05T01:00:00.000Z' WHERE id = 1`,
    ).run();
    const r = report();
    expect(r.cursor).toBe("cur-7");
    expect(r.epoch).toBe(3);
    expect(r.lastSyncAt).toBe("2026-09-05T01:00:00.000Z");
    expect(r.pending).toBe(0);
  });

  it("device and mode are on the report, so no surface has to infer them", () => {
    connect({ auto: true });
    const r = report();
    expect(r.deviceId).toBe(DEVICE);
    expect(r.label).toBe("laptop");
    expect(r.mode).toBe("automatic");
    expect(r.endpoint).toBe(ENDPOINT);
  });

  it("counts open and resolved conflicts separately", () => {
    db.prepare(
      `INSERT INTO sync_conflicts
         (id, entity, entity_id, field, base_value, local_value, remote_value,
          local_op_id, remote_op_id, local_device_id, remote_device_id,
          local_at, remote_at, detected_at)
       VALUES ('c1','issue','i1','title','"b"','"l"','"r"','op-l','op-r','d1','d2',
               '2026-09-05T00:00:00.000Z','2026-09-05T00:00:01.000Z','2026-09-05T00:00:02.000Z')`,
    ).run();
    expect(report().conflicts).toEqual({ open: 1, resolved: 0 });
  });

  it("counts only the leases THIS device holds", () => {
    connect();
    recordLocalLease(db, {
      entityId: "mine",
      fencingToken: 4,
      holder: "agent-a",
      deviceId: DEVICE,
      serverExpiresAt: "2026-09-05T02:00:00.000Z",
      acquiredAt: "2026-09-05T01:00:00.000Z",
      renewedAt: null,
    });
    recordLocalLease(db, {
      entityId: "theirs",
      fencingToken: 9,
      holder: "agent-b",
      deviceId: "device-there",
      serverExpiresAt: "2026-09-05T02:00:00.000Z",
      acquiredAt: "2026-09-05T01:00:00.000Z",
      renewedAt: null,
    });
    // A mirror row for ANOTHER device is knowledge, not authority.
    expect(report().leases).toEqual({ held: 1 });
  });

  /**
   * A disconnected workspace has the tables (migration 010 runs regardless) but
   * nothing in them. Zero is the honest answer and null is the honest cursor —
   * neither is an error, and neither may be rendered as one.
   */
  it("disconnected reports zeroes and nulls rather than refusing", () => {
    const r = report();
    expect(r.pending).toBe(0);
    expect(r.cursor).toBeNull();
    expect(r.conflicts).toEqual({ open: 0, resolved: 0 });
    expect(r.leases).toEqual({ held: 0 });
  });
});

// ------------------------------------------------------------ human rendering

describe("describeReport is the one human wording", () => {
  it("a disconnected repository gets a static hint and nothing that probes", () => {
    const text = describeReport(report());
    expect(text).toContain("not connected");
    expect(text).toContain("staple cloud connect");
  });

  it("a connected repository reports mode, device, pending, cursor and epoch", () => {
    connect();
    db.prepare("UPDATE sync_state SET cursor = 'cur-7', epoch = 3 WHERE id = 1").run();
    const text = describeReport(report());
    expect(text).toContain("manual");
    expect(text).toContain(DEVICE);
    expect(text).toContain("cur-7");
    expect(text).toMatch(/epoch\s+3/);
  });

  it("renders the failure remedy when there is one", () => {
    connect({ credential: false });
    expect(describeReport(report())).toContain("staple cloud connect");
  });
});

// -------------------------------------------------------- the claim scope half

describe("claim scope: a local checkout is not a global lease", () => {
  it("disconnected is local, whatever the mirror says", () => {
    // A mirror row on a machine with no connection is a MEMORY of a lease.
    recordLocalLease(db, {
      entityId: "i1",
      fencingToken: 4,
      holder: "agent-a",
      deviceId: DEVICE,
      serverExpiresAt: "2026-09-05T02:00:00.000Z",
      acquiredAt: "2026-09-05T01:00:00.000Z",
      renewedAt: null,
    });
    const resolver = claimScopeResolver(db, home);
    expect(resolver.scopeOf("i1")).toBe("local");
    expect(resolver.leaseOf("i1")).toBeNull();
  });

  it("connected with no mirror row is local — a connection is not exclusivity", () => {
    connect();
    const resolver = claimScopeResolver(db, home);
    expect(resolver.scopeOf("i1")).toBe("local");
    expect(resolver.leaseOf("i1")).toBeNull();
  });

  it("connected, holding the lease, is lease — with the token and server expiry", () => {
    connect();
    recordLocalLease(db, {
      entityId: "i1",
      fencingToken: 4,
      holder: "agent-a",
      deviceId: DEVICE,
      serverExpiresAt: "2026-09-05T02:00:00.000Z",
      acquiredAt: "2026-09-05T01:00:00.000Z",
      renewedAt: null,
    });
    const resolver = claimScopeResolver(db, home);
    expect(resolver.scopeOf("i1")).toBe("lease");
    expect(resolver.leaseOf("i1")).toEqual({
      fencingToken: 4,
      serverExpiresAt: "2026-09-05T02:00:00.000Z",
    });
  });

  /**
   * The failure the field exists to prevent, from the other side: a lease
   * ANOTHER device holds must never read as this device's exclusivity.
   */
  it("a lease held by another device is local here", () => {
    connect();
    recordLocalLease(db, {
      entityId: "i1",
      fencingToken: 4,
      holder: "agent-b",
      deviceId: "device-there",
      serverExpiresAt: "2026-09-05T02:00:00.000Z",
      acquiredAt: "2026-09-05T01:00:00.000Z",
      renewedAt: null,
    });
    const resolver = claimScopeResolver(db, home);
    expect(resolver.scopeOf("i1")).toBe("local");
    expect(resolver.leaseOf("i1")).toBeNull();
  });

  it("one resolver answers for a whole page without re-reading anything", () => {
    connect();
    for (const [id, device] of [
      ["a", DEVICE],
      ["b", "device-there"],
      ["c", DEVICE],
    ] as const) {
      recordLocalLease(db, {
        entityId: id,
        fencingToken: 1,
        holder: "agent",
        deviceId: device,
        serverExpiresAt: "2026-09-05T02:00:00.000Z",
        acquiredAt: "2026-09-05T01:00:00.000Z",
        renewedAt: null,
      });
    }
    const resolver = claimScopeResolver(db, home);
    expect(["a", "b", "c", "d"].map((id) => resolver.scopeOf(id))).toEqual([
      "lease",
      "local",
      "lease",
      "local",
    ]);
  });
});
