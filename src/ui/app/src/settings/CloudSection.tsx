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
  connectWorkspace,
  disconnectWorkspace,
  getCloudStatus,
  getCloudWorkspaces,
  listCloudDevices,
  previewCloudConnect,
  previewUnregisterWorkspace,
  previewWorkspaceConnect,
  revokeCloudDevice,
  setCloudConsent,
  setWorkspaceConsent,
  syncWorkspace,
  unregisterWorkspace,
} from "@/lib/api";
import { describeRefusal } from "@/lib/refusal";
import type {
  CloudSurfaceReport,
  ConnectPreview,
  ConsentTicket,
  HubCloudReport,
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
  hubGroups,
  hubListDescription,
  hubRowControls,
  hubUnreachableDescription,
  joinLabels,
  orderDevices,
  previewFacts,
  removeWarning,
  revokeWarning,
  type CloudFact,
  type HubRowAction,
  type HubRowControl,
  type HubRowView,
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
 * Every registered workspace, with its own state and its own controls —
 * S17 (STA-278), S19 (STA-280), S21 (STA-282).
 *
 * ## What this replaced, and what survives of the argument
 *
 * This shipped as a read-only table whose header said *"A LIST AND NOT A
 * CONTROL"*. The reasoning was that connecting every workspace at once spends one
 * enrollment secret against N services and produces a per-workspace outcome a
 * dialog has nowhere to put, so naming `staple cloud connect --all` was more use
 * than a button asking for less than the CLI preview does.
 *
 * That reasoning is intact and there is still no hub-wide button here. What it
 * did not justify — and was taken to — is the absence of PER-ROW controls. One
 * row's connect spends one secret against one service and produces one outcome:
 * the same shape the sections above have offered since S13. `cloud-settings.ts`
 * states this at length beside the pure half.
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
    outcomes: {},
    connecting: null,
    removing: null,
    disconnecting: null,
    error: null,
  });
  const patchHub = useCallback(
    (patch: Partial<HubPanelState>) => setHub((current) => ({ ...current, ...patch })),
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
      setHub((current) => ({
        ...current,
        outcomes: { ...current.outcomes, [answer.outcome.slug]: answer.outcome },
      }));
    },
    [],
  );

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
