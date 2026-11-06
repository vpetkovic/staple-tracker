/**
 * Members and device pairing, the client half: `staple cloud join`, approvals, the member
 * list, the shared endpoint and the `removed` status.
 *
 * The service is a fake `fetch` that implements the members wire contract (the epic's
 * design document, "Wire contract"). These tests are about what the CLIENT does: what it
 * sends, in what order, what it writes to disk and what it refuses. The Worker's own
 * behaviour is tested in `worker/` against `workerd`.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StapleError } from "../src/core/types.js";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import {
  REPOSITORY_MANIFEST_ENDPOINT_FORMAT,
  ensureRepositoryManifest,
  parseRepositoryManifest,
  readRepositoryManifest,
  renderRepositoryManifest,
  repositoryManifestPath,
  writeRepositoryEndpoint,
  writeStoredRepositoryId,
} from "../src/core/repo-identity.js";
import { credentialStoreFor, fileCredentialStore } from "../src/core/cloud/credential-store.js";
import { readConnection, writeConnection } from "../src/core/cloud/connection.js";
import { performDisconnect } from "../src/core/cloud/connect.js";
import {
  buildJoinPreview,
  normalizeJoinCode,
  renderJoinPreview,
  resolveJoinEndpoint,
} from "../src/core/cloud/join-preview.js";
import { performJoin } from "../src/core/cloud/join.js";
import {
  approveRequest,
  denyRequest,
  listPendingRequests,
  membersAfterConnect,
  ownerRenameHint,
  refreshMembersCache,
  removeMember,
  renameMember,
} from "../src/core/cloud/members.js";
import { membersCachePath, readMembersCache, writeMembersCache } from "../src/core/cloud/members-cache.js";
import { describeState, localCloudStatus, refreshCloudStatus } from "../src/core/cloud/status.js";
import { hubCloudReport } from "../src/core/cloud/hub-surface.js";
import { autoSyncGate } from "../src/core/cloud/auto.js";
import { cloudSurfaceReport } from "../src/core/cloud/surface.js";
import { syncRepository } from "../src/core/cloud/sync.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { initWorkspace } from "../src/core/workspace.js";

const ENDPOINT = "https://sync.members.example";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-members-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

import { MembersServer, OWNER_DEVICE, OWNER_MEMBER, OWNER_TOKEN, REPO_ID } from "./fixtures/fake-members-server.js";

/** This machine, connected as the owner's device. */
function connectAsOwner(): void {
  credentialStoreFor(home, "file").write(REPO_ID, OWNER_TOKEN);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId: OWNER_DEVICE,
    label: "studio",
    credentialMechanism: "file",
    connectedAt: "2026-11-06T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 4,
  });
}

function joinPreview() {
  return buildJoinPreview({
    home,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    endpointSource: "flag",
    label: "buddy-laptop",
    credential: { forceFile: true },
  });
}

// ---------------------------------------------------------------------- joining

