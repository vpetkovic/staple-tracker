/**
 * The ONE cloud status-and-error contract. Four surfaces render it; none of them
 * defines it.
 *
 * STA-75's first acceptance criterion is *"CLI MCP HTTP and UI derive status and
 * error data from one typed contract"*, and the state before this file was three
 * hand-written mappings of the same `CloudStatus`:
 *
 *  - `src/commands/cloud.ts` `renderStatus()` — human text
 *  - `src/mcp.ts` `cloud_status` — a nine-field object literal, plus its own
 *    "this workspace has no repository.json" literal
 *  - `src/ui/server.ts` `/api/cloud/status` — the same nine fields again, plus a
 *    `hint`, plus its own, differently-worded "no sync identity" literal
 *
 * Two of those three were the same field mapping written twice, and the two
 * "there is nothing here" literals had already drifted apart in wording. Nothing
 * was broken yet; the shape simply guaranteed it eventually would be, one
 * surface at a time, in the direction nobody was looking.
 *
 * ## What this file adds beyond de-duplication
 *
 * `CloudStatus` answers "is this machine connected, and in what mode". The
 * criteria ask for more: *"Status reports pending count last success cursor
 * epoch device mode and actionable failures."* None of the three mappings
 * reported pending, cursor or epoch, and none distinguished a failure a human
 * can act on from a state they merely observe. So the report composes the
 * connection state with the local sync counters, and adds an explicit
 * {@link CloudFailure}.
 *
 * ## Values, not sentences
 *
 * Every consumer gets the underlying value and does its own rendering; `detail`
 * and `failure.summary` are offered *in addition to* the values, never instead
 * of them. A control panel deciding whether a toggle is on must read `auto`, and
 * must never have to parse a sentence to find out — a surface that has to
 * reverse-engineer prose is a surface that will get it wrong the first time the
 * prose is improved.
 *
 * ## Network-free by construction
 *
 * Nothing here calls out, and nothing here *can*: the builder takes an
 * already-computed {@link CloudStatus} rather than fetching one. Whether that
 * status came from `localCloudStatus` (always silent) or `refreshCloudStatus`
 * (only ever reached because a human typed `--refresh`) is the caller's
 * decision, made at the call site where the consent for it exists. This file
 * cannot upgrade a silent surface into a probing one, which is the property that
 * matters for the UI: the page polls, and *"a polled UI with a refreshing status
 * endpoint would turn one human's page-open into a heartbeat to Cloudflare every
 * few seconds."*
 */
import type { DatabaseSync } from "node:sqlite";
import { conflictsSummary } from "./conflicts.js";
import type { CredentialMechanism } from "./credential-store.js";
import { listLocalLeases } from "./lease-store.js";
import { COPIED_HOME_DIAGNOSTIC, describeHostBinding } from "../repo-identity.js";
import { describeState, type CloudState, type CloudStatus } from "./status.js";
import { pendingCount, readSyncState } from "./sync-state.js";

/**
 * What a surface may OFFER, as distinct from what it observes.
 *
 * `docs/sync.md`'s "Three consents" table is organised around this: before
 * connect a surface may show static text and nothing else; connected-manual it
 * may offer a sync action; automatic it may additionally report background
 * activity. `state` has six values because it also carries reachability, and a
 * surface that switched on `state` would have to decide, for each of `offline`,
 * `revoked` and `auth_failed`, whether a sync button belongs there. `mode`
 * answers that once: those three are all still *connected*, so all three are
 * `manual` or `automatic` according to the consent actually on file.
 */
export type CloudMode = "disconnected" | "manual" | "automatic";

/**
 * Something a human or agent can DO something about.
 *
 * Deliberately not "the last error". `offline` is a status and not a failure of
 * the user's making, but it is actionable — the action is "run sync again when
 * you have a network" — and a surface that showed a red error for a train
 * journey would be lying about severity. So every failure carries a `remedy`
 * naming a command, and a state with no useful action attached produces `null`
 * rather than a failure with an empty remedy.
 *
 * `code` is a narrow union rather than `CloudState` because three states are not
 * failures at all, and a nullable field whose type still admits `"manual"` is a
 * field every consumer has to re-check.
 */
