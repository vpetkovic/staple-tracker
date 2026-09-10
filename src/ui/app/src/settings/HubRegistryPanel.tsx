/**
 * THE HUB REGISTRY PANEL — STA-289.
 *
 * The hub's own leg to a sync service, on the page: its identity, its connection,
 * the publish switch and a Publish button, hub backups on the service, restore and
 * adopt. Until this, the page had the publish switch and nothing else, so on any
 * machine that had not connected the hub from a terminal the switch sat disabled
 * with no way forward.
 *
 * ── TWO HALVES, LIKE THE REST OF THE PAGE ────────────────────────────────────
 *
 * `HubRegistryPanel` is a pure function of the hub report, a state object and some
 * handlers; `useHubRegistry` is the thing that holds the state and makes the calls.
 * The split is `CloudSection`'s, for its reason: the suite renders to a string and
 * never runs an effect, so every state this panel can be in has to be reachable by
 * passing a value.
 *
 * ── NOTHING HERE FIRES WITHOUT A PRESS ───────────────────────────────────────
 *
 * The panel draws from `report.self.registry`, which comes from the page's one
 * network-free read. Every call that reaches the service — connect, publish, the
 * backup switch, the backup list, taking a backup, restore, adopt — is inside a
 * handler. The one effect in this file tracks whether the section is still mounted
 * and calls nothing. A panel that listed backups when it opened would be a request
 * to the service on every visit to settings.
 */
import { useCallback, useRef, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  adoptHubIdentity,
  adoptHubRegistry,
  connectHubRegistry,
  createHubBackup,
  disconnectHubRegistry,
  listHubBackups,
  mintHubIdentity,
  previewHubRegistryConnect,
  publishHubRegistry,
  restoreHubRegistry,
  setHubBackupConsent,
  setHubRegistryConsent,
} from "@/lib/api";
import { describeRefusal } from "@/lib/refusal";
import type {
  AdoptionReport,
  ConnectPreview,
  ConsentTicket,
  HubCloudReport,
  HubRestoreNotice,
  HubRestoreReport,
  PublishReport,
  RemoteBackup,
} from "@/lib/types";
import { ConnectFields, EMPTY_DRAFT, Facts, type ConnectDraft } from "./cloud-fields";
import { connectFormProblem, hubRegistryControl } from "./cloud-settings";
import { DestructiveConfirm, Field, InlineError, Section } from "./form/primitives";
import {
  HUB_CONNECT_DISCLOSURE,
  HUB_DISCONNECT_WARNING,
  adoptionSummary,
  applyLabel,
  backupFacts,
  decisionLabel,
  hubPreviewFacts,
  hubRegistryBlocks,
  hubRegistryStage,
  linkLabel,
  publishGroups,
  publishSummary,
  restoreConfirmLabel,
  restoreSummary,
  shortId,
  showsReason,
  type HubRegistryAction,
} from "./hub-registry-settings";

/** What an identity press ended in. `notice` is the core's orphan sentence, or null. */
export interface HubIdentityOutcome {
  kind: "minted" | "existing" | "adopted" | "unchanged";
  hubId: string;
  notice: string | null;
}

export interface HubRegistryState {
  /** The press in flight. One at a time: every control here disables while any is. */
  busy: HubRegistryAction | null;
  /** The last refusal, in the server's words. Drawn in this panel only. */
  error: string | null;
  identity: {
    open: boolean;
    draft: string;
    /** The server asked before replacing an identity. `notice` is what it said. */
    confirm: { hubId: string; notice: string } | null;
    outcome: HubIdentityOutcome | null;
  };
  connectDraft: ConnectDraft;
  /** The preview shown and waiting on a yes. */
  connectPending: { preview: ConnectPreview; consent: ConsentTicket } | null;
  disconnecting: boolean;
  publish: PublishReport | null;
  /** The backup switch's warning when the service could not be told it was turned off. */
  backupWarning: string | null;
  /** Null until somebody presses the button that asks the service. */
  backups: RemoteBackup[] | null;
  restoreNotice: HubRestoreNotice | null;
  /** The backup whose restore is being confirmed. */
  restoring: RemoteBackup | null;
  /** What the last restore did on the service. */
  restored: HubRestoreReport | null;
  /** An adoption preview, from the adopt button or from a restore, waiting on an apply. */
  adoption: { report: AdoptionReport; digest: string } | null;
  /** The last applied adoption. */
  applied: AdoptionReport | null;
}