describe("join: the preview, then a code, then a credential", () => {
  it("builds and renders the preview without a single request", () => {
    const server = new MembersServer();
    const rendered = renderJoinPreview(joinPreview());
    expect(server.calls).toHaveLength(0);
    expect(rendered).toContain(ENDPOINT);
    expect(rendered).toContain(REPO_ID);
    expect(rendered).toContain("buddy-laptop");
    expect(rendered).toContain("no end-to-end encryption");
    expect(rendered).toContain("AUTOMATIC SYNC STAYS OFF");
    expect(rendered).toContain("Nothing has been sent yet");
    // And nothing on disk: no device id, no credential, no record.
    expect(existsSync(join(home, "cloud"))).toBe(false);
  });

  it("joins: request, code, wait, approval, then the credential, the record and the member list", async () => {
    const server = new MembersServer();
    const codes: string[] = [];
    let sleeps = 0;

    const outcome = await performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      now: () => server.now,
      onCode: (ticket) => codes.push(ticket.code),
      sleep: async () => {
        sleeps += 1;
        // Two waits pending, then someone approves at the other terminal.
        if (sleeps === 3) server.approve(codes[0]!, { name: "buddy" });
      },
    });

    expect(outcome.status).toBe("joined");
    if (outcome.status !== "joined") return;
    expect(codes).toEqual(["K001-7Q2M"]);
    expect(server.routes()).toEqual([
      "GET /v1/capabilities",
      "POST /join-requests",
      "GET /join-requests/jr_1",
      "GET /join-requests/jr_1",
      "GET /join-requests/jr_1",
      "GET /members",
    ]);

    // The request secret went to the service only as its digest, and came back as the bearer.
    const create = server.calls[1]!;
    const poll = server.calls[2]!;
    const secret = poll.authorization!.replace(/^Bearer /, "");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect((create.body as Record<string, unknown>).requestSecretSha256).toBe(
      createHash("sha256").update(secret, "utf8").digest("hex"),
    );
    expect(JSON.stringify(create.body)).not.toContain(secret);
    expect(create.authorization).toBeNull();
    expect(poll.device).toBeNull();

    // The credential, exactly as `performConnect` stores one, with every consent OFF.
    const deviceId = (create.body as { deviceId: string }).deviceId;
    expect(fileCredentialStore(home).read(REPO_ID)).toBe(`stpl_joined_${deviceId}`);
    const record = readConnection(home, REPO_ID)!;
    expect(record).toMatchObject({
      repositoryId: REPO_ID,
      endpoint: ENDPOINT,
      deviceId,
      label: "buddy-laptop",
      credentialMechanism: "file",
      auto: false,
      backup: false,
      registry: false,
      protocol: 4,
    });
    // The secret is nowhere on disk.
    const onDisk = readFileSync(join(home, "cloud", `${REPO_ID}.json`), "utf8");
    expect(onDisk).not.toContain(secret);

    // The member list, written through the cache contract, with this device as self.
    const cache = readMembersCache(home, REPO_ID)!;
    expect(cache.self.deviceId).toBe(deviceId);
    expect(cache.members.map((m) => m.name)).toEqual(["vp", "buddy"]);
    expect(outcome.member?.name).toBe("buddy");
    // And the members call was made with the NEW device token.
    expect(server.calls.at(-1)!.authorization).toBe(`Bearer stpl_joined_${deviceId}`);
  });

  it("backs off between polls, from two seconds to at most ten", async () => {
    const server = new MembersServer();
    const waits: number[] = [];
    let code = "";
    await performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      now: () => server.now,
      onCode: (ticket) => (code = ticket.code),
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 8) server.approve(code, { name: "buddy" });
      },
    });
    expect(waits).toEqual([2000, 3000, 4500, 6750, 10000, 10000, 10000, 10000]);
  });

  it("reports a denial, and stores nothing", async () => {
    const server = new MembersServer();
    let code = "";
    const joining = performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      now: () => server.now,
      onCode: (ticket) => (code = ticket.code),
      sleep: async () => server.setStatus(code, "denied"),
    });
    const error = await joining.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe("forbidden");
    expect((error as StapleError).detail?.joinStatus).toBe("denied");
    expect((error as StapleError).message).toMatch(/was denied\. Nothing was stored/);
    expect(readConnection(home, REPO_ID)).toBeNull();
    expect(fileCredentialStore(home).read(REPO_ID)).toBeNull();
    expect(existsSync(membersCachePath(home, REPO_ID))).toBe(false);
  });

  it("reports an expiry the service declares, and stores nothing", async () => {
    const server = new MembersServer();
    let code = "";
    const error = await performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      now: () => server.now,
      onCode: (ticket) => (code = ticket.code),
      sleep: async () => server.setStatus(code, "expired"),
    }).then(() => null, (e: unknown) => e);
    expect((error as StapleError).code).toBe("not_found");
    expect((error as StapleError).detail?.joinStatus).toBe("expired");
    expect((error as StapleError).message).toMatch(/expired before anyone approved it/);
    expect(readConnection(home, REPO_ID)).toBeNull();
  });

  it("gives up on its own clock past the expiry, even if the service never says so", async () => {
    const server = new MembersServer();
    let clock = server.now;
    const error = await performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms * 10;
      },
    }).then(() => null, (e: unknown) => e);
    expect((error as StapleError).detail?.joinStatus).toBe("expired");
  });

  it("Ctrl-C cancels locally: no call after the abort, nothing stored", async () => {
    const server = new MembersServer();
    const controller = new AbortController();
    let sleeps = 0;
    const outcome = await performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      now: () => server.now,
      signal: controller.signal,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) controller.abort();
      },
    });
    expect(outcome).toMatchObject({ status: "cancelled", code: "K001-7Q2M" });
    // capabilities, create, one poll; the abort came during the second wait.
    expect(server.routes()).toEqual(["GET /v1/capabilities", "POST /join-requests", "GET /join-requests/jr_1"]);
    expect(readConnection(home, REPO_ID)).toBeNull();
    expect(fileCredentialStore(home).read(REPO_ID)).toBeNull();
  });

  it("waits out a transient failure rather than throwing the request away", async () => {
    const server = new MembersServer();
    let code = "";
    let sleeps = 0;
    const outcome = await performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      now: () => server.now,
      onCode: (ticket) => {
        code = ticket.code;
        server.failReads = { code, times: 2 };
      },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 3) server.approve(code, { name: "buddy" });
      },
    });
    expect(outcome.status).toBe("joined");
  });

  it("refuses a service without member approval before sending a request", async () => {
    const server = new MembersServer();
    server.membersCapability = false;
    const error = await performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      sleep: async () => undefined,
    }).then(() => null, (e: unknown) => e);
    expect((error as StapleError).code).toBe("forbidden");
    expect((error as StapleError).message).toMatch(/does not support joining by approval/);
    expect(server.routes()).toEqual(["GET /v1/capabilities"]);
  });

  it("an approval whose credential was already collected elsewhere is an error, not a hang", async () => {
    const server = new MembersServer();
    let code = "";
    const error = await performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      now: () => server.now,
      onCode: (ticket) => (code = ticket.code),
      sleep: async () => server.setStatus(code, "collected"),
    }).then(() => null, (e: unknown) => e);
    expect((error as StapleError).code).toBe("conflict");
    expect((error as StapleError).detail?.joinStatus).toBe("collected");
    expect(readConnection(home, REPO_ID)).toBeNull();
  });
});

