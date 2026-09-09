import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE,
  OTHER_REPO,
  REPO,
  call,
  envelope,
  expectError,
  jsonOf,
  pushOps,
  seedRepo,
} from "./helpers.js";

let token: string;

beforeEach(async () => {
  token = await seedRepo();
});

describe("authentication", () => {
  it("refuses a request with no credential", async () => {
    const response = await call(`/v1/repos/${REPO}/ops`, { token: undefined });
    await expectError(response, "auth", 401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("refuses an unknown credential", async () => {
    await expectError(await call(`/v1/repos/${REPO}/ops`, { token: "stpl_nope" }), "auth", 401);
  });

  it("refuses a malformed Authorization header", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/ops`, { headers: { Authorization: "Basic abc" } }),
      "auth",
      401,
    );
  });

  it("stores only a hash of the token, never the token", async () => {
    const rows = await env.DB.prepare(`SELECT token_sha256 FROM devices WHERE repo_id = ?1`)
      .bind(REPO)
      .all<{ token_sha256: ArrayBuffer }>();

    expect(rows.results).toHaveLength(1);
    const stored = new Uint8Array(rows.results[0]!.token_sha256);
    expect(stored.byteLength).toBe(32);

    // The stored bytes are the digest, and the plaintext appears nowhere in the row.
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    expect([...stored]).toEqual([...expected]);
    expect(new TextDecoder().decode(stored)).not.toContain("stpl_");
  });

  it("accepts the scheme case-insensitively, as HTTP requires", async () => {
    const response = await call(`/v1/repos/${REPO}/ops`, {
      headers: { Authorization: `bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });
});

describe("membership and repository scope", () => {
  it("refuses a credential scoped to another repository", async () => {
    const otherToken = await seedRepo(OTHER_REPO, "device-b");
    await expectError(
      await call(`/v1/repos/${REPO}/ops`, { token: otherToken, device: "device-b" }),
      "forbidden",
      403,
    );
  });

  it("refuses a Staple-Device header that disagrees with the credential", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/ops`, { token, device: "some-other-device" }),
      "forbidden",
      403,
    );
  });

  it("checks membership on every request, not once at connect", async () => {
    // Two requests with the same credential, with a revocation in between. The second
    // must fail — there is no cached session to outlive the revocation.
    expect((await call(`/v1/repos/${REPO}/ops`, { token })).status).toBe(200);
    await env.DB.prepare(`UPDATE devices SET revoked_at = ?2 WHERE repo_id = ?1`)
      .bind(REPO, Date.now())
      .run();
    await expectError(await call(`/v1/repos/${REPO}/ops`, { token }), "revoked", 403);
  });
});

describe("revocation", () => {
  it("makes a revoked device fail its very next request", async () => {
    const doomedToken = await seedRepo(REPO, "device-doomed");

    expect(
      (await call(`/v1/repos/${REPO}/ops`, { token: doomedToken, device: "device-doomed" }))
        .status,
    ).toBe(200);

    const revoke = await call(`/v1/repos/${REPO}/devices/device-doomed`, {
      method: "DELETE",
      token,
    });
    expect(revoke.status).toBe(200);

    // The very next request. Not the next minute, not after a cache expires.
    const after = await call(`/v1/repos/${REPO}/ops`, {
      token: doomedToken,
      device: "device-doomed",
    });
    const body = await expectError(after, "revoked", 403);
    // `revoked` rather than a bare `auth`, so the device is told the remedy.
    expect(body.message).toContain("re-connect");
  });

  it("also blocks a revoked device from pushing", async () => {
    const doomedToken = await seedRepo(REPO, "device-doomed");
    await call(`/v1/repos/${REPO}/devices/device-doomed`, { method: "DELETE", token });

    const response = await pushOps([envelope({ clientSeq: 1, deviceId: "device-doomed" })], {
      token: doomedToken,
      device: "device-doomed",
    });
    await expectError(response, "revoked", 403);
  });

  it("404s a revocation for a device that is not in this repository", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/devices/ghost`, { method: "DELETE", token }),
      "not_found",
      404,
    );
  });

  it("is idempotent when revoking twice", async () => {
    await seedRepo(REPO, "device-doomed");
    expect(
      (await call(`/v1/repos/${REPO}/devices/device-doomed`, { method: "DELETE", token })).status,
    ).toBe(200);
    expect(
      (await call(`/v1/repos/${REPO}/devices/device-doomed`, { method: "DELETE", token })).status,
    ).toBe(200);
  });
});

