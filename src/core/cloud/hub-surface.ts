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
import { Hub } from "../hub.js";
import {
  HUB_BACKUP_CONTENTS,
  HUB_BACKUP_EXCLUSIONS,
  HUB_BACKUP_HEADLINE,
  REGISTRY_DISCLOSURE,
} from "./hub-registry.js";
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
  /**
   * True when staple records a sync identity for this workspace the next time it
   * opens it — every workspace that is not in a version control checkout.
   *
   * Carried through from {@link import("./hub-scope.js").HubWorkspace} rather
   * than re-derived, because re-deriving it means another `isCheckoutBacked`
   * walk and two walks can disagree. It is on the ROW because a surface has to
   * tell the two identity absences apart WITHOUT parsing prose: one of them
   * needs no instruction at all, and the other needs `staple init` in a precise
   * directory. Before this field existed the settings page had one sentence for
   * both, and for the first case that sentence invited a second repository id
   * over a workspace that was about to record its own.
   */
  recordsIdentityOnOpen: boolean;
  /**
   * Can any control on this row do anything at all?
   *
   * **Not `skip === null`, and the difference is the reason this is a field.**
   * A workspace whose only obstacle is that it has not recorded a sync identity
   * yet, and which will record one the next time staple opens it, is perfectly
   * connectable — pressing Connect is what opens it. `skipReasonFor` calls that
   * row `no_identity` and is right to: a hub-wide FAN-OUT will not act on it,
   * because a fan-out reads files and never opens a database. A row with its own
   * button is a different question, and this is that question's answer.
   *
   * Decided here so it is decided once. The alternative is every surface
   * re-deriving `!available ? no : problem ? no : identity ? yes :
   * recordsIdentityOnOpen` — which is a rule about `repo-identity.ts` spelled
   * out in a React component, in a CLI renderer, and in the next surface too.
   *
   * Orthogonal to {@link available}, deliberately, and both are needed. A
   * surface GROUPS on `available` ("is this thing on the machine") and COUNTS on
   * `actionable` ("is there anything to do here"). A reachable workspace inside a
   * checkout with no manifest is `available: true, actionable: false`, and
   * collapsing the two would hide it — which STA-282 forbids in as many words.
   */
  actionable: boolean;
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
  /**
   * Rows a surface can offer a working control on. See
   * {@link HubWorkspaceReport.actionable}.
   *
   * `total - skipped` is NOT this number, and that is the point of counting it
   * separately: a workspace that will record its identity on its next open is
   * skipped by a fan-out and actionable from a button.
   *
   * This is the count a settings page should lead with. "7 workspaces" said
   * about a list of which four point at paths that no longer exist is a true
   * number answering a question nobody asked.
   */
  actionable: number;
  /** Of the connected rows, those with automatic sync on for this device. */
  automatic: number;
}

/**
 * The hub, stated as a thing in its own right — S18 (STA-279).
 *
 * Separate from {@link HubCloudCounts} on purpose, and the distinction is the
 * whole ticket. `counts` describes the WORKSPACES: how many are connected, how
 * many a fan-out would act on. This describes the HUB: what it is, what it holds,
 * and what backing it up would and would not save.
 *
 * The old page conflated the two — it showed the current workspace's connection
 * at the top of a list of other workspaces, so the state on screen belonged to
 * something different from the thing the list was about. A panel that states the
 * hub's own state has to have somewhere to read it from that is not a workspace,
 * and this is it.
 */
