/**
 * Every registered workspace and its own connection state — the list the
 * settings surface renders.
 *
 * Contract: STA-275 — *"The settings surface lists every workspace with its own
 * connection state"* and *"A newly registered workspace appears without
 * reconnecting"*.
 *
 * ## Why a new report type instead of an array of `CloudSurfaceReport`
 *
 * `CloudSurfaceReport` carries `pending`, `cursor`, `epoch`, `conflicts` and
 * `leases`, and every one of those is read out of the workspace DATABASE. An
 * array of them is therefore an array whose construction opens N databases —
 * which migrates every workspace on the machine, and does it again on every poll
 * of the settings page. `hub-scope.ts` explains why that is unacceptable at
 * length; this type is the consequence.
 *
 * So the hub-wide report is a list of **connection states**, not a list of full
 * reports. Every field on it comes from a file: the hub registry, each
 * workspace's `repository.json`, and the connection records in
 * `<home>/cloud/`. The existing per-workspace `staple cloud status` and
 * `GET /api/cloud/status` remain the place counters come from, and a surface
 * that wants them for one workspace asks for that one workspace.
 *
 * That split is not a limitation to apologise for. A list is for *choosing*, and
 * choosing needs to know which workspaces are connected, to what, and whether
 * background sync is on. It does not need each one's outbox depth.
 *
 * ## Why `credentialPresent` is `boolean | null`
 *
 * Establishing it means READING the credential, and on macOS that is a
 * `security(1)` subprocess per workspace. The settings page polls; twelve
 * workspaces at a five-second poll is twelve subprocesses every five seconds,
 * forever, to render a list.
 *
 * So the probe is opt-in. `null` means *not asked*, which is an honest third
 * value and not a guess — and it is what the polled surface gets. `staple cloud
 * status --all`, which a human typed once, asks. The consequence is that the
 * unprobed list cannot report `auth_failed`; it reports the consent on file, and
 * the per-workspace detail view is where a missing credential surfaces. A list
 * that guessed `manual` and called it certainty would be worse than one that
 * says it did not look.
 *
 * ## Network-free, like everything else on this path
 *
 * Nothing here imports `client.ts`, so no reachability state (`offline`,
 * `revoked`) is expressible from this module — the same property `status.ts`
 * gives the single-workspace silent path, extended to the list. There is no
 * `--refresh` for the hub-wide view and deliberately no route that would add
 * one: a refresh over N workspaces is N authenticated round trips fired by one
 * click, which is precisely the "one human's page-open into a heartbeat"
 * failure `surface.ts` names.
 */
import { readConnection } from "./connection.js";
import { credentialStoreFor, type CredentialMechanism } from "./credential-store.js";
import {
  describeSkip,
  listHubWorkspaces,
  skipReasonFor,
  type HubSkipReason,
  type HubWorkspace,
} from "./hub-scope.js";
import type { CloudMode } from "./surface.js";

/**
 * The states a file-only, hub-wide read can actually establish.
 *
 * A deliberate subset of {@link import("./status.js").CloudState}: `offline` and
 * `revoked` require an authenticated round trip and this module cannot make one,
 * so a union that admitted them would be a type promising information the code
 * cannot produce.
 */
export type HubConnectionState = "disconnected" | "manual" | "automatic" | "auth_failed";