export const IDLE_REGISTRY: HubRegistryState = {
  busy: null,
  error: null,
  identity: { open: false, draft: "", confirm: null, outcome: null },
  connectDraft: EMPTY_DRAFT,
  connectPending: null,
  disconnecting: false,
  publish: null,
  backupWarning: null,
  backups: null,
  restoreNotice: null,
  restoring: null,
  restored: null,
  adoption: null,
  applied: null,
};

export interface HubRegistryActions {
  /**
   * The publish consent — S22 (STA-283). Takes the sentence the switch rendered,
   * from the report, because `setRegistryConsent` requires it back as evidence.
   */
  onConsent: (enabled: boolean, disclosure: string) => void;
  onMint: () => void;
  onIdentityOpen: (open: boolean) => void;
  onIdentityDraft: (value: string) => void;
  /** Take on the drafted id. Asks first when it would replace one. */
  onIdentitySubmit: () => void;
  /** Say yes to the replacement the server asked about. */
  onIdentityConfirm: () => void;
  onConnectDraft: (patch: Partial<ConnectDraft>) => void;
  onConnectPreview: () => void;
  onConnectCancel: () => void;
  onConnect: () => void;
  onAskDisconnect: (asking: boolean) => void;
  onDisconnect: () => void;
  onPublish: () => void;
  onBackupConsent: (enabled: boolean) => void;
  onBackups: () => void;
  onBackupCreate: () => void;
  onAskRestore: (backup: RemoteBackup | null) => void;
  onRestore: (backup: RemoteBackup) => void;
  onAdoptPreview: () => void;
  onApply: () => void;
  onDismissAdoption: () => void;
}

export interface HubRegistryPanelProps {
  report: HubCloudReport;
  state: HubRegistryState;
  actions: HubRegistryActions;
  /** Something else on the hub is in flight. Nothing here may start. */
  locked: boolean;
}

/** A block of the panel: a small heading and its contents. */
function Block({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <div data-hub-registry-block={name} className="space-y-2 border-t pt-3">
      <h5 className="text-[12px] font-medium text-muted-foreground">{title}</h5>
      {children}
    </div>
  );
}

/** One line saying why a control is unavailable. Rendered, not only a tooltip. */
function Blocked({ reason }: { reason: string | null }) {
  if (reason === null) return null;
  return <p className="text-[11px] leading-relaxed text-muted-foreground">{reason}</p>;
}

/**
 * A press button. `title` carries the reason for a pointer; the reason is also
 * rendered beside the controls by the caller, because a tooltip is not an
 * explanation on a phone.
 */
function Press({
  action,
  label,
  busyLabel,
  state,
  locked,
  blocked,
  onPress,
  variant = "outline",
}: {
  action: HubRegistryAction;
  label: string;
  busyLabel: string;
  state: HubRegistryState;
  locked: boolean;
  blocked: string | null;
  onPress: () => void;
  variant?: "outline" | "default" | "ghost";
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      data-hub-registry-action={action}
      data-disabled={blocked !== null ? "true" : "false"}
      disabled={blocked !== null || locked || state.busy !== null}
      title={blocked ?? undefined}
      onClick={onPress}
    >
      {state.busy === action ? busyLabel : label}
    </Button>
  );
}

