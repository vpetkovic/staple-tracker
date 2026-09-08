import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { REPO, call, expectError, jsonOf, seedRepo } from "./helpers.js";

let token: string;
let tokenB: string;

beforeEach(async () => {
  token = await seedRepo(REPO, "device-a");
  tokenB = await seedRepo(REPO, "device-b");
});

function acquire(entityId: string, holder: string, opts: { token: string; device: string }) {
  return call(`/v1/repos/${REPO}/leases`, {
    method: "POST",
    body: { entityId, holder, ttlSeconds: 300 },
    ...opts,
  });
}

describe("POST /v1/repos/{repoId}/leases — acquire", () => {
  it("grants a lease with a fencing token and a server-authoritative expiry", async () => {
    const before = Date.now();
    const response = await acquire("STA-1", "opus-s4", { token, device: "device-a" });
    expect(response.status).toBe(200);

    const { lease } = await jsonOf(response);
    expect(lease.entityId).toBe("STA-1");
    expect(lease.holder).toBe("opus-s4");
    expect(lease.deviceId).toBe("device-a");
    expect(lease.fencingToken).toBeGreaterThan(0);
    // Expiry is computed from the SERVER clock. Client clocks have no authority here.
    expect(lease.expiresAt).toBeGreaterThanOrEqual(before + 300 * 1000 - 5_000);
  });

  it("produces one winner and one non-retryable conflict when two devices race", async () => {
    const [first, second] = await Promise.all([
      acquire("STA-1", "agent-a", { token, device: "device-a" }),
      acquire("STA-1", "agent-b", { token: tokenB, device: "device-b" }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = first.status === 409 ? first : second;
    const body = await expectError(loser, "conflict", 409);
    // Not retryable: retrying would be a spin against a lease that is, as far as this
    // device knows, legitimately held. Takeover stays explicit.
    expect(body.retryable).toBe(false);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM leases WHERE repo_id = ?1 AND entity_id = 'STA-1'`,
    )
      .bind(REPO)
      .first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("refuses a second acquire while the lease is live", async () => {
    await acquire("STA-1", "agent-a", { token, device: "device-a" });
    const second = await acquire("STA-1", "agent-b", { token: tokenB, device: "device-b" });
    const body = await expectError(second, "conflict", 409);
    expect(body.holder).toBe("agent-a");
  });

  it("issues strictly increasing fencing tokens across entities and acquisitions", async () => {
    const a = await jsonOf(await acquire("STA-1", "agent-a", { token, device: "device-a" }));
    const b = await jsonOf(await acquire("STA-2", "agent-a", { token, device: "device-a" }));
    expect(b.lease.fencingToken).toBeGreaterThan(a.lease.fencingToken);
  });

  it("lets an expired lease be taken, without a sweeper", async () => {
    await acquire("STA-1", "agent-a", { token, device: "device-a" });
    // Expire it in place. There is no background reaper: the acquire that needs the
    // slot clears it, which is what keeps takeover explicit.
    await env.DB.prepare(`UPDATE leases SET expires_at = 1 WHERE repo_id = ?1`).bind(REPO).run();

    const taken = await acquire("STA-1", "agent-b", { token: tokenB, device: "device-b" });
    expect(taken.status).toBe(200);
    const { lease } = await jsonOf(taken);
    expect(lease.holder).toBe("agent-b");
  });

  it("rejects a ttl outside the permitted range", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/leases`, {
        method: "POST",
        token,
        device: "device-a",
        body: { entityId: "STA-1", holder: "a", ttlSeconds: 99_999 },
      }),
      "validation",
      400,
    );
  });
});

describe("lease renewal", () => {
  it("extends the expiry for the holder presenting the current token", async () => {
    const { lease } = await jsonOf(await acquire("STA-1", "agent-a", { token, device: "device-a" }));

    const renewed = await call(`/v1/repos/${REPO}/leases/STA-1/renew`, {
      method: "POST",
      token,
      device: "device-a",
      body: { fencingToken: lease.fencingToken, ttlSeconds: 600 },
    });
    expect(renewed.status).toBe(200);
    expect((await jsonOf(renewed)).lease.expiresAt).toBeGreaterThan(lease.expiresAt);
  });

  it("refuses a stale fencing token", async () => {
    const { lease } = await jsonOf(await acquire("STA-1", "agent-a", { token, device: "device-a" }));

    const response = await call(`/v1/repos/${REPO}/leases/STA-1/renew`, {
      method: "POST",
      token,
      device: "device-a",
      body: { fencingToken: lease.fencingToken - 1 },
    });
    // A stale token can never write, however convinced its holder is.
    await expectError(response, "conflict", 409);
  });

  it("refuses a renewal from a device that is not the holder", async () => {
    const { lease } = await jsonOf(await acquire("STA-1", "agent-a", { token, device: "device-a" }));

    const response = await call(`/v1/repos/${REPO}/leases/STA-1/renew`, {
      method: "POST",
      token: tokenB,
      device: "device-b",
      body: { fencingToken: lease.fencingToken },
    });
    await expectError(response, "conflict", 409);
  });

  it("refuses to renew a lease that has already expired", async () => {
    const { lease } = await jsonOf(await acquire("STA-1", "agent-a", { token, device: "device-a" }));
    await env.DB.prepare(`UPDATE leases SET expires_at = 1 WHERE repo_id = ?1`).bind(REPO).run();

    const response = await call(`/v1/repos/${REPO}/leases/STA-1/renew`, {
      method: "POST",
      token,
      device: "device-a",
      body: { fencingToken: lease.fencingToken },
    });
    await expectError(response, "conflict", 409);
  });

  it("refuses a token that was superseded by a takeover", async () => {
    const first = await jsonOf(await acquire("STA-1", "agent-a", { token, device: "device-a" }));
    await env.DB.prepare(`UPDATE leases SET expires_at = 1 WHERE repo_id = ?1`).bind(REPO).run();
    const second = await jsonOf(
      await acquire("STA-1", "agent-b", { token: tokenB, device: "device-b" }),
    );
    expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);

    // The original holder still believes it holds the lease. It does not.
    const response = await call(`/v1/repos/${REPO}/leases/STA-1/renew`, {
      method: "POST",
      token,
      device: "device-a",
      body: { fencingToken: first.lease.fencingToken },
    });
    const body = await expectError(response, "conflict", 409);
    expect(body.currentFencingToken).toBe(second.lease.fencingToken);
  });
});

