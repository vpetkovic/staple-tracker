/**
 * Is this claim exclusive on one machine, or across all of them?
 *
 * `docs/sync.md`, "Claims: a local checkout is not a global lease": *"the claim
 * payload grows a scope, and every surface reports it"* — `local` for "this
 * database only, no global exclusivity is claimed", `lease` for "a server lease
 * is held; the claim is globally exclusive". *"An agent that reads `local` and
 * behaves as though it read `lease` is the failure this field exists to
 * prevent."*
 *
 * ## Why this is a separate file from `status.ts`, and why merging them would
 * ## silently undo the zero-network guarantee on the most-used command
 *
 * This is the one thing to read before "simplifying" the two cloud-state
 * modules into one.
 *
 * `status.ts` exports `refreshCloudStatus`, so it statically imports
 * `client.ts` — and `client.ts` owns **the only outbound `fetch` in the
 * runtime**. ES module imports are hoisted and evaluated eagerly, so importing
 * `status.ts` anywhere pulls that module into the graph whether or not a single
 * line of it ever runs.
 *
 * `store.ts` is on the path of `staple ls`, `staple show` and `staple inbox` —
 * the most-used commands in the product, and precisely the ones
 * `docs/sync.md` requires to be silent: *"a `staple ls` on a connected
 * repository in manual mode is as silent as a `staple ls` on a disconnected
 * one, and that is a tested assertion, not an intention."* `src/commands/cloud.ts`
 * already guards the same property in prose on its own non-refresh path: *"The
 * silent path. No await, no client import reached, no request."*
 *
 * So the scope resolver — which `store.ts` must import, because the claim
 * payload is built there — lives here, and this file's entire import graph is
 * `node:sqlite` types, `connection.ts`, `lease-store.ts` and `config/home.ts`.
 * None of those reaches `client.ts`. Merging this file into `status.ts` would
 * put the fetch module into the import graph of `staple ls`.
 *
 * That would not fail a test today: `test/network-silence.test.ts` spies on
 * calls actually attempted, not on modules loaded, and a module that is imported
 * but never invoked attempts nothing. It would simply remove the structural
 * reason the guarantee holds and leave only the behavioural one — which is
 * exactly the kind of quiet load-bearing property that gets refactored away by
 * someone who checked that the tests still pass. Hence this comment rather than
 * a one-line note.
 *
 * ## Why a resolver object and not a function per issue
 *
 * `claimActivityFor` batches a whole page — `docs/queue.md`'s 114-row list
 * against a UI that polls every 1.5s. A per-issue `claimScopeOf` would be one
 * connection-file read and one `sync_leases` query per ROW. This reads each
 * source ONCE and then answers from a map, which is the same N+1 argument
 * `claimActivityFor` itself already makes.
 */
import type { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../../config/home.js";
import { readStoredRepositoryId } from "../repo-identity.js";
import { readConnection } from "./connection.js";
import {
  claimScopeOf,
  listLocalLeases,
  type ClaimLease,
  type ClaimScope,
  type LocalLease,
} from "./lease-store.js";

/**
 * {@link ClaimLease} is what makes `scope: "lease"` *confirmable* rather than
 * merely asserted: an agent handed a fencing token and a server-authoritative
 * expiry can say which lease it holds and until when, where one handed `scope`
 * alone can only repeat a word back.
 */
export interface ClaimScopeResolver {
  /** This machine's device id, or null when there is no connection record. */
  readonly connectedDeviceId: string | null;
  /** `lease` only when this device is connected AND holds the mirror row. */
  scopeOf(entityId: string): ClaimScope;
  /** The token and server expiry, or null whenever `scopeOf` says `local`. */
  leaseOf(entityId: string): ClaimLease | null;
}

/**
 * Read the connection record and the lease mirror once; answer from memory.
 *
 * **Fails closed to `local` on every error.** A missing `sync_leases` table (a
 * workspace older than migration 010), an unreadable connection record, a
 * damaged row — all of them produce `local`, and that asymmetry is deliberate.
 * Under-claiming exclusivity costs a caller a redundant coordination step;
 * over-claiming it is the exact failure the field exists to prevent, and a
 * resolver that threw would instead take `staple ls` down on a workspace that
 * had merely never been connected.
 *
 * The decision itself is delegated to `claimScopeOf` rather than restated. Two
 * copies of "when may this device say it holds a lease" is how the two copies
 * come to disagree.
 */
export function claimScopeResolver(db: DatabaseSync, home: string = stapleHome()): ClaimScopeResolver {
  let connectedDeviceId: string | null = null;
  let leases: Map<string, LocalLease> = new Map();

  try {
    const repositoryId = readStoredRepositoryId(db);
    if (repositoryId !== null) {
      connectedDeviceId = readConnection(home, repositoryId)?.deviceId ?? null;
    }
  } catch {
    connectedDeviceId = null;
  }

  // Only worth reading when a connection could make one of them authoritative.
  if (connectedDeviceId !== null) {
    try {
      leases = new Map(listLocalLeases(db).map((lease) => [lease.entityId, lease]));
    } catch {
      leases = new Map();
    }
  }

  const held = (entityId: string): LocalLease | null => {
    if (connectedDeviceId === null) return null;
    const lease = leases.get(entityId);
    if (!lease) return null;
    // The same test `claimScopeOf` makes, against the row already in hand.
    return lease.deviceId === connectedDeviceId ? lease : null;
  };

  return {
    connectedDeviceId,
    scopeOf: (entityId) => (held(entityId) ? "lease" : "local"),
    leaseOf: (entityId) => {
      const lease = held(entityId);
      return lease
        ? { fencingToken: lease.fencingToken, serverExpiresAt: lease.serverExpiresAt }
        : null;
    },
  };
}

/**
 * The single-entity answer, for callers holding no batch.
 *
 * Kept as a thin wrapper over the resolver rather than a second implementation,
 * and it re-exports the leases lane's `claimScopeOf` semantics unchanged.
 */
export function scopeOfClaim(db: DatabaseSync, entityId: string, home: string = stapleHome()): ClaimScope {
  return claimScopeResolver(db, home).scopeOf(entityId);
}

export type { ClaimLease, ClaimScope };
export { claimScopeOf };
