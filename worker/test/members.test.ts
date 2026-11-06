/**
 * Members and device-flow pairing, through the real router (`SELF.fetch`).
 *
 * Covers the design's wire contract for join requests, approval, the member list,
 * rename and remove; the owner/member power table; the refusal of the legacy connect
 * paths once a workspace has members; a hub repository left exactly as it was; and the
 * 0008 backfill, run from the shipped migration file.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { OTHER_REPO, REPO, call, expectError, jsonOf, sha256Hex } from "./helpers.js";

let ipCounter = 0;
let ip = "";

beforeEach(() => {
  // A fresh client address per test, so the per-IP limiter on the join routes never
  // carries one test's calls into another's budget.
  ipCounter += 1;
  ip = `203.0.113.${ipCounter % 250}`;
});

async function seedBareRepo(repoId = REPO, vocabulary: "workspace" | "hub" | null = "workspace"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, enroll_sha256, created_at, vocabulary)
     VALUES (?1, 1, 0, 0, ?2, ?3, ?4)`,
  )
    .bind(repoId, await sha256Hex(`enroll_${repoId}`), Date.now(), vocabulary)
    .run();
}

async function connectWithSecret(deviceId: string, repoId = REPO): Promise<Response> {
  return call(`/v1/repos/${repoId}/connect`, {
    method: "POST",
    token: `enroll_${repoId}`,
    body: { deviceId, label: deviceId },
    device: null,
  });
}

interface Owner {
  token: string;
  memberId: string;
}

/** A workspace whose first device connected with the enrollment secret: the owner. */
async function workspaceWithOwner(): Promise<Owner> {
  await seedBareRepo();
  const response = await connectWithSecret("owner-laptop");
  expect(response.status).toBe(200);
  const token = (await jsonOf(response)).token as string;
  const members = await jsonOf(await call(`/v1/repos/${REPO}/members`, { token, device: null }));
  return { token, memberId: members.self.memberId };
}

function hex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Joiner {
  secret: string;
  requestId: string;
  code: string;
  deviceId: string;
}

async function requestJoin(deviceId: string, repoId = REPO): Promise<Joiner> {
  const secret = `jrs_${crypto.randomUUID()}${crypto.randomUUID()}`;
  const response = await call(`/v1/repos/${repoId}/join-requests`, {
    method: "POST",
    body: { deviceId, label: `${deviceId} label`, requestSecretSha256: hex(await sha256Hex(secret)) },
    device: null,
    headers: { "CF-Connecting-IP": ip },
  });
  expect(response.status).toBe(200);
  const body = await jsonOf(response);
  return { secret, requestId: body.requestId, code: body.code, deviceId };
}

function poll(joiner: Pick<Joiner, "requestId" | "secret">, repoId = REPO): Promise<Response> {
  return call(`/v1/repos/${repoId}/join-requests/${joiner.requestId}`, {
    token: joiner.secret,
    device: null,
    headers: { "CF-Connecting-IP": ip },
  });
}

function approve(token: string, code: string, body: unknown): Promise<Response> {
  return call(`/v1/repos/${REPO}/join-requests/${code}/approve`, { method: "POST", token, body, device: null });
}

function deny(token: string, code: string): Promise<Response> {
  return call(`/v1/repos/${REPO}/join-requests/${code}/deny`, { method: "POST", token, body: {}, device: null });
}

function members(token: string): Promise<Response> {
  return call(`/v1/repos/${REPO}/members`, { token, device: null });
}

/** Admit a new person end to end, and return their device token and member id. */
async function admit(owner: Owner, name: string, deviceId: string): Promise<{ token: string; memberId: string }> {
  const joiner = await requestJoin(deviceId);
  const approved = await jsonOf(await approve(owner.token, joiner.code, { newMember: { name } }));
  const collected = await jsonOf(await poll(joiner));
  expect(collected.status).toBe("approved");
  return { token: collected.token, memberId: approved.member.memberId };
}

describe("capabilities", () => {
  it("advertises members", async () => {
    const body = await jsonOf(await call("/v1/capabilities"));
    expect(body.members).toBe(true);
  });
});