describe("join codes and endpoints, parsed locally", () => {
  it("normalizes what a person types to the form the service shows", () => {
    expect(normalizeJoinCode("k7q2-m9xd")).toBe("K7Q2-M9XD");
    expect(normalizeJoinCode(" K7Q2 M9XD ")).toBe("K7Q2-M9XD");
    expect(normalizeJoinCode("ko12il9x")).toBe("K012-119X");
    expect(() => normalizeJoinCode("K7Q2-M9X")).toThrow(/not a join code/);
    expect(() => normalizeJoinCode("K7Q2-M9XU")).toThrow(/not a join code/);
  });

  it("takes --endpoint first, then the shared one, else says how to get one", () => {
    expect(resolveJoinEndpoint("https://a.example", "https://b.example")).toEqual({ endpoint: "https://a.example", source: "flag" });
    expect(resolveJoinEndpoint(undefined, "https://b.example")).toEqual({ endpoint: "https://b.example", source: "manifest" });
    expect(() => resolveJoinEndpoint(undefined, undefined)).toThrow(/--endpoint <url>.*share-endpoint/s);
  });
});

// --------------------------------------------------------------- approvals, members

describe("approvals and the member list", () => {
  async function pendingCode(server: MembersServer): Promise<string> {
    // A joining device's request, made straight against the fake service.
    const response = await server.fetch(`${ENDPOINT}/v1/repos/${REPO_ID}/join-requests`, {
      method: "POST",
      body: JSON.stringify({ deviceId: "bbbbbbbb-0000-4000-8000-000000000002", label: "buddy-laptop", requestSecretSha256: "00" }),
    });
    return ((await response.json()) as { code: string }).code;
  }

  it("lists pending requests, and approves --as a new member, refreshing the cache", async () => {
    connectAsOwner();
    const server = new MembersServer();
    const code = await pendingCode(server);

    const pending = await listPendingRequests(home, REPO_ID, { fetchImpl: server.fetch });
    expect(pending).toEqual([
      expect.objectContaining({ code, label: "buddy-laptop", createdAt: server.now, expiresAt: server.now + 600_000 }),
    ]);

    // Typed loosely, the way a person reads it off a call.
    const outcome = await approveRequest(home, REPO_ID, code.toLowerCase().replace("-", " "), { asNewMember: "buddy" }, { fetchImpl: server.fetch });
    expect(outcome).toMatchObject({ code, newMember: true, member: { name: "buddy" } });
    const approve = server.calls.find((c) => c.path.endsWith("/approve"))!;
    expect(approve.path).toBe(`/v1/repos/${REPO_ID}/join-requests/${code}/approve`);
    expect(approve.body).toEqual({ newMember: { name: "buddy" } });
    expect(approve.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(approve.device).toBe(OWNER_DEVICE);
    expect(readMembersCache(home, REPO_ID)!.members.map((m) => m.name)).toEqual(["vp", "buddy"]);
  });

  it("approve --to resolves a member's name to their id against a fresh list", async () => {
    connectAsOwner();
    const server = new MembersServer();
    const code = await pendingCode(server);
    await approveRequest(home, REPO_ID, code, { toMember: "VP" }, { fetchImpl: server.fetch });
    expect(server.calls.find((c) => c.path.endsWith("/approve"))!.body).toEqual({ memberId: OWNER_MEMBER });
  });

  it("states the rule when the service refuses a non-owner admitting a new person", async () => {
    const server = new MembersServer();
    server.members.push({ memberId: "mem_b", name: "buddy", isOwner: false, removedAt: null, removedBy: null });
    server.devices.push({ deviceId: OWNER_DEVICE.replace("1", "9"), memberId: "mem_b", token: "stpl_b", label: null, revoked: false });
    credentialStoreFor(home, "file").write(REPO_ID, "stpl_b");
    writeConnection(home, {
      schemaVersion: 1, repositoryId: REPO_ID, endpoint: ENDPOINT, deviceId: OWNER_DEVICE.replace("1", "9"),
      label: null, credentialMechanism: "file", connectedAt: "2026-11-06T00:00:00.000Z", auto: false, backup: false, protocol: 4,
    });
    const code = await pendingCode(server);
    const error = await approveRequest(home, REPO_ID, code, { asNewMember: "eve" }, { fetchImpl: server.fetch }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as StapleError).code).toBe("forbidden");
    expect((error as StapleError).message).toMatch(/Only the workspace owner may admit a new person/);
  });

  it("an unknown code says it may have expired, rather than 'not found'", async () => {
    connectAsOwner();
    const server = new MembersServer();
    const error = await denyRequest(home, REPO_ID, "ZZZZ-ZZZZ", { fetchImpl: server.fetch }).then(() => null, (e: unknown) => e);
    expect((error as StapleError).code).toBe("not_found");
    expect((error as StapleError).message).toMatch(/may have expired/);
  });

  it("denies", async () => {
    connectAsOwner();
    const server = new MembersServer();
    const code = await pendingCode(server);
    await denyRequest(home, REPO_ID, code, { fetchImpl: server.fetch });
    expect(server.requests[0]!.status).toBe("denied");
  });

  it("members ls writes the cache; rename refreshes it", async () => {
    connectAsOwner();
    const server = new MembersServer();
    const cache = await refreshMembersCache(home, REPO_ID, { fetchImpl: server.fetch });
    expect(cache.self).toEqual({ memberId: OWNER_MEMBER, deviceId: OWNER_DEVICE });
    expect(readMembersCache(home, REPO_ID)).toEqual(cache);

    await renameMember(home, REPO_ID, "vp", "Vlad", { fetchImpl: server.fetch });
    expect(server.calls.find((c) => c.method === "PATCH")!.body).toEqual({ name: "Vlad" });
    expect(readMembersCache(home, REPO_ID)!.members[0]!.name).toBe("Vlad");
  });

  it("remove needs the name typed back, sends nothing without it, and refuses removing yourself", async () => {
    connectAsOwner();
    const server = new MembersServer();
    server.members.push({ memberId: "mem_b", name: "buddy", isOwner: false, removedAt: null, removedBy: null });

    const missing = await removeMember(home, REPO_ID, "buddy", undefined, { fetchImpl: server.fetch }).then(() => null, (e: unknown) => e);
    expect((missing as StapleError).message).toMatch(/--confirm buddy/);
    const wrong = await removeMember(home, REPO_ID, "buddy", "bud", { fetchImpl: server.fetch }).then(() => null, (e: unknown) => e);
    expect((wrong as StapleError).message).toMatch(/did not match/);
    const self = await removeMember(home, REPO_ID, "vp", "vp", { fetchImpl: server.fetch }).then(() => null, (e: unknown) => e);
    expect((self as StapleError).message).toMatch(/cannot remove yourself/);
    expect(server.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

    const removed = await removeMember(home, REPO_ID, "buddy", "buddy", { fetchImpl: server.fetch });
    expect(removed).toMatchObject({ memberId: "mem_b", name: "buddy" });
    expect(server.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([`/v1/repos/${REPO_ID}/members/mem_b`]);
    expect(readMembersCache(home, REPO_ID)!.members.find((m) => m.name === "buddy")!.removed).toBe(true);
  });
});

// ------------------------------------------------------------------ the cache lifecycle

describe("the members cache follows sync and disconnect", () => {
  /**
   * The full sync fake, with the members routes put in front of it. Capabilities gains
   * `members: true` only when `members` is on, as a newer Worker's does.
   */
  function syncDevice(members: { on: boolean; fail?: boolean }) {
    const sync = new FakeSyncServer({ repositoryId: REPO_ID });
    sync.enroll(OWNER_DEVICE, OWNER_TOKEN);
    const membersServer = new MembersServer();
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/members")) {
        if (members.fail) return new Response(JSON.stringify({ code: "unavailable", message: "down" }), { status: 503 });
        return membersServer.fetch(input, init);
      }
      const response = await sync.fetch(input, init);
      if (url.pathname === "/v1/capabilities" && members.on) {
        return new Response(JSON.stringify({ ...((await response.json()) as object), members: true }), { status: 200 });
      }
      return response;
    }) as unknown as typeof fetch;

    connectAsOwner();
    const db = openDb(":memory:");
    migrateWorkspace(db);
    writeStoredRepositoryId(db, REPO_ID);
    bindJournal(db, OWNER_DEVICE);
    const store = new WorkspaceStore(db, "test", "TST");
    store.createIssue({ title: "shared work", createdBy: "vp" });
    return {
      calls,
      store,
      sync,
      run: () => syncRepository(db, REPO_ID, { home, fetchImpl, sleep: async () => undefined }),
    };
  }

  it("a sync refused because the member was removed records it, so plain status says so", async () => {
    const device = syncDevice({ on: true });
    try {
      // The first request that carries the credential refuses with `removedBy`.
      device.sync.failNext = {
        route: "POST /v1/repos/:id/ops",
        times: 1,
        status: 403,
        code: "revoked",
        detail: { removedBy: "olga" },
      };
      const error = await device.run().then(() => null, (e: unknown) => e);
      expect((error as StapleError).code).toBe("revoked");

      // No network from here on: the local status reads the record.
      const local = localCloudStatus(home, REPO_ID);
      expect(local.state).toBe("removed");
      expect(local.removedBy).toBe("olga");
      expect(describeState(local)).toBe("removed from this workspace by olga — rejoin: staple cloud join");
      expect(readConnection(home, REPO_ID)!.removed?.by).toBe("olga");

      // The hub-wide list reads the same record.
      const row = hubCloudReport(home, {
        workspaces: [
          {
            slug: "shared",
            prefix: "TST",
            path: "/nonexistent/shared/.staple/staple.db",
            kind: "repo",
            available: true,
            identityDir: "/nonexistent/shared/.staple",
            recordsIdentityOnOpen: false,
            repositoryId: REPO_ID,
            problem: null,
          },
        ],
        crossLinks: 0,
      }).workspaces[0];
      expect(row).toMatchObject({ state: "removed", removedBy: "olga" });

      // Automatic sync stops trying.
      writeConnection(home, { ...readConnection(home, REPO_ID)!, auto: true });
      expect(
        autoSyncGate({ home, repositoryId: REPO_ID, trigger: "post-write" }),
      ).toMatchObject({ allowed: false, reason: "removed" });
    } finally {
      device.store.db.close();
    }
  });

  it("a plain revocation is not recorded as a removal", async () => {
    const device = syncDevice({ on: true });
    try {
      device.sync.failNext = { route: "POST /v1/repos/:id/ops", times: 1, status: 403, code: "revoked" };
      await device.run().then(() => null, (e: unknown) => e);
      expect(readConnection(home, REPO_ID)!.removed).toBeUndefined();
      expect(localCloudStatus(home, REPO_ID).state).toBe("manual");
    } finally {
      device.store.db.close();
    }
  });

  it("a successful sync writes the member list", async () => {
    const device = syncDevice({ on: true });
    try {
      await device.run();
      expect(device.calls.filter((c) => c.endsWith("/members"))).toHaveLength(1);
      expect(readMembersCache(home, REPO_ID)!.self.memberId).toBe(OWNER_MEMBER);
    } finally {
      device.store.db.close();
    }
  });

  it("an older Worker is not asked for one, and no cache appears", async () => {
    const device = syncDevice({ on: false });
    try {
      await device.run();
      expect(device.calls.filter((c) => c.endsWith("/members"))).toHaveLength(0);
      expect(readMembersCache(home, REPO_ID)).toBeNull();
    } finally {
      device.store.db.close();
    }
  });

  it("a member list that cannot be fetched never fails the sync", async () => {
    const device = syncDevice({ on: true, fail: true });
    try {
      const report = await device.run();
      expect(report.pushed.applied).toBeGreaterThan(0);
      expect(readMembersCache(home, REPO_ID)).toBeNull();
    } finally {
      device.store.db.close();
    }
  });

  it("disconnect deletes it", async () => {
    connectAsOwner();
    writeMembersCache(home, {
      version: 1,
      repositoryId: REPO_ID,
      fetchedAt: "2026-11-06T00:00:00.000Z",
      self: { memberId: OWNER_MEMBER, deviceId: OWNER_DEVICE },
      members: [{ memberId: OWNER_MEMBER, name: "vp", isOwner: true, removed: false, devices: [] }],
    });
    expect(existsSync(membersCachePath(home, REPO_ID))).toBe(true);
    performDisconnect(home, REPO_ID);
    expect(existsSync(membersCachePath(home, REPO_ID))).toBe(false);
  });
});

