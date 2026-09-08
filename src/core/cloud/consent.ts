/**
 * How preview-then-consent survives an HTTP boundary.
 *
 * Contract: `docs/sync.md`, "Three consents" — *"**Connect shows before it
 * asks.** It prints the endpoint, the `repositoryId` and the account it is about
 * to bind, and performs **no remote mutation** before the answer."*
 *
 * ## The property this file exists to preserve
 *
 * On the command line the property is an import graph. `preview.ts` does not
 * import `client.ts`, so computing a preview cannot reach the network; and every
 * function in `connect.ts` takes an already-built, already-shown
 * {@link ConnectPreview} as its first argument, so there is no entry point that
 * can connect without one. The consent mechanism is structural rather than
 * remembered.
 *
 * A browser breaks that, because a browser is not a caller — it is a stranger
 * sending bytes. The obvious route, `POST /api/cloud/connect { endpoint, token }`,
 * would rebuild `performConnect`'s missing first argument on the server out of
 * whatever the request said, and the whole property would end at the last
 * surface: an unattended script, a page in another tab, or a UI whose confirm
 * dialog somebody later decided was one click too many, could all connect a
 * machine to a service no human had been shown.
 *
 * So the HTTP boundary is a TWO-STEP EXCHANGE, and the property is restated in
 * the shape of the wire:
 *
 *   1. `POST /api/cloud/connect/preview { endpoint }` builds the preview and
 *      returns it, together with a ticket minted from it.
 *   2. `POST /api/cloud/connect { consent, digest, token }` redeems the ticket.
 *
 * **The second request has no `endpoint` field and no `repositoryId` field, and
 * there is no other route that accepts one.** The endpoint travels in exactly one
 * direction: it is a field of the preview RESPONSE, and it is not expressible in
 * a connect REQUEST. A ticket is minted only in the act of returning a preview,
 * so the bytes naming the service, the repository, the device and where the
 * secret is about to be stored were necessarily delivered to the client before
 * any ticket existed for it to send back.
 *
 * That is the statement this design can make: *a client cannot connect without
 * having been handed, in a prior response, the description of what it is
 * connecting to.* It is a property of the route shapes, not of the UI's
 * diligence, which is the same kind of guarantee the import graph gives the CLI.
 *
 * ## Why the client echoes a digest
 *
 * The digest is NOT authentication — the client holds the preview, so it can
 * always compute it, and the bearer token is what makes the request privileged
 * in the first place. It answers a different question: *are the facts the human
 * agreed to still the facts?*
 *
 * Redeeming re-derives the preview from local state and compares. Between the
 * two requests another process may have connected this repository, or
 * disconnected it, or the keychain may have locked and the credential mechanism
 * fallen back to a `0600` file. Each of those changes something the preview
 * ASSERTED, and consent to a sentence that is no longer true is not consent. The
 * remedy is to show the human the new preview, which is what the mismatch
 * refusal says.
 *
 * ## What this module deliberately cannot do
 *
 * It imports `node:crypto` and the {@link ConnectPreview} TYPE. Not `client.ts`,
 * not `connect.ts`, not `credential-store.ts`. Like `preview.ts`, the fact that
 * minting or redeeming a consent ticket cannot reach the network is a property of
 * the import graph rather than of anybody's care, and
 * `test/network-silence.test.ts` asserts it against a real spy as well.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { StapleError } from "../types.js";
import type { ConnectPreview } from "./preview.js";

/**
 * Five minutes.
 *
 * Long enough to read the disclosure, look up an enrollment secret in a password
 * manager and paste it. Short enough that a ticket left in a tab overnight is not
 * a standing permission to connect this machine to that service — which is what
 * an unexpiring one would be, since the whole point of the ticket is that holding
 * it is sufficient.
 */
export const CONSENT_TTL_MS = 5 * 60 * 1000;

/**
 * A bound on outstanding tickets, so a caller looping on the preview route cannot
 * grow this map without limit. The oldest are dropped first: a ticket that has
 * been sitting unredeemed the longest is the one least likely to be a human still
 * reading, and dropping it costs one re-preview rather than anything irreversible.
 */