describe("the first connect of a repository with no members", () => {
  it("creates the owner member, named owner, holding that device", async () => {
    const owner = await workspaceWithOwner();
    const body = await jsonOf(await members(owner.token));
    expect(body).toEqual({
      self: { memberId: owner.memberId, deviceId: "owner-laptop" },
      members: [
        {
          memberId: owner.memberId,
          name: "owner",
          isOwner: true,
          removed: false,
          devices: [{ deviceId: "owner-laptop", label: "owner-laptop", lastSeenAt: expect.any(Number), revoked: false }],
        },
      ],
    });
  });

  it("adopts the repository's member-less devices into the owner", async () => {
    // An unclaimed repository with a device from before members existed.
    await seedBareRepo(REPO, null);
    await env.DB.prepare(
      `INSERT INTO devices (repo_id, device_id, token_sha256, label, created_at) VALUES (?1, 'old-device', ?2, 'old', 1)`,
    )
      .bind(REPO, await sha256Hex("stpl_old"))
      .run();
    const token = (await jsonOf(await connectWithSecret("new-device"))).token as string;

    const body = await jsonOf(await members(token));
    expect(body.members).toHaveLength(1);
    expect(body.members[0].devices.map((d: any) => d.deviceId).sort()).toEqual(["new-device", "old-device"]);
  });
});

describe("legacy connect once a workspace has members", () => {
  it("refuses the enrollment secret", async () => {
    await workspaceWithOwner();
    const body = await expectError(await connectWithSecret("someone-else"), "forbidden", 403);
    expect(body.message).toBe("this workspace uses member approval; run `staple cloud join`");
    const row = await env.DB.prepare(`SELECT 1 FROM devices WHERE repo_id = ?1 AND device_id = 'someone-else'`)
      .bind(REPO)
      .first();
    expect(row).toBeNull();
  });

  it("refuses a working device token", async () => {
    const owner = await workspaceWithOwner();
    const body = await expectError(
      await call(`/v1/repos/${REPO}/connect`, {
        method: "POST",
        token: owner.token,
        body: { deviceId: "second-machine" },
        device: null,
      }),
      "forbidden",
      403,
    );
    expect(body.message).toBe("this workspace uses member approval; run `staple cloud join`");
  });

  it("still answers a wrong credential as before, without saying the workspace uses members", async () => {
    await workspaceWithOwner();
    const body = await expectError(
      await call(`/v1/repos/${REPO}/connect`, { method: "POST", token: "stpl_wrong", body: { deviceId: "x" }, device: null }),
      "forbidden",
      403,
    );
    expect(body.message).toBe("not a member of this repository");
  });
});

