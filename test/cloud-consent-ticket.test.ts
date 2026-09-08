/**
 * The consent ticket — how preview-then-consent survives an HTTP boundary.
 *
 * On the command line the property is an import graph: `preview.ts` cannot reach
 * `client.ts`, and every function in `connect.ts` takes an already-shown preview
 * as its first argument. Over HTTP the equivalent is the pair of route shapes,
 * and this file pins the piece that makes them work — `src/core/cloud/consent.ts`.
 *
 * The claim being tested is: **a client cannot connect without having been
 * handed, in a prior response, the description of what it is connecting to.**
 * `test/ui-cloud-settings.test.ts` proves it at the routes; this proves the
 * mechanism underneath, including the parts a route test cannot reach without a
 * clock (expiry) or a second process (a concurrent connect).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_TTL_MS,
  ConsentTicketStore,
  MAX_OUTSTANDING_CONSENTS,
  previewDigest,
} from "../src/core/cloud/consent.js";
import { buildConnectPreview } from "../src/core/cloud/preview.js";
import type { ConnectPreview } from "../src/core/cloud/preview.js";
import { StapleError } from "../src/core/types.js";
import { describeViolations, installNetworkSpy } from "./fixtures/network-spy.js";

const REPO = "0e77fa01-1111-2222-3333-444444444444";
const ENDPOINT = "https://staple-sync-dev.example.workers.dev";

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-consent-home-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A real preview, built the way the route builds it. `forceFile` so no keychain is touched. */
function preview(overrides: Partial<ConnectPreview> = {}): ConnectPreview {
  const built = buildConnectPreview({
    home,
    repositoryId: REPO,
    endpoint: ENDPOINT,
    credential: { forceFile: true },
  });
  return { ...built, ...overrides };
}

/** The identity rebuild: the world did not move between mint and redeem. */
const unchanged = (stored: ConnectPreview) => stored;

