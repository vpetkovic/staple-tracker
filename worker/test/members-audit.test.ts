/**
 * The five findings of the cross-vendor audit of the members code, each reproduced first.
 *
 * Two of them are races between requests, which `SELF.fetch` cannot interleave on its own.
 * Those are driven through the Worker's own `fetch` with its D1 binding wrapped so that one
 * statement's read stalls while another complete request runs, which is exactly the
 * interleaving the audit describes. Nothing else about the request is faked.
 */
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { sha256, type Session } from "../src/auth.js";
import { assertOwnerForRecovery } from "../src/members.js";

/** The fold the Worker stores names under (members.ts `nameKey`), restated so this file states the rule. */
const nameKey = (name: string) => name.normalize("NFKC").toLowerCase();
import { DEVICE, ORIGIN, REPO, call, expectError, jsonOf, sha256Hex } from "./helpers.js";

let ipCounter = 0;
let ip = "";
beforeEach(() => {
  ipCounter += 1;
  ip = `198.51.100.${ipCounter % 250}`;
});

async function seedBareRepo(vocabulary: "workspace" | "hub" | null = "workspace"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, enroll_sha256, created_at, vocabulary)
     VALUES (?1, 1, 0, 0, ?2, ?3, ?4)`,
  )
    .bind(REPO, await sha256Hex(`enroll_${REPO}`), Date.now(), vocabulary)
    .run();
}

function connectRequest(deviceId: string, token = `enroll_${REPO}`): Request {
  const body = JSON.stringify({ deviceId, label: deviceId });
  return new Request(`${ORIGIN}/v1/repos/${REPO}/connect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Staple-Protocol": "1",
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(body).length),
    },
    body,
  });
}

async function connect(deviceId: string): Promise<string> {
  const response = await SELF.fetch(connectRequest(deviceId));
  expect(response.status).toBe(200);
  return (await jsonOf(response)).token as string;
}

function hex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requestJoin(deviceId: string): Promise<{ secret: string; requestId: string; code: string }> {
  const secret = `jrs_${crypto.randomUUID()}`;
  const response = await call(`/v1/repos/${REPO}/join-requests`, {
    method: "POST",
    body: { deviceId, label: deviceId, requestSecretSha256: hex(await sha256Hex(secret)) },
    device: null,
    headers: { "CF-Connecting-IP": ip },
  });
  expect(response.status).toBe(200);
  const body = await jsonOf(response);
  return { secret, requestId: body.requestId, code: body.code };
}

function poll(joiner: { requestId: string; secret: string }): Promise<Response> {
  return call(`/v1/repos/${REPO}/join-requests/${joiner.requestId}`, {
    token: joiner.secret,
    device: null,
    headers: { "CF-Connecting-IP": ip },
  });
}

function approve(token: string, code: string, body: unknown): Promise<Response> {
  return call(`/v1/repos/${REPO}/join-requests/${code}/approve`, { method: "POST", token, body, device: null });
}

async function selfMemberId(token: string): Promise<string> {
  return (await jsonOf(await call(`/v1/repos/${REPO}/members`, { token, device: null }))).self.memberId as string;
}

async function admit(ownerToken: string, name: string, deviceId: string): Promise<{ token: string; memberId: string }> {
  const joiner = await requestJoin(deviceId);
  const approved = await jsonOf(await approve(ownerToken, joiner.code, { newMember: { name } }));
  const collected = await jsonOf(await poll(joiner));
  return { token: collected.token as string, memberId: approved.member.memberId as string };
}

/**
 * The D1 binding, with ONE statement's read stalled: when a statement whose SQL contains
 * `marker` is read, `meanwhile` runs to completion first, and the read then returns what
 * it saw before it — a request that read, stalled, and carried on.
 */