describe("lease release", () => {
  it("releases when the holder presents the fencing token", async () => {
    const { lease } = await jsonOf(await acquire("STA-1", "agent-a", { token, device: "device-a" }));

    const released = await call(`/v1/repos/${REPO}/leases/STA-1`, {
      method: "DELETE",
      token,
      device: "device-a",
      body: { fencingToken: lease.fencingToken },
    });
    expect(released.status).toBe(200);

    // And the slot is free again.
    expect((await acquire("STA-1", "agent-b", { token: tokenB, device: "device-b" })).status).toBe(
      200,
    );
  });

  it("refuses a release without the fencing token", async () => {
    await acquire("STA-1", "agent-a", { token, device: "device-a" });
    await expectError(
      await call(`/v1/repos/${REPO}/leases/STA-1`, {
        method: "DELETE",
        token,
        device: "device-a",
        body: { fencingToken: 99_999 },
      }),
      "conflict",
      409,
    );
  });

  it("refuses a release by a device that does not hold the lease", async () => {
    const { lease } = await jsonOf(await acquire("STA-1", "agent-a", { token, device: "device-a" }));
    await expectError(
      await call(`/v1/repos/${REPO}/leases/STA-1`, {
        method: "DELETE",
        token: tokenB,
        device: "device-b",
        body: { fencingToken: lease.fencingToken },
      }),
      "conflict",
      409,
    );
  });
});

/**
 * The third member of "expired, stolen or revoked".
 *
 * Expiry and takeover are the lease code's own business and are covered above.
 * Revocation is not — it is enforced one layer earlier, at authentication — and
 * that is exactly why it is worth asserting here rather than assuming. A holder
 * whose device was revoked still has a valid, current, un-superseded fencing
 * token; the lease predicate would be perfectly happy with it. The only thing
 * standing between that device and a write is the auth check, and this is the
 * test that says so.
 */
describe("a revoked holder cannot finish the work it holds", () => {
  it("refuses to renew a live lease held by a device that was revoked", async () => {
    const granted = await acquire("STA-1", "agent-a", { token, device: "device-a" });
    const { lease } = await jsonOf(granted);

    await env.DB.prepare(
      `UPDATE devices SET revoked_at = ?3 WHERE repo_id = ?1 AND device_id = ?2`,
    )
      .bind(REPO, "device-a", Date.now())
      .run();

    const response = await call(`/v1/repos/${REPO}/leases/STA-1/renew`, {
      method: "POST",
      body: { fencingToken: lease.fencingToken, ttlSeconds: 300 },
      token,
      device: "device-a",
    });
    await expectError(response, "revoked", 403);

    // The lease is untouched. A revoked device cannot renew it and cannot make
    // it disappear either; it stands until the service expires it or somebody
    // else takes it over explicitly.
    const row = await env.DB.prepare(
      `SELECT fencing_token AS token FROM leases WHERE repo_id = ?1 AND entity_id = 'STA-1'`,
    )
      .bind(REPO)
      .first<{ token: number }>();
    expect(row!.token).toBe(lease.fencingToken);
  });

  it("refuses to release a live lease held by a device that was revoked", async () => {
    const granted = await acquire("STA-1", "agent-a", { token, device: "device-a" });
    const { lease } = await jsonOf(granted);

    await env.DB.prepare(
      `UPDATE devices SET revoked_at = ?3 WHERE repo_id = ?1 AND device_id = ?2`,
    )
      .bind(REPO, "device-a", Date.now())
      .run();

    const response = await call(`/v1/repos/${REPO}/leases/STA-1`, {
      method: "DELETE",
      body: { fencingToken: lease.fencingToken },
      token,
      device: "device-a",
    });
    await expectError(response, "revoked", 403);

    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM leases WHERE repo_id = ?1 AND entity_id = 'STA-1'`,
    )
      .bind(REPO)
      .first<{ n: number }>();
    expect(row!.n).toBe(1);
  });
});

describe("lease repository scoping", () => {
  it("refuses a lease request against another repository", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    await seedRepo(other, "device-elsewhere");
    await expectError(
      await call(`/v1/repos/${other}/leases`, {
        method: "POST",
        token,
        device: "device-a",
        body: { entityId: "STA-1", holder: "a" },
      }),
      "forbidden",
      403,
    );
  });
});