describe("a hub repository is unchanged", () => {
  it("keeps both connect paths, makes no members, refuses join requests and member routes", async () => {
    await seedBareRepo(REPO, "hub");
    const first = await connectWithSecret("hub-a");
    expect(first.status).toBe(200);
    const firstBody = await jsonOf(first);
    expect(Object.keys(firstBody).sort()).toEqual(["capabilities", "deviceId", "epoch", "protocol", "repoId", "token"]);

    // Again with the secret, and by an existing device token: both still admitted.
    expect((await connectWithSecret("hub-b")).status).toBe(200);
    const byToken = await call(`/v1/repos/${REPO}/connect`, {
      method: "POST",
      token: firstBody.token,
      body: { deviceId: "hub-c" },
      device: null,
    });
    expect(byToken.status).toBe(200);

    const memberRows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE repo_id = ?1`).bind(REPO).first<{ n: number }>();
    expect(memberRows?.n).toBe(0);
    const memberIds = await env.DB.prepare(`SELECT member_id FROM devices WHERE repo_id = ?1`).bind(REPO).all();
    expect(memberIds.results.every((r: any) => r.member_id === null)).toBe(true);

    await expectError(
      await call(`/v1/repos/${REPO}/join-requests`, {
        method: "POST",
        body: { deviceId: "j", requestSecretSha256: "ab".repeat(32) },
        device: null,
        headers: { "CF-Connecting-IP": ip },
      }),
      "forbidden",
      403,
    );
    const listed = await expectError(await members(firstBody.token), "forbidden", 403);
    expect(listed.members).toBe("unavailable");

    // Any hub device may still revoke any other.
    const hubB = await call(`/v1/repos/${REPO}/devices/hub-b`, { method: "DELETE", token: firstBody.token, device: null });
    expect(hubB.status).toBe(200);
  });
});

describe("join, approve, collect", () => {
  it("admits a new person: request, list, approve, collect once", async () => {
    const owner = await workspaceWithOwner();
    const joiner = await requestJoin("ana-laptop");
    expect(joiner.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const pending = await jsonOf(await poll(joiner));
    expect(pending).toEqual({ status: "pending", expiresAt: expect.any(Number) });

    const listed = await jsonOf(await call(`/v1/repos/${REPO}/join-requests`, { token: owner.token, device: null }));
    expect(listed).toEqual([
      {
        requestId: joiner.requestId,
        code: joiner.code,
        label: "ana-laptop label",
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
      },
    ]);

    // Typed by a person: lower case, no dash, an O for a zero and an L for a one.
    const typed = joiner.code.replace("-", "").toLowerCase().replace(/0/g, "o").replace(/1/g, "l");
    const approved = await approve(owner.token, typed, { newMember: { name: "Ana" } });
    expect(approved.status).toBe(200);
    const approvedBody = await jsonOf(approved);
    expect(approvedBody).toEqual({ requestId: joiner.requestId, member: { memberId: expect.any(String), name: "Ana" } });

    const collected = await jsonOf(await poll(joiner));
    expect(collected).toMatchObject({
      status: "approved",
      token: expect.stringMatching(/^stpl_/),
      deviceId: "ana-laptop",
      member: { memberId: approvedBody.member.memberId, name: "Ana" },
      repoId: REPO,
      epoch: 1,
    });
    expect(collected.capabilities.members).toBe(true);

    // The token works, and is Ana's.
    const ops = await call(`/v1/repos/${REPO}/ops`, { token: collected.token, device: "ana-laptop" });
    expect(ops.status).toBe(200);
    const list = await jsonOf(await members(collected.token));
    expect(list.self).toEqual({ memberId: approvedBody.member.memberId, deviceId: "ana-laptop" });
    const ana = list.members.find((m: any) => m.name === "Ana");
    expect(ana).toMatchObject({ isOwner: false, removed: false, devices: [{ deviceId: "ana-laptop", revoked: false }] });

    // Collected once. A second read gets no token.
    const again = await jsonOf(await poll(joiner));
    expect(again).toEqual({ status: "collected", expiresAt: expect.any(Number) });
    // ...and wrote nothing: the token handed out first still works.
    expect((await call(`/v1/repos/${REPO}/ops`, { token: collected.token, device: null })).status).toBe(200);

    // And the request is gone from the pending list.
    expect(await jsonOf(await call(`/v1/repos/${REPO}/join-requests`, { token: owner.token, device: null }))).toEqual([]);
  });

  it("adds a device to an existing member, approved by that member", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");

    const joiner = await requestJoin("ana-phone");
    const approved = await approve(ana.token, joiner.code, { memberId: ana.memberId });
    expect(approved.status).toBe(200);
    expect((await jsonOf(approved)).member).toEqual({ memberId: ana.memberId, name: "Ana" });

    const collected = await jsonOf(await poll(joiner));
    expect(collected.member).toEqual({ memberId: ana.memberId, name: "Ana" });
    const list = await jsonOf(await members(owner.token));
    const devices = list.members.find((m: any) => m.memberId === ana.memberId).devices.map((d: any) => d.deviceId);
    expect(devices.sort()).toEqual(["ana-laptop", "ana-phone"]);
  });

  it("lets the owner add a device to any member", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");
    const joiner = await requestJoin("ana-desktop");
    expect((await approve(owner.token, joiner.code, { memberId: ana.memberId })).status).toBe(200);
    expect((await jsonOf(await poll(joiner))).member.memberId).toBe(ana.memberId);
  });

  it("denies", async () => {
    const owner = await workspaceWithOwner();
    const joiner = await requestJoin("stranger");
    const denied = await deny(owner.token, joiner.code);
    expect(await jsonOf(denied)).toEqual({ requestId: joiner.requestId });
    expect(await jsonOf(await poll(joiner))).toEqual({ status: "denied", expiresAt: expect.any(Number) });
    await expectError(await approve(owner.token, joiner.code, { newMember: { name: "S" } }), "not_found", 404);
  });

  it("expires", async () => {
    const owner = await workspaceWithOwner();
    const joiner = await requestJoin("late");
    await env.DB.prepare(`UPDATE join_requests SET expires_at = ?2 WHERE request_id = ?1`)
      .bind(joiner.requestId, Date.now() - 1)
      .run();
    expect((await jsonOf(await poll(joiner))).status).toBe("expired");
    expect(await jsonOf(await call(`/v1/repos/${REPO}/join-requests`, { token: owner.token, device: null }))).toEqual([]);
    await expectError(await approve(owner.token, joiner.code, { newMember: { name: "Late" } }), "not_found", 404);
    // Nothing was created for it.
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE repo_id = ?1`).bind(REPO).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("an approved request that expires uncollected is not collectable", async () => {
    const owner = await workspaceWithOwner();
    const joiner = await requestJoin("slow");
    await approve(owner.token, joiner.code, { newMember: { name: "Slow" } });
    await env.DB.prepare(`UPDATE join_requests SET expires_at = ?2 WHERE request_id = ?1`)
      .bind(joiner.requestId, Date.now() - 1)
      .run();
    const body = await jsonOf(await poll(joiner));
    expect(body).toEqual({ status: "expired", expiresAt: expect.any(Number) });
    const device = await env.DB.prepare(`SELECT 1 FROM devices WHERE device_id = 'slow'`).first();
    expect(device).toBeNull();
  });

  it("refuses a wrong request secret, and an unknown request, alike", async () => {
    await workspaceWithOwner();
    const joiner = await requestJoin("ana-laptop");
    await expectError(await poll({ requestId: joiner.requestId, secret: "jrs_wrong" }), "auth", 401);
    await expectError(await poll({ requestId: crypto.randomUUID(), secret: joiner.secret }), "auth", 401);
    // Not even a request of another repository with the right secret.
    await expectError(await poll(joiner, OTHER_REPO), "auth", 401);
  });

  it("caps pending requests at five per repository", async () => {
    const owner = await workspaceWithOwner();
    const joiners: Joiner[] = [];
    for (let i = 0; i < 5; i += 1) joiners.push(await requestJoin(`d${i}`));

    const sixth = await call(`/v1/repos/${REPO}/join-requests`, {
      method: "POST",
      body: { deviceId: "d5", requestSecretSha256: "cd".repeat(32) },
      device: null,
      headers: { "CF-Connecting-IP": ip },
    });
    const body = await expectError(sixth, "rate_limited", 429);
    expect(body.pendingCap).toBe(5);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);

    // Deciding one frees a slot.
    await deny(owner.token, joiners[0]!.code);
    await requestJoin("d6");
  });

  it("refuses join requests for an unknown repository and for one with no members yet", async () => {
    await seedBareRepo(REPO, "workspace");
    for (const repoId of [REPO, OTHER_REPO]) {
      const body = await expectError(
        await call(`/v1/repos/${repoId}/join-requests`, {
          method: "POST",
          body: { deviceId: "j", requestSecretSha256: "ab".repeat(32) },
          device: null,
          headers: { "CF-Connecting-IP": ip },
        }),
        "forbidden",
        403,
      );
      expect(body.message).toBe("this repository does not accept join requests");
    }
  });

  it("refuses to approve a device id that is already active here", async () => {
    const owner = await workspaceWithOwner();
    const joiner = await requestJoin("owner-laptop");
    await expectError(await approve(owner.token, joiner.code, { newMember: { name: "Thief" } }), "conflict", 409);
  });

  it("lets a member take back their own revoked device id, but not someone else's", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");
    const bo = await admit(owner, "Bo", "bo-laptop");
    // Ana revokes her own laptop, then rejoins it.
    expect((await call(`/v1/repos/${REPO}/devices/ana-laptop`, { method: "DELETE", token: ana.token, device: null })).status).toBe(200);
    const back = await requestJoin("ana-laptop");
    expect((await approve(owner.token, back.code, { memberId: ana.memberId })).status).toBe(200);
    const ana2 = (await jsonOf(await poll(back))).token as string;
    expect((await call(`/v1/repos/${REPO}/ops`, { token: ana2, device: null })).status).toBe(200);

    // Bo's laptop, revoked, cannot be approved into Ana by Ana.
    await call(`/v1/repos/${REPO}/devices/bo-laptop`, { method: "DELETE", token: owner.token, device: null });
    const stolen = await requestJoin("bo-laptop");
    await expectError(await approve(ana2, stolen.code, { memberId: ana.memberId }), "forbidden", 403);
    void bo;
  });

  it("validates the approve body", async () => {
    const owner = await workspaceWithOwner();
    const joiner = await requestJoin("x");
    await expectError(await approve(owner.token, joiner.code, {}), "validation", 400);
    await expectError(
      await approve(owner.token, joiner.code, { newMember: { name: "A" }, memberId: owner.memberId }),
      "validation",
      400,
    );
    await expectError(await approve(owner.token, joiner.code, { newMember: { name: "  " } }), "validation", 400);
    await expectError(await approve(owner.token, "short", { newMember: { name: "A" } }), "validation", 400);
  });
});