export interface CloudFailure {
  code: "offline" | "revoked" | "auth_failed" | "no_identity";
  /** One sentence naming what is wrong. */
  summary: string;
  /** One sentence naming the command that fixes it. Never empty. */
  remedy: string;
}

/** Open and settled conflicts on this machine. Both, because a settled one is the audit trail. */
export interface CloudConflictCounts {
  open: number;
  resolved: number;
}

/** Leases THIS device holds. A mirror row for another device is knowledge, not authority. */
export interface CloudLeaseCounts {
  held: number;
}

/**
 * Everything any surface needs to render cloud state, and nothing any surface
 * has to derive for itself.
 *
 * Every key is present in every state. A surface rendering `report.pending` must
 * not have to ask whether `pending` exists on a disconnected repository — the
 * moment it does, four surfaces grow four different guards and the duplication
 * this type removes comes straight back in a subtler form. Disconnected reports
 * `0` and `null`, which are true statements, not placeholders.
 */
/**
 * Deliberately NOT `readonly`-per-property, unlike {@link CloudStatus}.
 *
 * `src/mcp.ts` proves its zod output schema equal to this interface with the
 * exact `Equals<>` check it already uses for `Issue`, `ClaimActivity` and
 * `IssueTiming` — and that check is sensitive to property modifiers, while
 * `z.infer` never produces them. So a `readonly` here would not be extra safety;
 * it would break the proof that the MCP schema and this type can never drift
 * apart, which is worth far more on a type only one function ever constructs.
 * Every other wire interface matched against a zod shape in this repository is
 * mutable-style for exactly this reason.
 */
export interface CloudSurfaceReport {
  state: CloudState;
  /** What this surface may OFFER. See {@link CloudMode}. */
  mode: CloudMode;
  /** One human sentence for `state`. Offered alongside the values, never instead. */
  detail: string;
  repositoryId: string | null;
  endpoint: string | null;
  deviceId: string | null;
  label: string | null;
  credentialMechanism: CredentialMechanism | null;
  credentialPresent: boolean;
  /** This DEVICE's automatic-sync consent. A value, so a toggle can bind to it. */
  auto: boolean;
  /** This DEVICE's backup consent. Separate decision, separate flag. */
  backup: boolean;
  connectedAt: string | null;
  /** True only when a live probe produced this. Always false on the silent path. */
  checked: boolean;
  /** Operations journalled here and not yet acknowledged by the server. */
  pending: number;
  /** The last successful pull cursor. Null before the first bootstrap completes. */
  cursor: string | null;
  /** The sync epoch. Null when this workspace has no sync state at all. */
  epoch: number | null;
  lastSyncAt: string | null;
  conflicts: CloudConflictCounts;
  leases: CloudLeaseCounts;
  /** Things worth knowing that are not the state — a widened credential file, say. */
  warnings: string[];
  /** Present only when there is something to do about it. */
  failure: CloudFailure | null;
  /**
   * The ONE static hint, and only where `docs/sync.md` permits one: *"Before
   * connect — render 'not connected' and a static hint naming `staple cloud
   * connect`. Static text."* Null in every other state, so a connected
   * repository can never be nagged to connect and a UI can render this field
   * unconditionally without becoming a prompt.
   */
  hint: string | null;
}

const CONNECT = "staple cloud connect";

function modeOf(status: CloudStatus): CloudMode {
  if (status.state === "disconnected") return "disconnected";
  return status.auto ? "automatic" : "manual";
}

/**
 * The failure, if the state is one a human can act on.
 *
 * `manual` and `automatic` are working states and produce null. `disconnected`
 * also produces null: not being connected is the DEFAULT and the entire point of
 * the epic's first invariant, and reporting the product's normal resting state
 * as a failure is how a status widget turns into the nag `docs/sync.md` forbids.
 * The static `hint` covers it instead.
 */