export const MAX_OUTSTANDING_CONSENTS = 32;

/** What the preview route returns alongside the preview itself. Never the preview's twin — the client needs both. */
export interface ConsentTicket {
  /** Opaque, unguessable, single-use. The only thing a connect request may carry. */
  id: string;
  /** The digest of the preview this ticket was minted from. The client echoes it back. */
  digest: string;
  /** ISO 8601. Rendered, so a human sees their consent has a lifetime. */
  expiresAt: string;
}

/**
 * The choices that PRODUCED the preview, carried so the redeem path can reproduce
 * it exactly.
 *
 * Only one so far, and it is here for a specific reason rather than for
 * generality. `credentialFile` is `staple cloud connect --credential-file`: it
 * makes the preview say "a 0600 file in your staple home" and
 * "--credential-file was passed" instead of naming the OS keychain. Those two
 * strings are inside the digest, so a rebuild that did not know the flag had been
 * set would produce a different preview and refuse a consent that was perfectly
 * valid.
 *
 * It is NOT inferrable from the stored preview: a preview reading "file" because
 * the human asked and one reading "file" because the keychain was locked are
 * different facts with different fallback sentences, and guessing between them is
 * exactly the kind of reconstruction this whole design refuses to do.
 *
 * A boolean rather than the credential store's own `SelectOptions`, so this module
 * still imports nothing but `node:crypto`, `core/types` and a type.
 */
export interface ConsentContext {
  credentialFile: boolean;
}

/** What redeeming gives back: the preview to act on, and the choices that made it. */
export interface RedeemedConsent {
  preview: ConnectPreview;
  context: ConsentContext;
}

interface StoredTicket {
  preview: ConnectPreview;
  context: ConsentContext;
  digest: string;
  expiresAtMs: number;
}

/**
 * The consent-relevant fields of a preview, in a fixed order, as one string.
 *
 * Every field here is something the rendered preview SAYS to a human, and the
 * list is deliberately not "everything on the object": `autoAfterConnect` is the
 * constant `false` and cannot vary, so hashing it would only make the digest
 * longer. If a field is added to `ConnectPreview` that a human is shown and could
 * act differently on, it belongs here — that is the rule this function encodes.
 *
 * A newline-joined `key=value` list rather than `JSON.stringify`: object key
 * order is a property of construction and a refactor of `buildConnectPreview`
 * that reordered its literal would silently change every digest.
 */