/** The four facts about the hub's registry, as tiles — the same shape as the hub's counts. */
function RegistryTiles({ report }: { report: HubCloudReport }) {
  const { hubId, endpoint, connected, consent, backup } = report.self.registry;
  const host = endpoint === null ? null : endpoint.replace(/^https?:\/\//, "");
  const tiles = [
    { label: "Registry id", value: hubId === null ? "None" : shortId(hubId) },
    { label: "Service", value: connected && host !== null ? host : "Not connected" },
    { label: "Publishing", value: consent ? "On" : "Off" },
    { label: "Hub backups", value: backup ? "On" : "Off" },
  ];
  return (
    <dl data-hub-registry-tiles className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex min-w-0 flex-col-reverse rounded-md border px-3 py-2">
          <dt className="text-[11px] leading-snug text-muted-foreground">{tile.label}</dt>
          <dd className="truncate text-[15px] leading-tight font-semibold" title={tile.value}>
            {tile.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A native disclosure that opens itself when it mounts holding a draft — the shape
 * the workspace connect form uses, for its reason. The summary carries no display
 * utility, so the marker triangle survives; on a phone it is the only sign this opens.
 */
function Disclosure({
  name,
  summary,
  hasDraft,
  children,
}: {
  name: string;
  summary: string;
  hasDraft: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(hasDraft);
  return (
    <details
      data-hub-registry-disclosure={name}
      className="rounded-md border px-3 py-2"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer py-1.5 text-[13px] font-medium">{summary}</summary>
      {children}
    </details>
  );
}

/**
 * One adoption, listed: a row per incoming workspace and a row per link, each with
 * its outcome, and its sentence wherever the sentence says something the label does
 * not. Used for the adopt preview, the restore's preview, and what an apply did.
 */
export function AdoptionView({ report }: { report: AdoptionReport }) {
  return (
    <div data-hub-registry-adoption={report.dryRun ? "preview" : "applied"} className="space-y-2">
      <p className="text-[12px] leading-relaxed">{adoptionSummary(report)}</p>
      <ul className="m-0 list-none space-y-1 p-0">
        {report.decisions.map((decision) => (
          <li
            key={`${decision.entry.repositoryId ?? "none"}:${decision.entry.slug}`}
            data-hub-registry-decision={decision.entry.slug}
            data-outcome={decision.outcome}
            className="rounded-md border px-2 py-1"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[12px] font-medium">{decision.entry.slug}</span>
              <span className="text-[11px] text-muted-foreground">{decision.entry.prefix}</span>
              <span className="text-[10px] uppercase text-muted-foreground">
                {decisionLabel(decision, report.dryRun)}
              </span>
            </div>
            {showsReason(decision.outcome) ? (
              <p className="text-[11px] leading-relaxed wrap-anywhere text-muted-foreground">{decision.reason}</p>
            ) : null}
          </li>
        ))}
        {report.crossLinkDecisions.map((decision) => (
          <li
            key={`${decision.link.blockerIdentifier}>${decision.link.blockedIdentifier}`}
            data-hub-registry-link={`${decision.link.blockerIdentifier}>${decision.link.blockedIdentifier}`}
            data-outcome={decision.outcome}
            className="rounded-md border px-2 py-1"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[12px] font-medium">
                {decision.link.blockerIdentifier} blocks {decision.link.blockedIdentifier}
              </span>
              <span className="text-[10px] uppercase text-muted-foreground">
                {linkLabel(decision, report.dryRun)}
              </span>
            </div>
            {showsReason(decision.outcome) ? (
              <p className="text-[11px] leading-relaxed wrap-anywhere text-muted-foreground">{decision.reason}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a publish did: its line, then every list it carries that is not empty. */
export function PublishView({ report }: { report: PublishReport }) {
  return (
    <div data-hub-registry-publish-report className="space-y-2">
      <p className="text-[12px] leading-relaxed">{publishSummary(report)}</p>
      {publishGroups(report).map((group) => (
        <div key={group.key} data-hub-registry-publish-group={group.key}>
          <p className="text-[11px] font-medium">{group.title}</p>
          <ul className="m-0 mt-0.5 list-disc space-y-0.5 pl-4">
            {group.lines.map((line, index) => (
              <li key={`${index}:${line}`} className="text-[11px] leading-relaxed wrap-anywhere text-muted-foreground">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * THE HUB'S PUBLISH CONSENT — S22 (STA-283), moved here from the hub panel by STA-289
 * so it sits with the Publish button it unlocks.
 *
 * The disclosure is rendered from the report, never retyped: `REGISTRY_DISCLOSURE` —
 * *"a machine that publishes its registry tells the service the
 * names, prefixes and identities of every workspace on it, and that they sit together"* — is the one
 * sentence that has to appear wherever this consent is granted, the
 * browser cannot import `src/core`, and a copy here would drift silently. The switch
 * hands back the sentence it rendered, which is what `setRegistryConsent` requires
 * as evidence a surface displayed it.
 */
function RegistryConsent({
  report,
  busy,
  locked,
  onConsent,
  reasonStated,
}: {
  report: HubCloudReport;
  busy: boolean;
  locked: boolean;
  onConsent: (enabled: boolean, disclosure: string) => void;
  /** The panel already says, once, that nothing here works until the hub is connected. */
  reasonStated: boolean;
}) {
  const control = hubRegistryControl(report);
  const disabled = control.disabledReason !== null;
  return (
    <div data-cloud-hub-registry>
      <Field id="cloud-hub-registry" label={control.label} description={control.description}>
        {(aria) => (
          <label className="flex min-h-8 items-center gap-2 text-[13px]">
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
      <p data-cloud-hub-registry-disclosure className="mt-1 text-[12px] leading-relaxed">
        {report.self.registry.disclosure.charAt(0).toUpperCase()}
        {report.self.registry.disclosure.slice(1)}
      </p>
      {disabled && !reasonStated ? (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{control.disabledReason}</p>
      ) : null}
    </div>
  );
}

/** The whole panel, as a pure function of the report and the state. */
export function HubRegistryPanel(props: HubRegistryPanelProps) {
  const { report, state, actions } = props;
  const stage = hubRegistryStage(report);
  const blocks = hubRegistryBlocks(report);
  const locked = props.locked;
  const registry = report.self.registry;
  /**
   * The reason every block below the connection shares while the hub is not
   * connected, stated ONCE under the connection rather than under each of three
   * blocks — the grouping every other part of this page does for a reason several
   * controls share. A block's own line is kept only for a reason that is its own.
   */
  const shared = blocks.disconnect;
  const beyondConnection = (reason: string | null) => (reason === shared ? null : reason);
  const press = (action: HubRegistryAction, label: string, busyLabel: string, onPress: () => void, variant?: "outline" | "default" | "ghost") => (
    <Press
      action={action}
      label={label}
      busyLabel={busyLabel}
      state={state}
      locked={locked}
      blocked={blocks[action]}
      onPress={onPress}
      variant={variant}
    />
  );

  return (
    <Section title="Hub registry" error={state.error}>
      <div data-hub-registry data-stage={stage} className="space-y-3">
        <RegistryTiles report={report} />

        {/* ─── IDENTITY ─────────────────────────────────────────────────── */}
        <Block name="identity" title="Identity">
          {registry.hubId !== null ? (
            <p data-hub-registry-id className="font-mono text-[12px] wrap-anywhere">
              {registry.hubId}
            </p>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              None yet. Mint one for a new registry, or take on the id another machine published under.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {registry.hubId === null ? press("mint", "Mint an id", "Minting…", actions.onMint, "default") : null}
            {state.identity.open ? null : (
              <Press
                action="identity"
                label={registry.hubId === null ? "Take on an existing id" : "Take on another id"}
                busyLabel="Working…"
                state={state}
                locked={locked}
                blocked={blocks.identity}
                onPress={() => actions.onIdentityOpen(true)}
              />
            )}
          </div>
          <Blocked reason={blocks.identity} />

          {state.identity.open && state.identity.confirm === null ? (
            <div data-hub-registry-identity-form className="space-y-2 rounded-md border px-3 py-3">
              <Field
                id="hub-registry-identity"
                label="Hub id"
                description="The id another machine published under, kept with its enrollment secret."
              >
                {(aria) => (
                  <Input
                    {...aria}
                    value={state.identity.draft}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    onChange={(event) => actions.onIdentityDraft(event.target.value)}
                  />
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  data-hub-registry-identity-submit
                  disabled={locked || state.busy !== null || state.identity.draft.trim() === ""}
                  onClick={actions.onIdentitySubmit}
                >
                  {state.busy === "identity" ? "Working…" : "Take on this id"}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={state.busy !== null} onClick={() => actions.onIdentityOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {/*
            THE ORPHAN NOTICE, before the yes. Its text is the server's
            `describeIdentityReplacement` — stated whenever there is a previous id,
            never branched on whether that id was used, because a disconnect leaves
            no evidence either way.
          */}
          {state.identity.confirm !== null ? (
            <DestructiveConfirm
              message={state.identity.confirm.notice}
              confirmLabel={state.busy === "identity" ? "Working…" : `Take on ${shortId(state.identity.confirm.hubId)}`}
              disabled={locked || state.busy !== null}
              onConfirm={actions.onIdentityConfirm}
              onCancel={() => actions.onIdentityOpen(false)}
            />
          ) : null}

          {state.identity.outcome !== null ? (
            <div data-hub-registry-identity-outcome={state.identity.outcome.kind} className="space-y-1">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {state.identity.outcome.kind === "minted"
                  ? "Minted and stored on this machine. It is not a secret: give it to whoever runs the sync service so they can create its repository row."
                  : state.identity.outcome.kind === "existing"
                    ? "This hub already had an id; nothing was minted."
                    : state.identity.outcome.kind === "unchanged"
                      ? "That is already this hub's id. Nothing changed."
                      : `This hub is now ${state.identity.outcome.hubId}. Connect it below.`}
              </p>
              {state.identity.outcome.notice !== null ? (
                <p data-hub-registry-orphan-notice className="text-[12px] leading-relaxed">
                  {state.identity.outcome.notice}
                </p>
              ) : null}
            </div>
          ) : null}
        </Block>

        {/* ─── CONNECTION ───────────────────────────────────────────────── */}
        <Block name="connection" title="Connection">
          {stage === "connected" ? (
            <>
              <p className="text-[12px] wrap-anywhere">Connected to {registry.endpoint}.</p>
              {state.disconnecting ? (
                <DestructiveConfirm
                  message={HUB_DISCONNECT_WARNING}
                  confirmLabel={state.busy === "disconnect" ? "Disconnecting…" : "Disconnect the hub"}
                  disabled={locked || state.busy !== null}
                  onConfirm={actions.onDisconnect}
                  onCancel={() => actions.onAskDisconnect(false)}
                />
              ) : (
                <div>{press("disconnect", "Disconnect the hub", "Disconnecting…", () => actions.onAskDisconnect(true))}</div>
              )}
            </>
          ) : state.connectPending !== null ? (
            /*
              THE CONSENT SCREEN, never collapsed. The facts are the workspace
              connect's own renderer; the confirm carries only the ticket.
            */
            <div data-hub-registry-consent className="space-y-3 rounded-md border px-3 py-3">
              <h5 className="text-sm font-semibold">
                {state.connectPending.preview.alreadyConnected ? "Re-connect this hub" : "Connect this hub"}
              </h5>
              <Facts facts={hubPreviewFacts(state.connectPending.preview)} />
              <ul className="list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-muted-foreground">
                {HUB_CONNECT_DISCLOSURE.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  data-hub-registry-connect-confirm
                  disabled={locked || state.busy !== null}
                  onClick={actions.onConnect}
                >
                  {state.busy === "connect" ? "Connecting…" : "Connect"}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={state.busy !== null} onClick={actions.onConnectCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Disclosure
                name="connect"
                summary="Connect the hub to a sync service"
                hasDraft={state.connectDraft.endpoint !== "" || state.connectDraft.enrollment !== ""}
              >
                <div className="mt-3 space-y-3">
                  <ConnectFields
                    idPrefix="hub-registry"
                    draft={state.connectDraft}
                    problem={connectFormProblem({
                      endpoint: state.connectDraft.endpoint,
                      token: state.connectDraft.enrollment,
                    })}
                    onDraft={actions.onConnectDraft}
                    enrollmentDescription="The secret whoever runs the service created with the hub's repository row, or an existing device token from a machine already connected to this hub."
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      data-hub-registry-connect-preview
                      disabled={
                        blocks.connect !== null ||
                        locked ||
                        state.busy !== null ||
                        connectFormProblem({
                          endpoint: state.connectDraft.endpoint,
                          token: state.connectDraft.enrollment,
                        }) !== null
                      }
                      onClick={actions.onConnectPreview}
                    >
                      {state.busy === "connect" ? "Reading…" : "Review connection"}
                    </Button>
                    <span className="text-[12px] text-muted-foreground">Nothing is sent until you confirm.</span>
                  </div>
                </div>
              </Disclosure>
            </>
          )}
          {shared !== null ? (
            <p data-hub-registry-shared-block className="text-[11px] leading-relaxed text-muted-foreground">
              {stage === "no_identity"
                ? "Connecting, publishing, hub backups, restore and adopt need a registry identity first."
                : "Publishing, hub backups, restore and adopt need the hub connected first."}
            </p>
          ) : null}
        </Block>

        {/* ─── PUBLISH ──────────────────────────────────────────────────── */}
        <Block name="publish" title="Publish">
          {/* The switch's value is its receipt; a sentence saying "it is on" under an "On" is noise. */}
          <RegistryConsent
            report={report}
            busy={state.busy === "consent"}
            locked={locked || state.busy !== null}
            onConsent={actions.onConsent}
            reasonStated={shared !== null}
          />
          <div>{press("publish", "Publish now", "Publishing…", actions.onPublish, "default")}</div>
          <Blocked reason={beyondConnection(blocks.publish)} />
          {state.publish !== null ? <PublishView report={state.publish} /> : null}
        </Block>

        {/* ─── BACKUPS ON THE SERVICE ───────────────────────────────────── */}
        <Block name="backups" title="Backups on the service">
          <Field
            id="hub-registry-backup"
            label="Keep hub backups on the service"
            description="Point-in-time copies of the registry, so a lost machine can be restored to a moment. Its own decision, separate from publishing."
          >
            {(aria) => (
              <label className="flex min-h-8 items-center gap-2 text-[13px]">
                <input
                  {...aria}
                  type="checkbox"
                  role="switch"
                  data-hub-registry-backup-toggle
                  aria-checked={registry.backup}
                  checked={registry.backup}
                  disabled={blocks.backupConsent !== null || locked || state.busy !== null}
                  title={blocks.backupConsent ?? undefined}
                  onChange={(event) => actions.onBackupConsent(event.target.checked)}
                  className="accent-primary size-4"
                />
                <span>{state.busy === "backupConsent" ? "Asking the service…" : registry.backup ? "On" : "Off"}</span>
              </label>
            )}
          </Field>
          {state.backupWarning !== null ? <InlineError>{state.backupWarning}</InlineError> : null}
          <div className="flex flex-wrap items-center gap-2">
            {press("backups", state.backups === null ? "Show backups" : "Refresh", "Asking the service…", actions.onBackups)}
            {press("backupCreate", "Take a backup", "Backing up…", actions.onBackupCreate)}
          </div>
          <Blocked reason={beyondConnection(blocks.backups)} />
          {state.backups !== null && state.backups.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">The service holds no hub backups yet.</p>
          ) : null}
          {state.backups !== null && state.backups.length > 0 ? (
            <ul data-hub-registry-backups className="m-0 list-none space-y-1.5 p-0">
              {state.backups.map((backup) => (
                <li
                  key={backup.backupId}
                  data-hub-registry-backup={backup.backupId}
                  data-kind={backup.kind}
                  className="rounded-md border px-2 py-1.5"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-[12px]">{shortId(backup.backupId)}</span>
                    <span className="rounded border px-1 text-[10px] text-muted-foreground">
                      {backup.backupId === state.restored?.preRestoreBackupId ? "undo" : backup.kind}
                    </span>
                    <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{backupFacts(backup)}</span>
                    {state.restoring?.backupId === backup.backupId ? null : (
                      <Press
                        action="restore"
                        label="Restore…"
                        busyLabel="Restoring…"
                        state={state}
                        locked={locked}
                        blocked={blocks.restore}
                        onPress={() => actions.onAskRestore(backup)}
                      />
                    )}
                  </div>
                  {/*
                    THE RESTORE CONFIRMATION. The CLI's disclosure, from the server,
                    then a button whose label IS the enumeration — which backup,
                    which epoch, how many entities. The server compares those three
                    with its own list and restores nothing if they differ.
                  */}
                  {state.restoring?.backupId === backup.backupId && state.restoreNotice !== null ? (
                    <div data-hub-registry-restore-confirm className="mt-2 space-y-2 rounded-md border border-dashed px-2 py-2">
                      <p className="text-[12px] font-medium">{state.restoreNotice.headline}</p>
                      <ul className="list-disc space-y-0.5 pl-5 text-[12px] leading-relaxed text-muted-foreground">
                        {state.restoreNotice.bullets.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                      <p className="font-mono text-[11px] wrap-anywhere text-muted-foreground">{backup.backupId}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          data-hub-registry-restore-confirm-button
                          disabled={locked || state.busy !== null}
                          onClick={() => actions.onRestore(backup)}
                        >
                          {state.busy === "restore" ? "Restoring…" : restoreConfirmLabel(backup)}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" disabled={state.busy !== null} onClick={() => actions.onAskRestore(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {state.restored !== null ? (
            <div data-hub-registry-restored className="space-y-1 rounded-md border px-2 py-2">
              <p className="text-[12px] leading-relaxed">{restoreSummary(state.restored)}</p>
              {state.restored.preRestoreBackupId !== null ? (
                <p data-hub-registry-undo className="text-[11px] leading-relaxed wrap-anywhere text-muted-foreground">
                  Undo: restore {state.restored.preRestoreBackupId}, the copy taken just before. It is in the list above.
                </p>
              ) : null}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {state.adoption !== null && applyLabel(state.adoption.report) !== null
                  ? "This machine's hub is unchanged until you apply the adoption below. No workspace is removed from it either way."
                  : "No workspace is removed from this machine's list by a restore."}
              </p>
            </div>
          ) : null}
        </Block>

        {/* ─── ADOPT ────────────────────────────────────────────────────── */}
        <Block name="adopt" title="Adopt what the service holds">
          <div>{press("adopt", "Preview adoption", "Reading the service…", actions.onAdoptPreview)}</div>
          <Blocked reason={beyondConnection(blocks.adopt)} />
          {state.adoption !== null ? (
            <div data-hub-registry-adopt-preview className="space-y-2">
              <AdoptionView report={state.adoption.report} />
              <div className="flex flex-wrap items-center gap-2">
                {applyLabel(state.adoption.report) === null ? (
                  <p className="text-[12px] text-muted-foreground">Nothing to apply: this machine already has all it can take.</p>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    data-hub-registry-apply
                    disabled={locked || state.busy !== null}
                    onClick={actions.onApply}
                  >
                    {state.busy === "apply" ? "Applying…" : applyLabel(state.adoption.report)}
                  </Button>
                )}
                <Button type="button" size="sm" variant="ghost" disabled={state.busy !== null} onClick={actions.onDismissAdoption}>
                  Close
                </Button>
              </div>
            </div>
          ) : null}
          {state.applied !== null ? <AdoptionView report={state.applied} /> : null}
        </Block>
      </div>
    </Section>
  );
}

/**
 * The state and the calls. `onReport` hands each response's refreshed hub report
 * back to the section, so acting and re-reading are one round trip and the tiles
 * never describe the state before the thing just done.
 */
export function useHubRegistry(onReport: (report: HubCloudReport) => void): {
  state: HubRegistryState;
  actions: HubRegistryActions;
} {
  const [state, setState] = useState<HubRegistryState>(IDLE_REGISTRY);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const patch = useCallback((next: Partial<HubRegistryState>) => {
    if (alive.current) setState((current) => ({ ...current, ...next }));
  }, []);

  /** One press: busy while in flight, the server's refusal on failure, the report on success. */
  const run = useCallback(
    async (action: HubRegistryAction, work: () => Promise<void>) => {
      setState((current) => ({ ...current, busy: action, error: null }));
      try {
        await work();
      } catch (caught) {
        if (alive.current) setState((current) => ({ ...current, error: describeRefusal(caught).message }));
      } finally {
        if (alive.current) setState((current) => ({ ...current, busy: null }));
      }
    },
    [],
  );
  const report = useCallback(
    (answer: { report: HubCloudReport }) => {
      if (alive.current) onReport(answer.report);
    },
    [onReport],
  );

  const actions: HubRegistryActions = {
    onConsent: (enabled, disclosure) =>
      void run("consent", async () => {
        report(await setHubRegistryConsent(enabled, disclosure));
      }),
    onMint: () =>
      void run("mint", async () => {
        const answer = await mintHubIdentity();
        report(answer);
        patch({
          identity: {
            ...IDLE_REGISTRY.identity,
            outcome: { kind: answer.minted ? "minted" : "existing", hubId: answer.hubId, notice: null },
          },
        });
      }),
    onIdentityOpen: (open) =>
      setState((current) => ({
        ...current,
        // Opening the form clears the last outcome: a notice about the PREVIOUS
        // replacement left on screen under a new one reads as being about the new one.
        identity: open
          ? { ...current.identity, open, confirm: null, outcome: null }
          : { ...current.identity, open, confirm: null, draft: "" },
      })),
    onIdentityDraft: (value) =>
      setState((current) => ({ ...current, identity: { ...current.identity, draft: value } })),
    onIdentitySubmit: () => {
      const hubId = state.identity.draft.trim();
      void run("identity", async () => {
        const answer = await adoptHubIdentity(hubId);
        report(answer);
        if (answer.needsConfirm && answer.notice !== null) {
          patch({ identity: { ...state.identity, confirm: { hubId: answer.hubId, notice: answer.notice } } });
          return;
        }
        patch({
          identity: {
            ...IDLE_REGISTRY.identity,
            outcome: { kind: answer.adopted ? "adopted" : "unchanged", hubId: answer.hubId, notice: answer.notice },
          },
        });
      });
    },
    onIdentityConfirm: () => {
      const confirm = state.identity.confirm;
      if (confirm === null) return;
      void run("identity", async () => {
        const answer = await adoptHubIdentity(confirm.hubId, true);
        report(answer);
        patch({
          identity: {
            ...IDLE_REGISTRY.identity,
            outcome: { kind: answer.adopted ? "adopted" : "unchanged", hubId: answer.hubId, notice: answer.notice },
          },
        });
      });
    },
    onConnectDraft: (next) =>
      setState((current) => ({ ...current, connectDraft: { ...current.connectDraft, ...next } })),
    onConnectPreview: () => {
      const draft = state.connectDraft;
      void run("connect", async () => {
        const answer = await previewHubRegistryConnect({
          endpoint: draft.endpoint.trim(),
          label: draft.label.trim() || undefined,
          credentialFile: draft.credentialFile,
        });
        report(answer);
        patch({ connectPending: { preview: answer.preview, consent: answer.consent } });
      });
    },
    onConnectCancel: () => patch({ connectPending: null }),
    onConnect: () => {
      const pending = state.connectPending;
      const token = state.connectDraft.enrollment;
      if (pending === null) return;
      void run("connect", async () => {
        try {
          report(await connectHubRegistry({ consent: pending.consent, token }));
          // The secret has been spent; holding it in React state is a copy nobody needs.
          // The identity's last outcome goes too: "connect it below" is done.
          patch({ connectPending: null, connectDraft: EMPTY_DRAFT, identity: IDLE_REGISTRY.identity });
        } catch (caught) {
          // The ticket is spent whatever the refusal was, so back to the form.
          patch({ connectPending: null });
          throw caught;
        }
      });
    },
    onAskDisconnect: (asking) => patch({ disconnecting: asking }),
    onDisconnect: () =>
      void run("disconnect", async () => {
        report(await disconnectHubRegistry());
        patch({ ...IDLE_REGISTRY, identity: state.identity });
      }),
    onPublish: () =>
      void run("publish", async () => {
        const answer = await publishHubRegistry();
        report(answer);
        patch({ publish: answer.publish });
      }),
    onBackupConsent: (enabled) =>
      void run("backupConsent", async () => {
        const answer = await setHubBackupConsent(enabled);
        report(answer);
        patch({ backupWarning: answer.backup.warning, ...(enabled ? {} : { backups: null, restoring: null }) });
      }),
    onBackups: () =>
      void run("backups", async () => {
        const answer = await listHubBackups();
        report(answer);
        patch({ backups: answer.backups, restoreNotice: answer.restoreNotice });
      }),
    onBackupCreate: () =>
      void run("backupCreate", async () => {
        const answer = await createHubBackup();
        report(answer);
        patch({ backups: answer.backups, restoreNotice: answer.restoreNotice });
      }),
    onAskRestore: (backup) => patch({ restoring: backup }),
    onRestore: (backup) =>
      void run("restore", async () => {
        const answer = await restoreHubRegistry(backup);
        report(answer);
        patch({
          publish: null,
          restoring: null,
          restored: answer.restore,
          backups: answer.backups,
          adoption: { report: answer.restore.adoption, digest: answer.digest },
          applied: null,
        });
      }),
    onAdoptPreview: () =>
      void run("adopt", async () => {
        const answer = await adoptHubRegistry();
        report(answer);
        patch({ adoption: { report: answer.adoption, digest: answer.digest }, applied: null });
      }),
    onApply: () => {
      const adoption = state.adoption;
      if (adoption === null) return;
      void run("apply", async () => {
        const answer = await adoptHubRegistry(adoption.digest);
        report(answer);
        patch({ adoption: null, applied: answer.adoption, publish: null });
      });
    },
    onDismissAdoption: () => patch({ adoption: null }),
  };

  return { state, actions };
}
