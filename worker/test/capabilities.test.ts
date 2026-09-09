import { describe, expect, it } from "vitest";
import { call, jsonOf } from "./helpers.js";

/**
 * `/v1/capabilities` is the handshake. The client sizes its batches from THIS, never
 * from a constant compiled into itself — the ceilings differ by plan, and a client
 * that hardcodes the paid number fails permanently on the free one.
 */
describe("GET /v1/capabilities", () => {
  it("advertises the protocol range and every limit a client must size against", async () => {
    const response = await call("/v1/capabilities");
    expect(response.status).toBe(200);

    const body = await jsonOf(response);
    expect(body).toMatchObject({
      protocol: { min: 1, max: 1 },
      maxOpBytes: 512 * 1024,
      maxPullLimit: 500,
      defaultPullLimit: 200,
    });
    // The test config declares PLAN = "free" in wrangler.toml. A push costs N+4 D1
    // statements against a free ceiling of 50 queries per invocation, so 25.
    expect(body.maxBatchSize).toBe(25);
  });

  it("is answerable without a credential", async () => {
    // The only unscoped route, deliberately: a client calls it precisely because it
    // does not yet know how to talk to this server.
    const response = await call("/v1/capabilities", { token: undefined });
    expect(response.status).toBe(200);
  });

  it("is answerable without a protocol header", async () => {
    // Otherwise the handshake is a chicken-and-egg: you would need to know the
    // supported version in order to ask what the supported version is.
    const response = await call("/v1/capabilities", { protocol: null });
    expect(response.status).toBe(200);
  });

  it("rejects a non-GET", async () => {
    const response = await call("/v1/capabilities", { method: "POST", body: {} });
    expect(response.status).toBe(400);
  });

  it("404s an unknown route without disclosing anything about it", async () => {
    const response = await call("/v1/nope");
    expect(response.status).toBe(404);
    expect((await jsonOf(response)).code).toBe("not_found");
  });
});
