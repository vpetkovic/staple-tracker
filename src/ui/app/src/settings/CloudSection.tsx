/**
 * THE CLOUD SECTION — S13 (STA-258). In the settings shell; not a workspace setting.
 *
 * ── WHAT THIS IS BACKED BY ────────────────────────────────────────────────────
 *
 * Not `settings-registry.ts`. Every other section in this shell reads and writes
 * `/api/settings`, which is the WORKSPACE DATABASE, and the workspace database
 * synchronizes — a credential written there would replicate to every device, and
 * an `auto` flag written there would let one laptop spend every other laptop's
 * consent. So this section reads `/api/cloud/status` and writes the cloud routes,
 * which act on `~/.staple/cloud/<repositoryId>.json`. Same place in the UI,
 * different store. `cloud-settings.ts` states it again beside the category
 * object, because nothing in the types can.
 *
 * ── TWO COMPONENTS, AND WHY ───────────────────────────────────────────────────
 *
 * `CloudPanel` is a pure function of a report and some handlers, exactly like
 * `CloudStrip`. `CloudSection` is the thin thing that fetches, holds state and
 * calls it. That split is not tidiness: the suite has no DOM and renders to a
 * string, so effects never run — a component that fetched its own report inside
 * its own render tree could only ever be tested in its loading state, and the
 * property that matters most here ("a disconnected workspace renders quietly") is
 * a property of the CONNECTED-STATE-ABSENT markup.
 *
 * ── THE DISCONNECTED CASE IS THE ONE THAT MATTERS ─────────────────────────────
 *
 * *"Fresh installs and unconnected workspaces make zero Staple-owned DNS socket
 * or HTTP calls."* The classic way a settings panel breaks that is by pinging on
 * open to show you status. This one makes exactly ONE request when it mounts —
 * `GET /api/cloud/status`, same-origin loopback — and that route is network-free
 * by construction: it has no `refresh` parameter and `localCloudStatus` reads
 * files. It is the same request `CloudStrip` makes for the same reason.
 *
 * Nothing else here fires without a press. In particular the device list, which
 * is the one control on the page that leaves the machine, is behind a button and
 * is never fetched on mount — a panel that listed devices when you opened it
 * would have turned opening settings into a request to Cloudflare.
 *
 * ── CONNECT IS TWO STEPS, AND THAT IS THE CONSENT MECHANISM ───────────────────
 *
 * `previewCloudConnect` then `cloudConnect`. The second call has no endpoint
 * parameter and neither does the route behind it: the only thing it carries is a
 * consent id the server minted while returning the preview. So this component
 * physically cannot connect to a service without having first received, and
 * therefore been able to display, the description of it. Reordering the JSX could
 * not break that; deleting the confirm screen could not break that. See
 * `src/core/cloud/consent.ts`.
 *
 * ── WHY THIS FORM DOES NOT REPORT ITSELF DIRTY ────────────────────────────────
 *
 * The shell guards closing over unsaved edits, and every other editor reports
 * through `onDirtyChange`. This one does not, deliberately: the guard's sentence
 * is "you have unsaved changes", and a half-typed endpoint is not an unsaved
 * change to anything — nothing here has a saved version. Raising that dialog on a
 * page somebody opened to READ their cloud state would be a false alarm on the
 * common path to prevent a small loss on the rare one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  cloudConnect,
  cloudDisconnect,
  connectHub,
  connectWorkspace,
  disconnectHub,
  disconnectWorkspace,
  getCloudStatus,
  backupHub,
  getCloudWorkspaces,
  listCloudDevices,
  previewCloudConnect,
  previewHubConnect,
  previewUnregisterWorkspace,
  previewWorkspaceConnect,
  revokeCloudDevice,
  setCloudConsent,
  setHubRegistryConsent,
  setWorkspaceConsent,
  syncHub,
  syncWorkspace,
  unregisterWorkspace,
} from "@/lib/api";
import { describeRefusal } from "@/lib/refusal";
import type {
  CloudSurfaceReport,
  ConnectPreview,
  ConsentTicket,
  HubCloudReport,
  HubConnectPreview,
  HubFanOut,
  HubWorkspaceOutcome,
  HubWorkspaceReport,
  RemoteDevice,
} from "@/lib/types";
import { LoadingState } from "@/views/ViewChrome";
import { DestructiveConfirm, Field, InlineError, Section } from "./form/primitives";
import {
  CONNECT_DISCLOSURE,
  PURGE_NOTICE,
  canOfferConnect,
  connectFormProblem,
  connectionFacts,
  consentControls,
  counterFacts,
  describeDevice,
  groupDisabledReasons,
  hubFanOutSummary,
  hubGroups,
  hubListDescription,
  hubSelfFacts,
  hubSelfSummary,
  hubRowControls,
  hubRegistryControl,
  hubRowActed,
  hubWideActed,
  hubWideFailure,
  hubUnreachableDescription,
  hubWideControls,
  hubWideDisconnectWarning,
  joinLabels,
  orderDevices,
  previewFacts,
  removeWarning,
  revokeWarning,
  type CloudFact,
  type HubRowAction,
  type HubRowControl,
  type HubRowView,
  type HubWideAction,
  type HubWideControl,
} from "./cloud-settings";

/** Which action is in flight. One at a time: every control disables while any is. */
export type CloudBusy =
  | null
  | "preview"
  | "connect"
  | "consent"
  | "disconnect"
  | "devices"
  | "revoke";

/** The connect form's draft. Held by the section, rendered by the panel. */
export interface ConnectDraft {
  endpoint: string;
  enrollment: string;
  label: string;
  /** `staple cloud connect --credential-file`. Chosen before the preview, because the preview states the consequence. */
  credentialFile: boolean;
}

export interface CloudPanelProps {
  report: CloudSurfaceReport;
  /** The last refusal, as the store or the server worded it. */
  error: string | null;
  busy: CloudBusy;
  draft: ConnectDraft;
  onDraft: (patch: Partial<ConnectDraft>) => void;
  /** The preview that has been shown and is waiting on a yes. */
  pending: { preview: ConnectPreview; consent: ConsentTicket } | null;
  /** `null` means "we have not left this machine and will not until you press the button". */
  devices: readonly RemoteDevice[] | null;
  /**
   * Every registered workspace and its own connection state — S16 (STA-275).
   *
   * `null` while the one request for it is in flight, or when it failed. A
   * failure here does NOT take the panel down: the rest of this surface is about
   * one workspace and is perfectly usable without the list.
   */
  workspaces: HubCloudReport | null;
  /**
   * Everything the per-row half of the list is doing — S17/S19/S21.
   *
   * One object rather than eight props, and keyed by SLUG throughout. That is the
   * mechanism behind *"an action on one row does not act on another"* at the
   * rendering layer: a row reads `hub.busy?.slug === row.slug`, so a press on one
   * row cannot spin another's spinner, and it reads `hub.outcomes[row.slug]`, so
   * an outcome cannot be drawn against a row it is not about. The outcomes map is
   * keyed on the slug the SERVER reported, not the one the client sent.
   */
  hub: HubPanelState;
  revoking: string | null;
  confirmDisconnect: boolean;
  onPreview: () => void;
  onCancelPreview: () => void;
  onConnect: () => void;
  onConsent: (consent: "auto" | "backup", value: boolean) => void;
  onDevices: () => void;
  onAskRevoke: (deviceId: string | null) => void;
  onRevoke: (deviceId: string) => void;
  onAskDisconnect: (asking: boolean) => void;
  onDisconnect: () => void;
  /** The per-row half. Every one takes the slug it acts on; none defaults. */
  hubActions: HubActions;
}

/** What one row is in the middle of. Null when nothing on the list is busy. */
export interface HubBusy {
  slug: string;
  action: HubRowAction;
}

export interface HubPanelState {
  /** Null when nothing on the list is in flight. */
  busy: HubBusy | null;
  /** True while the list is being re-enumerated. Not a row action. */
  refreshing: boolean;
  /** A hub backup is in flight. Separate from `busy`, which is per-row. */
  backingUp: boolean;
  /** The hub's own consent is being written — S22. Separate again: not a row, not a verb. */
  consenting: boolean;
  /**
   * The last outcome for each row, keyed by slug.
   *
   * Persisted across other rows' actions on purpose: *"a row shows the outcome
   * of the last operation on it"*, and a map that cleared on every press would
   * lose the answer to "what happened when I synced that one" the moment the
   * next row was touched.
   */
  outcomes: Record<string, HubWorkspaceOutcome | undefined>;
  /** The row whose connect flow is open, with its own draft and its own preview. */
  connecting: {
    slug: string;
    draft: ConnectDraft;
    /** The preview shown and waiting on a yes, or null before Review is pressed. */
    pending: { preview: ConnectPreview; consent: ConsentTicket } | null;
    /** The server's sentence when it would SKIP this row rather than connect it. */
    skipped: string | null;
  } | null;
  /** The row whose removal is being confirmed, with what the server said it would do. */
  removing: { slug: string; crossLinks: number } | null;
  /** The row whose disconnect is being confirmed. */
  disconnecting: string | null;
  /** The last refusal from a per-row call. Shown on the row it came from. */
  error: { slug: string; message: string } | null;
  /**
   * Everything the HUB-WIDE half is doing — S18 (STA-279).
   *
   * A nested object rather than more fields on this one, and the nesting is the
   * statement: nothing in here is keyed by slug, because none of it is about a
   * row. `busy` here does not lock a row's spinner and a refusal here is drawn in
   * the hub panel, never against a workspace — which is the same discipline
   * `outcome.slug` enforces one level down, applied to the thing that has no
   * slug.
   */
  wide: HubWideState;
}

