/**
 * THE CLOUD SECTION'S PURE HALF — S13 (STA-258).
 *
 * Same discipline as `settings-shell.ts` and `settings-ops.ts`: everything this
 * section decides that can be decided without a DOM lives here, so a test with no
 * browser can pin it. The component holds the wiring and nothing else.
 *
 * ── THE ONE THING TO UNDERSTAND ABOUT THIS FILE ───────────────────────────────
 *
 * There is a `SettingCategoryView` declared below and it is NOT in the settings
 * registry. That is the whole design of this lane, stated in one object.
 *
 * `src/core/settings-registry.ts` describes values that live in the WORKSPACE
 * database, and the workspace database synchronizes. A credential stored there
 * would replicate itself to every device. A `sync.auto` flag stored there would
 * mean one machine enabling background sync had silently enabled it for
 * everyone — which is exactly the consent this epic promises not to spend on
 * somebody else's behalf. `src/core/cloud/connection.ts` opens by explaining why
 * it is a file in the staple home rather than a row.
 *
 * So the category is declared HERE, in the browser, and composed into the nav by
 * `SettingsDialog`. The shell renders it in the same place as every other
 * section; the backing store is `~/.staple/cloud/<repositoryId>.json` through the
 * cloud routes, and `/api/settings` never learns this category exists. Same place
 * in the UI, different store, and the type system cannot express the difference —
 * which is why it is written down.
 *
 * ── VALUES, NOT PROSE ─────────────────────────────────────────────────────────
 *
 * Every function here reads a VALUE off `CloudSurfaceReport` — `mode`, `auto`,
 * `backup`, `pending`, `credentialPresent`. `detail` and `failure.summary` are
 * rendered as sentences for a human and are never parsed. `surface.ts` says why:
 * *"a surface that has to reverse-engineer prose is a surface that will get it
 * wrong the first time the prose is improved."*
 */
import type { SettingCategoryView } from "@/lib/settings";
import type {
  CloudSurfaceReport,
  ConnectPreview,
  HubCloudReport,
  HubWorkspaceReport,
  RemoteDevice,
} from "@/lib/types";

/** The category id. Not a setting key: nothing is ever stored under it. */
export const CLOUD_CATEGORY_ID = "cloud";

/**
 * The synthetic category.
 *
 * `scope: "global"` is the honest answer and not a placement trick — it puts the
 * section under the nav's "Global" heading, beside "This machine", which is
 * precisely where a per-device credential and two per-device consents belong. A
 * reader who wonders "does connecting here connect my other laptop?" is answered
 * by the heading before they read a word of the section.
 *
 * `editor` is inert. `CategoryContent` matches this id BEFORE it switches on
 * `editor`, so the value is never consulted; it is `"fields"` because the type
 * mirrors the server's closed union and widening a wire type to describe a
 * category the wire never carries would be the wrong repair. The registry serves
 * no definitions in this category, so even the unreachable `fields` arm would
 * render an empty form rather than anything wrong.
 *
 * `order: 80` sits it just before "This machine" (90) and after every workspace
 * category, so the nav reads workspace-things then machine-things.
 */
export const CLOUD_CATEGORY: SettingCategoryView = {
  id: CLOUD_CATEGORY_ID,
  label: "Cloud",
  description:
    "This machine's connection to a sync service, and the two later consents. Stored beside " +
    "staple's home on this computer — never in the workspace, which would replicate it to " +
    "every device.",
  scope: "global",
  editor: "fields",
  order: 80,
};

export function isCloudCategory(id: string | null | undefined): boolean {
  return id === CLOUD_CATEGORY_ID;
}

/**
 * The served registry plus this one, in shell order.
 *
 * Returns the input untouched while the registry is empty — before `/api/settings`
 * resolves there is no nav at all, and a lone "Cloud" entry appearing a beat
 * before the rest would move the selection under the reader.
 */