describe("the power table", () => {
  it("a member cannot admit a new person", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");
    const joiner = await requestJoin("stranger");
    const body = await expectError(await approve(ana.token, joiner.code, { newMember: { name: "Mallory" } }), "forbidden", 403);
    expect(body.message).toBe("only the workspace owner can admit a new person");
    // Nor add a device to someone else.
    await expectError(await approve(ana.token, joiner.code, { memberId: owner.memberId }), "forbidden", 403);
    expect((await jsonOf(await poll(joiner))).status).toBe("pending");
  });

  it("a member cannot remove another member", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");
    const bo = await admit(owner, "Bo", "bo-laptop");
    await expectError(
      await call(`/v1/repos/${REPO}/members/${bo.memberId}`, { method: "DELETE", token: ana.token, device: null }),
      "forbidden",
      403,
    );
    await expectError(
      await call(`/v1/repos/${REPO}/members/${owner.memberId}`, { method: "DELETE", token: ana.token, device: null }),
      "forbidden",
      403,
    );
  });

  it("a member cannot revoke another member's device, only their own", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");
    const body = await expectError(
      await call(`/v1/repos/${REPO}/devices/owner-laptop`, { method: "DELETE", token: ana.token, device: null }),
      "forbidden",
      403,
    );
    expect(body.message).toBe("a member can only revoke their own devices");
    expect((await call(`/v1/repos/${REPO}/ops`, { token: owner.token, device: null })).status).toBe(200);

    // The owner can revoke Ana's.
    const anaPhone = await requestJoin("ana-phone");
    await approve(ana.token, anaPhone.code, { memberId: ana.memberId });
    await poll(anaPhone);
    expect((await call(`/v1/repos/${REPO}/devices/ana-phone`, { method: "DELETE", token: owner.token, device: null })).status).toBe(200);
    // And Ana her own.
    expect((await call(`/v1/repos/${REPO}/devices/ana-laptop`, { method: "DELETE", token: ana.token, device: null })).status).toBe(200);
  });

  it("the owner cannot revoke their own last active device", async () => {
    const owner = await workspaceWithOwner();
    const revoke = (deviceId: string, token: string) =>
      call(`/v1/repos/${REPO}/devices/${deviceId}`, { method: "DELETE", token, device: null });

    const refused = await expectError(await revoke("owner-laptop", owner.token), "conflict", 409);
    expect(refused.message).toBe("this is the owner's last device; add another device first");
    expect((await call(`/v1/repos/${REPO}/ops`, { token: owner.token, device: null })).status).toBe(200);

    // With a second device the first may go, and then the second is the last one.
    const desktop = await requestJoin("owner-desktop");
    expect((await approve(owner.token, desktop.code, { memberId: owner.memberId })).status).toBe(200);
    const desktopToken = (await jsonOf(await poll(desktop))).token as string;
    expect((await revoke("owner-laptop", desktopToken)).status).toBe(200);
    await expectError(await revoke("owner-desktop", desktopToken), "conflict", 409);
    expect((await call(`/v1/repos/${REPO}/ops`, { token: desktopToken, device: null })).status).toBe(200);
  });

  it("a member cannot restore or purge; the owner can", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");
    await env.DB.prepare(`UPDATE repos SET backup_enabled = 1 WHERE repo_id = ?1`).bind(REPO).run();

    const restore = await expectError(
      await call(`/v1/repos/${REPO}/backups/some-backup/restore`, { method: "POST", token: ana.token, body: { confirm: REPO }, device: null }),
      "forbidden",
      403,
    );
    expect(restore.message).toBe("only the workspace owner can restore it");
    const purge = await expectError(
      await call(`/v1/repos/${REPO}`, { method: "DELETE", token: ana.token, body: { confirm: REPO }, device: null }),
      "forbidden",
      403,
    );
    expect(purge.message).toBe("only the workspace owner can purge it");
    expect(await env.DB.prepare(`SELECT 1 FROM repos WHERE repo_id = ?1`).bind(REPO).first()).not.toBeNull();

    // The owner passes the owner check: the restore is then refused for the backup it names.
    await expectError(
      await call(`/v1/repos/${REPO}/backups/some-backup/restore`, { method: "POST", token: owner.token, body: { confirm: REPO }, device: null }),
      "not_found",
      404,
    );
    const purged = await call(`/v1/repos/${REPO}`, { method: "DELETE", token: owner.token, body: { confirm: REPO }, device: null });
    expect(purged.status).toBe(200);
    for (const table of ["members", "join_requests", "devices", "repos"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id = ?1`).bind(REPO).first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
  });
});

describe("rename", () => {
  it("renames self, and the owner renames anyone; a member cannot rename another", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");

    const self = await call(`/v1/repos/${REPO}/members/${owner.memberId}`, { method: "PATCH", token: owner.token, body: { name: "VP" }, device: null });
    expect(await jsonOf(self)).toEqual({ memberId: owner.memberId, name: "VP" });

    await expectError(
      await call(`/v1/repos/${REPO}/members/${owner.memberId}`, { method: "PATCH", token: ana.token, body: { name: "Boss" }, device: null }),
      "forbidden",
      403,
    );
    expect((await call(`/v1/repos/${REPO}/members/${ana.memberId}`, { method: "PATCH", token: owner.token, body: { name: "Ana M" }, device: null })).status).toBe(200);
    expect((await call(`/v1/repos/${REPO}/members/${ana.memberId}`, { method: "PATCH", token: ana.token, body: { name: "Ana" }, device: null })).status).toBe(200);
  });

  it("keeps names unique per repository, case-insensitively and beyond ASCII", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ćiro", "ciro-laptop");

    // "ćIRO" against "Ćiro" is a clash only a Unicode-aware fold sees: SQLite's lower()
    // folds ASCII alone.
    await expectError(
      await call(`/v1/repos/${REPO}/members/${owner.memberId}`, { method: "PATCH", token: owner.token, body: { name: "ćIRO" }, device: null }),
      "conflict",
      409,
    );
    await expectError(
      await call(`/v1/repos/${REPO}/members/${ana.memberId}`, { method: "PATCH", token: ana.token, body: { name: "OWNER" }, device: null }),
      "conflict",
      409,
    );
    // A new member cannot take a taken name either.
    const joiner = await requestJoin("other");
    await expectError(await approve(owner.token, joiner.code, { newMember: { name: "Owner" } }), "conflict", 409);
    // Changing only the case of one's own name is fine.
    expect((await call(`/v1/repos/${REPO}/members/${ana.memberId}`, { method: "PATCH", token: ana.token, body: { name: "ĆIRO" }, device: null })).status).toBe(200);
    // Unique per repository, not globally.
    expect((await jsonOf(await members(owner.token))).members.map((m: any) => m.name).sort()).toEqual(["owner", "ĆIRO"].sort());
  });
});

describe("remove", () => {
  it("revokes every device, marks removed, and says who removed them", async () => {
    const owner = await workspaceWithOwner();
    await call(`/v1/repos/${REPO}/members/${owner.memberId}`, { method: "PATCH", token: owner.token, body: { name: "VP" }, device: null });
    const ana = await admit(owner, "Ana", "ana-laptop");
    const phone = await requestJoin("ana-phone");
    await approve(ana.token, phone.code, { memberId: ana.memberId });
    const anaPhone = (await jsonOf(await poll(phone))).token as string;

    const removed = await call(`/v1/repos/${REPO}/members/${ana.memberId}`, { method: "DELETE", token: owner.token, device: null });
    expect(await jsonOf(removed)).toEqual({ memberId: ana.memberId, removed: true });

    for (const token of [ana.token, anaPhone]) {
      const body = await expectError(await call(`/v1/repos/${REPO}/ops`, { token, device: null }), "revoked", 403);
      expect(body.message).toBe("removed from this workspace by VP");
      expect(body.removedBy).toBe("VP");
    }

    const list = await jsonOf(await members(owner.token));
    const entry = list.members.find((m: any) => m.memberId === ana.memberId);
    expect(entry.removed).toBe(true);
    expect(entry.devices.every((d: any) => d.revoked)).toBe(true);

    // Idempotent.
    expect((await call(`/v1/repos/${REPO}/members/${ana.memberId}`, { method: "DELETE", token: owner.token, device: null })).status).toBe(200);
  });

  it("a plainly revoked device keeps the plain message", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");
    await call(`/v1/repos/${REPO}/devices/ana-laptop`, { method: "DELETE", token: ana.token, device: null });
    const body = await expectError(await call(`/v1/repos/${REPO}/ops`, { token: ana.token, device: null }), "revoked", 403);
    expect(body.message).toBe("this device was revoked; re-connect required");
    expect(body.removedBy).toBeUndefined();
  });

  it("the owner cannot remove themselves", async () => {
    const owner = await workspaceWithOwner();
    await expectError(
      await call(`/v1/repos/${REPO}/members/${owner.memberId}`, { method: "DELETE", token: owner.token, device: null }),
      "forbidden",
      403,
    );
  });

  it("voids an approval the removed member had not collected", async () => {
    const owner = await workspaceWithOwner();
    const ana = await admit(owner, "Ana", "ana-laptop");
    const phone = await requestJoin("ana-phone");
    await approve(ana.token, phone.code, { memberId: ana.memberId });
    await call(`/v1/repos/${REPO}/members/${ana.memberId}`, { method: "DELETE", token: owner.token, device: null });
    const body = await jsonOf(await poll(phone));
    expect(body).toEqual({ status: "denied", expiresAt: expect.any(Number) });
    expect(await env.DB.prepare(`SELECT 1 FROM devices WHERE device_id = 'ana-phone'`).first()).toBeNull();
  });
});

describe("the 0008 backfill, run from the shipped migration", () => {
  async function runBackfill(): Promise<void> {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0008"));
    expect(migration).toBeDefined();
    const statements = migration!.queries.filter(
      (q) => /INSERT INTO members/.test(q) || /^\s*(--[^\n]*\n\s*)*UPDATE devices/.test(q),
    );
    expect(statements).toHaveLength(2);
    for (const sql of statements) await env.DB.prepare(sql).run();
  }

  async function device(repoId: string, deviceId: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO devices (repo_id, device_id, token_sha256, label, created_at) VALUES (?1, ?2, ?3, NULL, 1)`,
    )
      .bind(repoId, deviceId, await sha256Hex(`stpl_${repoId}_${deviceId}`))
      .run();
  }

  it("makes one owner per workspace with devices, assigns its devices, and leaves hubs alone", async () => {
    const WS_EMPTY = "33333333-3333-4333-8333-333333333333";
    const UNCLAIMED = "44444444-4444-4444-8444-444444444444";
    await seedBareRepo(REPO, "workspace");
    await seedBareRepo(OTHER_REPO, "hub");
    await seedBareRepo(WS_EMPTY, "workspace");
    await seedBareRepo(UNCLAIMED, null);
    await device(REPO, "a");
    await device(REPO, "b");
    await device(OTHER_REPO, "h");
    await device(UNCLAIMED, "u");

    await runBackfill();
    // Re-running it changes nothing: no second owner.
    await runBackfill();

    const all = await env.DB.prepare(`SELECT repo_id, member_id, name, is_owner, removed_at FROM members`).all<any>();
    expect(all.results).toHaveLength(1);
    const [owner] = all.results;
    expect(owner).toMatchObject({ repo_id: REPO, name: "owner", is_owner: 1, removed_at: null });
    expect(owner.member_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const devices = await env.DB.prepare(`SELECT repo_id, device_id, member_id FROM devices ORDER BY device_id`).all<any>();
    expect(devices.results).toEqual([
      { repo_id: REPO, device_id: "a", member_id: owner.member_id },
      { repo_id: REPO, device_id: "b", member_id: owner.member_id },
      { repo_id: OTHER_REPO, device_id: "h", member_id: null },
      { repo_id: UNCLAIMED, device_id: "u", member_id: null },
    ]);

    // The backfilled workspace now uses member approval, and its devices see their owner.
    const response = await call(`/v1/repos/${REPO}/members`, { token: `stpl_${REPO}_a`, device: null });
    expect((await jsonOf(response)).self).toEqual({ memberId: owner.member_id, deviceId: "a" });
    await expectError(await connectWithSecret("c"), "forbidden", 403);
  });
});
