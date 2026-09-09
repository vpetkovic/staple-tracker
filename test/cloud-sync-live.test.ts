/**
 * The one test in this repository that talks to the deployed dev Worker.
 *
 * **Skipped unless `STAPLE_LIVE_SYNC=1`.** It is not part of any gate, it is not
 * run by `npm test` in CI or locally by default, and it is the only file here
 * that would make a real outbound request. Everything else about this lane runs
 * against `test/fixtures/fake-sync-server.ts` in-process.
 *
 * ## Why it exists at all
 *
 * The client sizes its push batches and its pull pages from what
 * `GET /v1/capabilities` advertises, never from a constant. That is the right
 * design and it has one failure mode a fake cannot catch: the fake advertises
 * what this lane believes the service advertises. If the deployed Worker's
 * numbers ever drift from the shapes this client parses — a renamed field, a
 * missing one — every in-process test still passes and the real client reads
 * `undefined` as a batch size.
 *
 * So this asserts the handshake against the thing that is actually running, and
 * nothing else. It performs no mutation, presents no credential, and needs none:
 * `/v1/capabilities` is the only unscoped route.
 *
 * ## Why it does not push
 *
 * Pushing needs an enrollment secret for a real repository, and a repository is
 * provisioned out of band by writing a row into D1 (`worker/README.md`). A test
 * that provisioned one would be creating durable remote state as a side effect of
 * `npm test`, which is not a thing a test suite should be able to do by accident.
 *
 * ```bash
 * STAPLE_LIVE_SYNC=1 npx vitest run test/cloud-sync-live.test.ts
 * ```
 */
import { describe, expect, it } from "vitest";
import { CLIENT_PROTOCOL, fetchCapabilities } from "../src/core/cloud/client.js";
import { parseEndpoint } from "../src/core/cloud/endpoint.js";

const LIVE = process.env.STAPLE_LIVE_SYNC === "1";
const ENDPOINT =
  process.env.STAPLE_LIVE_ENDPOINT ?? "https://staple-sync-dev.vptkvc.workers.dev";

describe.skipIf(!LIVE)("the deployed dev Worker", () => {
  it("advertises a capabilities document this client can size itself from", async () => {
    const capabilities = await fetchCapabilities(parseEndpoint(ENDPOINT), { timeoutMs: 20_000 });

    // Every field the client reads. A missing one is `undefined` arithmetic in
    // the batching loop, which is the failure this test exists to catch.
    expect(Number.isInteger(capabilities.protocol.min)).toBe(true);
    expect(Number.isInteger(capabilities.protocol.max)).toBe(true);
    expect(capabilities.maxBatchSize).toBeGreaterThan(0);
    expect(capabilities.maxOpBytes).toBeGreaterThan(0);
    expect(capabilities.maxPullLimit).toBeGreaterThan(0);
    expect(capabilities.defaultPullLimit).toBeGreaterThan(0);
    expect(capabilities.maxSnapshotPageSize).toBeGreaterThan(0);

    // And the protocol this build speaks is inside the range it advertises, so a
    // sync against it would negotiate rather than refuse.
    expect(capabilities.protocol.min).toBeLessThanOrEqual(CLIENT_PROTOCOL);
    expect(capabilities.protocol.max).toBeGreaterThanOrEqual(CLIENT_PROTOCOL);

    // The pull default must be reachable within the maximum, or the client's
    // clamp would silently ask for less than it was told it could have.
    expect(capabilities.defaultPullLimit).toBeLessThanOrEqual(capabilities.maxPullLimit);
  });

  it("refuses a scoped route without a credential, rather than answering it", async () => {
    // Not a mutation, and not authenticated: a 401 or 403 is the pass. What
    // would fail this is a 200 — a scoped route that answers an anonymous caller.
    const response = await fetch(
      `${ENDPOINT}/v1/repos/00000000-0000-4000-8000-000000000000/ops?limit=1`,
      { signal: AbortSignal.timeout(20_000) },
    );
    expect([401, 403]).toContain(response.status);
  });
});