function failureOf(state: CloudState): CloudFailure | null {
  switch (state) {
    case "offline":
      return {
        code: "offline",
        summary:
          "The endpoint could not be reached. Local work is unaffected and everything you do " +
          "here is still journalled for the next successful sync.",
        remedy: "Run `staple cloud sync` again once this machine has a network.",
      };
    case "revoked":
      return {
        code: "revoked",
        summary:
          "The service says this device was revoked, so it can no longer read or write remote " +
          "state. Local data and pending operations are untouched.",
        remedy: `Re-enrol this machine with \`${CONNECT}\` to get a new credential.`,
      };
    case "auth_failed":
      return {
        code: "auth_failed",
        summary:
          "The credential was rejected, or there is no credential on this machine to present.",
        remedy: `Re-connect with \`${CONNECT}\` to store a working credential.`,
      };
    default:
      return null;
  }
}

/**
 * Read one counter, or report the absence honestly.
 *
 * A workspace predating migration 010 has no `sync_state`, `sync_outbox` or
 * `sync_leases` at all, and asking it for a pending count is a SQL error rather
 * than a zero. `/api/cloud/status` already established the right answer for this
 * class of failure — *"the read fails closed to 'disconnected', which is true"* —
 * and the same reasoning applies per counter: a workspace with no sync tables
 * genuinely has nothing pending, and taking `staple cloud status` down over it
 * would be a worse answer than the true one.
 */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Compose a connection state with this machine's local sync counters.
 *
 * The counters are read even when disconnected, and that is deliberate rather
 * than wasteful: a repository that synced and was then disconnected still holds
 * its pending operations and its unsettled conflicts, and zeroing them because
 * the credential is gone would hide real, recoverable work at exactly the moment
 * somebody is trying to find out what state they are in.
 */
export function cloudSurfaceReport(status: CloudStatus, db: DatabaseSync): CloudSurfaceReport {
  const syncState = safely(() => readSyncState(db), null);

  return {
    state: status.state,
    mode: modeOf(status),
    detail: describeState(status),
    repositoryId: status.repositoryId,
    endpoint: status.endpoint,
    deviceId: status.deviceId,
    label: status.label,
    credentialMechanism: status.credentialMechanism,
    credentialPresent: status.credentialPresent,
    auto: status.auto,
    backup: status.backup,
    connectedAt: status.connectedAt,
    checked: status.checked,
    pending: safely(() => pendingCount(db), 0),
    cursor: syncState?.cursor ?? null,
    epoch: syncState?.epoch ?? null,
    lastSyncAt: syncState?.lastSyncAt ?? null,
    conflicts: safely(() => conflictsSummary(db), { open: 0, resolved: 0 }),
    leases: {
      held: safely(
        () =>
          status.deviceId === null
            ? 0
            : listLocalLeases(db).filter((lease) => lease.deviceId === status.deviceId).length,
        0,
      ),
    },
    warnings: [...status.warnings, ...copiedHomeWarning(db)],
    failure: failureOf(status.state),
    hint: status.state === "disconnected" ? CONNECT : null,
  };
}

/**
 * "This staple home was restored from another machine", if it was.
 *
 * A warning rather than a {@link CloudFailure}, and the distinction is the one
 * this file already draws: a failure is a state this machine is IN, and every
 * code in that union describes the connection. This describes the workspace's
 * provenance, it is true in every connection state including `disconnected`, and
 * it is exactly the class the `warnings` array exists for — "things worth knowing
 * that are not the state".
 *
 * It is also, deliberately, not the enforcement. Status reports; the refusal
 * lives at `assertOwnHost` on the paths that move data, so a person who opens
 * status to find out what is wrong gets an answer instead of an exception.
 *
 * Read through `safely` because a workspace predating migration 012 has no
 * column to read, and a status command that fell over on an old database would
 * be a worse answer than the true one — which is that nothing is bound.
 */
function copiedHomeWarning(db: DatabaseSync): string[] {
  const binding = safely(() => describeHostBinding(db).status, "unbound" as const);
  return binding === "moved" ? [COPIED_HOME_DIAGNOSTIC] : [];
}