export function withCloudCategory(
  categories: readonly SettingCategoryView[],
): SettingCategoryView[] {
  if (categories.length === 0) return [...categories];
  if (categories.some((category) => category.id === CLOUD_CATEGORY_ID)) return [...categories];
  return [...categories, CLOUD_CATEGORY].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- what the section shows

/** One label/value row. `value` null means "do not render this row at all". */
export interface CloudFact {
  label: string;
  value: string | null;
}

/**
 * WHO this machine is connected to, as facts.
 *
 * Empty on a disconnected workspace — every field would be null, and a table of
 * eight dashes is a worse answer than no table. That is also the first half of
 * "renders quietly": there is nothing to draw, so nothing is drawn.
 */
export function connectionFacts(report: CloudSurfaceReport): CloudFact[] {
  if (report.mode === "disconnected") return [];
  return (
    [
      { label: "Service", value: report.endpoint },
      { label: "Repository", value: report.repositoryId },
      {
        label: "This device",
        value: report.deviceId ? `${report.label ? `${report.label} — ` : ""}${report.deviceId}` : null,
      },
      {
        label: "Credential",
        value: report.credentialMechanism
          ? `${report.credentialMechanism}${report.credentialPresent ? "" : " — NOT FOUND"}`
          : null,
      },
      { label: "Connected", value: report.connectedAt },
    ] satisfies CloudFact[]
  ).filter((fact) => fact.value !== null);
}

/**
 * The counters, in every connected state.
 *
 * `pending`, `cursor` and `epoch` are rendered even at zero and null, unlike
 * `CloudStrip` which drops them. The strip is a one-line ambient reading that has
 * to earn its vertical space; this is the page somebody opened to find out what
 * state they are in, and there "pending: 0" is an answer while a missing row is
 * indistinguishable from a row that was never implemented — the same argument
 * `describeReport` makes for the CLI's output.
 */
export function counterFacts(report: CloudSurfaceReport): CloudFact[] {
  if (report.mode === "disconnected") return [];
  const facts: CloudFact[] = [
    { label: "Pending operations", value: String(report.pending) },
    { label: "Cursor", value: report.cursor ?? "none yet" },
    { label: "Epoch", value: report.epoch === null ? "none" : String(report.epoch) },
  ];
  if (report.lastSyncAt) facts.push({ label: "Last sync", value: report.lastSyncAt });
  if (report.conflicts.open > 0) {
    facts.push({ label: "Unresolved conflicts", value: String(report.conflicts.open) });
  }
  if (report.leases.held > 0) facts.push({ label: "Leases held", value: String(report.leases.held) });
  return facts;
}

/** One of the two later consents, as a control binds to it. */
export interface ConsentControl {
  key: "auto" | "backup";
  label: string;
  description: string;
  /** THE VALUE. Read off the report; never inferred from `detail`. */
  value: boolean;
}

/**
 * The two later consents. Two of them, always, and never one compound switch.
 *
 * *"Connection, automatic sync, and backup are three separate explicit
 * consents."* A single "cloud on" control would spend all three with one press,
 * and a UI that offered one would make the separation the epic is built on
 * unobservable — the flags would still be separate in the file and identical in
 * practice.
 *
 * Both read false on a fresh connection because `performConnect` writes false for
 * both, on every connection including a re-connect. The descriptions say so, in
 * the affirmative, because a person deciding whether to press this is asking
 * exactly "what starts happening if I do".
 */
export function consentControls(report: CloudSurfaceReport): ConsentControl[] {
  return [
    {
      key: "auto",
      label: "Automatic sync",
      description:
        "Off: nothing is uploaded or downloaded until you run `staple cloud sync`. On: this " +
        "machine syncs in the background. This is a per-device decision — turning it on here " +
        "does not turn it on anywhere else.",
      value: report.auto,
    },
    {
      key: "backup",
      label: "Backup",
      description:
        "A separate opt-in from sync. Off: no snapshot is ever taken. On: this machine may " +
        "create and list remote backups. Backup does not drive convergence and enabling it " +
        "does not enable sync.",
      value: report.backup,
    },
  ];
}

/**
 * Is the section allowed to offer a connect form at all?
 *
 * False when the workspace has no sync identity, because there is nothing for a
 * connection to be ABOUT. The report says so through
 * `failure.code === "no_identity"`, which is the value; the section renders
 * `failure.summary` and `failure.remedy` rather than a form that would be
 * refused.
 *
 * This used to exclude every global workspace, permanently. STA-273 gave a
 * workspace with no repository an identity of its own, so the answer here is
 * now true for one — the predicate did not have to change, because it was
 * already asking about the identity rather than about the kind.
 */
export function canOfferConnect(report: CloudSurfaceReport): boolean {
  return report.mode === "disconnected" && report.failure?.code !== "no_identity";
}

/**
 * What is wrong with the connect form, before a round trip.
 *
 * Deliberately thin. It answers the two questions that need no server — did you
 * fill both required boxes — and nothing else. The endpoint's real rules (https,
 * no credentials in the URL, parseable) belong to `parseEndpoint`, arrive as its
 * own sentence, and a second copy here would be a second chance to paraphrase
 * one. Same argument `validateVocabularyId` makes in settings-ops.ts.
 */
export function connectFormProblem(input: { endpoint: string; token: string }): string | null {
  if (input.endpoint.trim() === "") return "An endpoint is required.";
  if (input.token.trim() === "") {
    return (
      "An enrollment credential is required: this repository's enrollment secret for the " +
      "first machine, or an existing device token from a machine that is already connected."
    );
  }
  return null;
}

/**
 * The lines of the consent screen, as values.
 *
 * The rendered CLI preview is prose on purpose — *"consent to a table is not
 * really consent"* — and this keeps that, but the FACTS are extracted so the
 * component does not parse a paragraph to draw a row. The disclosure sentences
 * below are the same claims `renderConnectPreview` makes, because they are the
 * claims this build can actually stand behind.
 */
export function previewFacts(preview: ConnectPreview): CloudFact[] {
  return (
    [
      { label: "Service", value: preview.endpoint.origin },
      { label: "Repository", value: preview.repositoryId },
      {
        label: "Device",
        value: preview.deviceId ?? "a new device id will be minted for this machine",
      },
      { label: "Label", value: `${preview.label} (sent to the server)` },
      { label: "Credential", value: describeMechanism(preview.credentialMechanism) },
      { label: "Falling back because", value: preview.credentialFallbackReason },
      {
        label: "Already connected to",
        value: preview.existingEndpoint
          ? `${preview.existingEndpoint} — connecting will point this repository at ${preview.endpoint.origin} instead and replace the stored credential`
          : null,
      },
    ] satisfies CloudFact[]
  ).filter((fact) => fact.value !== null);
}

function describeMechanism(mechanism: ConnectPreview["credentialMechanism"]): string {
  switch (mechanism) {
    case "keychain":
      return "macOS keychain (service staple-sync)";
    case "secret-tool":
      return "the system secret service (libsecret)";
    case "file":
      return "a 0600 file in your staple home";
  }
}

/**
 * What happens if you say yes. Verbatim in meaning from `renderConnectPreview`,
 * including the two sentences that are least comfortable to show and most
 * necessary: sync stays off, and the contents are stored in plaintext.
 */
export const CONNECT_DISCLOSURE: readonly string[] = [
  "This device is registered with that service and given a credential.",
  "The credential is stored on this machine only, and never in git or the workspace database.",
  "AUTOMATIC SYNC STAYS OFF. Nothing is uploaded until you run `staple cloud sync`, or turn " +
    "on Automatic sync here — a separate decision.",
  "Issue titles, descriptions, comments and documents are stored in PLAINTEXT on that service. " +
    "There is no end-to-end encryption. Whoever holds that Cloudflare account can read them.",
  "Nothing has been sent yet. Declining leaves no credential, no setting and no remote record.",
];

/**
 * Purge is NAMED here and is not a button, and that is a decision rather than an
 * omission.
 *
 * `staple cloud purge` requires the repository id typed back before it will act,
 * and STA-256 records that the server does not yet validate a confirmation on the
 * wire. A one-click irreversible remote deletion behind a browser session, whose
 * only guard is a dialog this page draws, is not a thing to add while that is
 * true — the guard would live entirely in the surface that a script bypasses.
 *
 * Telling somebody the capability exists and where it lives costs nothing and
 * hides nothing, so the section says it.
 */
export const PURGE_NOTICE =
  "Deleting the remote copy of this repository is `staple cloud purge`, at a terminal. It " +
  "prints what is stored and for how long, and requires the repository id typed back. It is " +
  "deliberately not a button here: it cannot be undone, and the typed confirmation is the " +
  "whole safeguard.";

// ---------------------------------------------------------------- devices

/**
 * The device list, ordered for reading: this machine first, then live devices by
 * most recently seen, then revoked ones last.
 *
 * This machine goes first because the question somebody opens this list with is
 * usually "which of these is me" — and it is also the row whose Revoke button is
 * the one with a consequence they might not expect, so it is the row that gets
 * read rather than the one they scroll past. Revoked devices stay on the list
 * rather than being filtered out: they are the audit trail of a revocation, and a
 * list that forgets what you did to it cannot confirm you did it.
 */
export function orderDevices(devices: readonly RemoteDevice[]): RemoteDevice[] {
  return [...devices].sort((a, b) => {
    const revoked = Number(a.revokedAt !== null) - Number(b.revokedAt !== null);
    if (revoked !== 0) return revoked;
    const self = Number(b.self) - Number(a.self);
    if (self !== 0) return self;
    return (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt);
  });
}

/** One device row's secondary line. Milliseconds since epoch, as the Worker sends them. */
export function describeDevice(device: RemoteDevice, now: number = Date.now()): string {
  const parts: string[] = [];
  if (device.revokedAt !== null) parts.push(`revoked ${relativeTime(device.revokedAt, now)}`);
  else if (device.lastSeenAt !== null) parts.push(`last seen ${relativeTime(device.lastSeenAt, now)}`);
  else parts.push("never seen");
  parts.push(`added ${relativeTime(device.createdAt, now)}`);
  return parts.join(" · ");
}

/**
 * Coarse on purpose: minutes, hours, days. A device list is answering "is that
 * old laptop still enrolled", and a to-the-second reading invites a precision the
 * server's `lastSeenAt` — written on request, not on a heartbeat — does not have.
 */
function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The sentence a revoke confirmation shows. Revoking THIS device is allowed and
 * is a real thing to want — a stolen laptop is revoked from the laptop you still
 * have — so it is warned about rather than refused, which is the same choice
 * `performRevoke` makes.
 */
export function revokeWarning(device: RemoteDevice): string {
  return device.self
    ? "This is the machine you are using. Revoking it ends THIS device's access on its very " +
        "next request. Your local database and pending work are untouched, and re-enrolling " +
        "needs `staple cloud connect` and an enrollment credential."
    : "That device loses access on its very next request. Its local data and pending work are " +
        "untouched, and every other device is unaffected.";
}

// ------------------- the per-workspace list, as a CONTROL (S17/S19/S21)

/**
 * ## What changed here, and why the previous shape was wrong
 *
 * This section shipped as a table with a sentence under each row and no controls
 * at all. Its own header said so — *"A LIST AND NOT A CONTROL, and that is a
 * decision rather than an omission"* — and the argument was that connecting
 * every workspace at once spends one enrollment secret against N services and
 * produces a per-workspace outcome a settings dialog has nowhere to put, so
 * naming `staple cloud connect --all` was more use than a button that would ask
 * for less than the CLI preview does.
 *
 * **That argument was sound and it was about the wrong thing.** It is an argument
 * against a HUB-WIDE button, and it is still correct: there is no "connect
 * everything" control here and there should not be. What it was taken to justify
 * was the absence of PER-ROW controls, which it does not touch. A single row's
 * connect spends one secret against one service and produces one outcome, which
 * is exactly the shape the single-workspace sections above have offered from the
 * start. Nine tenths of the reasoning survives; the conclusion does not.
 *
 * The visible consequence was a page that explained at length and did nothing:
 * seven rows, four of them pointing at paths that no longer exist, each with a
 * four-line paragraph about unmounted volumes, and every action it described
 * reachable only from a terminal. STA-278, STA-280 and STA-282 are three
 * statements of that one fact.
 *
 * ## The three rules this half now follows
 *
 * 1. **A row states what it is in ONE line.** {@link hubRowSummary}. The
 *    paragraph — `describeSkip`'s prose about unmounted volumes and committed
 *    manifests — moves to {@link hubRowRationale}, behind a disclosure. It is
 *    good writing; it was in the wrong place.
 *
 * 2. **Every control is present, and a control that will not work says why.**
 *    {@link hubRowControls} returns all six for every row, always, with
 *    `disabledReason` set instead of being dropped from the list. A control that
 *    vanishes teaches a reader nothing; one that is greyed out with a sentence
 *    teaches them the model.
 *
 * 3. **Nothing here parses prose.** Every decision below reads `state`, `auto`,
 *    `backup`, `available`, `actionable` or `recordsIdentityOnOpen` — values.
 *    `skipDetail` is rendered and never inspected, the rule the rest of this file
 *    already followed.
 */

/** One workspace row, reduced to what the list draws. */
export interface HubRowView {
  slug: string;
  /** `state`, in the words a person uses. Never parsed back. */
  state: string;
  /** The service it is connected to, or a dash. */
  endpoint: string;
  /** Short badges: auto, backup, MISSING. */
  marks: string[];
  /**
   * ONE line saying what this row is and what its state means for it.
   *
   * The row body. Everything longer is behind {@link rationale}.
   */
  summary: string;
  /**
   * The long explanation, or null when the row needs none.
   *
   * This is where `describeSkip`'s paragraphs live now. They answer real
   * questions — why an unmounted volume is not a deleted workspace, why a
   * checkout's manifest is different — and they answer them for the reader who
   * went looking, rather than for the six who did not.
   */
  rationale: string | null;
  /** True for the workspace this settings dialog is currently open on. */
  current: boolean;
  /** `available`. Drives GROUPING — is this thing on the machine at all. */
  reachable: boolean;
  /** Drives the COUNT. See `HubWorkspaceReport.actionable`; it is not `!skip`. */
  actionable: boolean;
}

/** One verb a row offers. Six of them, on every row, always. */
export type HubRowAction = "connect" | "sync" | "auto" | "backup" | "disconnect" | "remove";

export interface HubRowControl {
  action: HubRowAction;
  label: string;
  /**
   * One line: what pressing this does. Rendered whether the control is enabled
   * or not, because "what would this have done" is the question a disabled
   * control most needs to answer.
   */
  effect: string;
  /**
   * Null when the control works. A sentence when it does not.
   *
   * **Never used to filter.** *"Actions are disabled with a stated reason rather
   * than hidden"* — a control that disappears leaves a reader unable to tell an
   * unavailable capability from one that does not exist.
   */
  disabledReason: string | null;
  /** The current value, for the two consents. Undefined for the four buttons. */
  value?: boolean;
  /** Renders as a destructive confirmation rather than as a plain press. */
  destructive?: boolean;
}

const HUB_STATE_WORDS: Record<HubWorkspaceReport["state"], string> = {
  disconnected: "Not connected",
  manual: "Connected, manual",
  automatic: "Connected, automatic",
  auth_failed: "Credential missing",
};

/**
 * The row's one line.
 *
 * Written as a switch over the facts rather than as a template with holes,
 * because the six cases say genuinely different things and a template would have
 * produced one sentence with three clauses that never all applied at once.
 *
 * Note what is NOT here: no path, no repository id, no device id, no timestamp.
 * They are all true and none of them is what somebody scanning a list of
 * workspaces is looking for. They are in the disclosure.
 */
export function hubRowSummary(row: HubWorkspaceReport): string {
  if (!row.available) {
    return "Not on this machine right now. Still registered, and nothing has been deleted.";
  }
  if (row.skip === "problem") {
    return "Its sync identity could not be read, so nothing here can act on it.";
  }
  if (row.state === "auth_failed") {
    return `Connected to ${row.endpoint ?? "a service"}, but this machine's credential is gone. Connecting again mints a new one.`;
  }
  if (row.state === "automatic") {
    return `Syncing automatically with ${row.endpoint}, in the background, on this machine.`;
  }
  if (row.state === "manual") {
    return `Connected to ${row.endpoint}. Nothing moves until you sync it.`;
  }
  if (row.skip === "no_identity") {
    return row.recordsIdentityOnOpen
      ? "Not connected. Connecting it records its sync identity — there is nothing to set up first."
      : "Not connected, and its sync identity is a committed file that is not there yet.";
  }
  return "Not connected. Nothing about this workspace leaves the machine.";
}

/**
 * The paragraph, for the disclosure — or null when the row has nothing to
 * explain.
 *
 * `skipDetail` is the server's own sentence and is passed through UNCHANGED, the
 * same discipline `describeRefusal` follows: a surface that paraphrases a core
 * explanation is a surface that will be paraphrasing a stale one within a
 * release. The path is appended because a person who opened this disclosure is
 * asking "which one IS this", and that is the answer.
 */
export function hubRowRationale(row: HubWorkspaceReport): string | null {
  const parts: string[] = [];
  if (row.skipDetail !== null) parts.push(row.skipDetail);
  parts.push(`Database: ${row.path}`);
  if (row.repositoryId !== null) parts.push(`Sync identity: ${row.repositoryId}`);
  if (row.deviceId !== null) {
    parts.push(`This machine is device ${row.deviceId}${row.label ? ` (${row.label})` : ""}.`);
  }
  if (row.connectedAt !== null) parts.push(`Connected ${row.connectedAt}.`);
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * Describe one row of the list.
 *
 * `state` and `marks` are derived from VALUES — `state`, `auto`, `backup`,
 * `available` — and never from `skipDetail`, which is a sentence for a human.
 *
 * `credentialPresent` is deliberately NOT rendered. The route that feeds this
 * list does not probe it, so it is always `null` here, and a column that read
 * `null` as "missing" would tell somebody their credential had gone when nothing
 * had looked for it. `state` already carries `auth_failed` on the one surface
 * that does probe.
 */
export function hubRowView(
  row: HubWorkspaceReport,
  options: { currentRepositoryId?: string | null } = {},
): HubRowView {
  const marks: string[] = [];
  if (row.auto) marks.push("auto");
  if (row.backup) marks.push("backup");
  if (!row.available) marks.push("MISSING");
  return {
    slug: row.slug,
    state: HUB_STATE_WORDS[row.state],
    endpoint: row.endpoint ?? "—",
    marks,
    summary: hubRowSummary(row),
    rationale: hubRowRationale(row),
    current:
      options.currentRepositoryId != null &&
      row.repositoryId != null &&
      row.repositoryId === options.currentRepositoryId,
    reachable: row.available,
    actionable: row.actionable,
  };
}

/**
 * Why nothing on this row will work, or null.
 *
 * Computed ONCE and shared by the controls that need it, so six disabled
 * messages cannot become six paraphrases of one fact. Reads `actionable`, which
 * `hub-surface.ts` decided — the browser does not re-derive the
 * `recordsIdentityOnOpen` rule, which is a statement about `repo-identity.ts`
 * and has no business in a settings component.
 */
function rowBlocked(row: HubWorkspaceReport): string | null {
  if (row.actionable) return null;
  if (!row.available) return "Its database is not on this machine right now.";
  if (row.skip === "problem") return "Its sync identity could not be read. The details are below.";
  return (
    "It is inside a version control checkout, where the sync identity is committed alongside " +
    "the code rather than minted behind you. `staple init` in that directory records one; it " +
    "adopts this workspace and its data and creates nothing new."
  );
}

/**
 * The six controls a row offers, in the order they are drawn.
 *
 * **All six, on every row, always.** Enablement is expressed by
 * `disabledReason` and never by omission, which is the acceptance criterion and
 * also the thing that makes this list teachable: a reader who presses nothing
 * still learns that connecting, syncing and backing up are three separate
 * decisions, because they can see all three and read why two of them are not
 * available yet.
 *
 * ## The three asymmetries worth reading before changing this
 *
 * **Sync needs the disk; disconnect does not.** Synchronizing opens the
 * workspace database, so an unmounted volume makes it impossible. Disconnecting
 * deletes a file in the staple home, so an unmounted volume makes it *more*
 * important — `performHubDisconnect` is deliberately not gated on `available`,
 * because refusing would leave a live credential behind for exactly the
 * workspace somebody is most likely to be disconnecting. So on a MISSING row,
 * five controls are disabled and Disconnect is not.
 *
 * **The two consents need a connection and nothing else.** They write one file
 * in the staple home, so they are offered on a connected row whose disk is
 * absent. That reads oddly beside "not on this machine" and is right: the
 * consent is this device's, it persists, and it applies the moment the volume
 * returns.
 *
 * **Remove is refused while connected.** The connection record and credential
 * are keyed by repository id in the staple home, and the registry row is the
 * only thing on this machine that points a human at them. Removing it leaves a
 * live credential nothing names. The server refuses this too; it is stated here
 * so the reason is visible before the press rather than after it.
 */
export function hubRowControls(
  row: HubWorkspaceReport,
  options: { current?: boolean } = {},
): HubRowControl[] {
  const connected = row.state !== "disconnected";
  const blocked = rowBlocked(row);
  const notConnected = "It is not connected on this machine, so there is nothing to act on.";
  const noDisk = "Its database is not on this machine right now.";

  return [
    {
      action: "connect",
      label: "Connect",
      effect:
        "Shows what would be sent and asks, then stores a credential for this machine only. " +
        "Sync stays off — that is a separate decision.",
      disabledReason: connected
        ? `Already connected to ${row.endpoint ?? "a service"}. Disconnect it first to point it somewhere else.`
        : blocked,
    },
    {
      action: "sync",
      label: "Sync now",
      effect: "Sends this workspace's queued changes and applies what other devices have sent.",
      disabledReason: !connected ? notConnected : !row.available ? noDisk : blocked,
    },
    {
      action: "auto",
      label: "Automatic sync",
      effect:
        "On: this machine syncs this workspace in the background. Off: nothing moves until you " +
        "press Sync now. This device only — it does not decide for your other machines.",
      value: row.auto,
      disabledReason: connected ? null : notConnected,
    },
    {
      action: "backup",
      label: "Backup",
      effect:
        "On: this machine may take and list remote snapshots of this workspace. A separate " +
        "opt-in from sync, and turning it on does not turn sync on.",
      value: row.backup,
      disabledReason: connected ? null : notConnected,
    },
    {
      action: "disconnect",
      label: "Disconnect",
      effect:
        "Removes this machine's credential for it and stops all later traffic. Its data, " +
        "including queued changes, is untouched, and other devices are unaffected.",
      destructive: true,
      // Deliberately NOT gated on `available`. See the header.
      disabledReason: connected ? null : notConnected,
    },
    {
      action: "remove",
      label: "Remove from list",
      effect:
        "Takes it off this machine's list of workspaces. It unregisters; it does not delete — " +
        "the database and every file beside it stay exactly where they are.",
      destructive: true,
      disabledReason: connected
        ? "Disconnect it first. Removing it now would leave this machine's credential for it " +
          "with nothing pointing at it."
        : options.current === true
          ? "This is the workspace this window is serving. It would register itself again immediately."
          : null,
    },
  ];
}

/**
 * The row's disabled controls, grouped by the reason they share.
 *
 * ## Why this exists, and why it is not a softening of the criterion
 *
 * *"Actions are disabled with a stated reason rather than hidden"* is the
 * criterion, and the first thing built to satisfy it rendered each control's
 * reason beside that control. On a disconnected row that produces the SAME
 * sentence four times — beside Sync now, Automatic sync, Backup and Disconnect —
 * seven rows deep. Which is repetitive, and worse than repetitive: it is the
 * exact failure this ticket exists to fix, arrived at from the opposite
 * direction. *"We don't need settings page to be noise gibberish."*
 *
 * So the reason is still STATED, once per distinct reason, naming every control
 * it applies to. Nothing is hidden — a reader can see which controls are
 * unavailable and why — and the row goes from four identical lines to one.
 *
 * Deliberately NOT done by making `hubRowControls` return one reason for the row:
 * the reasons are genuinely per-control (on a MISSING row, Disconnect is live
 * while Sync is not, and the two carry different sentences), and collapsing them
 * at the source would lose that. This groups for RENDERING and leaves the
 * decision per control, where it belongs.
 *
 * Insertion-ordered, so the sentences appear in the order their first control
 * does — a `Map` rather than an object, because the reasons are sentences and
 * object keys would be both enormous and reordered by the runtime for integer
 * lookalikes.
 */
export function groupDisabledReasons(
  controls: readonly HubRowControl[],
): Array<{ reason: string; labels: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const control of controls) {
    if (control.disabledReason === null) continue;
    const labels = grouped.get(control.disabledReason);
    if (labels) labels.push(control.label);
    else grouped.set(control.disabledReason, [control.label]);
  }
  return [...grouped].map(([reason, labels]) => ({ reason, labels }));
}

/** "Sync now, Automatic sync, Backup and Disconnect" — an Oxford-free list. */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The list split into what is here and what is not — S21 (STA-282).
 *
 * The grouping key is `reachable`, and it is `available` and nothing else.
 * **Not a list of slugs.** The rows this ticket is about are named in it —
 * `autotrigger`, `legacyrepo`, `qdemo`, `r6b`, `s1-schema-probe` — and a
 * denylist of those five would be the same class of mistake as the debris
 * itself: a fact about one afternoon's testing, compiled into the product, wrong
 * on the next machine and invisible when it is.
 *
 * `existsSync(path)` is a property of the world, and it happens to be false for
 * four of the five. The fifth is still on disk, so it stays in the main list and
 * is removable from there — which is exactly what *"a reachable workspace is
 * never hidden by this grouping"* requires, and what a denylist would have
 * broken.
 *
 * Both groups are rendered. Subordinate is not the same as hidden: an unreachable
 * row keeps every control it can honestly offer, and Remove is the point of it
 * being on screen at all.
 */
export function hubGroups(
  report: HubCloudReport,
  options: { currentRepositoryId?: string | null } = {},
): { reachable: HubRowView[]; unreachable: HubRowView[] } {
  const views = report.workspaces.map((row) => hubRowView(row, options));
  return {
    reachable: views.filter((view) => view.reachable),
    unreachable: views.filter((view) => !view.reachable),
  };
}

/**
 * The one sentence under the list's heading.
 *
 * ## What it no longer says
 *
 * It used to end *"Connect all of them at once with `staple cloud connect
 * --all`"* — a terminal command as the answer to the question the section had
 * just raised, on a page whose whole job is to be the place you act. That
 * sentence is gone, and no sentence replaces it: the actions are on the rows.
 *
 * It also used to lead with `total`. "7 workspaces" said about a list of which
 * four point at paths that no longer exist is a true number answering a question
 * nobody asked, and it is the number that made the debris look like inventory.
 * It leads with `actionable` now — *"the count at the top reflects actionable
 * workspaces rather than every row"* — and names the unreachable ones separately
 * so nothing is concealed by the change.
 */
export function hubListDescription(report: HubCloudReport): string {
  const counts = report.counts;
  const missing = report.workspaces.filter((row) => !row.available).length;

  const lead =
    counts.actionable === 0
      ? "None of the workspaces registered on this machine can be acted on from here."
      : counts.actionable === counts.total
        ? `All ${counts.total} workspaces registered on this machine can be acted on here.`
        : `${counts.actionable} of ${counts.total} workspaces registered on this machine can be acted on here.`;

  const parts = [lead];
  parts.push(
    counts.connected === 0
      ? "None is connected."
      : `${counts.connected} connected${counts.automatic > 0 ? `, ${counts.automatic} syncing automatically` : ""}.`,
  );
  if (missing > 0) {
    parts.push(
      `${missing} ${missing === 1 ? "is" : "are"} not on this machine and ${missing === 1 ? "is" : "are"} listed separately below.`,
    );
  }
  parts.push("Each acts on its own workspace; nothing here acts on all of them at once.");
  return parts.join(" ");
}

/**
 * The heading over the subordinate group, with its count.
 *
 * Says what removal means in the heading rather than in each row's confirmation,
 * because the question "does this delete my data" is asked once about the group
 * and not six times about its members.
 */
export function hubUnreachableDescription(count: number): string {
  return (
    `${count} registered ${count === 1 ? "workspace is" : "workspaces are"} not on this machine ` +
    "right now. An unmounted volume is not a deleted workspace, so they are left alone rather " +
    "than repaired — and removing one only unregisters it. Nothing is deleted, and if its files " +
    "come back, running staple in that directory registers it again."
  );
}

/**
 * What the removal confirmation says.
 *
 * The sentence STA-282 asks for — *"removal explains that it unregisters and
 * does not delete data"* — and it is not a reassurance, it is the mechanism:
 * `deleteHubRegistration` is handed a database connection and a NAME, with no
 * `fs` module and no workspace opener, so it has nothing to delete a file WITH.
 */
export function removeWarning(row: HubWorkspaceReport, crossLinks: number): string {
  const base =
    `"${row.slug}" comes off this machine's list. Its database and every file beside it are ` +
    `left exactly as they are — this unregisters, it does not delete. Its prefix ${row.prefix} ` +
    "becomes available for another workspace to use.";
  const returning = row.available
    ? " Because its files are still here, running staple in that directory registers it again."
    : " Its files are not on this machine, so nothing will bring it back on its own.";
  const links =
    crossLinks > 0
      ? ` ${crossLinks} cross-workspace ${crossLinks === 1 ? "link names" : "links name"} it. ` +
        "Removing it removes those links too, which is a change to another workspace's blockers."
      : "";
  return base + returning + links;
}
