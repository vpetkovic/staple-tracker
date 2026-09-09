/**
 * Everything a hub-wide connect does AFTER consent, and nothing it does before.
 *
 * The split between this file and {@link ./hub-preview.js} is the same split
 * `connect.ts` and `preview.ts` already have, expressed the same way: the
 * preview lives in a module that cannot reach `client.ts`, and every function
 * here takes an already-built, already-shown, already-agreed-to
 * {@link HubConnectPreview} as its first argument. There is no entry point here
 * that can be called without one.
 *
 * ## The credential decision, and why it went this way
 *
 * **Each workspace keeps its own credential. One gesture, N secrets.** The
 * alternative — one credential authorized for many repositories — was rejected
 * on four grounds, and the first is decisive on its own.
 *
 *  1. **The service cannot express it without giving up a structural
 *     invariant.** `worker/migrations/0002_devices.sql` declares
 *     `CREATE UNIQUE INDEX devices_token ON devices (token_sha256)` — globally
 *     unique, *not* scoped by `repo_id` — and `authenticate()` looks a token up
 *     by digest alone, with `repo_id` falling out of the row as an OUTPUT.
 *     `worker/src/auth.ts` states what that buys: *"`repoId` is bound into every
 *     subsequent statement FROM THE SESSION, never from the request path or
 *     body. Cross-repository access is structurally impossible rather than
 *     merely checked."* A multi-repository credential means `authenticate()`
 *     returns a SET, `assertRepoScope` becomes a membership test, and every
 *     downstream statement's `repoId` becomes a per-request choice. That is the
 *     same trade `preview.ts` and `consent.ts` refuse to make locally — swapping
 *     an impossibility for a check — and refusing it here costs nothing.
 *
 *  2. **The authorization set changes locally; only the server could widen it.**
 *     A hub-wide credential must be valid for a set that grows every time
 *     somebody runs `staple init`. Either registering a workspace re-mints the
 *     credential — a network call on a local command, which is the zero-network
 *     invariant gone — or it is minted for a wildcard, which is exactly the
 *     unbounded blast radius the whole question is about. Per-workspace
 *     credentials have no set to maintain: enumeration happens at call time and a
 *     newly registered workspace is simply one that is not connected yet.
 *
 *  3. **Revocation stays granular.** `staple cloud devices revoke` is scoped to
 *     one `(repo_id, device_id)` row. Under one credential, revoking a stolen
 *     laptop from one workspace revokes it from all of them, and "stop syncing
 *     the client's repository but keep syncing mine" becomes inexpressible.
 *
 *  4. **The machine identity is ALREADY hub-wide.** `device.ts`: *"One laptop
 *     connected to three repositories is one device three times over, not three
 *     devices."* The device id is one file in the home, reused across every
 *     repository, and the server keys devices by `(repo_id, device_id)`. So the
 *     thing a person means by "one connection covering all of them" — one
 *     machine, one label, recognisable in every workspace's device list — is
 *     already true today. What was per-repository is the GESTURE and the
 *     SURFACE. This lane fixes those two and leaves the secret alone.
 *
 * The cost, stated plainly: N secrets in the store instead of one, and N
 * rotations if an operator ever rotates. It buys a fan-out that needs **no
 * Worker change at all** — no redeploy, no membership rework, no new server-side
 * golden — and every request it makes is indistinguishable, at the service, from
 * a human running `staple cloud connect` in each directory by hand. Which is
 * also the answer to *"the hub database still never leaves the machine"*: the
 * service is never told that these workspaces sit together, because nothing in
 * the wire format can say so.
 *
 * **What the operator still supplies per workspace is the enrollment
 * credential.** `repos.enroll_sha256` is per repository and there is no account
 * tier above it, so this takes ONE enrollment secret and offers it to each
 * workspace in turn.
 */
import { performConnect, performDisconnect, type ConnectOutcome } from "./connect.js";
import { cloudCodeOf } from "./client.js";
import type { CloudConnection } from "./connection.js";
import type { SelectOptions } from "./credential-store.js";
import { listHubWorkspaces, type HubWorkspace } from "./hub-scope.js";
import type { HubConnectAction, HubConnectPreview } from "./hub-preview.js";
import type { RequestOptions } from "./client.js";
import { StapleError } from "../types.js";

