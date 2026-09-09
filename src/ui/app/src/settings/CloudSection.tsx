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
  getCloudStatus,
  getCloudWorkspaces,
  listCloudDevices,
  previewCloudConnect,
  revokeCloudDevice,
  setCloudConsent,
} from "@/lib/api";
import { describeRefusal } from "@/lib/refusal";
import type {
  CloudSurfaceReport,
  ConnectPreview,
  ConsentTicket,
  HubCloudReport,
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
  hubListDescription,
  hubRowView,
  orderDevices,
  previewFacts,
  revokeWarning,
  type CloudFact,
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
              <Field
                id="cloud-endpoint"
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
                    onChange={(event) => props.onDraft({ endpoint: event.target.value })}
                  />
                )}
              </Field>
              <Field
                id="cloud-enrollment"
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
                    onChange={(event) => props.onDraft({ enrollment: event.target.value })}
                  />
                )}
              </Field>
              <Field
                id="cloud-label"
                label="Device label"
                description="Sent to the server so you can tell your machines apart. Defaults to this computer's hostname."
              >
                {(aria) => (
                  <Input
                    {...aria}
                    value={draft.label}
                    placeholder="this computer's hostname"
                    onChange={(event) => props.onDraft({ label: event.target.value })}
                  />
                )}
              </Field>
              <Field
                id="cloud-credential-file"
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
                      onChange={(event) => props.onDraft({ credentialFile: event.target.checked })}
                      className="accent-primary size-4"
                    />
                    <span>{draft.credentialFile ? "A 0600 file" : "This machine's keychain"}</span>
                  </label>
                )}
              </Field>
              {formProblem ? <InlineError>{formProblem}</InlineError> : null}
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
      <HubWorkspaceList report={props.workspaces} currentRepositoryId={report.repositoryId} />
    </div>
  );
}

/**
 * Every registered workspace, with its own state — S16 (STA-275).
 *
 * A LIST AND NOT A CONTROL, and that is a decision rather than an omission.
 * Connecting every workspace spends one enrollment secret against N services and
 * produces a per-workspace outcome — nine connected, two skipped, one refused —
 * which is a table this dialog has nowhere sensible to put and a consent this
 * page would have to re-implement the whole fan-out preview to ask for honestly.
 * So the description names the command instead. A button that showed less than
 * the CLI preview shows would be a worse consent, not a more convenient one.
 *
 * Renders nothing at all when there is one workspace or none: a "list" of one is
 * a heading and a row restating what the four sections above already said.
 */
function HubWorkspaceList({
  report,
  currentRepositoryId,
}: {
  report: HubCloudReport | null;
  currentRepositoryId: string | null;
}) {
  if (report === null || report.workspaces.length < 2) return null;
  const rows = report.workspaces.map((row) => hubRowView(row, { currentRepositoryId }));

  return (
    <Section title="Workspaces on this machine" description={hubListDescription(report.counts)}>
      <ul data-cloud-workspaces className="space-y-1">
        {rows.map((row) => (
          <li key={row.slug} data-cloud-workspace={row.slug} className="text-[12px]">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={row.current ? "font-semibold" : undefined}>{row.slug}</span>
              {row.current ? <span className="text-muted-foreground">(this one)</span> : null}
              <span className="text-muted-foreground">{row.state}</span>
              <span className="min-w-0 wrap-anywhere text-muted-foreground">{row.endpoint}</span>
              {row.marks.map((mark) => (
                <span key={mark} className="rounded border px-1 text-[11px] text-muted-foreground">
                  {mark}
                </span>
              ))}
            </div>
            {row.skipDetail ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">{row.skipDetail}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
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