/** One workspace's row in the hub-wide list. */
export interface HubWorkspaceReport {
  slug: string;
  prefix: string;
  /** The workspace database path, as registered. */
  path: string;
  kind: string;
  /** `existsSync(path)`. False is `hub ls`'s `MISSING`. */
  available: boolean;
  repositoryId: string | null;
  state: HubConnectionState;
  /** What a surface may OFFER for this row. Same three values as one workspace. */
  mode: CloudMode;
  endpoint: string | null;
  deviceId: string | null;
  label: string | null;
  credentialMechanism: CredentialMechanism | null;
  /** `null` when the credential was deliberately not probed. See the header. */
  credentialPresent: boolean | null;
  /** This device's automatic-sync consent FOR THIS WORKSPACE. */
  auto: boolean;
  /** This device's backup consent for this workspace. */
  backup: boolean;
  connectedAt: string | null;
  /**
   * Why a hub-wide operation would not act on this row, or null when it would.
   *
   * Orthogonal to `state`, and that is the point: a MISSING workspace that has a
   * connection record is genuinely `manual` — the record is a fact about this
   * machine and does not stop being true because a volume is unmounted — and it
   * is equally genuinely not something a fan-out will touch. Two facts, two
   * fields. Collapsing them would force every consumer to guess which one it was
   * being told.
   */
  skip: HubSkipReason | null;
  /** One sentence for `skip`, or for a row problem. Null when there is neither. */
  skipDetail: string | null;
}

/** Counts a surface would otherwise derive four different ways. */
export interface HubCloudCounts {
  total: number;
  /** Rows with a connection record, whatever their availability. */
  connected: number;
  disconnected: number;
  /** Rows a fan-out would not act on, for any of the three reasons. */
  skipped: number;
  /** Of the connected rows, those with automatic sync on for this device. */
  automatic: number;
}

export interface HubCloudReport {
  workspaces: HubWorkspaceReport[];
  counts: HubCloudCounts;
  /**
   * Every distinct endpoint in use across the hub, sorted.
   *
   * A list rather than a single value, because a hub spanning two services is
   * legitimate — a work repository on a company Worker and a personal one
   * elsewhere is the obvious case — and a surface that rendered "the endpoint"
   * would have to pick one and would pick wrong. Empty when nothing is
   * connected.
   */
  endpoints: string[];
}

export interface HubReportOptions {
  /**
   * Read each connected workspace's credential to establish that it is really
   * there. Off by default; see the header for why the polled surface must not
   * ask for it.
   */
  probeCredentials?: boolean;
  /** Injected in tests so no real keychain is consulted. */
  platform?: NodeJS.Platform;
  /** Injected in tests. Replaces the whole enumeration. */
  workspaces?: readonly HubWorkspace[];
}

/**
 * Compose the registry with this machine's connection records.
 *
 * Enumeration happens HERE, on every call, and no member list is stored
 * anywhere. That is the whole mechanism behind *"a newly registered workspace
 * appears without reconnecting"*: there is no set of connected workspaces to go
 * stale, because there is no set. `staple init` writes a hub row, and the next
 * read of this function sees it. A design that recorded "these are the
 * workspaces this connection covers" would have to be kept in step with the hub
 * by something, and that something would be the bug.
 */
export function hubCloudReport(home: string, options: HubReportOptions = {}): HubCloudReport {
  const workspaces = options.workspaces ?? listHubWorkspaces();
  const rows = workspaces.map((workspace) => reportFor(home, workspace, options));

  const endpoints = [
    ...new Set(rows.map((row) => row.endpoint).filter((value): value is string => value !== null)),
  ].sort();

  return {
    workspaces: rows,
    counts: {
      total: rows.length,
      connected: rows.filter((row) => row.state !== "disconnected").length,
      disconnected: rows.filter((row) => row.state === "disconnected").length,
      skipped: rows.filter((row) => row.skip !== null).length,
      automatic: rows.filter((row) => row.auto).length,
    },
    endpoints,
  };
}