export interface HubSelfReport {
  /** Rows in the registry, present or not. */
  registered: number;
  /** Rows whose database is on this machine right now. */
  present: number;
  /**
   * Rows registered here with no database on this machine.
   *
   * Worth its own number rather than `registered - present`: it is the count the
   * hub panel exists to make visible, because it is what a person on a new
   * machine is trying to find out — what am I missing.
   */
  absent: number;
  /** Cross-workspace edges the hub holds. Part of a hub backup; not tasks. */
  crossLinks: number;
  /**
   * What a hub backup would contain, and what it would not, in the words a
   * surface shows.
   *
   * Carried on the report rather than imported by the client so the two cannot
   * drift: whatever decides the payload decides the sentence.
   */
  backupHeadline: string;
  backupContents: readonly string[];
  backupExclusions: readonly string[];
  /**
   * The HUB's own connection to a sync service — S22 (STA-283).
   *
   * Distinct from every workspace's connection and from `counts`: this is the
   * hub as a subject, connected under `hub.storedHubId()`, which is what the
   * registry publish/restore path acts through. A machine can have nine
   * connected workspaces and an unconnected hub, or the reverse.
   *
   * ## Local fields only, and the two that are missing are the point
   *
   * `hubId` is a row in `hub.db`'s `meta`; every other field comes from
   * `readConnection(home, hubId)` — a file in the staple home, the same read this
   * module already does per row. There is deliberately **no `epoch` and no
   * `lastPublishedAt`**.
   *
   * `hubCloudReport` makes no authenticated round trip. That is the property
   * {@link HubConnectionState} protects by omitting `offline` and `revoked`, and
   * the one `hub-scope.ts` calls its single most important guarantee. An `epoch`
   * is only knowable from a push or snapshot RESPONSE, so a field for it would
   * force either a request inside a polled read or a local cache of remote
   * state. `lastPublishedAt` is worse: there is no hub-local sync state to
   * record it in, deliberately, and adding one is a hub migration bought to
   * improve one line of a panel.
   *
   * If a surface needs an epoch, it belongs on the OUTCOME of a publish or a
   * restore, where a round trip actually happened — the same place
   * {@link HubWorkspaceOutcome} puts its `detail`.
   */
  registry: {
    /**
     * The hub's registry identity, or null when it has none — STA-289.
     *
     * `storedHubId()`, never `hubId()`: that one MINTS, and this is read by a route the
     * settings page polls. It is on the report because the page has to say which identity
     * the hub has before it offers to mint one or take on another, and the id is a local
     * fact — a row in `hub.db`'s `meta` — so reading it asks nobody anything.
     */
    hubId: string | null;
    /** A connection record exists under the hub's id. False is "never connected". */
    connected: boolean;
    endpoint: string | null;
    /**
     * The sentence that must appear wherever this consent is granted.
     *
     * **Carried on the report rather than imported by the client**, exactly like
     * `backupHeadline` above and for the identical reason stated there:
     * *"whatever decides the payload decides the sentence."* The browser cannot
     * import `src/core` at all, so a client-side copy would be a second wording
     * with nothing holding it in step.
     *
     * Taken from `hub-registry.ts`, the LEAF — which imports only `../types.js`
     * and a `Hub` type — and never from `hub-registry-service.ts`, which reaches
     * `client.ts`. `hubCloudReport` is called by a route the settings page
     * POLLS, and putting the transport into a polled read's import graph is the
     * precise setup `hub-preview.ts` was split out of `hub-connect.ts` to
     * prevent.
     *
     * It briefly lived in two places, here and in the service, pinned equal by a
     * test. One declaration in a leaf is better than two that cannot drift, and
     * this is now that.
     */
    disclosure: string;
    /**
     * This machine's publish consent, `connection.registry === true`.
     *
     * False whenever `connected` is false, and not because it is defaulted:
     * `setRegistryConsent` refuses `not_found` on an unconnected hub rather than
     * springing a record into existence, so there is nowhere for a true to live.
     * A surface must therefore disable the toggle rather than merely let it
     * error.
     */
    consent: boolean;
    /**
     * This machine's HUB BACKUP consent, `connection.backup === true` — STA-289.
     *
     * The local half of `setHubBackupConsent`, read from the same connection record as
     * `consent`. The server's half (`repos.backup_enabled`) is not knowable without a
     * round trip and is deliberately not here; the page learns it from a button that asks.
     */
    backup: boolean;
  };
}

export interface HubCloudReport {
  workspaces: HubWorkspaceReport[];
  counts: HubCloudCounts;
  /** The hub itself. See {@link HubSelfReport} for why this is not `counts`. */
  self: HubSelfReport;
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

/**
 * What one row's control just did — S19 (STA-280), *"A row shows the outcome of
 * the last operation on it"*.
 *
 * One shape for all six of them, and the uniformity is the feature: a surface
 * that had a different result type per verb would render six different outcome
 * lines, and five of them would be written by whoever added the sixth verb last.
 *
 * `slug` is on it although the caller knew which row it pressed. It is the
 * evidence: an outcome whose slug does not match the row it is being rendered
 * against is the exact bug S19 asks to be prevented — *"an action on one row
 * does not act on another"* — and a result that carried no name could not be
 * checked. `test/ui-cloud-workspace-actions.test.ts` checks it.
 */
export interface HubWorkspaceOutcome {
  /** The workspace acted on, as the server resolved it. */
  slug: string;
  /**
   * S22 (STA-283) added `registry` — the HUB's own consent, and the first member
   * of this union whose subject is not a workspace. It arrives with the empty
   * slug, like the hub backup receipt, because the hub is not a row.
   */
  action: "connect" | "sync" | "auto" | "backup" | "disconnect" | "remove" | "registry";
  status: "ok" | "skipped" | "failed";
  /**
   * One sentence about THIS workspace. Rendered for a human, never parsed —
   * every decision a surface makes comes from `status` and from the refreshed
   * row beside it.
   */
  detail: string;
  /** ISO 8601, so a row can say "a moment ago" without the client guessing. */
  at: string;
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
  /**
   * Injected in tests, alongside `workspaces`. A caller that replaced the
   * enumeration has no hub file for the link count to be read from, and a
   * report that went to disk anyway would make those tests depend on the
   * developer's own registry.
   */
  crossLinks?: number;
  /**
   * Injected in tests, alongside `workspaces`, for the reason `crossLinks` is: a
   * caller that replaced the enumeration has no hub file for the hub's own
   * connection to be read from, and a report that went to disk anyway would make
   * those tests depend on the developer's own registry.
   */
  registry?: HubSelfReport["registry"];
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
      actionable: rows.filter((row) => row.actionable).length,
      automatic: rows.filter((row) => row.auto).length,
    },
    self: {
      registered: rows.length,
      present: rows.filter((row) => row.available).length,
      absent: rows.filter((row) => !row.available).length,
      crossLinks: options.crossLinks ?? countCrossLinks(),
      backupHeadline: HUB_BACKUP_HEADLINE,
      backupContents: HUB_BACKUP_CONTENTS,
      backupExclusions: HUB_BACKUP_EXCLUSIONS,
      registry: options.registry ?? readHubRegistryState(home),
    },
    endpoints,
  };
}