export interface HubWideState {
  /** Which hub-wide verb is in flight, or null. One at a time. */
  busy: HubWideAction | null;
  /**
   * The hub-wide connect flow: its own draft, and its own two-step preview.
   *
   * Separate from `connecting` above, which is one row's flow, because the two
   * are genuinely different decisions holding two different enrollment secrets —
   * and opening either closes the other, by construction, since two half-filled
   * connect forms is a state in which the wrong secret gets sent.
   */
  connecting: {
    draft: ConnectDraft;
    /**
     * The ENUMERATION shown and waiting on a yes, with one ticket per actionable
     * row. Null before Review is pressed.
     *
     * The tickets travel together because the confirm is a confirm of the whole
     * enumeration: the server re-derives it and refuses if a workspace has been
     * registered or connected since this was drawn.
     */
    pending: {
      preview: HubConnectPreview;
      consents: Array<{ slug: string; consent: ConsentTicket }>;
    } | null;
  } | null;
  /** True while the hub-wide disconnect confirmation is up. */
  disconnecting: boolean;
  /**
   * The last hub-wide result, as a per-workspace TABLE.
   *
   * This is the resolution of the recorded refusal that a fan-out *"produces a
   * per-workspace outcome a dialog has nowhere to put"*. It has somewhere to go:
   * here, rendered as rows. A toast was the wrong container, not the outcome the
   * wrong shape.
   */
  fanOut: HubFanOut | null;
  /** The last hub-wide refusal. Drawn in the hub panel; never on a row. */
  error: string | null;
}

export interface HubActions {
  onOpenConnect: (slug: string | null) => void;
  onDraft: (patch: Partial<ConnectDraft>) => void;
  onPreview: () => void;
  onConnect: () => void;
  onSync: (slug: string) => void;
  onConsent: (slug: string, consent: "auto" | "backup", value: boolean) => void;
  onAskDisconnect: (slug: string | null) => void;
  onDisconnect: (slug: string) => void;
  onAskRemove: (slug: string | null) => void;
  onRemove: (slug: string, removeCrossLinks: boolean) => void;
  /** Re-enumerates the registry, so a workspace registered since load appears. */
  onRefresh: () => void;
  /**
   * Back up the hub itself — the registry and its cross-links, never tasks.
   *
   * Takes no slug, unlike every other action on this interface, and that is the
   * signature saying what it acts on: the hub is not one of the rows.
   */
  onBackup: () => void;

  /**
   * ─── THE HUB-WIDE VERBS — S18 (STA-279) ────────────────────────────────────
   *
   * Seven members, and **none of them takes a slug.** That is the same statement
   * `onBackup`'s signature makes, extended to the three verbs: the hub is not one
   * of the rows, so there is no workspace for these to name. A `slug` parameter
   * appearing on any of them later would mean one of two things — either it had
   * quietly become a per-row action, in which case it belongs above beside the
   * others, or a hub-wide verb had acquired a way to be scoped, which is the
   * per-row family's job and is already done. Either way it is the review moment.
   *
   * Connect is THREE members rather than one because it is a two-step consent,
   * exactly as the per-row connect is: `onHubPreview` fetches the enumeration and
   * `onHubConnect` redeems the tickets it issued. There is no shape either can
   * produce that connects without the enumeration having been returned first —
   * the route accepts no endpoint, so it is not a matter of this component's
   * diligence.
   */
  onHubOpenConnect: (open: boolean) => void;
  onHubDraft: (patch: Partial<ConnectDraft>) => void;
  onHubPreview: () => void;
  onHubConnect: () => void;
  /** EGRESSES, once per connected workspace. Never called on mount. */
  onHubSync: () => void;
  onHubAskDisconnect: (asking: boolean) => void;
  onHubDisconnect: () => void;
  /**
   * The hub's own publish consent — S22 (STA-283). Takes no slug, like every
   * member above it, because the hub is not one of the rows.
   */
  onHubRegistryConsent: (enabled: boolean, disclosure: string) => void;
}

/**
 * The four fields a connect needs, wherever it is being offered.
 *
 * Factored out when the workspace list grew its own per-row connect — S17
 * (STA-278). Not for brevity: the fields' DESCRIPTIONS are part of what consent
 * is given to. "The next screen states which one it will be", said about the
 * credential store, is a promise, and a second copy of these fields would be a
 * second place for that promise to be worded slightly differently and to drift
 * out of step with what the preview actually says.
 *
 * `idPrefix` keeps the label/input association unique when two of these are on
 * the page — the current workspace's form and one row's — which is a real state
 * and not a hypothetical.
 */