// ---------------------------------------------------------------------- removed status

describe("cloud status reports removal as its own state", () => {
  it("a revoked refusal carrying removedBy is `removed`, naming who and how to rejoin", async () => {
    connectAsOwner();
    const server = new MembersServer();
    // This machine's member was removed by someone else, who owns the workspace.
    server.members[0]!.isOwner = false;
    server.members.push({ memberId: "mem_o", name: "olga", isOwner: true, removedAt: null, removedBy: null });
    server.members[0]!.removedAt = server.now;
    server.members[0]!.removedBy = "olga";
    server.devices[0]!.revoked = true;

    const status = await refreshCloudStatus(home, REPO_ID, { fetchImpl: server.fetch });
    expect(status.state).toBe("removed");
    expect(status.removedBy).toBe("olga");
    expect(describeState(status)).toBe("removed from this workspace by olga — rejoin: staple cloud join");

    const db = openDb(":memory:");
    migrateWorkspace(db);
    try {
      const report = cloudSurfaceReport(status, db);
      expect(report.state).toBe("removed");
      expect(report.failure).toMatchObject({ code: "removed" });
      expect(report.failure!.summary).toContain("olga");
      expect(report.failure!.remedy).toContain("staple cloud join");
    } finally {
      db.close();
    }
  });

  it("a plain revocation stays `revoked`", async () => {
    connectAsOwner();
    const server = new MembersServer();
    server.devices[0]!.revoked = true;
    const status = await refreshCloudStatus(home, REPO_ID, { fetchImpl: server.fetch });
    expect(status.state).toBe("revoked");
  });
});