/** What happened to one workspace. */
export interface HubConnectWorkspaceOutcome {
  slug: string;
  path: string;
  repositoryId: string | null;
  action: HubConnectAction;
  status: "connected" | "skipped" | "failed";
  /** A sentence. For a failure, the service's own message. */
  reason: string;
  /** The record written. Never contains a token. Null unless `connected`. */
  connection: CloudConnection | null;
  /** Where the credential went, in words. Null unless `connected`. */
  credentialLocation: string | null;
  /** The staple error code, when this row failed. Null otherwise. */
  code: string | null;
  /**
   * The SERVICE's own code — `forbidden`, `offline`, `rate_limited` — when the
   * failure came from the wire. Null otherwise.
   *
   * Reported alongside `code` rather than instead of it because the two answer
   * different questions, and the fan-out is the surface where the difference
   * finally matters. `client.ts` maps every cloud code into staple's four-value
   * space to keep exit codes coherent, and in that space `forbidden`,
   * `cursor_invalid`, `payload_too_large` and `protocol_unsupported` are all
   * `validation`. For one workspace that is fine: the message says which. For
   * twelve rows in a table it is not — "validation" against a row tells a person
   * nothing they can act on, while `forbidden` tells them precisely that THIS
   * repository was provisioned with a different enrollment secret.
   */
  cloudCode: string | null;
}

export interface HubConnectOutcome {
  endpoint: string;
  workspaces: HubConnectWorkspaceOutcome[];
  connected: number;
  skipped: number;
  failed: number;
}

export interface PerformHubConnectArgs extends RequestOptions {
  home: string;
  /** Offered to each workspace in turn. See the module header. */
  enrollmentSecret: string;
  credential?: SelectOptions;
}

/**
 * Do the fan-out. Called only once a human has said yes to the preview.
 *
 * ## Partial failure is the normal case, and this is where that is expressed
 *
 * **Every workspace is attempted independently and no failure aborts the run.**
 * The acceptance criterion is *"A failure on one workspace does not abort the
 * others"*, and it is a `try`/`catch` around each iteration rather than a
 * `Promise.allSettled`, because the loop is deliberately sequential and
 * `allSettled` over an already-sequential body would only obscure that.
 *
 * The result is N rows, never an aggregate. A caller that wants one exit code
 * derives it from `failed > 0`; a caller that wants to know WHICH workspace
 * failed is told, by name, with the service's own message and code.
 *
 * ## Sequential, not concurrent
 *
 * Twelve simultaneous `POST /connect` calls arrive at the Worker as a burst from
 * one device and meet the rate limiter. The credential store is a subprocess and
 * serializes anyway. Concurrency buys nothing here and costs a deterministic
 * report order, which is the thing a human reading twelve rows most needs.
 */
export async function performHubConnect(
  preview: HubConnectPreview,
  args: PerformHubConnectArgs,
): Promise<HubConnectOutcome> {
  if (args.enrollmentSecret.trim().length === 0) {
    throw new StapleError(
      "validation",
      "An enrollment credential is required. Pass --token with the enrollment secret these " +
        "workspaces were provisioned with; it is offered to each one in turn, and a workspace " +
        "that does not accept it is reported rather than aborting the others.",
    );
  }

  const workspaces: HubConnectWorkspaceOutcome[] = [];

  for (const entry of preview.entries) {
    if (entry.action === "skip" || entry.preview === null) {
      workspaces.push({
        slug: entry.slug,
        path: entry.path,
        repositoryId: entry.repositoryId,
        action: "skip",
        status: "skipped",
        reason: entry.reason,
        connection: null,
        credentialLocation: null,
        code: null,
        cloudCode: null,
      });
      continue;
    }

    let outcome: ConnectOutcome;
    try {
      outcome = await performConnect(entry.preview, {
        home: args.home,
        enrollmentSecret: args.enrollmentSecret,
        credential: args.credential,
        fetchImpl: args.fetchImpl,
        timeoutMs: args.timeoutMs,
      });
    } catch (error) {
      /**
       * Recorded and stepped over. The next workspace is attempted with the SAME
       * enrollment secret, because the overwhelmingly likely cause of a
       * `forbidden` here is that this particular repository was provisioned with
       * a different secret — not that the secret is wrong for all of them. A
       * fan-out that gave up on the first refusal would make a hub containing one
       * third-party repository unconnectable as a whole, which is the shape of
       * hub the feature exists for.
       */
      workspaces.push({
        slug: entry.slug,
        path: entry.path,
        repositoryId: entry.repositoryId,
        action: entry.action,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        connection: null,
        credentialLocation: null,
        code: error instanceof StapleError ? error.code : "unknown",
        cloudCode: cloudCodeOf(error),
      });
      continue;
    }

    workspaces.push({
      slug: entry.slug,
      path: entry.path,
      repositoryId: entry.repositoryId,
      action: entry.action,
      status: "connected",
      reason: `Connected. Credential stored in ${outcome.credentialLocation}.`,
      connection: outcome.connection,
      /**
       * Reported per row rather than once for the run, and that is not
       * redundancy. `performConnect` re-selects the credential store for every
       * connection — a keychain can lock between the second workspace and the
       * seventh — so a fan-out can legitimately end with some credentials in the
       * keychain and some in a `0600` file. One location for the run would state
       * something not necessarily true of any particular credential.
       */
      credentialLocation: outcome.credentialLocation,
      code: null,
      cloudCode: null,
    });
  }

  return {
    endpoint: preview.endpoint,
    workspaces,
    connected: workspaces.filter((row) => row.status === "connected").length,
    skipped: workspaces.filter((row) => row.status === "skipped").length,
    failed: workspaces.filter((row) => row.status === "failed").length,
  };
}