describe("the digest, which is what 'the same preview' means", () => {
  it("is stable for the same preview and different for any field a human is shown", () => {
    const base = preview();
    expect(previewDigest(base)).toBe(previewDigest(preview()));

    const changed: Array<[string, ConnectPreview]> = [
      ["endpoint", preview({ endpoint: { origin: "https://elsewhere.example", host: "elsewhere.example", loopback: false } })],
      ["repositoryId", preview({ repositoryId: "aaaaaaaa-1111-2222-3333-444444444444" })],
      ["deviceId", preview({ deviceId: "dddddddd-1111-2222-3333-444444444444" })],
      ["label", preview({ label: "somebody else's laptop" })],
      ["credentialMechanism", preview({ credentialMechanism: "keychain" })],
      ["credentialFallbackReason", preview({ credentialFallbackReason: "the keychain is locked" })],
      ["alreadyConnected", preview({ alreadyConnected: true })],
      ["existingEndpoint", preview({ existingEndpoint: "https://old.example" })],
    ];
    for (const [field, variant] of changed) {
      expect(previewDigest(variant), `${field} did not move the digest`).not.toBe(previewDigest(base));
    }
  });

  it("computes without touching the network", () => {
    const spy = installNetworkSpy();
    try {
      spy.selfCheck();
      previewDigest(preview());
      expect(spy.violations, describeViolations(spy.violations)).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });
});

describe("minting and redeeming", () => {
  it("round-trips: a ticket minted from a preview redeems to that preview", () => {
    const store = new ConsentTicketStore();
    const shown = preview();
    const ticket = store.mint(shown);

    expect(ticket.digest).toBe(previewDigest(shown));
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());

    const { preview: redeemed } = store.redeem(ticket.id, ticket.digest, unchanged);
    expect(redeemed.endpoint.origin).toBe(ENDPOINT);
    expect(redeemed.repositoryId).toBe(REPO);
  });

  it("is SINGLE USE — one consent buys one connection", () => {
    const store = new ConsentTicketStore();
    const ticket = store.mint(preview());
    store.redeem(ticket.id, ticket.digest, unchanged);

    /**
     * The second attempt is the one that matters. A ticket that survived its
     * first use would be a standing permission to re-mint this machine's
     * credential — replayable after the human had walked away.
     */
    expect(() => store.redeem(ticket.id, ticket.digest, unchanged)).toThrow(/expired, was already used/);
  });

  it("consumes the ticket even when the attempt is REFUSED, so a digest cannot be guessed at", () => {
    const store = new ConsentTicketStore();
    const ticket = store.mint(preview());
    expect(() => store.redeem(ticket.id, "not the digest", unchanged)).toThrow(/does not match/);
    // Gone. The correct digest no longer helps.
    expect(() => store.redeem(ticket.id, ticket.digest, unchanged)).toThrow(/expired, was already used/);
  });

  it("refuses an id it never minted, and says so without inviting a retry", () => {
    const store = new ConsentTicketStore();
    let raised: unknown;
    try {
      store.redeem("made-up", previewDigest(preview()), unchanged);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(StapleError);
    expect((raised as StapleError).code).toBe("not_found");
    expect((raised as StapleError).message).toContain("Nothing was sent");
  });

  it("refuses a request that carries no consent at all, naming why there is no other way in", () => {
    const store = new ConsentTicketStore();
    let raised: unknown;
    try {
      store.redeem(undefined, undefined, unchanged);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(StapleError);
    expect((raised as StapleError).code).toBe("validation");
    // The refusal states the property rather than just the missing field: there
    // is no field on a connect request that can name an endpoint.
    expect((raised as StapleError).message).toContain("no way");
    expect((raised as StapleError).message).toContain("shown");
  });
});

describe("consent has a lifetime, and it is not indefinite", () => {
  it("expires, because a ticket left in a tab overnight is not a standing permission", () => {
    let now = 1_000_000;
    const store = new ConsentTicketStore(() => now);
    const ticket = store.mint(preview());

    now += CONSENT_TTL_MS - 1;
    expect(store.redeem(ticket.id, ticket.digest, unchanged).preview.repositoryId).toBe(REPO);

    const second = store.mint(preview());
    now += CONSENT_TTL_MS + 1;
    expect(() => store.redeem(second.id, second.digest, unchanged)).toThrow(/expired/);
  });

  it("bounds the number outstanding, dropping the oldest first", () => {
    const store = new ConsentTicketStore();
    const first = store.mint(preview());
    for (let i = 0; i < MAX_OUTSTANDING_CONSENTS; i += 1) store.mint(preview());
    expect(store.size).toBeLessThanOrEqual(MAX_OUTSTANDING_CONSENTS);
    // The oldest one went, which costs one re-preview and nothing irreversible.
    expect(() => store.redeem(first.id, first.digest, unchanged)).toThrow(/expired, was already used/);
  });
});

describe("consent is to FACTS, not to a moment", () => {
  /**
   * The reason `redeem` takes a rebuild callback rather than trusting what it
   * stored. Between the preview and the confirmation, another process can connect
   * or disconnect this repository, or the keychain can lock and push the
   * credential to a `0600` file. Each of those changes something the preview
   * ASSERTED — and consent to a sentence that is no longer true is not consent.
   */
  it("refuses when the world moved under the preview, and says nothing was sent", () => {
    const store = new ConsentTicketStore();
    const ticket = store.mint(preview());

    let raised: unknown;
    try {
      store.redeem(ticket.id, ticket.digest, (stored) => ({
        ...stored,
        // The keychain locked while the human was reading.
        credentialMechanism: "file",
        credentialFallbackReason: "the keychain is locked",
      }));
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(StapleError);
    expect((raised as StapleError).code).toBe("conflict");
    expect((raised as StapleError).message).toContain("Nothing was sent");
  });

  it("returns the REBUILT preview, which is the state the connect will act on", () => {
    const store = new ConsentTicketStore();
    const shown = preview();
    const ticket = store.mint(shown);
    const rebuilt = { ...shown };
    expect(store.redeem(ticket.id, ticket.digest, () => rebuilt).preview).toBe(rebuilt);
  });

  /**
   * The choices that produced the preview travel with it. `credentialFile` is
   * `--credential-file`, and it changes two strings the digest covers — the
   * mechanism and the fallback reason. A rebuild that did not know it had been set
   * would produce a different preview and refuse a perfectly valid consent, and
   * inferring it from `credentialMechanism === "file"` is wrong for a real reason:
   * a preview reading "file" because the human asked and one reading "file"
   * because the keychain was locked are different facts with different sentences.
   */
  it("carries the choices that produced the preview through to the redeem", () => {
    const store = new ConsentTicketStore();
    const ticket = store.mint(preview(), { credentialFile: true });
    let sawContext: unknown;
    const { context } = store.redeem(ticket.id, ticket.digest, (stored, choices) => {
      sawContext = choices;
      return stored;
    });
    expect(sawContext).toEqual({ credentialFile: true });
    expect(context).toEqual({ credentialFile: true });
  });
});

describe("the store itself cannot reach the network", () => {
  /**
   * The same discipline `preview.ts` gets, and for the same reason: the way to
   * keep a consent mechanism from quietly acquiring a network call is to build it
   * somewhere a network call cannot be written. `consent.ts` imports
   * `node:crypto`, `core/types.js` and a TYPE. Not `client.ts`.
   */
  it("mints and redeems under a spy with zero outbound calls", () => {
    const spy = installNetworkSpy();
    try {
      spy.selfCheck();
      const store = new ConsentTicketStore();
      const ticket = store.mint(preview());
      store.redeem(ticket.id, ticket.digest, unchanged);
      expect(spy.violations, describeViolations(spy.violations)).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });
});