// ------------------------------------------------------------------- the shared endpoint

describe("share-endpoint round-trips through the manifest", () => {
  it("writes format 2 with the endpoint, reads it back, and withdraws to the original bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "staple-members-manifest-"));
    try {
      const original = readFileSync(ensureRepositoryManifest(dir).path, "utf8");
      const id = readRepositoryManifest(dir)!.repositoryId;

      const written = writeRepositoryEndpoint(dir, "https://sync.members.example/");
      expect(written).toEqual({ repositoryId: id, format: REPOSITORY_MANIFEST_ENDPOINT_FORMAT, endpoint: ENDPOINT });
      expect(readRepositoryManifest(dir)).toEqual(written);
      expect(readFileSync(repositoryManifestPath(dir), "utf8")).toBe(
        `{\n  "repositoryId": "${id}",\n  "format": 2,\n  "endpoint": "${ENDPOINT}"\n}\n`,
      );

      writeRepositoryEndpoint(dir, null);
      expect(readFileSync(repositoryManifestPath(dir), "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an endpoint at format 1 is refused, as every older build refuses it", () => {
    expect(() =>
      parseRepositoryManifest(JSON.stringify({ repositoryId: REPO_ID, format: 1, endpoint: ENDPOINT }), "/tmp/repository.json"),
    ).toThrow(/unexpected keys \(endpoint\).*"format": 2/s);
  });

  it("refuses an endpoint that is not https or that carries a credential", () => {
    for (const bad of ["http://sync.example.com", "https://user:pw@sync.example.com"]) {
      expect(() =>
        parseRepositoryManifest(renderRepositoryManifest({ repositoryId: REPO_ID, format: 2, endpoint: bad }), "/tmp/r.json"),
      ).toThrow(/not a usable sync service address/);
    }
  });

  it("refuses a format beyond 2 as a newer build's", () => {
    try {
      parseRepositoryManifest(JSON.stringify({ repositoryId: REPO_ID, format: 3 }), "/tmp/r.json");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as StapleError).code).toBe("conflict");
    }
  });
});

// ------------------------------------------------------------------------ the CLI

describe("the CLI", () => {
  const REPO_ROOT = process.cwd();
  const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const CLI = join(REPO_ROOT, "src", "cli.ts");

  function staple(cwd: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [TSX, CLI, ...args], {
      env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "cloud-members", NODE_NO_WARNINGS: "1" },
      encoding: "utf8",
      cwd,
    });
    if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(result.stderr ?? "")) {
      throw new Error(`the CLI child never started:\n${result.stderr}`);
    }
    return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it("`cloud --help` lists every new verb, and the agents-may-not list names them", () => {
    const result = staple(REPO_ROOT, "cloud", "--help");
    for (const verb of [
      "cloud join",
      "cloud requests",
      "cloud approve <code> --as",
      "cloud approve <code> --to",
      "cloud deny <code>",
      "cloud members [ls]",
      "cloud members rename",
      "cloud members remove",
      "cloud share-endpoint",
    ]) {
      expect(result.stdout).toContain(verb);
    }
    const agents = result.stdout.slice(result.stdout.indexOf("Agents may not"));
    for (const verb of ["join", "approve", "deny", "members rename", "members remove", "share-endpoint"]) {
      expect(agents).toContain(verb);
    }
  });

  it("share-endpoint previews, writes only with --yes, and join then finds the endpoint", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "staple-members-repo-"));
    try {
      process.env.STAPLE_HOME = home;
      const ws = initWorkspace({ dir: repoDir, slug: "members" });
      ws.store.db.close();
      const manifestPath = join(repoDir, ".staple", "repository.json");
      const id = (JSON.parse(readFileSync(manifestPath, "utf8")) as { repositoryId: string }).repositoryId;
      credentialStoreFor(home, "file").write(id, "stpl_x");
      writeConnection(home, {
        schemaVersion: 1, repositoryId: id, endpoint: ENDPOINT, deviceId: OWNER_DEVICE, label: "studio",
        credentialMechanism: "file", connectedAt: "2026-11-06T00:00:00.000Z", auto: false, backup: false, protocol: 4,
      });

      const preview = staple(repoDir, "cloud", "share-endpoint");
      expect(preview.status).toBe(2);
      expect(preview.stdout).toContain(ENDPOINT);
      expect(preview.stdout).toContain("NOT a credential");
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).not.toHaveProperty("endpoint");

      const written = staple(repoDir, "cloud", "share-endpoint", "--yes");
      expect(written.status, written.stderr).toBe(0);
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual({ repositoryId: id, format: 2, endpoint: ENDPOINT });

      // A teammate's join, without --endpoint and without --yes: the preview names the
      // shared endpoint and where it came from, and nothing is sent.
      const joined = staple(repoDir, "cloud", "join", "--credential-file");
      expect(joined.status).toBe(2);
      expect(joined.stdout).toContain(`${ENDPOINT}   (from .staple/repository.json)`);
      expect(joined.stderr).toContain("Nothing was sent");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------- wave 2 client gaps