function ConnectFields({
  idPrefix,
  draft,
  problem,
  onDraft,
}: {
  idPrefix: string;
  draft: ConnectDraft;
  problem: string | null;
  onDraft: (patch: Partial<ConnectDraft>) => void;
}) {
  return (
    <>
      <Field
        id={`${idPrefix}-endpoint`}
        label="Service endpoint"
        description="The https origin of the sync service. Shown back to you for confirmation before anything is sent."
      >
        {(aria) => (
          <Input
            {...aria}
            value={draft.endpoint}
            placeholder="https://…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onDraft({ endpoint: event.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-enrollment`}
        label="Enrollment credential"
        description="This repository's enrollment secret for the first machine, or an existing device token from a machine that is already connected."
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            value={draft.enrollment}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onDraft({ enrollment: event.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-label`}
        label="Device label"
        description="Sent to the server so you can tell your machines apart. Defaults to this computer's hostname."
      >
        {(aria) => (
          <Input
            {...aria}
            value={draft.label}
            placeholder="this computer's hostname"
            onChange={(event) => onDraft({ label: event.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-credential-file`}
        label="Store the credential in a file"
        description="By default the secret goes into this machine's keychain. Tick this to put it in a 0600 file in your staple home instead — the same choice as `staple cloud connect --credential-file`. The next screen states which one it will be."
      >
        {(aria) => (
          <label className="flex h-7 items-center gap-2 text-[13px]">
            <input
              {...aria}
              type="checkbox"
              role="switch"
              aria-checked={draft.credentialFile}
              checked={draft.credentialFile}
              onChange={(event) => onDraft({ credentialFile: event.target.checked })}
              className="accent-primary size-4"
            />
            <span>{draft.credentialFile ? "A 0600 file" : "This machine's keychain"}</span>
          </label>
        )}
      </Field>
      {problem ? <InlineError>{problem}</InlineError> : null}
    </>
  );
}

/** One label/value pair, the shape `connectionFacts` and friends produce. */
function Facts({ facts }: { facts: readonly CloudFact[] }) {
  if (facts.length === 0) return null;
  return (
    <dl data-cloud-facts className="grid gap-x-4 gap-y-1 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-[12px] text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 text-[12px] wrap-anywhere">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The whole surface, as a pure function of a report.
 *
 * Every branch below reads a VALUE — `mode`, `auto`, `backup`, `credentialPresent`
 * — and never parses `detail` or `failure.summary`, which are rendered as
 * sentences for a human and are never inputs to a decision.
 */
export function CloudPanel(props: CloudPanelProps) {
  const { report, busy, draft, pending, devices } = props;
  const connected = report.mode !== "disconnected";
  const formProblem = connectFormProblem({ endpoint: draft.endpoint, token: draft.enrollment });

  return (
    <div data-cloud-section data-mode={report.mode} className="space-y-6">
      <Section
        title={connected ? "Connected" : "Not connected"}
        description={report.detail}
        error={props.error}
      >
        <Facts facts={connectionFacts(report)} />
        {report.failure ? (
          <p role="status" data-cloud-failure className="text-[12px] leading-relaxed">
            {report.failure.summary} {report.failure.remedy}
          </p>
        ) : null}
        {report.warnings.map((warning) => (
          <InlineError key={warning}>{warning}</InlineError>
        ))}
      </Section>

      {/*
        DISCONNECTED. A form, and nothing else — no probe, no reachability check,
        no "we noticed you might want to connect". The heading above already said
        "Not connected" and the report's own sentence said what that means. On a
        workspace with no repository identity there is not even a form: the
        failure above says why, and a form that would be refused is worse than
        none.
      */}
      {!connected && canOfferConnect(report) ? (
        <Section
          title="Connect this repository"
          description={
            "Connecting stores a credential for this machine only. It does not start syncing: " +
            "automatic sync is a separate decision you make afterwards."
          }
        >
          {pending === null ? (
            <>
              <ConnectFields
                idPrefix="cloud"
                draft={draft}
                problem={formProblem}
                onDraft={props.onDraft}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  data-cloud-preview
                  disabled={formProblem !== null || busy !== null}
                  onClick={props.onPreview}
                >
                  {busy === "preview" ? "Reading…" : "Review connection"}
                </Button>
                <span className="text-[12px] text-muted-foreground">
                  Nothing is sent until you confirm what this shows.
                </span>
              </div>
            </>
          ) : (
            /*
              THE CONSENT SCREEN. Everything the CLI prints before it asks, as
              values plus the disclosure sentences — including the two least
              comfortable ones, which is the point of showing it at all.
            */
            <div data-cloud-consent className="space-y-3 rounded-md border px-3 py-3">
              <h5 className="text-sm font-semibold">
                {pending.preview.alreadyConnected ? "Re-connect this repository" : "Connect this repository"}
              </h5>
              <Facts facts={previewFacts(pending.preview)} />
              <div>
                <p className="text-[12px] font-medium">What happens if you say yes:</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-muted-foreground">
                  {CONNECT_DISCLOSURE.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" data-cloud-connect disabled={busy !== null} onClick={props.onConnect}>
                  {busy === "connect" ? "Connecting…" : "Connect"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={props.onCancelPreview}
                >
                  Cancel
                </Button>
                <span className="text-[12px] text-muted-foreground">
                  This confirmation expires; if it does, review the connection again.
                </span>
              </div>
            </div>
          )}
        </Section>
      ) : null}

      {/* CONNECTED: the two later consents, then the counters, then devices. */}
      {connected ? (
        <>
          <Section
            title="Consents"
            description="Three separate decisions. You have made the first; these are the other two, and each is for this machine alone."
          >
            {consentControls(report).map((control) => (
              <Field
                key={control.key}
                id={`cloud-consent-${control.key}`}
                label={control.label}
                description={control.description}
              >
                {(aria) => (
                  <label className="flex h-7 items-center gap-2 text-[13px]">
                    <input
                      {...aria}
                      type="checkbox"
                      role="switch"
                      data-cloud-consent-toggle={control.key}
                      aria-checked={control.value}
                      checked={control.value}
                      disabled={busy !== null}
                      onChange={(event) => props.onConsent(control.key, event.target.checked)}
                      className="accent-primary size-4"
                    />
                    <span>{control.value ? "On" : "Off"}</span>
                  </label>
                )}
              </Field>
            ))}
          </Section>

          <Section title="State">
            <Facts facts={counterFacts(report)} />
          </Section>

          <Section
            title="Devices"
            description="Every machine enrolled for this repository, as the service knows it. This is the only control here that contacts the service, so it is behind a button."
          >
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-cloud-devices
                disabled={busy !== null}
                onClick={props.onDevices}
              >
                {busy === "devices" ? "Asking the service…" : devices === null ? "Show devices" : "Refresh"}
              </Button>
              {devices === null ? (
                <span className="text-[12px] text-muted-foreground">Nothing has been asked yet.</span>
              ) : null}
            </div>
            {devices !== null ? (
              <ul data-cloud-device-list className="m-0 list-none space-y-1 p-0">
                {devices.map((device) => (
                  <li key={device.deviceId} className="rounded-md border px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {device.label ?? device.deviceId}
                        {device.self ? <span className="text-muted-foreground"> — this machine</span> : null}
                      </span>
                      {device.revokedAt === null ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          data-cloud-revoke={device.deviceId}
                          disabled={busy !== null}
                          onClick={() => props.onAskRevoke(device.deviceId)}
                        >
                          Revoke
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground uppercase">revoked</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{describeDevice(device)}</p>
                    {props.revoking === device.deviceId ? (
                      <DestructiveConfirm
                        message={revokeWarning(device)}
                        confirmLabel={busy === "revoke" ? "Revoking…" : "Revoke"}
                        disabled={busy !== null}
                        onConfirm={() => props.onRevoke(device.deviceId)}
                        onCancel={() => props.onAskRevoke(null)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>

          <Section
            title="Disconnect"
            description="Removes this machine's credential and stops all later cloud traffic. Your local database, including pending operations and unsettled conflicts, is untouched. Other devices are unaffected, and the remote copy is not deleted."
          >
            {props.confirmDisconnect ? (
              <DestructiveConfirm
                message="This machine stops talking to the service. Re-connecting later needs an enrollment credential."
                confirmLabel={busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                disabled={busy !== null}
                onConfirm={props.onDisconnect}
                onCancel={() => props.onAskDisconnect(false)}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-cloud-disconnect
                disabled={busy !== null}
                onClick={() => props.onAskDisconnect(true)}
              >
                Disconnect this machine
              </Button>
            )}
            <p className="text-[12px] leading-relaxed text-muted-foreground">{PURGE_NOTICE}</p>
          </Section>
        </>
      ) : null}

      {/*
        OUTSIDE the `connected` branch, deliberately.

        Every other section on this page is about the workspace the dialog was
        opened on, so they are all behind that branch. This one is about the
        MACHINE, and the case it exists for is precisely the one where the
        current workspace is NOT connected and five others are — a person looking
        at "Not connected" and wondering whether they connected anything. Hiding
        the list until the current workspace happens to be connected would make
        it invisible exactly when it answers the question.
      */}
      <HubSelfPanel
        report={props.workspaces}
        hub={props.hub}
        actions={props.hubActions}
        outcome={props.hub.outcomes[""]}
      />
      <HubWorkspaceList
        report={props.workspaces}
        currentRepositoryId={report.repositoryId}
        hub={props.hub}
        actions={props.hubActions}
      />
    </div>
  );
}

/**
 * The hub, as an object — S18 (STA-279).
 *
 * Sits ABOVE the workspace list and states the hub's own state. Nothing in here
 * reads the current workspace, which is the whole point: the page used to lead
 * with one workspace's connection and follow it with a list of others, so the
 * heading described a different thing from the list under it.
 *
 * ## Why it renders even for one workspace
 *
 * `HubWorkspaceList` returns null below two workspaces, because a list of one is
 * not a list. This panel does not, and the asymmetry is deliberate: the hub is
 * a thing whether or not there is more than one workspace in it, and the backup
 * it offers is exactly as available — and exactly as necessary — on a machine
 * with one workspace as on a machine with nine.
 *
 * ## Why backup is not behind a connection check
 *
 * VP: *"the main hub should always have option to backup."* The control is
 * therefore always rendered and always enabled. It is not a promise that a
 * backup will succeed without further consent — pressing it walks through
 * whatever is missing — but the affordance never disappears, because a backup
 * button that vanishes when you most want it is the failure being designed out.
 *
 * ## Why the three hub-wide verbs live HERE and nowhere else
 *
 * They act on the hub, so they belong to the thing that IS the hub. Put on the
 * workspace list they would be a fourth control competing with each row's own
 * six, and a reader would have no way to tell "Disconnect" at the top of a list
 * from "Disconnect" inside it — the wrong-subject confusion S18 exists to end,
 * arrived at from the other direction.
 *
 * Every control STATES THE COUNT it will act on — "Connect 4 workspaces", "Sync
 * 2 connected workspaces" — rather than saying "all". "All" is a blast radius
 * that is invisible until after the press; a number is something somebody can
 * decline for a reason. On a machine with nine registered workspaces of which
 * four are debris, 9 against 4 is the whole question.
 */
function HubSelfPanel({
  report,
  hub,
  actions,
  outcome,
}: {
  report: HubCloudReport | null;
  hub: HubPanelState;
  actions: HubActions;
  /** The hub's own outcome, keyed on the empty slug — a backup receipt, so far. */
  outcome: HubWorkspaceOutcome | undefined;
}) {
  if (report === null) return null;
  const wide = hub.wide;
  const controls = hubWideControls(report);
  const unavailable = groupDisabledReasons(controls);
  /**
   * Any hub-wide verb in flight locks all of them, and the backup and every row
   * too. These are one-at-a-time operations against one registry and one staple
   * home; a second press mid-flight would race a file write across every
   * workspace at once, which is the rows' own argument with a bigger blast
   * radius.
   */
  const locked = wide.busy !== null || hub.backingUp || hub.busy !== null;

  return (
    <Section title="This hub" description={hubSelfSummary(report)}>
      <div data-cloud-hub-self>
        <Facts facts={hubSelfFacts(report)} />
        {/*
          Not a dismissible hint, and not a tooltip. A person will reasonably
          read "back up the hub" as "back up my work", and it is not — there is
          no issues table in hub.db at all. The sentence that corrects that has
          to be next to the button, every time, or the assumption survives.
        */}
        <p data-cloud-hub-backup-note className="mt-2 text-[12px] text-muted-foreground">
          {report.self.backupHeadline}
        </p>
        <details data-cloud-hub-backup-details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            What a hub backup contains
          </summary>
          <ul className="m-0 mt-1 list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
            {report.self.backupContents.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <ul className="m-0 mt-1 list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
            {report.self.backupExclusions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
        <div className="mt-2">
          <Button
            size="sm"
            variant="outline"
            data-cloud-hub-backup
            onClick={actions.onBackup}
            disabled={locked}
          >
            {hub.backingUp ? "Backing up…" : "Back up the hub"}
          </Button>
        </div>

        {/*
          ─── THE HUB'S OWN CONSENT — S22 (STA-283) ────────────────────────────

          The fourth consent, and the first that belongs to the hub rather than
          to a workspace. It sits here for the same reason the three verbs below
          do: its subject is the hub, and there is exactly one registry.

          It is deliberately NOT a fourth toggle on each row. The other three
          consents are per workspace and a hub-wide switch for any of them would
          be one press spending N consents — the shape `docs/sync.md` separates
          them to prevent. This one is singular by nature.
        */}
        <RegistryConsent
          report={report}
          busy={hub.consenting}
          locked={locked}
          onConsent={actions.onHubRegistryConsent}
        />

        {/*
          ─── THE THREE HUB-WIDE VERBS — S18 (STA-279) ─────────────────────────

          All three, always, each carrying the count it will act on. Enablement
          is `disabledReason` and never omission, exactly as on a row: a control
          that disappeared would leave a reader unable to tell an unavailable
          capability from one the product does not have — and a hub-wide Connect
          that vanished the moment everything was connected would teach nobody
          that it existed.
        */}
        <div data-cloud-hub-wide className="mt-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {controls.map((control) => (
              <HubWideControlButton
                key={control.action}
                control={control}
                busy={wide.busy === control.action}
                locked={locked}
                actions={actions}
              />
            ))}
          </div>

          {/*
            WHY EACH UNAVAILABLE CONTROL IS UNAVAILABLE — once per distinct
            reason, naming the controls it covers. The same grouping the rows
            use, and for the same reason: on a machine with nothing connected,
            Sync and Disconnect share one sentence, and printing it twice is the
            noise this page is supposed to be free of.
          */}
          {unavailable.length > 0 ? (
            <ul data-cloud-hub-wide-unavailable className="m-0 mt-1 list-none space-y-0.5 p-0">
              {unavailable.map((group) => (
                <li key={group.reason} className="text-[11px] leading-relaxed text-muted-foreground">
                  <span className="font-medium">{joinLabels(group.labels)}</span>
                  {group.labels.length > 1 ? " are unavailable: " : " is unavailable: "}
                  {group.reason}
                </li>
              ))}
            </ul>
          ) : null}

          {/*
            THE HUB-WIDE CONNECT FLOW. Fields, then the ENUMERATION, then the
            confirm — two steps, exactly as the current workspace's form and each
            row's form are, and for the same structural reason:
            `/api/hub/connect` accepts no endpoint, only the tickets the server
            minted while returning the enumeration it therefore had to show
            first.
          */}
          {wide.connecting !== null ? (
            <div data-cloud-hub-connect className="mt-2 space-y-3 rounded-md border px-3 py-3">
              {wide.connecting.pending === null ? (
                <>
                  <p className="text-[12px] text-muted-foreground">
                    Connecting every workspace that can be. The next screen names each one, the
                    service it would be registered with and where its credential would go. Nothing
                    is sent until you confirm what it shows.
                  </p>
                  <ConnectFields
                    idPrefix="cloud-hub"
                    draft={wide.connecting.draft}
                    problem={connectFormProblem({
                      endpoint: wide.connecting.draft.endpoint,
                      token: wide.connecting.draft.enrollment,
                    })}
                    onDraft={actions.onHubDraft}
                  />
                  {/*
                    THE ONE SENTENCE THIS FORM ADDS over the per-row one, and it
                    is the honest half of the recorded objection: the secret is
                    offered to each workspace in turn. It is not hidden behind
                    the preview, because a person typing a secret into a
                    hub-wide form should know that before they type it.
                  */}
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    The enrollment credential is offered to each workspace in turn. A workspace
                    whose service does not accept it is reported and skipped; the rest still
                    connect. Each workspace gets its own credential, so revoking one does not
                    disconnect the others.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      data-cloud-hub-preview
                      disabled={
                        locked ||
                        connectFormProblem({
                          endpoint: wide.connecting.draft.endpoint,
                          token: wide.connecting.draft.enrollment,
                        }) !== null
                      }
                      onClick={actions.onHubPreview}
                    >
                      {wide.busy === "connect" ? "Reading…" : "Review what would be connected"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={locked}
                      onClick={() => actions.onHubOpenConnect(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <HubConnectConsent
                  preview={wide.connecting.pending.preview}
                  busy={wide.busy === "connect"}
                  locked={locked}
                  actions={actions}
                />
              )}
            </div>
          ) : null}

          {wide.disconnecting ? (
            <div className="mt-2">
              <DestructiveConfirm
                message={hubWideDisconnectWarning(report)}
                /**
                 * The control's OWN label, not a sentence rebuilt from its
                 * `.count`. Rebuilding it produced "Disconnect 1 workspaces" on
                 * the very common one-connected-workspace hub — in the one
                 * dialog whose entire job is being read carefully — while every
                 * other label on this page pluralises properly. `hubWideControls`
                 * already did the work; this was a second, worse copy of it.
                 */
                confirmLabel={
                  wide.busy === "disconnect"
                    ? "Disconnecting…"
                    : controls.find((control) => control.action === "disconnect")!.label
                }
                disabled={locked}
                onConfirm={actions.onHubDisconnect}
                onCancel={() => actions.onHubAskDisconnect(false)}
              />
            </div>
          ) : null}

          {wide.error !== null ? <InlineError>{wide.error}</InlineError> : null}

          {/*
            THE PER-WORKSPACE OUTCOME TABLE — and this is the answer to the
            recorded refusal, not a workaround for it.

            The objection was that a fan-out *"produces a per-workspace outcome a
            dialog has nowhere to put"*. True of a dialog. `HubConnectOutcome`,
            `HubSyncOutcome` and `HubDisconnectOutcome` are already per-workspace
            shapes precisely because a fan-out had no other way to report, and
            the server normalizes all three into the row shape S19 pinned. So it
            renders as rows, including the skipped ones — a table listing only
            the failures would be indistinguishable, on a good day, from a button
            that did nothing.
          */}
          {wide.fanOut !== null ? (
            <div data-cloud-hub-fanout={wide.fanOut.action} className="mt-3">
              <p className="text-[12px] leading-relaxed">{hubFanOutSummary(wide.fanOut)}</p>
              <ul className="m-0 mt-1 list-none space-y-1 p-0">
                {wide.fanOut.workspaces.map((row) => (
                  <li
                    key={row.slug}
                    data-cloud-hub-fanout-row={row.slug}
                    data-status={row.status}
                    className="rounded-md border px-2 py-1"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[12px] font-medium">{row.slug}</span>
                      <span className="text-[10px] uppercase text-muted-foreground">
                        {row.status === "ok" ? "done" : row.status}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">{row.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/*
            The hub's own single-outcome line — the backup receipt. Keyed on the
            EMPTY slug because the hub is not a row, and a key that collided with
            a real slug would put a hub result inside a workspace's row, which is
            the precise class of bug S19 pinned `outcome.slug` to catch.
          */}
          {outcome ? (
            <p
              data-cloud-hub-outcome={outcome.action}
              data-status={outcome.status}
              className="mt-2 text-[11px] leading-relaxed text-muted-foreground"
            >
              {outcome.status === "failed" ? "Did not work: " : ""}
              {outcome.detail}
            </p>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

/**
 * THE HUB'S PUBLISH CONSENT — S22 (STA-283).
 *
 * ## The disclosure is rendered from the constant, never retyped
 *
 * `REGISTRY_DISCLOSURE` is the one sentence that has to appear wherever this
 * consent is granted: *"a machine that publishes its registry tells the service
 * the names, prefixes and identities of every workspace on it, and that they sit
 * together."* It is the whole price of the invariant the registry gave up —
 * `hub-scope.ts` had said cross-repository topology *"is not this repository's
 * business"*, and publishing is precisely the act of making it the service's.
 *
 * So the surface imports the constant and shows it BEFORE the switch, not behind
 * a disclosure triangle and not as a tooltip. Same rule as `CONNECT_DISCLOSURE`:
 * one copy, or the strongest wording becomes whichever surface a person did not
 * read. `cloud-section.test.tsx` asserts at the source that this file contains no
 * copy of the text.
 *
 * ## Disabled rather than merely erroring when the hub is unconnected
 *
 * `setRegistryConsent` refuses `not_found` on a hub with no connection record,
 * inherited from `setConsent`, which will not spring one into existence. A switch
 * that flipped and then threw would be offering a decision the product cannot
 * store; it carries its reason instead, like every other unavailable control on
 * this page.
 */
function RegistryConsent({
  report,
  busy,
  locked,
  onConsent,
}: {
  report: HubCloudReport;
  busy: boolean;
  locked: boolean;
  onConsent: (enabled: boolean, disclosure: string) => void;
}) {
  const control = hubRegistryControl(report);
  const disabled = control.disabledReason !== null;
  return (
    <div data-cloud-hub-registry className="mt-3 border-t pt-3">
      <Field
        id="cloud-hub-registry"
        label={control.label}
        description={control.description}
      >
        {(aria) => (
          <label className="flex h-7 items-center gap-2 text-[13px]">
            <input
              {...aria}
              type="checkbox"
              role="switch"
              data-cloud-hub-registry-toggle
              aria-checked={control.value}
              checked={control.value}
              disabled={disabled || locked}
              title={control.disabledReason ?? control.description}
              onChange={(event) => onConsent(event.target.checked, report.self.registry.disclosure)}
              className="accent-primary size-4"
            />
            <span>{busy ? "Saving…" : control.value ? "On" : "Off"}</span>
          </label>
        )}
      </Field>
      {/*
        THE DISCLOSURE, from the constant, and always visible. A person granting
        this is telling a service that these workspaces are one person's — which
        is the single fact the rest of the design goes to lengths to withhold.
      */}
      <p data-cloud-hub-registry-disclosure className="mt-1 text-[12px] leading-relaxed">
        {report.self.registry.disclosure.charAt(0).toUpperCase()}
        {report.self.registry.disclosure.slice(1)}
      </p>
      {disabled ? (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {control.disabledReason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One hub-wide control.
 *
 * A button for all three, unlike a row's six — none of the hub-wide verbs has a
 * standing VALUE, so a switch would make an event look like a state. The two
 * consents that do have values are per workspace and stay there: automatic sync
 * is a decision about one repository's traffic, and a hub-wide switch for it
 * would be one press spending N consents, which is the shape `docs/sync.md`
 * separates them to prevent.
 *
 * `title` carries the reason for a pointer AND the sentence is rendered
 * separately, because a tooltip is not an explanation on a page somebody is
 * reading to understand the model.
 */
function HubWideControlButton({
  control,
  busy,
  locked,
  actions,
}: {
  control: HubWideControl;
  busy: boolean;
  locked: boolean;
  actions: HubActions;
}) {
  const disabled = control.disabledReason !== null;
  const press = () => {
    if (control.action === "connect") actions.onHubOpenConnect(true);
    else if (control.action === "sync") actions.onHubSync();
    else actions.onHubAskDisconnect(true);
  };
  return (
    <span
      data-cloud-hub-wide-control={control.action}
      data-disabled={disabled ? "true" : "false"}
      data-count={control.count}
      className="flex items-center gap-1.5"
    >
      <Button
        type="button"
        size="sm"
        variant={control.destructive === true ? "ghost" : "outline"}
        data-cloud-hub-action={control.action}
        disabled={disabled || locked}
        title={control.disabledReason ?? control.effect}
        onClick={press}
      >
        {busy ? "Working…" : control.label}
      </Button>
    </span>
  );
}

/**
 * THE HUB-WIDE CONSENT SCREEN — the enumeration, per workspace, and then the ask.
 *
 * ## This is where the recorded refusal is answered rather than overruled
 *
 * The objection was that a hub-wide connect *"spends one enrollment secret
 * against N services"* and that a button therefore asked *"for less than the CLI
 * preview does"*. The answer is to ask for exactly as much as the CLI preview
 * does, which is what this screen is: **every registered workspace appears,
 * including every one that will be skipped and why**, and each actionable row
 * names its own service, repository, device, label and credential store through
 * `previewFacts` — the same function the single-workspace consent screen uses, so
 * there is one definition of what a connect discloses.
 *
 * `willConnect: 4` is a number, and agreeing to a number is not consent. The
 * count is on the button; the enumeration is here.
 *
 * ## Why the disclosure is `CONNECT_DISCLOSURE` and not a hub-wide copy
 *
 * Because a second copy is a second place for a consent promise to drift. Every
 * line of it is true of every row — the credential is per workspace and stays on
 * this machine, automatic sync stays off, the contents are stored in plaintext —
 * so a hub-wide rewording would be the same promise said differently, and the
 * two would diverge the first time one of them was edited. The only thing this
 * screen adds is the sentence about the secret being offered to each workspace in
 * turn, which is a fact about the FAN-OUT rather than about what connecting
 * means, and it sits beside the field the secret is typed into.
 */
function HubConnectConsent({
  preview,
  busy,
  locked,
  actions,
}: {
  preview: HubConnectPreview;
  busy: boolean;
  locked: boolean;
  actions: HubActions;
}) {
  const acting = preview.entries.filter((entry) => entry.preview !== null);
  const skipping = preview.entries.filter((entry) => entry.preview === null);
  return (
    <div data-cloud-hub-consent className="space-y-3">
      <h5 className="text-sm font-semibold">
        Connect {acting.length} {acting.length === 1 ? "workspace" : "workspaces"} to{" "}
        {preview.endpoint}
      </h5>

      <ul className="m-0 list-none space-y-2 p-0">
        {acting.map((entry) => (
          <li
            key={entry.slug}
            data-cloud-hub-consent-row={entry.slug}
            data-action={entry.action}
            className="rounded-md border px-2 py-1.5"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[12px] font-medium">{entry.slug}</span>
              <span className="text-[10px] uppercase text-muted-foreground">{entry.action}</span>
            </div>
            {/*
              The per-row enumeration. `previewFacts` is the single-workspace
              consent screen's own renderer, reused rather than re-described, so
              a hub-wide row cannot end up disclosing less than a single connect
              does.
            */}
            <Facts facts={previewFacts(entry.preview!)} />
          </li>
        ))}
      </ul>

      {/*
        THE SKIPPED ROWS, rendered and not hidden. They answer the question a
        reader asks immediately — "why is my other repository not in this list?"
        — before they ask it, and each carries the fan-out's own sentence for
        why. Dropping them would turn "4 of 7" into "4", which is the number that
        makes debris look like inventory.
      */}
      {skipping.length > 0 ? (
        <div data-cloud-hub-consent-skipped>
          <p className="text-[12px] font-medium">
            Not included ({skipping.length}), and left exactly as they are:
          </p>
          <ul className="m-0 mt-1 list-none space-y-1 p-0">
            {skipping.map((entry) => (
              <li
                key={entry.slug}
                data-cloud-hub-consent-skip={entry.slug}
                className="text-[11px] leading-relaxed text-muted-foreground"
              >
                <span className="font-medium">{entry.slug}</span> — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="text-[12px] font-medium">What happens if you say yes:</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-muted-foreground">
          {CONNECT_DISCLOSURE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-cloud-hub-confirm
          disabled={locked}
          onClick={actions.onHubConnect}
        >
          {busy
            ? "Connecting…"
            : `Connect ${acting.length} ${acting.length === 1 ? "workspace" : "workspaces"}`}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={locked}
          onClick={() => actions.onHubOpenConnect(false)}
        >
          Cancel
        </Button>
        <span className="text-[12px] text-muted-foreground">
          This confirmation expires, and it covers exactly the workspaces above — if one is
          registered or connected in the meantime, you will be asked to look again.
        </span>
      </div>
    </div>
  );
}

/**
 * Every registered workspace, with its own state and its own controls —
 * S17 (STA-278), S19 (STA-280), S21 (STA-282).
 *
 * ## What this replaced, and how the argument ended
 *
 * This shipped as a read-only table whose header said *"A LIST AND NOT A
 * CONTROL"*, on two grounds:
 *
 *   > connecting every workspace at once spends one enrollment secret against N
 *   > services and produces a per-workspace outcome a dialog has nowhere to put,
 *   > so naming `staple cloud connect --all` was more use than a button asking
 *   > for less than the CLI preview does.
 *
 * S17 (STA-278) answered the part about PER-ROW controls: one row's connect
 * spends one secret against one service and produces one outcome, the same shape
 * the sections above have offered since S13.
 *
 * **S18 (STA-279) answered the hub-wide part, and the refusal no longer stands.**
 * It was not overruled — both objections were correct, and both were about the
 * SHAPE the button was imagined to have rather than about the verb:
 *
 *  - *"one secret against N services"* — the objection is to a button that asks
 *    for less than the CLI. So the hub panel's connect asks for exactly as much:
 *    `/api/hub/connect/preview` returns the fan-out preview, EVERY registered
 *    workspace appears including every one that will be skipped and why, and each
 *    actionable row names its own service, repository, device and credential
 *    store through the same `previewFacts` the single-workspace screen uses. Then
 *    the confirm carries ONE TICKET PER ROW, so the consent is over that
 *    enumeration and not over a count — and the server re-derives the
 *    enumeration before the secret moves, so a workspace registered or connected
 *    while the screen was up is a refusal naming it rather than a silent extra
 *    connection. An already-connected workspace is SKIPPED, with the preview
 *    naming the service it is already talking to; there is deliberately no
 *    hub-wide reconnect, because replacing N credentials and resetting N consents
 *    behind one press is the unbounded blast radius the objection was really
 *    about.
 *  - *"an outcome a dialog has nowhere to put"* — true of a dialog, and the
 *    conclusion drawn from it was the wrong one. `HubConnectOutcome`,
 *    `HubSyncOutcome` and `HubDisconnectOutcome` are per-workspace shapes
 *    *precisely because* a fan-out had no other way to report. The container was
 *    wrong, not the outcome: `HubSelfPanel` renders a per-workspace TABLE,
 *    including the skipped rows, so nothing needs squeezing into a toast.
 *
 * `staple cloud connect --all` remains the better tool for a hub of forty. The
 * page is not trying to beat it; it is trying not to be a dead end for the person
 * who is already looking at their workspaces.
 *
 * ## The hub-wide controls are NOT here, and that is deliberate
 *
 * They are in `HubSelfPanel`, above, whose subject is the hub. A hub-wide
 * Disconnect at the top of a list of per-row Disconnects would be the
 * wrong-subject confusion S18 exists to end, arrived at from the other side.
 * Every control on THIS list acts on the one workspace whose row it is on.
 * `cloud-settings.ts` states the per-row half at length beside the pure functions.
 *
 * ## Why a row can act at all
 *
 * Every control here posts to `/api/cloud/workspace/*` or `/api/hub/unregister`,
 * which address the machine registry by SLUG. They deliberately do not reuse the
 * `/api/cloud/*` routes the sections above use: those resolve their workspace
 * through the server's `handleFor`, which in single-workspace mode — the ordinary
 * `staple ui` — ignores the slug and answers with the workspace it was started
 * on. A per-row press through those routes would disconnect the wrong workspace,
 * silently, on the common configuration.
 *
 * ## Renders nothing for one workspace or none
 *
 * Unchanged, and still right: a "list" of one is a heading and a row restating
 * what the four sections above already said about that same workspace.
 */
function HubWorkspaceList({
  report,
  currentRepositoryId,
  hub,
  actions,
}: {
  report: HubCloudReport | null;
  currentRepositoryId: string | null;
  hub: HubPanelState;
  actions: HubActions;
}) {
  if (report === null || report.workspaces.length < 2) return null;
  const groups = hubGroups(report, { currentRepositoryId });
  const byslug = new Map(report.workspaces.map((row) => [row.slug, row]));

  const renderRow = (view: HubRowView) => {
    const row = byslug.get(view.slug);
    if (!row) return null;
    return (
      <HubRow
        key={view.slug}
        row={row}
        view={view}
        hub={hub}
        actions={actions}
      />
    );
  };

  return (
    <Section title="Workspaces on this machine" description={hubListDescription(report)}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-cloud-workspaces-refresh
          disabled={hub.busy !== null || hub.refreshing}
          onClick={actions.onRefresh}
        >
          {hub.refreshing ? "Reading…" : "Refresh list"}
        </Button>
        <span className="text-[12px] text-muted-foreground">
          Reads this machine's registry again, so a workspace registered since you opened this
          appears. It contacts nobody.
        </span>
      </div>

      <ul data-cloud-workspaces className="m-0 list-none space-y-2 p-0">
        {groups.reachable.map(renderRow)}
      </ul>

      {/*
        THE SUBORDINATE GROUP — S21. Rendered, not hidden: an unreachable row
        still carries Disconnect (its credential is on THIS machine) and Remove,
        and Remove is the point of it being on screen. Subordination is a
        heading, dimmer text and second place, which is what "must not compete
        with real workspaces for attention" asks for.

        The group key is `available`. NOT a list of slugs: four of the five rows
        this ticket names are unreachable because their paths are gone, which is
        a fact about the world; the fifth is still on disk and stays in the main
        list, which is what "a reachable workspace is never hidden by this
        grouping" requires and what a denylist would have broken.
      */}
      {groups.unreachable.length > 0 ? (
        <div data-cloud-workspaces-unreachable className="mt-4 border-t pt-3 opacity-70">
          <h5 className="text-[12px] font-medium text-muted-foreground">Not on this machine</h5>
          <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            {hubUnreachableDescription(groups.unreachable.length)}
          </p>
          <ul className="m-0 list-none space-y-2 p-0">{groups.unreachable.map(renderRow)}</ul>
        </div>
      ) : null}
    </Section>
  );
}

/**
 * One row: a line, its controls, its outcome, and its rationale behind a
 * disclosure.
 *
 * The order is the whole design of S17. What it IS comes first and takes one
 * line; what you can DO comes second; what happened last comes third; the
 * paragraph explaining why an unmounted volume is not a deleted workspace comes
 * fourth, behind a `<details>` that is closed. Every one of those sentences used
 * to be in position one.
 */
function HubRow({
  row,
  view,
  hub,
  actions,
}: {
  row: HubWorkspaceReport;
  view: HubRowView;
  hub: HubPanelState;
  actions: HubActions;
}) {
  const controls = hubRowControls(row, { current: view.current });
  const disabledReasons = groupDisabledReasons(controls);
  const outcome = hub.outcomes[row.slug];
  const busyHere = hub.busy?.slug === row.slug ? hub.busy.action : null;
  // Any row busy locks every row's controls: these are one-at-a-time operations
  // against one registry and one staple home, and a second press mid-flight
  // would race a file write.
  const locked = hub.busy !== null;
  const connecting = hub.connecting?.slug === row.slug ? hub.connecting : null;
  const removing = hub.removing?.slug === row.slug ? hub.removing : null;
  const error = hub.error?.slug === row.slug ? hub.error.message : null;

  return (
    <li
      data-cloud-workspace={row.slug}
      data-cloud-workspace-reachable={view.reachable ? "true" : "false"}
      data-cloud-workspace-actionable={view.actionable ? "true" : "false"}
      className="rounded-md border px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={`text-[13px] ${view.current ? "font-semibold" : "font-medium"}`}>
          {row.slug}
        </span>
        {view.current ? <span className="text-[11px] text-muted-foreground">(this one)</span> : null}
        <span className="text-[11px] text-muted-foreground">{view.state}</span>
        {view.marks.map((mark) => (
          <span key={mark} className="rounded border px-1 text-[10px] text-muted-foreground">
            {mark}
          </span>
        ))}
      </div>

      {/* THE ONE LINE. Everything longer is in the disclosure below. */}
      <p data-cloud-workspace-summary className="text-[12px] text-muted-foreground">
        {view.summary}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {controls.map((control) => (
          <HubControl
            key={control.action}
            slug={row.slug}
            control={control}
            busy={busyHere === control.action}
            locked={locked}
            actions={actions}
          />
        ))}
      </div>

      {/*
        WHY EACH UNAVAILABLE CONTROL IS UNAVAILABLE — once per distinct reason,
        naming the controls it covers.

        The criterion is *"actions are disabled with a stated reason rather than
        hidden"*, and the first build of this put each reason beside its control.
        On a disconnected row that is the same sentence four times, seven rows
        deep — repetitive, and worse: it is precisely the noise this ticket
        exists to remove, arrived at from the other direction. Grouping states
        every reason and hides none, in one line instead of four.
      */}
      {disabledReasons.length > 0 ? (
        <ul data-cloud-workspace-unavailable className="m-0 mt-1 list-none space-y-0.5 p-0">
          {disabledReasons.map((group) => (
            <li key={group.reason} className="text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-medium">{joinLabels(group.labels)}</span>
              {group.labels.length > 1 ? " are unavailable: " : " is unavailable: "}
              {group.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        The per-row connect flow: fields, then the preview, then the confirm.
        Two steps, exactly as the current workspace's form is, and for the same
        structural reason — `/api/cloud/workspace/connect` accepts no endpoint,
        only a ticket the server minted while returning a preview it therefore
        had to show first.
      */}
      {connecting !== null ? (
        <div data-cloud-workspace-connect={row.slug} className="mt-2 space-y-3 rounded-md border px-3 py-3">
          {connecting.skipped !== null ? (
            <>
              <p className="text-[12px] leading-relaxed">{connecting.skipped}</p>
              <Button type="button" variant="ghost" size="sm" onClick={() => actions.onOpenConnect(null)}>
                Close
              </Button>
            </>
          ) : connecting.pending === null ? (
            <>
              <p className="text-[12px] text-muted-foreground">
                Connecting <strong>{row.slug}</strong>. Nothing is sent until you confirm what the
                next screen shows.
              </p>
              <ConnectFields
                idPrefix={`cloud-ws-${row.slug}`}
                draft={connecting.draft}
                problem={connectFormProblem({
                  endpoint: connecting.draft.endpoint,
                  token: connecting.draft.enrollment,
                })}
                onDraft={actions.onDraft}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  data-cloud-workspace-preview={row.slug}
                  disabled={
                    locked ||
                    connectFormProblem({
                      endpoint: connecting.draft.endpoint,
                      token: connecting.draft.enrollment,
                    }) !== null
                  }
                  onClick={actions.onPreview}
                >
                  {busyHere === "connect" ? "Reading…" : "Review connection"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={() => actions.onOpenConnect(null)}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <h5 className="text-sm font-semibold">
                {connecting.pending.preview.alreadyConnected ? "Re-connect" : "Connect"} {row.slug}
              </h5>
              <Facts facts={previewFacts(connecting.pending.preview)} />
              <div>
                <p className="text-[12px] font-medium">What happens if you say yes:</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-muted-foreground">
                  {CONNECT_DISCLOSURE.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  data-cloud-workspace-confirm={row.slug}
                  disabled={locked}
                  onClick={actions.onConnect}
                >
                  {busyHere === "connect" ? "Connecting…" : `Connect ${row.slug}`}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={() => actions.onOpenConnect(null)}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {hub.disconnecting === row.slug ? (
        <div className="mt-2">
          <DestructiveConfirm
            message={`${row.slug} stops talking to ${row.endpoint ?? "the service"}. Its data, including queued changes and unsettled conflicts, is untouched, and no other device is affected. Re-connecting later needs an enrollment credential.`}
            confirmLabel={busyHere === "disconnect" ? "Disconnecting…" : "Disconnect"}
            disabled={locked}
            onConfirm={() => actions.onDisconnect(row.slug)}
            onCancel={() => actions.onAskDisconnect(null)}
          />
        </div>
      ) : null}

      {removing !== null ? (
        <div className="mt-2">
          <DestructiveConfirm
            message={removeWarning(row, removing.crossLinks)}
            confirmLabel={busyHere === "remove" ? "Removing…" : "Remove from list"}
            disabled={locked}
            onConfirm={() => actions.onRemove(row.slug, removing.crossLinks > 0)}
            onCancel={() => actions.onAskRemove(null)}
          />
        </div>
      ) : null}

      {error !== null ? <InlineError>{error}</InlineError> : null}

      {/*
        PER-ROW OUTCOME — S19. Keyed on `outcome.slug`, which is the slug the
        SERVER reported rather than the one this client sent, so a result can
        never be drawn against a row it is not about.
      */}
      {outcome ? (
        <p
          data-cloud-workspace-outcome={outcome.slug}
          data-status={outcome.status}
          className="mt-1 text-[11px] leading-relaxed text-muted-foreground"
        >
          {outcome.status === "failed" ? "Did not work: " : ""}
          {outcome.detail}
        </p>
      ) : null}

      {/*
        THE DISCLOSURE — S17. `describeSkip`'s paragraphs used to be the row
        body: four lines about unmounted volumes under every row, including the
        rows they did not apply to. They are good writing and they answer a real
        question; they answer it here, for the reader who went looking.
      */}
      {view.rationale !== null ? (
        <details data-cloud-workspace-details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">Details</summary>
          <p className="mt-1 text-[11px] leading-relaxed wrap-anywhere text-muted-foreground">
            {view.rationale}
          </p>
        </details>
      ) : null}
    </li>
  );
}

/**
 * One control on one row.
 *
 * **A disabled control renders, with its reason.** *"Actions are disabled with a
 * stated reason rather than hidden"* — the alternative teaches a reader nothing,
 * and worse, makes an unavailable capability indistinguishable from one the
 * product does not have. `title` carries the reason for a pointer and the
 * sentence is also rendered, because a tooltip is not an explanation on a page
 * somebody is reading to understand the model.
 *
 * The two consents are switches and the four verbs are buttons, and that
 * difference is not cosmetic: `auto` and `backup` have a VALUE that persists, and
 * a button would make a standing state look like an event.
 */
function HubControl({
  slug,
  control,
  busy,
  locked,
  actions,
}: {
  slug: string;
  control: HubRowControl;
  busy: boolean;
  locked: boolean;
  actions: HubActions;
}) {
  const disabled = control.disabledReason !== null;

  if (control.action === "auto" || control.action === "backup") {
    return (
      <label
        data-cloud-workspace-control={control.action}
        data-disabled={disabled ? "true" : "false"}
        className="flex items-center gap-1.5 text-[12px]"
        title={control.disabledReason ?? control.effect}
      >
        <input
          type="checkbox"
          role="switch"
          data-cloud-workspace-toggle={`${slug}:${control.action}`}
          aria-checked={control.value === true}
          aria-label={`${control.label} for ${slug}`}
          checked={control.value === true}
          disabled={disabled || locked}
          onChange={(event) => actions.onConsent(slug, control.action as "auto" | "backup", event.target.checked)}
          className="accent-primary size-3.5"
        />
        <span className={disabled ? "text-muted-foreground" : undefined}>{control.label}</span>
      </label>
    );
  }

  const press = () => {
    if (control.action === "connect") actions.onOpenConnect(slug);
    else if (control.action === "sync") actions.onSync(slug);
    else if (control.action === "disconnect") actions.onAskDisconnect(slug);
    else if (control.action === "remove") actions.onAskRemove(slug);
  };

  return (
    <span
      data-cloud-workspace-control={control.action}
      data-disabled={disabled ? "true" : "false"}
      className="flex items-center gap-1.5"
    >
      <Button
        type="button"
        size="sm"
        variant={control.destructive === true ? "ghost" : "outline"}
        data-cloud-workspace-action={`${slug}:${control.action}`}
        disabled={disabled || locked}
        title={control.disabledReason ?? control.effect}
        onClick={press}
      >
        {busy ? "Working…" : control.label}
      </Button>
    </span>
  );
}

const EMPTY_DRAFT: ConnectDraft = { endpoint: "", enrollment: "", label: "", credentialFile: false };

/** Nothing hub-wide is happening. The state the panel mounts in and returns to. */
const IDLE_WIDE: HubWideState = {
  busy: null,
  connecting: null,
  disconnecting: false,
  fanOut: null,
  error: null,
};

/** The data half: one read on mount, and one round trip per press. */
export function CloudSection({ ws }: { ws?: string }) {
  const [report, setReport] = useState<CloudSurfaceReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<CloudBusy>(null);
  const [draft, setDraft] = useState<ConnectDraft>(EMPTY_DRAFT);
  const [pending, setPending] = useState<{ preview: ConnectPreview; consent: ConsentTicket } | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [workspaces, setWorkspaces] = useState<HubCloudReport | null>(null);

  /**
   * The per-row half — S17/S19/S21. One state object, all of it keyed by slug.
   *
   * `busy` holds the slug AND the verb rather than a bare boolean, because the
   * two questions a row asks are "am I the one working" and "which control of
   * mine is". A shared boolean would spin every row's button on one press, which
   * is the visual form of the very confusion S19 exists to remove.
   */
  const [hub, setHub] = useState<HubPanelState>({
    busy: null,
    refreshing: false,
    backingUp: false,
    consenting: false,
    outcomes: {},
    connecting: null,
    removing: null,
    disconnecting: null,
    error: null,
    wide: IDLE_WIDE,
  });
  const patchHub = useCallback(
    (patch: Partial<HubPanelState>) => setHub((current) => ({ ...current, ...patch })),
    [],
  );
  const patchWide = useCallback(
    (patch: Partial<HubWideState>) =>
      setHub((current) => ({ ...current, wide: { ...current.wide, ...patch } })),
    [],
  );

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * THE ONE REQUEST ON MOUNT. Loopback, and network-free on the far side.
   *
   * Not on the fingerprint poll: connection state changes when a human runs a
   * command, not while they read a page, so polling it would be a great deal of
   * traffic to learn nothing — and it is the shape most likely to be quietly
   * upgraded into a probe later. The same argument `CloudStrip` makes.
   */
  useEffect(() => {
    let live = true;
    getCloudStatus()
      .then((next) => {
        if (live) {
          setReport(next);
          setLoadError(null);
        }
      })
      .catch((caught: unknown) => {
        if (live) setLoadError(describeRefusal(caught).message);
      });
    return () => {
      live = false;
    };
  }, [ws]);

  /**
   * The hub-wide list — S16 (STA-275). One request, once, on mount.
   *
   * A SEPARATE effect from the status read above, not a `Promise.all` with it,
   * and the reason is the error handling. `loadError` from the status read
   * replaces the whole panel, because without a report there is nothing to draw.
   * The list is different: it is one section of several, and losing it must not
   * take away the connect form. So its failure is swallowed to `null` and the
   * section simply does not render — see `HubWorkspaceList`.
   *
   * Not keyed on `ws`. The list is about the MACHINE and is identical whichever
   * workspace the dialog was opened on; re-fetching it when `ws` changes would be
   * a request for a value that cannot have changed. `currentRepositoryId` is what
   * marks the current row, and that comes from the status report.
   */
  useEffect(() => {
    let live = true;
    getCloudWorkspaces()
      .then((next) => {
        if (live) setWorkspaces(next);
      })
      .catch(() => {
        // Deliberately silent. The list is additive; the panel is not about it.
        if (live) setWorkspaces(null);
      });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Every mutation answers with the refreshed report, so acting and re-reading
   * are one round trip rather than two. A second GET would be a window in which
   * the page shows the state before the thing it just did.
   */
  const run = useCallback(
    async <T,>(kind: Exclude<CloudBusy, null>, work: () => Promise<T>): Promise<T | null> => {
      setBusy(kind);
      setError(null);
      try {
        return await work();
      } catch (caught) {
        if (alive.current) setError(describeRefusal(caught).message);
        return null;
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [],
  );

  /**
   * One row's round trip — S19 (STA-280).
   *
   * The whole of "an action on one row does not act on another" at this layer,
   * and it is three properties of these few lines:
   *
   *  - `busy` carries the SLUG, so only the pressed row locks and only its
   *    control spins. A shared boolean would spin all seven, which is the visual
   *    form of exactly the confusion this ticket removes.
   *  - a refusal is stored WITH its slug, so an error is drawn on the row that
   *    produced it rather than at the top of a list of seven.
   *  - the outcome is keyed on `answer.outcome.slug` — the slug the SERVER
   *    reported — and not on the one this function sent. If the two ever
   *    disagreed, the outcome would appear on the row it actually happened to,
   *    which is the honest failure. Drawing it on the row that was pressed is
   *    the dishonest one.
   *
   * The refreshed list is applied from the same response, so acting and
   * re-reading are one round trip and a row never renders the state that existed
   * before the thing it just did.
   */
  const runRow = useCallback(
    async <T,>(slug: string, action: HubRowAction, work: () => Promise<T>): Promise<T | null> => {
      setHub((current) => ({ ...current, busy: { slug, action }, error: null }));
      try {
        return await work();
      } catch (caught) {
        if (alive.current) {
          const refusal = describeRefusal(caught);
          setHub((current) => ({ ...current, error: { slug, message: refusal.message } }));
        }
        return null;
      } finally {
        if (alive.current) setHub((current) => ({ ...current, busy: null }));
      }
    },
    [],
  );

  /** Apply what a per-row route answered: the outcome on its own row, and the fresh list. */
  const applyRowResult = useCallback(
    (answer: { outcome: HubWorkspaceOutcome; report: HubCloudReport }) => {
      if (!alive.current) return;
      setWorkspaces(answer.report);
      // `hubRowActed` in the pure half; the mirror of `hubWideActed`.
      setHub((current) => hubRowActed(current, answer.outcome.slug, answer.outcome));
    },
    [],
  );

  /**
   * One hub-wide round trip — S18 (STA-279).
   *
   * The sibling of `runRow`, and the differences are all consequences of the hub
   * not being a row:
   *
   *  - `busy` carries only the VERB, because there is no slug. It is a separate
   *    field from `hub.busy` so that a hub-wide press cannot spin a workspace's
   *    spinner and a workspace's press cannot spin the hub's — the same "an
   *    action on one row does not act on another" discipline, applied to the one
   *    subject that is not a row.
   *  - a refusal is stored on `wide.error`, drawn in the hub panel. Putting it in
   *    `hub.error` would draw a machine-wide refusal against whichever workspace
   *    happened to match its slug, and the empty slug is already the backup's.
   *  - the previous `fanOut` table is CLEARED on a new press. It is a result, not
   *    a log: leaving last run's rows on screen under a spinner would show
   *    somebody a table describing a state that no longer exists.
   */
  const runWide = useCallback(
    async <T,>(action: HubWideAction, work: () => Promise<T>): Promise<T | null> => {
      setHub((current) => ({
        ...current,
        wide: { ...current.wide, busy: action, error: null, fanOut: null },
      }));
      try {
        return await work();
      } catch (caught) {
        if (alive.current) {
          const refusal = describeRefusal(caught);
          /**
           * The transition is `hubWideFailure`, in the pure half, because the
           * rule it encodes — **a refused confirm returns to the FORM, never to
           * the consent screen** — is subtle enough to have been got wrong once
           * and cannot be tested from inside a `catch` by a suite with no DOM.
           * See its comment for why tickets are already spent by the time most
           * refusals land here.
           */
          setHub((current) => ({ ...current, wide: hubWideFailure(current.wide, refusal.message) }));
          /**
           * **A REFUSAL REFRESHES THE LIST TOO.**
           *
           * Only the success paths carried a report, so after *"Confirming
           * bravo: This machine's connection state changed…"* the control above
           * still read "Connect 3 workspaces" — a button contradicting the
           * message directly beneath it, and stale in exactly the case where the
           * refusal EXISTS because the counts moved.
           *
           * A local re-read rather than a report on the refusal envelope:
           * `deny` is shared by every route on this server and its shape is
           * pinned by `test/contract-http.test.ts`, so widening it would put a
           * registry read behind every 400 the API can produce. This is one
           * network-free request, the same one `onRefresh` makes.
           *
           * Its own failure is swallowed. The refusal already on screen is the
           * thing the reader needs; replacing it with a complaint about the
           * refresh would lose the message that explains what just happened.
           */
          getCloudWorkspaces()
            .then((next) => {
              if (alive.current) setWorkspaces(next);
            })
            .catch(() => {});
        }
        return null;
      } finally {
        if (alive.current) {
          setHub((current) => ({ ...current, wide: { ...current.wide, busy: null } }));
        }
      }
    },
    [],
  );

  /**
   * Apply what a hub-wide route answered: the TABLE, and the fresh list.
   *
   * The table is kept whole rather than folded into `outcomes` keyed by slug, and
   * that is deliberate. Scattering a fan-out's rows onto the workspace list below
   * would put a machine-wide result in N places and lose the one thing a reader
   * needs from it — that these rows are one action, taken together, with totals.
   * The rows still carry the slug the SERVER reported, so nothing is drawn
   * against a workspace it is not about.
   */
  const applyFanOut = useCallback((answer: { fanOut: HubFanOut; report: HubCloudReport }) => {
    if (!alive.current) return;
    setWorkspaces(answer.report);
    // `hubWideActed` in the pure half, so the rule is tested as a transition.
    setHub((current) => hubWideActed(current, answer.fanOut));
  }, []);

  const hubActions: HubActions = {
    /**
     * Opening one row's form closes any other's, by construction: `connecting`
     * holds a single slug. Two half-filled connect forms holding two enrollment
     * secrets is not a state worth supporting, and it is a state in which the
     * wrong secret gets sent.
     */
    onOpenConnect: (slug) =>
      patchHub({
        connecting:
          slug === null ? null : { slug, draft: EMPTY_DRAFT, pending: null, skipped: null },
        removing: null,
        disconnecting: null,
        error: null,
      }),
    onDraft: (patch) =>
      setHub((current) =>
        current.connecting === null
          ? current
          : {
              ...current,
              connecting: {
                ...current.connecting,
                draft: { ...current.connecting.draft, ...patch },
              },
            },
      ),
    onPreview: () => {
      const open = hub.connecting;
      if (open === null) return;
      void runRow(open.slug, "connect", async () => {
        const answer = await previewWorkspaceConnect({
          slug: open.slug,
          endpoint: open.draft.endpoint.trim(),
          label: open.draft.label.trim() || undefined,
          credentialFile: open.draft.credentialFile,
        });
        if (!alive.current) return;
        setWorkspaces(answer.report);
        setHub((current) =>
          current.connecting === null || current.connecting.slug !== open.slug
            ? current
            : {
                ...current,
                connecting: {
                  ...current.connecting,
                  /**
                   * A skipped row gets the fan-out's own sentence and NO ticket.
                   * The server minted none, because a consent for something that
                   * will not happen is a consent with no subject.
                   */
                  skipped:
                    answer.preview === null || answer.consent === null ? answer.reason : null,
                  pending:
                    answer.preview === null || answer.consent === null
                      ? null
                      : { preview: answer.preview, consent: answer.consent },
                },
              },
        );
      });
    },
    onConnect: () => {
      const open = hub.connecting;
      if (open === null || open.pending === null) return;
      const consent = open.pending.consent;
      const token = open.draft.enrollment;
      void runRow(open.slug, "connect", async () => {
        applyRowResult(await connectWorkspace({ slug: open.slug, consent, token }));
        // The secret has been spent. Holding it in React state after the server
        // has stored it is a copy of a credential nobody needs.
        if (alive.current) patchHub({ connecting: null });
      });
    },
    onSync: (slug) =>
      void runRow(slug, "sync", async () => {
        /**
         * EGRESSES, and a failed row comes back 200 with `status: "failed"`.
         * `applyRowResult` renders it either way — the fan-out reports a failure
         * as a row carrying the service's own message, and turning that back
         * into a thrown error here would discard exactly the `offline` /
         * `revoked` / `rate_limited` distinction it exists to keep.
         */
        applyRowResult(await syncWorkspace({ slug }));
      }),
    onConsent: (slug, consent, value) =>
      void runRow(slug, consent, async () => {
        applyRowResult(await setWorkspaceConsent({ slug, consent, value }));
      }),
    onAskDisconnect: (slug) =>
      patchHub({ disconnecting: slug, connecting: null, removing: null, error: null }),
    onDisconnect: (slug) =>
      void runRow(slug, "disconnect", async () => {
        applyRowResult(await disconnectWorkspace({ slug }));
        if (alive.current) patchHub({ disconnecting: null });
      }),
    /**
     * Asking to remove PREVIEWS first, on the server, and writes nothing.
     *
     * The confirmation then states a fact rather than a hope: how many
     * cross-workspace links name this row, and therefore whether saying yes also
     * changes another workspace's blockers. Guessing at that in the browser
     * would mean either a warning that is usually wrong or no warning at all.
     */
    onAskRemove: (slug) => {
      if (slug === null) {
        patchHub({ removing: null });
        return;
      }
      void runRow(slug, "remove", async () => {
        const answer = await previewUnregisterWorkspace({ slug });
        if (!alive.current) return;
        setWorkspaces(answer.report);
        patchHub({
          removing: { slug, crossLinks: answer.preview.crossLinks.length },
          connecting: null,
          disconnecting: null,
        });
      });
    },
    onRemove: (slug, removeCrossLinks) =>
      void runRow(slug, "remove", async () => {
        applyRowResult(await unregisterWorkspace({ slug, removeCrossLinks }));
        if (alive.current) patchHub({ removing: null });
      }),
    /**
     * *"A workspace registered after page load appears on refresh."* One local
     * read of the registry; `GET /api/cloud/workspaces` opens no workspace
     * database and nothing in its import graph can reach the transport, so this
     * contacts nobody.
     */
    onRefresh: () => {
      patchHub({ refreshing: true, error: null });
      getCloudWorkspaces()
        .then((next) => {
          if (alive.current) setWorkspaces(next);
        })
        .catch((caught: unknown) => {
          if (alive.current) {
            setHub((current) => ({
              ...current,
              error: { slug: "", message: describeRefusal(caught).message },
            }));
          }
        })
        .finally(() => {
          if (alive.current) patchHub({ refreshing: false });
        });
    },

    /**
     * Back up the hub. Never disabled by connection state — see `HubSelfPanel`.
     *
     * Reports the receipt through the same per-row outcome channel, keyed on the
     * empty slug, because the hub is not a row and must not light one up. A key
     * that collided with a real slug would put a hub result inside a workspace's
     * row, which is the precise class of bug S19 pinned `outcome.slug` to catch.
     */
    onBackup: () => {
      patchHub({ backingUp: true, error: null });
      backupHub()
        .then((answer) => {
          if (!alive.current) return;
          setWorkspaces(answer.report);
          setHub((current) => ({
            ...current,
            outcomes: {
              ...current.outcomes,
              "": {
                slug: "",
                action: "backup",
                status: "ok",
                detail: `Wrote ${answer.workspaces} ${answer.workspaces === 1 ? "workspace" : "workspaces"} and ${answer.crossLinks} ${answer.crossLinks === 1 ? "link" : "links"} to ${answer.path}. No tasks are in this file.`,
                at: new Date().toISOString(),
              },
            },
          }));
        })
        .catch((caught: unknown) => {
          if (alive.current) {
            setHub((current) => ({
              ...current,
              error: { slug: "", message: describeRefusal(caught).message },
            }));
          }
        })
        .finally(() => {
          if (alive.current) patchHub({ backingUp: false });
        });
    },

    // ─── the hub-wide verbs — S18 (STA-279) ────────────────────────────────

    /**
     * Opening the hub-wide connect closes any ROW's connect form, and vice
     * versa, by construction: `connecting` here and `connecting` on the row
     * state are two fields and both are cleared. Two half-filled connect forms
     * holding two enrollment secrets is not a state worth supporting, and it is
     * a state in which the wrong secret gets sent — the same argument
     * `onOpenConnect` makes between rows, extended to the one form that is not a
     * row.
     */
    onHubOpenConnect: (open) =>
      setHub((current) => ({
        ...current,
        connecting: null,
        removing: null,
        disconnecting: null,
        error: null,
        wide: {
          ...current.wide,
          connecting: open ? { draft: EMPTY_DRAFT, pending: null } : null,
          disconnecting: false,
          error: null,
        },
      })),

    onHubDraft: (patch) =>
      setHub((current) =>
        current.wide.connecting === null
          ? current
          : {
              ...current,
              wide: {
                ...current.wide,
                connecting: {
                  ...current.wide.connecting,
                  draft: { ...current.wide.connecting.draft, ...patch },
                },
              },
            },
      ),

    onHubPreview: () => {
      const open = hub.wide.connecting;
      if (open === null) return;
      void runWide("connect", async () => {
        const answer = await previewHubConnect({
          endpoint: open.draft.endpoint.trim(),
          label: open.draft.label.trim() || undefined,
          credentialFile: open.draft.credentialFile,
        });
        if (!alive.current) return;
        setWorkspaces(answer.report);
        setHub((current) =>
          current.wide.connecting === null
            ? current
            : {
                ...current,
                wide: {
                  ...current.wide,
                  connecting: {
                    ...current.wide.connecting,
                    pending: { preview: answer.preview, consents: answer.consents },
                  },
                },
              },
        );
      });
    },

    onHubConnect: () => {
      const open = hub.wide.connecting;
      if (open === null || open.pending === null) return;
      const consents = open.pending.consents;
      const token = open.draft.enrollment;
      void runWide("connect", async () => {
        /**
         * Every ticket goes together, because the confirm is a confirm of the
         * whole enumeration. Sending them one at a time would turn one decision
         * into N requests, each of which could succeed while the next was
         * refused — which is exactly the partial state the enumeration check
         * exists to make impossible.
         */
        applyFanOut(await connectHub({ consents, token }));
        // The secret has been spent. Holding it in React state after the server
        // has stored N credentials is a copy of a credential nobody needs.
        if (alive.current) patchWide({ connecting: null });
      });
    },

    /**
     * EGRESSES, once per connected workspace, and only on this press. A failed
     * row comes back inside a 200 with `status: "failed"`; `applyFanOut` renders
     * it as a row, because turning it back into a thrown error here would discard
     * exactly the `offline` / `revoked` / `rate_limited` distinction the fan-out
     * exists to keep.
     */
    onHubSync: () =>
      void runWide("sync", async () => {
        applyFanOut(await syncHub());
      }),

    onHubAskDisconnect: (asking) =>
      setHub((current) => ({
        ...current,
        connecting: null,
        removing: null,
        disconnecting: null,
        wide: { ...current.wide, disconnecting: asking, connecting: null, error: null },
      })),

    onHubDisconnect: () =>
      void runWide("disconnect", async () => {
        applyFanOut(await disconnectHub());
        if (alive.current) patchWide({ disconnecting: false });
      }),

    /**
     * The hub's own consent — S22 (STA-283). One local file write.
     *
     * Not routed through `runWide`, because that is for the three VERBS and
     * clears the fan-out table on every press: flipping a consent is not a
     * fan-out and must not wipe the result of one somebody is still reading.
     * `consenting` is its own flag for the same reason `backingUp` is.
     *
     * The receipt goes through the hub's outcome channel, keyed on the empty
     * slug like the backup's, because the hub is not a row and a key colliding
     * with a real slug would put a hub result inside a workspace's.
     */
    onHubRegistryConsent: (enabled, disclosure) => {
      patchHub({ consenting: true });
      setHubRegistryConsent(enabled, disclosure)
        .then((answer) => {
          if (!alive.current) return;
          setWorkspaces(answer.report);
          setHub((current) => ({
            ...current,
            outcomes: { ...current.outcomes, [answer.outcome.slug]: answer.outcome },
          }));
        })
        .catch((caught: unknown) => {
          if (alive.current) {
            setHub((current) => ({
              ...current,
              error: { slug: "", message: describeRefusal(caught).message },
            }));
          }
        })
        .finally(() => {
          if (alive.current) patchHub({ consenting: false });
        });
    },
  };

  if (loadError !== null) {
    return (
      <Section title="Cloud">
        <InlineError>{loadError}</InlineError>
      </Section>
    );
  }
  if (report === null) return <LoadingState rows={3} />;

  return (
    <CloudPanel
      report={report}
      error={error}
      busy={busy}
      draft={draft}
      onDraft={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      pending={pending}
      devices={devices}
      workspaces={workspaces}
      hub={hub}
      hubActions={hubActions}
      revoking={revoking}
      confirmDisconnect={confirmDisconnect}
      onPreview={() =>
        void run("preview", async () => {
          const answer = await previewCloudConnect({
            ws,
            endpoint: draft.endpoint.trim(),
            label: draft.label.trim() || undefined,
            credentialFile: draft.credentialFile,
          });
          if (alive.current) setPending(answer);
        })
      }
      onCancelPreview={() => setPending(null)}
      onConnect={() =>
        void run("connect", async () => {
          if (!pending) return;
          const answer = await cloudConnect({ ws, consent: pending.consent, token: draft.enrollment });
          if (!alive.current) return;
          setReport(answer.report);
          setPending(null);
          // The secret has been spent. Holding it in a React state after the
          // server has stored it is a copy of a credential nobody needs.
          setDraft(EMPTY_DRAFT);
          setDevices(null);
        })
      }
      onConsent={(consent, value) =>
        void run("consent", async () => {
          const answer = await setCloudConsent({ ws, consent, value });
          if (alive.current) setReport(answer.report);
        })
      }
      onDevices={() =>
        void run("devices", async () => {
          const answer = await listCloudDevices({ ws });
          if (alive.current) setDevices(orderDevices(answer.devices));
        })
      }
      onAskRevoke={setRevoking}
      onRevoke={(deviceId) =>
        void run("revoke", async () => {
          const answer = await revokeCloudDevice({ ws, deviceId });
          if (!alive.current) return;
          setReport(answer.report);
          setRevoking(null);
          // Re-read rather than patch the row: the server's list is the
          // authority, and this is the one moment we know it changed.
          const refreshed = await listCloudDevices({ ws });
          if (alive.current) setDevices(orderDevices(refreshed.devices));
        })
      }
      onAskDisconnect={setConfirmDisconnect}
      onDisconnect={() =>
        void run("disconnect", async () => {
          const answer = await cloudDisconnect({ ws });
          if (!alive.current) return;
          setReport(answer.report);
          setConfirmDisconnect(false);
          setDevices(null);
        })
      }
    />
  );
}