function reportFor(
  home: string,
  workspace: HubWorkspace,
  options: HubReportOptions,
): HubWorkspaceReport {
  const skip = skipReasonFor(workspace);
  const skipDetail = skip === null ? null : describeSkip(workspace, skip);

  const base = {
    slug: workspace.slug,
    prefix: workspace.prefix,
    path: workspace.path,
    kind: workspace.kind,
    available: workspace.available,
    repositoryId: workspace.repositoryId,
    skip,
    skipDetail,
  };

  /**
   * No identity means no key to look a connection record up by, so the row is
   * disconnected in the only sense available: there is nothing on this machine
   * that could be a connection for it. Note the ordering — a row with a PROBLEM
   * also lands here, and reports `disconnected` alongside its `skip`, because
   * reporting `manual` for a workspace whose id could not be read would be
   * asserting a connection we could not have found.
   */
  if (workspace.repositoryId === null) {
    return {
      ...base,
      state: "disconnected",
      mode: "disconnected",
      endpoint: null,
      deviceId: null,
      label: null,
      credentialMechanism: null,
      credentialPresent: null,
      auto: false,
      backup: false,
      connectedAt: null,
    };
  }

  /**
   * A connection record that will not parse is refused by `readConnection`
   * rather than replaced, and that refusal must not take the whole list down
   * either. Caught here, reported as the row's `skipDetail`, and the row reads
   * disconnected — the same discipline `hub-scope.ts` applies to a manifest.
   */
  let connection;
  try {
    connection = readConnection(home, workspace.repositoryId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      skip: "problem",
      skipDetail: `This workspace's connection record could not be read: ${message}`,
      state: "disconnected",
      mode: "disconnected",
      endpoint: null,
      deviceId: null,
      label: null,
      credentialMechanism: null,
      credentialPresent: null,
      auto: false,
      backup: false,
      connectedAt: null,
    };
  }

  if (!connection) {
    return {
      ...base,
      state: "disconnected",
      mode: "disconnected",
      endpoint: null,
      deviceId: null,
      label: null,
      credentialMechanism: null,
      credentialPresent: null,
      auto: false,
      backup: false,
      connectedAt: null,
    };
  }

  let credentialPresent: boolean | null = null;
  if (options.probeCredentials === true) {
    try {
      credentialPresent =
        credentialStoreFor(home, connection.credentialMechanism, {
          platform: options.platform,
        }).read(workspace.repositoryId) !== null;
    } catch {
      /**
       * A store that will not answer is not a store that answered "no". Left as
       * null — "this machine could not ask" — rather than reported as a missing
       * credential, which would tell a human to re-connect over a credential
       * that is probably sitting in a locked keychain.
       */
      credentialPresent = null;
    }
  }

  const state: HubConnectionState =
    credentialPresent === false ? "auth_failed" : connection.auto ? "automatic" : "manual";

  return {
    ...base,
    state,
    mode: connection.auto ? "automatic" : "manual",
    endpoint: connection.endpoint,
    deviceId: connection.deviceId,
    label: connection.label,
    credentialMechanism: connection.credentialMechanism,
    credentialPresent,
    auto: connection.auto,
    backup: connection.backup,
    connectedAt: connection.connectedAt,
  };
}

/** The hub-wide list as a human reads it. One line per workspace, plus a tail. */
export function describeHubReport(report: HubCloudReport): string {
  if (report.workspaces.length === 0) {
    return "No workspaces are registered on this machine, so there is nothing to connect.";
  }

  const lines: string[] = [];
  const slugWidth = Math.max(...report.workspaces.map((row) => row.slug.length), 9);

  for (const row of report.workspaces) {
    const marks: string[] = [];
    if (row.auto) marks.push("auto");
    if (row.backup) marks.push("backup");
    if (!row.available) marks.push("MISSING");
    lines.push(
      `  ${row.slug.padEnd(slugWidth)}  ${row.state.padEnd(12)} ` +
        `${row.endpoint ?? "-"}${marks.length > 0 ? `  [${marks.join(", ")}]` : ""}`,
    );
  }

  const skipped = report.workspaces.filter((row) => row.skip !== null);
  if (skipped.length > 0) {
    lines.push("");
    lines.push("Not acted on by a hub-wide operation:");
    for (const row of skipped) lines.push(`  ${row.slug}  ${row.skipDetail ?? row.skip}`);
  }

  lines.push("");
  lines.push(
    `  ${report.counts.connected} of ${report.counts.total} connected` +
      (report.counts.automatic > 0 ? `, ${report.counts.automatic} on automatic sync` : "") +
      (report.counts.skipped > 0 ? `, ${report.counts.skipped} not actionable` : ""),
  );
  return lines.join("\n");
}