function stallingDb(db: D1Database, marker: (sql: string) => boolean, meanwhile: () => Promise<void>): D1Database {
  let fired = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!marker(sql)) return statement;
          return new Proxy(statement, {
            get(inner, key) {
              if (key === "bind") {
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  return new Proxy(bound, {
                    get(b, k) {
                      const read = (method: "first" | "all") => async (...args: unknown[]) => {
                        const result = await (b[method] as (...a: unknown[]) => Promise<unknown>)(...args);
                        if (!fired) {
                          fired = true;
                          await meanwhile();
                        }
                        return result;
                      };
                      if (k === "first") return read("first");
                      if (k === "all") return read("all");
                      const value = Reflect.get(b, k);
                      return typeof value === "function" ? value.bind(b) : value;
                    },
                  });
                };
              }
              const value = Reflect.get(inner, key);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("finding 1: an in-flight request cannot inherit owner powers", () => {
  it("resolves the member from the session's own credential, not from its device id", async () => {
    await seedBareRepo();
    const ownerToken = await connect("owner-laptop");
    const ownerId = await selfMemberId(ownerToken);
    const ana = await admit(ownerToken, "Ana", "ana-laptop");

    // Ana's request is authenticated now...
    const stale: Session = {
      repoId: REPO,
      deviceId: "ana-laptop",
      epoch: 1,
      lastSeq: 0,
      vocabulary: "workspace",
      digest: await sha256(ana.token),
    };
    // ...and before it acts, ana-laptop is revoked and its id re-collected into the owner.
    await call(`/v1/repos/${REPO}/devices/ana-laptop`, { method: "DELETE", token: ownerToken, device: null });
    const back = await requestJoin("ana-laptop");
    expect((await approve(ownerToken, back.code, { memberId: ownerId })).status).toBe(200);
    expect((await jsonOf(await poll(back))).status).toBe("approved");

    // The old credential must not act as the owner.
    await expect(assertOwnerForRecovery(env, stale, "purge")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("finding 2: a delayed legacy connect cannot overwrite the owner's token", () => {
  const repoRead = (sql: string) => sql.includes("has_members") && sql.includes("enroll_sha256");

  it("a stalled first connect for the same device is refused, and the owner's token survives", async () => {
    await seedBareRepo();
    let ownerToken = "";
    const db = stallingDb(env.DB, repoRead, async () => {
      ownerToken = await connect("dev-a");
    });
    const stalled = await worker.fetch(connectRequest("dev-a"), { ...env, DB: db } as never);
    await expectError(stalled, "forbidden", 403);

    expect((await call(`/v1/repos/${REPO}/ops`, { token: ownerToken, device: null })).status).toBe(200);
    const owners = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE repo_id = ?1 AND is_owner = 1`).bind(REPO).first<{ n: number }>();
    expect(owners?.n).toBe(1);
  });

  it("two first connects for different devices end with one owner, and the late one is refused", async () => {
    await seedBareRepo();
    const db = stallingDb(env.DB, repoRead, async () => {
      await connect("dev-a");
    });
    const stalled = await worker.fetch(connectRequest("dev-b"), { ...env, DB: db } as never);
    await expectError(stalled, "forbidden", 403);
    const devices = await env.DB.prepare(`SELECT device_id FROM devices WHERE repo_id = ?1`).bind(REPO).all<{ device_id: string }>();
    expect(devices.results.map((d) => d.device_id)).toEqual(["dev-a"]);
    const members = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE repo_id = ?1`).bind(REPO).first<{ n: number }>();
    expect(members?.n).toBe(1);
  });
});

describe("finding 3: collect applies approve's device-ownership rule", () => {
  it("a second approval for the same device id cannot move it to another member at collect", async () => {
    await seedBareRepo();
    const ownerToken = await connect("owner-laptop");
    const ana = await admit(ownerToken, "Ana", "ana-laptop");
    const bo = await admit(ownerToken, "Bo", "bo-laptop");

    // Two requests for one unused device id: the owner approves one into Ana, and Bo, a
    // member, approves the other into himself — allowed, the id is unused at approval.
    const first = await requestJoin("shared-x");
    const second = await requestJoin("shared-x");
    expect((await approve(ownerToken, first.code, { memberId: ana.memberId })).status).toBe(200);
    expect((await approve(bo.token, second.code, { memberId: bo.memberId })).status).toBe(200);

    // Ana collects, uses it, and revokes it. Bo's collect must not take it and its history.
    expect((await jsonOf(await poll(first))).status).toBe("approved");
    await call(`/v1/repos/${REPO}/devices/shared-x`, { method: "DELETE", token: ana.token, device: null });
    await expectError(await poll(second), "conflict", 409);
    const row = await env.DB.prepare(`SELECT member_id, revoked_at FROM devices WHERE repo_id = ?1 AND device_id = 'shared-x'`)
      .bind(REPO)
      .first<{ member_id: string; revoked_at: number | null }>();
    expect(row?.member_id).toBe(ana.memberId);
    expect(row?.revoked_at).not.toBeNull();
  });
});

describe("finding 4: members never bind on a hub", () => {
  function registration(index: number): Record<string, unknown> {
    return {
      opId: `reg-${index}`,
      repoId: REPO,
      protocol: 2,
      schema: 12,
      entity: "registration",
      entityId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      verb: "create",
      baseVersion: null,
      payload: { format: 1, slug: `ws-${index}`, prefix: `W${index}`, kind: "repo", addedAt: "2026-09-10T00:00:00.000Z" },
      deviceId: "hub-a",
      actor: "opus-audit",
      clientSeq: index,
      createdAt: "2026-09-10T00:00:00.000Z",
    };
  }

  it("a repository first claimed as a hub drops the owner its first connect made, and acts as a hub", async () => {
    await seedBareRepo(null);
    const hubA = await connect("hub-a");
    // The first connect of an unclaimed repository made an owner, as it must for a workspace.
    const pushed = await call(`/v1/repos/${REPO}/ops`, {
      method: "POST",
      token: hubA,
      protocol: 2,
      device: "hub-a",
      body: { protocol: 2, deviceId: "hub-a", ops: [registration(1)] },
    });
    expect(pushed.status, JSON.stringify(await pushed.clone().json())).toBe(200);

    const members = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE repo_id = ?1`).bind(REPO).first<{ n: number }>();
    expect(members?.n).toBe(0);
    const bound = await env.DB.prepare(`SELECT COUNT(*) AS n FROM devices WHERE repo_id = ?1 AND member_id IS NOT NULL`).bind(REPO).first<{ n: number }>();
    expect(bound?.n).toBe(0);

    // A hub's devices connect by the secret again, and any one may revoke any other, the
    // last one included: there is no owner on a hub.
    const hubB = await connect("hub-b");
    expect((await call(`/v1/repos/${REPO}/devices/hub-a`, { method: "DELETE", token: hubB, device: null })).status).toBe(200);
    expect((await call(`/v1/repos/${REPO}/devices/hub-b`, { method: "DELETE", token: hubB, device: null })).status).toBe(200);
  });
});

describe("finding 5: names are unique under a Unicode-aware fold, in the database itself", () => {
  it("the unique index refuses two names that differ only by a non-ASCII case", async () => {
    await seedBareRepo();
    const insert = (id: string, name: string) =>
      env.DB.prepare(
        `INSERT INTO members (repo_id, member_id, name, name_key, is_owner, created_at, removed_at)
         VALUES (?1, ?2, ?3, ?4, 0, 1, NULL)`,
      )
        .bind(REPO, id, name, nameKey(name))
        .run();
    await insert("m-1", "Ćiro");
    await expect(insert("m-2", "ćIRO")).rejects.toThrow(/UNIQUE/);
    expect(nameKey("Ｃiro")).toBe(nameKey("ciro"));
  });

  it("an approval whose name check read stale still cannot commit a second Ćiro", async () => {
    await seedBareRepo();
    const ownerToken = await connect("owner-laptop");
    const joiner = await requestJoin("other-laptop");
    // The approval reads the names before Ćiro exists, then Ćiro is admitted, then it writes.
    // The approval's read of who holds a name: a SELECT on members, by repository.
    const nameRead = (sql: string) => /^\s*SELECT/.test(sql) && /FROM members WHERE repo_id = \?1/.test(sql) && sql.includes("removed_at");
    const db = stallingDb(env.DB, nameRead, async () => {
      await admit(ownerToken, "Ćiro", "ciro-laptop");
    });
    const body = JSON.stringify({ newMember: { name: "ćIRO" } });
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v1/repos/${REPO}/join-requests/${joiner.code}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Staple-Protocol": "1",
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(body).length),
        },
        body,
      }),
      { ...env, DB: db } as never,
    );
    await expectError(response, "conflict", 409);
    const named = await env.DB.prepare(`SELECT name FROM members WHERE repo_id = ?1 AND name_key = ?2`).bind(REPO, nameKey("Ćiro")).all();
    expect(named.results).toHaveLength(1);
  });
});

// Keep DEVICE referenced: the shared helpers default to it for the Staple-Device header.
void DEVICE;