/** The fan-out result as a human reads it. One line per workspace, always. */
export function renderHubConnectOutcome(outcome: HubConnectOutcome): string {
  const lines: string[] = [];
  if (outcome.workspaces.length === 0) {
    return "No workspaces are registered on this machine, so nothing was connected.";
  }

  const width = Math.max(...outcome.workspaces.map((row) => row.slug.length), 9);
  for (const row of outcome.workspaces) {
    const mark = row.status === "connected" ? "ok" : row.status === "failed" ? "FAILED" : "skipped";
    lines.push(`  ${mark.padEnd(8)} ${row.slug.padEnd(width)}  ${row.reason}`);
  }

  lines.push("");
  lines.push(
    `  ${outcome.connected} connected, ${outcome.skipped} skipped, ${outcome.failed} failed.`,
  );
  if (outcome.connected > 0) {
    lines.push("");
    lines.push(
      "Automatic sync is OFF for every one of them. Nothing leaves this machine until you run " +
        "`staple cloud sync`.",
    );
    lines.push("Turning it on is a separate decision, per workspace: `staple cloud auto on`.");
  }
  if (outcome.failed > 0) {
    lines.push("");
    lines.push(
      "The failures above did not affect the others. Each workspace is enrolled separately, so " +
        "re-running with the right enrollment secret for those workspaces connects only them.",
    );
  }
  return lines.join("\n");
}

export interface HubDisconnectWorkspaceOutcome {
  slug: string;
  path: string;
  repositoryId: string | null;
  status: "disconnected" | "skipped";
  reason: string;
  credentialRemoved: boolean;
}

export interface HubDisconnectOutcome {
  workspaces: HubDisconnectWorkspaceOutcome[];
  disconnected: number;
  skipped: number;
}

/**
 * Disconnect every connected workspace. Local, and only local.
 *
 * Inherits `performDisconnect`'s contract exactly, N times: **no network call**,
 * not even a courtesy one, and the entire local database preserved including
 * pending outbox operations. A person who has decided to stop talking to a
 * service must not need that service's permission to stop, and that is no less
 * true of twelve workspaces than of one.
 *
 * Not `async`, and that is deliberate rather than incidental. A signature that
 * returned a promise would invite a later caller to add something that needed
 * one, and the only thing that would need one is a request.
 */
export function performHubDisconnect(
  home: string,
  options: SelectOptions & { workspaces?: readonly HubWorkspace[] } = {},
): HubDisconnectOutcome {
  const workspaces = options.workspaces ?? listHubWorkspaces();
  const rows: HubDisconnectWorkspaceOutcome[] = [];

  for (const workspace of workspaces) {
    if (workspace.repositoryId === null) {
      rows.push({
        slug: workspace.slug,
        path: workspace.path,
        repositoryId: null,
        status: "skipped",
        reason: "No sync identity, so there is no connection to remove.",
        credentialRemoved: false,
      });
      continue;
    }

    /**
     * NOT gated on `available`, deliberately, and unlike connect and sync.
     *
     * The connection record and the credential live in the staple home, not in
     * the workspace, so disconnecting a workspace whose disk is unmounted is
     * both possible and correct — the credential is on THIS machine and removing
     * it is the whole point. Refusing because a volume is absent would leave a
     * live credential behind for precisely the workspace somebody is most likely
     * to be disconnecting.
     */
    const outcome = performDisconnect(home, workspace.repositoryId, options);
    rows.push({
      slug: workspace.slug,
      path: workspace.path,
      repositoryId: workspace.repositoryId,
      status: outcome.wasConnected ? "disconnected" : "skipped",
      reason: outcome.wasConnected
        ? outcome.credentialRemoved
          ? "Disconnected. Credential removed; local data and pending work untouched."
          : "Disconnected. The credential store did not answer, so the credential may still be " +
            "there — revoke this device to be certain."
        : "Was not connected on this machine.",
      credentialRemoved: outcome.credentialRemoved,
    });
  }

  return {
    workspaces: rows,
    disconnected: rows.filter((row) => row.status === "disconnected").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
  };
}