/**
 * Cross-link count, read through the hub's read-only handle.
 *
 * Never throws: a machine with no hub file at all has no links, and a settings
 * page that failed to render because a registry was missing would be a worse
 * answer than a zero.
 */
/**
 * The hub's own connection state — S22 (STA-283). Local files only.
 *
 * Reads through `storedHubId()` and **never `hubId()`**, and the difference is
 * the whole reason that pair exists: `hubId()` MINTS when there is none, and
 * this function is called by a report the settings page POLLS. A polled read
 * that minted an identity would write a permanent id into `meta` as a side
 * effect of somebody looking at a panel — the same class of mistake
 * `Hub.openReadOnly()` was introduced for.
 *
 * Never throws, for the reason {@link countCrossLinks} does not: a machine with
 * no hub file has no hub connection, and a settings page that failed to render
 * because a registry was missing is a worse answer than "not connected".
 */
function readHubRegistryState(home: string): HubSelfReport["registry"] {
  let hubId: string | null;
  try {
    const hub = Hub.openReadOnly();
    try {
      hubId = hub.storedHubId();
    } finally {
      hub.close();
    }
  } catch {
    hubId = null;
  }
  const absent = {
    hubId,
    connected: false,
    endpoint: null,
    disclosure: REGISTRY_DISCLOSURE,
    consent: false,
    backup: false,
  };
  if (hubId === null) return absent;

  try {
    const connection = readConnection(home, hubId);
    if (connection === null) return absent;
    return {
      hubId,
      connected: true,
      endpoint: connection.endpoint,
      disclosure: REGISTRY_DISCLOSURE,
      consent: connection.registry === true,
      backup: connection.backup === true,
    };
  } catch {
    /**
     * A hub connection record that will not parse. Reported as NOT CONNECTED
     * rather than propagated, which is the one place this differs from a
     * workspace row — a row has a `skip`/`skipDetail` pair to carry the problem
     * and this block has nowhere to put it. The consequence is bounded and
     * safe in the right direction: the panel offers to connect rather than
     * offering a consent toggle over a record nobody can read, and
     * `setRegistryConsent` would refuse on that record anyway.
     */
    return absent;
  }
}

function countCrossLinks(): number {
  try {
    const hub = Hub.openReadOnly();
    try {
      return hub.listCrossLinks().length;
    } finally {
      hub.close();
    }
  } catch {
    return 0;
  }
}

/**
 * The ONE place `actionable` is decided. See
 * {@link HubWorkspaceReport.actionable} for why it is not `skip === null`.
 *
 * Written as a switch over the skip reason rather than as a boolean expression,
 * because each arm is a different argument and the next person to add a skip
 * reason must be made to answer this question for it:
 *
 * - `unavailable` — the database file is not on this machine. Connect would mint
 *   a credential for something that cannot then sync, and sync would either fail
 *   or, worse, CREATE an empty database and hydrate it from the remote. `hub-
 *   scope.ts` makes that argument at length. The one control that IS offered on
 *   such a row is disconnect, and it is offered for the opposite reason —
 *   `performHubDisconnect` is deliberately not gated on `available`, because the
 *   credential is on THIS machine and refusing to remove it would leave a live
 *   secret behind for exactly the workspace somebody is most likely to be
 *   disconnecting. That asymmetry belongs to the surface, not to this flag: a
 *   surface asks "is there anything here" and then asks each control separately.
 *
 * - `problem` — the manifest is present and will not parse. Neither absent nor
 *   usable, and every consumer treats it as not actionable rather than guessing.
 *
 * - `no_identity` — the interesting one, and it splits.
 *   `recordsIdentityOnOpen` means opening this workspace records an identity, and
 *   opening it is exactly what a per-row connect does. So the row IS actionable,
 *   and the surface offers Connect with no instruction attached. Inside a
 *   checkout the manifest is a committed file; nothing that opens the database
 *   will produce one, and `staple init` in that directory really is the answer.
 *
 * - `null` — nothing is in the way.
 */
function actionableFor(workspace: HubWorkspace, skip: HubSkipReason | null): boolean {
  switch (skip) {
    case null:
      return true;
    case "unavailable":
    case "problem":
      return false;
    case "no_identity":
      return workspace.recordsIdentityOnOpen;
  }
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
    recordsIdentityOnOpen: workspace.recordsIdentityOnOpen,
    actionable: actionableFor(workspace, skip),
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
      /**
       * Overridden alongside `skip`, and it has to be. `base.actionable` was
       * computed before this read was attempted and said true, because the only
       * facts known at that point were that the disk is here and the manifest
       * parsed. A control offered now would act through a connection record
       * nobody could read.
       */
      actionable: false,
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