describe("GET /v1/repos/{repoId}/devices", () => {
  it("lists the repository's devices and never their credential hashes", async () => {
    await seedRepo(REPO, "device-b");
    const body = await jsonOf(await call(`/v1/repos/${REPO}/devices`, { token }));

    const ids = body.devices.map((d: any) => d.deviceId).sort();
    expect(ids).toEqual([DEVICE, "device-b"]);

    // `token_sha256` is not a usable credential, but it IS a verifier for an offline
    // guess, and the device list is the one response a compromised-but-not-yet-revoked
    // device can always read.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("sha256");
  });

  it("does not list another repository's devices", async () => {
    await seedRepo(OTHER_REPO, "device-elsewhere");
    const body = await jsonOf(await call(`/v1/repos/${REPO}/devices`, { token }));
    expect(body.devices.map((d: any) => d.deviceId)).not.toContain("device-elsewhere");
  });
});

describe("POST /v1/repos/{repoId}/connect", () => {
  it("mints a credential for a caller presenting the enrollment secret", async () => {
    const response = await call(`/v1/repos/${REPO}/connect`, {
      method: "POST",
      token: `enroll_${REPO}`,
      body: { deviceId: "device-new", label: "laptop" },
      device: null,
    });
    expect(response.status).toBe(200);

    const body = await jsonOf(response);
    expect(body.deviceId).toBe("device-new");
    expect(body.token).toMatch(/^stpl_[A-Za-z0-9_-]+$/);
    // The client sizes its batches from what connect hands back, so connect carries
    // the same capabilities the handshake route does.
    expect(body.capabilities.maxBatchSize).toBe(25);

    // And the minted credential actually works.
    const used = await call(`/v1/repos/${REPO}/ops`, {
      token: body.token,
      device: "device-new",
    });
    expect(used.status).toBe(200);
  });

  it("lets an existing device enroll another device", async () => {
    const response = await call(`/v1/repos/${REPO}/connect`, {
      method: "POST",
      token,
      body: { deviceId: "device-second" },
      device: null,
    });
    expect(response.status).toBe(200);
  });

  it("refuses an unknown enrollment credential", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/connect`, {
        method: "POST",
        token: "stpl_wrong",
        body: { deviceId: "device-new" },
        device: null,
      }),
      "forbidden",
      403,
    );
  });

  it("never auto-creates a repository for an id it does not know", async () => {
    const unknown = "99999999-9999-4999-8999-999999999999";
    await expectError(
      await call(`/v1/repos/${unknown}/connect`, {
        method: "POST",
        token: `enroll_${unknown}`,
        body: { deviceId: "device-new" },
        device: null,
      }),
      // `forbidden`, not `not_found`: whether an id is registered here is not
      // something an unauthenticated caller gets to enumerate.
      "forbidden",
      403,
    );

    const repo = await env.DB.prepare(`SELECT repo_id FROM repos WHERE repo_id = ?1`)
      .bind(unknown)
      .first();
    expect(repo).toBeNull();
  });

  it("returns a different token on every connect", async () => {
    const first = await jsonOf(
      await call(`/v1/repos/${REPO}/connect`, {
        method: "POST",
        token: `enroll_${REPO}`,
        body: { deviceId: "device-x" },
        device: null,
      }),
    );
    const second = await jsonOf(
      await call(`/v1/repos/${REPO}/connect`, {
        method: "POST",
        token: `enroll_${REPO}`,
        body: { deviceId: "device-x" },
        device: null,
      }),
    );
    expect(first.token).not.toBe(second.token);
    // Re-connecting rotates the credential: the old one stops working.
    const old = await call(`/v1/repos/${REPO}/ops`, { token: first.token, device: "device-x" });
    await expectError(old, "auth", 401);
  });
});