export function previewDigest(preview: ConnectPreview): string {
  const fields: Array<[string, string]> = [
    ["endpoint", preview.endpoint.origin],
    ["repository", preview.repositoryId],
    ["device", preview.deviceId ?? ""],
    ["label", preview.label],
    ["credential", preview.credentialMechanism],
    ["fallback", preview.credentialFallbackReason ?? ""],
    ["alreadyConnected", preview.alreadyConnected ? "1" : "0"],
    ["existingEndpoint", preview.existingEndpoint ?? ""],
  ];
  const canonical = fields.map(([key, value]) => `${key}=${value}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/** Constant-time string compare for the digest echo. Cheap, and the alternative is a habit worth not forming. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The outstanding consents of ONE server process.
 *
 * In memory, on purpose, and not persisted anywhere. A ticket is a record that a
 * human was shown something a moment ago and has not yet answered; surviving a
 * restart would turn it into a stored permission, and a stored permission to
 * connect is precisely the thing `connection.ts` refuses to keep a placeholder
 * for. Restarting the UI server means the human looks at the preview again, which
 * is the correct outcome.
 */
export class ConsentTicketStore {
  private readonly tickets = new Map<string, StoredTicket>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Mint a ticket for a preview that has just been built and is about to be
   * returned to the client in the same response. There is no other caller shape:
   * a `mint` whose preview was not returned would be a ticket for something
   * nobody saw.
   */
  mint(preview: ConnectPreview, context: ConsentContext = { credentialFile: false }): ConsentTicket {
    this.sweep();
    if (this.tickets.size >= MAX_OUTSTANDING_CONSENTS) {
      // Oldest first. `Map` preserves insertion order, so the first key is it.
      const oldest = this.tickets.keys().next();
      if (!oldest.done) this.tickets.delete(oldest.value);
    }
    const id = randomBytes(32).toString("base64url");
    const digest = previewDigest(preview);
    const expiresAtMs = this.now() + CONSENT_TTL_MS;
    this.tickets.set(id, { preview, context, digest, expiresAtMs });
    return { id, digest, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /**
   * Consume a ticket and return the preview it was minted from, or refuse.
   *
   * SINGLE USE, and consumed before anything else can fail: one consent buys one
   * connection. A ticket that survived a failed connect could be replayed after
   * the human had walked away, and a ticket that survived a SUCCESSFUL one is a
   * standing permission to re-mint this machine's credential.
   *
   * `rebuild` is handed the STORED preview and returns one derived from local
   * state right now. A callback rather than a second argument, because the caller
   * cannot build the current preview without the endpoint — and the endpoint is
   * inside the ticket, which is precisely the point: a connect request has no
   * field that can name one. The callback is also what keeps this module free of
   * `credential-store.ts`, and therefore free of side effects.
   */
  redeem(
    id: unknown,
    digest: unknown,
    rebuild: (stored: ConnectPreview, context: ConsentContext) => ConnectPreview,
  ): RedeemedConsent {
    this.sweep();

    if (typeof id !== "string" || id.length === 0) {
      throw new StapleError(
        "validation",
        "A connect request must carry the consent id returned by the preview. There is no way " +
          "to name an endpoint here: connecting requires having been shown, in a prior response, " +
          "the service and repository it would bind.",
      );
    }
    const stored = this.tickets.get(id);
    /**
     * Deleted BEFORE the digest is checked and before the connect is attempted.
     * A ticket that outlived a rejected attempt would let a caller keep guessing
     * at the digest, and the digest is the only thing standing between a stale
     * preview and a connection nobody agreed to in its current form.
     */
    this.tickets.delete(id);

    if (!stored) {
      throw new StapleError(
        "not_found",
        "That consent has expired, was already used, or was issued by a server that has since " +
          "restarted. Nothing was sent. Ask for the connection preview again and confirm the " +
          "endpoint and repository it shows.",
      );
    }
    if (typeof digest !== "string" || !digestsMatch(stored.digest, digest)) {
      throw new StapleError(
        "validation",
        "The confirmation does not match the preview it names. Nothing was sent. Ask for the " +
          "preview again.",
      );
    }
    /**
     * The world moved. Re-derived from local files a moment ago, and it no longer
     * says what the human read — another process connected or disconnected this
     * repository, or the credential store changed under us. Refused rather than
     * connected, because the sentence consent was given to is no longer true.
     */
    const current = rebuild(stored.preview, stored.context);
    if (!digestsMatch(stored.digest, previewDigest(current))) {
      throw new StapleError(
        "conflict",
        "This machine's connection state changed while that preview was on screen, so it no " +
          "longer describes what would happen. Nothing was sent. Ask for the preview again and " +
          "read what it now says.",
      );
    }
    /**
     * The REBUILT one, not the stored one. They agree on every field the digest
     * covers — that is what was just checked — and the rebuilt one is derived from
     * the state `performConnect` is about to act on. Returning a minutes-old object
     * because it happens to be equivalent is the habit that stops being true the
     * day a field is added and not added to {@link previewDigest}.
     */
    return { preview: current, context: stored.context };
  }

  /** Outstanding tickets. For tests and for a caller that wants to report the count; never a decision input. */
  get size(): number {
    this.sweep();
    return this.tickets.size;
  }

  /** Forget everything. Called when the server closes; also what a test uses between cases. */
  clear(): void {
    this.tickets.clear();
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAtMs <= now) this.tickets.delete(id);
    }
  }
}
