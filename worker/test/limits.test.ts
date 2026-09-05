import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVICE, REPO, call, envelope, expectError, jsonOf, pushOps, seedRepo } from "./helpers.js";

let token: string;

beforeEach(async () => {
  token = await seedRepo();
});

describe("protocol negotiation", () => {
  it("accepts the supported version", async () => {
    expect((await call(`/v1/repos/${REPO}/ops`, { token, protocol: 1 })).status).toBe(200);
  });

  it("refuses a version above the supported range with the range attached", async () => {
    const body = await expectError(
      await call(`/v1/repos/${REPO}/ops`, { token, protocol: 2 }),
      "protocol_unsupported",
      426,
    );
    expect(body.min).toBe(1);
    expect(body.max).toBe(1);
    expect(body.retryable).toBe(false);
  });

  it("refuses a version below the supported range", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/ops`, { token, protocol: 0 }),
      "protocol_unsupported",
      426,
    );
  });

  it("refuses an unsupported version BEFORE any write", async () => {
    // The check runs before the body is read and before any statement is prepared, so
    // there is no partial batch and no half-applied page to reason about.
    const response = await pushOps(
      [envelope({ clientSeq: 1, protocol: 2 }), envelope({ clientSeq: 2, protocol: 2 })],
      { token, protocol: 2 },
    );
    await expectError(response, "protocol_unsupported", 426);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops`).first<{ n: number }>();
    expect(count!.n).toBe(0);

    const repo = await env.DB.prepare(`SELECT last_seq FROM repos WHERE repo_id = ?1`)
      .bind(REPO)
      .first<{ last_seq: number }>();
    expect(repo!.last_seq).toBe(0);
  });

  it("refuses an unsupported version before authentication, so it is not an auth oracle", async () => {
    const response = await call(`/v1/repos/${REPO}/ops`, { token: "stpl_bogus", protocol: 9 });
    await expectError(response, "protocol_unsupported", 426);
  });

  it("refuses an envelope whose protocol disagrees with the request header", async () => {
    await expectError(
      await pushOps([envelope({ clientSeq: 1, protocol: 2 })], { token, protocol: 1 }),
      "validation",
      400,
    );
  });

  it("refuses a non-integer protocol header", async () => {
    await expectError(
      await call(`/v1/repos/${REPO}/ops`, { token, headers: { "Staple-Protocol": "one" } }),
      "validation",
      400,
    );
  });
});

describe("payload and batch limits", () => {
  it("refuses a batch larger than the advertised maximum", async () => {
    const capabilities = await jsonOf(await call("/v1/capabilities"));
    const tooMany = Array.from({ length: capabilities.maxBatchSize + 1 }, (_, i) =>
      envelope({ clientSeq: i + 1 }),
    );

    const body = await expectError(
      await pushOps(tooMany, { token }),
      "payload_too_large",
      413,
    );
    expect(body.maxBatchSize).toBe(capabilities.maxBatchSize);

    // Never a silent truncation and never a partially accepted batch.
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops`).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("accepts a batch of exactly the advertised maximum", async () => {
    // A client that sized itself from the handshake must never be refused for doing
    // exactly what it was told.
    const capabilities = await jsonOf(await call("/v1/capabilities"));
    const exact = Array.from({ length: capabilities.maxBatchSize }, (_, i) =>
      envelope({ clientSeq: i + 1, entityId: `issue-${i}` }),
    );
    const response = await pushOps(exact, { token });
    expect(response.status).toBe(200);
    expect((await jsonOf(response)).results).toHaveLength(capabilities.maxBatchSize);
  });

  it("refuses a single operation payload above the 512 KiB cap", async () => {
    const body = await expectError(
      await pushOps(
        [envelope({ clientSeq: 1, payload: { blob: "x".repeat(600 * 1024) } })],
        { token },
      ),
      "payload_too_large",
      413,
    );
    expect(body.maxBytes).toBe(512 * 1024);
  });

  it("requires Content-Length, because the size check cannot wait for the parsed body", async () => {
    // The free plan allows 10 ms of CPU per request. A limit enforced after
    // `await request.json()` is enforced too late to help.
    const response = await call(`/v1/repos/${REPO}/ops`, {
      method: "POST",
      token,
      headers: { "Content-Type": "application/json" },
    });
    await expectError(response, "validation", 400);
  });

  it("refuses an oversized body from the header alone, before parsing it", async () => {
    // A LYING Content-Length. The refusal must come from the header, so a body that
    // was never sent still cannot be parsed.
    const response = await call(`/v1/repos/${REPO}/ops`, {
      method: "POST",
      token,
      body: { protocol: 1, deviceId: DEVICE, ops: [] },
      headers: { "Content-Length": String(999 * 1024 * 1024) },
    });
    await expectError(response, "payload_too_large", 413);
  });
});

describe("rate limiting", () => {
  it("returns rate_limited with Retry-After when the limiter refuses", async () => {
    // The real binding is per-colo and eventually consistent, so driving it to its
    // threshold in a test would be both slow and flaky. What matters is the contract
    // the Worker presents when the limiter says no: a typed 429, retryable, with a
    // bounded backoff hint.
    const limited = { limit: async () => ({ success: false }) };
    const response = await (
      await import("../src/index.js")
    ).default.fetch(
      new Request(`https://sync.test/v1/repos/${REPO}/ops`, {
        headers: { Authorization: `Bearer ${token}`, "Staple-Protocol": "1" },
      }),
      { ...env, SYNC_LIMITER: limited } as any,
    );

    const body = await expectError(response, "rate_limited", 429);
    // The one class of error a client SHOULD retry, with a bounded backoff.
    expect(body.retryable).toBe(true);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("serves requests normally when no limiter binding is present", async () => {
    // Rate limiting is abuse control, not an authorization control. A missing binding
    // must fail open rather than 500 the service; authorization is the credential
    // lookup, which is never optional.
    const response = await (
      await import("../src/index.js")
    ).default.fetch(
      new Request(`https://sync.test/v1/repos/${REPO}/ops`, {
        headers: { Authorization: `Bearer ${token}`, "Staple-Protocol": "1" },
      }),
      { ...env, SYNC_LIMITER: undefined } as any,
    );
    expect(response.status).toBe(200);
  });
});

describe("TLS", () => {
  it("refuses a plaintext request to a non-loopback host", async () => {
    const response = await (
      await import("../src/index.js")
    ).default.fetch(new Request(`http://sync.example.com/v1/capabilities`), env as any);
    await expectError(response, "forbidden", 403);
  });

  it("permits plaintext on loopback, which is how wrangler dev --local serves", async () => {
    const response = await (
      await import("../src/index.js")
    ).default.fetch(new Request(`http://127.0.0.1:8787/v1/capabilities`), env as any);
    expect(response.status).toBe(200);
  });

  it("sets HSTS and nosniff on every response", async () => {
    const response = await call("/v1/capabilities");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