describe("a recorded removal, re-admission and the owner hint", () => {
  it("a successful join clears a recorded removal", async () => {
    connectAsOwner();
    writeConnection(home, { ...readConnection(home, REPO_ID)!, removed: { by: "olga", at: "2026-11-06T00:00:00.000Z" } });
    expect(localCloudStatus(home, REPO_ID).state).toBe("removed");

    const server = new MembersServer();
    let code = "";
    const outcome = await performJoin(joinPreview(), {
      home,
      credential: { forceFile: true },
      fetchImpl: server.fetch,
      now: () => server.now,
      onCode: (ticket) => (code = ticket.code),
      sleep: async () => server.approve(code, { name: "buddy" }),
    });
    expect(outcome.status).toBe("joined");
    expect(readConnection(home, REPO_ID)!.removed).toBeUndefined();
    expect(localCloudStatus(home, REPO_ID).state).toBe("manual");
  });

  it("a refresh the service answers clears a stale recorded removal", async () => {
    connectAsOwner();
    writeConnection(home, { ...readConnection(home, REPO_ID)!, removed: { by: "olga", at: "2026-11-06T00:00:00.000Z" } });
    const server = new MembersServer();
    const status = await refreshCloudStatus(home, REPO_ID, { fetchImpl: server.fetch });
    expect(status.state).toBe("manual");
    expect(readConnection(home, REPO_ID)!.removed).toBeUndefined();
  });

  it("approve --to a REMOVED member says so and points at --as, sending no approval", async () => {
    connectAsOwner();
    const server = new MembersServer();
    server.members.push({ memberId: "mem_m", name: "marko", isOwner: false, removedAt: server.now, removedBy: "vp" });
    const created = await server.fetch(`${ENDPOINT}/v1/repos/${REPO_ID}/join-requests`, {
      method: "POST",
      body: JSON.stringify({ deviceId: "cccccccc-0000-4000-8000-000000000003", label: "marko-laptop", requestSecretSha256: "00" }),
    });
    const code = ((await created.json()) as { code: string }).code;

    const error = await approveRequest(home, REPO_ID, code, { toMember: "Marko" }, { fetchImpl: server.fetch }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as StapleError).code).toBe("validation");
    expect((error as StapleError).message).toContain("marko was removed from this workspace");
    expect((error as StapleError).message).toContain(`staple cloud approve ${code} --as marko`);
    expect(server.calls.filter((c) => c.path.endsWith("/approve"))).toHaveLength(0);
  });

  it("after a connect that made this device the owner named `owner`, says how to rename", async () => {
    connectAsOwner();
    const server = new MembersServer();
    server.members[0]!.name = "owner";
    const cache = await membersAfterConnect(home, REPO_ID, { members: true }, { fetchImpl: server.fetch });
    expect(ownerRenameHint(cache)).toBe(
      `You are this workspace's owner, listed as "owner". Rename with: staple cloud members rename owner <your name>`,
    );
    // Renamed already, not the owner, or an older service: no hint, and no request for the last.
    server.members[0]!.name = "vp";
    expect(ownerRenameHint(await membersAfterConnect(home, REPO_ID, { members: true }, { fetchImpl: server.fetch }))).toBeNull();
    const before = server.calls.length;
    expect(await membersAfterConnect(home, REPO_ID, {}, { fetchImpl: server.fetch })).toBeNull();
    expect(server.calls.length).toBe(before);
  });
});
