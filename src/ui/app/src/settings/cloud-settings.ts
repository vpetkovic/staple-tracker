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
import type { CloudSurfaceReport, ConnectPreview, RemoteDevice } from "@/lib/types";

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
 * False when the workspace has no repository identity — a global workspace has
 * none by design, and there is nothing for a connection to be ABOUT. The report
 * says so through `failure.code === "no_identity"`, which is the value; the
 * section renders `failure.summary` and `failure.remedy` rather than a form that
 * would be refused.
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