/**
 * The report for a workspace that has no sync identity at all.
 *
 * A workspace predating repository manifests has no `repository.json` and no
 * `sync_state.repository_id`. It is not "disconnected from something" — there is
 * no something. Both `src/mcp.ts` and `src/ui/server.ts` had already written this
 * case out by hand, in two different sentences; this is the one of them.
 *
 * This used to be where a global workspace ended up, permanently and by design.
 * It is not any more (STA-273): a workspace with no repository mints an identity
 * in its own directory inside the staple home, so the only workspaces that reach
 * this report are ones `staple init` has never been run in.
 *
 * It carries a `failure` where plain `disconnected` does not, because the two
 * are genuinely different: a disconnected repository can be connected, and this
 * one cannot until it has an identity. That is a thing to do, so it is a remedy.
 */
export function noIdentityReport(): CloudSurfaceReport {
  return {
    state: "disconnected",
    mode: "disconnected",
    detail:
      "This workspace has no repository identity, so it has no sync identity and cannot be " +
      "connected.",
    repositoryId: null,
    endpoint: null,
    deviceId: null,
    label: null,
    credentialMechanism: null,
    credentialPresent: false,
    auto: false,
    backup: false,
    connectedAt: null,
    checked: false,
    pending: 0,
    cursor: null,
    epoch: null,
    lastSyncAt: null,
    conflicts: { open: 0, resolved: 0 },
    leases: { held: 0 },
    warnings: [],
    failure: {
      code: "no_identity",
      summary:
        "This workspace has no sync identity, so there is nothing for a connection to be about.",
      remedy: "Run `staple init` in this workspace to record one.",
    },
    hint: null,
  };
}

/**
 * The ONE human rendering. The CLI prints it; nothing else re-words it.
 *
 * Laid out as aligned label/value pairs rather than prose because the values are
 * the point — a human reading this is answering "what is my pending count" and
 * "which epoch am I on", and a paragraph makes those hard to find.
 */
export function describeReport(report: CloudSurfaceReport): string {
  const lines = [report.detail, ""];
  const row = (label: string, value: string) => lines.push(`  ${label.padEnd(15)}${value}`);

  if (report.repositoryId) row("repository", report.repositoryId);
  if (report.endpoint) row("service", report.endpoint);
  if (report.deviceId) {
    row("device", `${report.deviceId}${report.label ? `  (${report.label})` : ""}`);
  }
  if (report.credentialMechanism) {
    row(
      "credential",
      `${report.credentialMechanism}${report.credentialPresent ? "" : "  — NOT FOUND"}`,
    );
  }

  if (report.mode !== "disconnected") {
    row("mode", report.mode);
    row("automatic sync", report.auto ? "on" : "off");
    row("backup", report.backup ? "on" : "off");
    if (report.connectedAt) row("connected at", report.connectedAt);
  }

  // The numbers the acceptance criteria name, always, in every state — an empty
  // outbox is a fact worth printing, and a reader who has to infer zero from a
  // missing line cannot tell it apart from a line that was never implemented.
  row("pending", String(report.pending));
  row("cursor", report.cursor ?? "none yet");
  row("epoch", report.epoch === null ? "none" : String(report.epoch));
  if (report.lastSyncAt) row("last sync", report.lastSyncAt);
  if (report.conflicts.open > 0) {
    row("conflicts", `${report.conflicts.open} unresolved — staple cloud conflicts`);
  }
  if (report.leases.held > 0) row("leases held", String(report.leases.held));

  row(
    "checked",
    report.checked
      ? "just now, against the endpoint"
      : "local files only (--refresh to ask the endpoint)",
  );

  if (report.hint) {
    lines.push("", `  Connect with: ${report.hint} --endpoint <url> --token <secret>`);
  }
  if (report.failure) {
    lines.push("", `  ! ${report.failure.summary}`, `    ${report.failure.remedy}`);
  }
  for (const warning of report.warnings) {
    lines.push("", `  ! ${warning}`);
  }

  return lines.join("\n");
}
