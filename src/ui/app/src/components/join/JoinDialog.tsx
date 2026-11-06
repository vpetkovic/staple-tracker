/**
 * JOINING A SHARED WORKSPACE FROM THE PAGE: consent preview → the code, large, with
 * a live wait → joined. The same protocol and the same sentences as `staple cloud join`.
 *
 * ## Nothing leaves the machine before "Request to join"
 *
 * Opening the dialog calls `previewJoin`, which the server answers from local files without a
 * request (`join-preview.ts` cannot reach the client) and with a consent ticket. "Request to
 * join" sends that ticket and nothing else, so this dialog cannot send a request to a service
 * it did not first show. The page never holds the request secret: the server keeps the join
 * in its own memory and the page holds an id for it.
 *
 * `JoinDialogView` is a pure function of a {@link JoinStage}, so every screen of the
 * storyboard (preview, waiting, joined, expired, denied, too many waiting) can be rendered
 * and asserted without a server. `JoinDialog` drives it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Check, Copy } from "lucide-react";
import { ApiError, cancelJoin, pollJoin, previewJoin, previewLinkJoin, startJoin, startLinkJoin } from "@/lib/api";
import { copyText } from "@/settings/InviteBox";
import type { CloudJoinPreview, CloudJoinPreviewResponse, CloudJoinStarted, ConsentTicket } from "@/lib/types";

/** Where a link join lands: the workspace it connects, and whether one is made for it. */
export interface JoinTargetView {
  name: string;
  created: boolean;
  fromCheckout: boolean;
}
import { countdown, joinPollDelay, serviceName } from "@/settings/members-settings";

export type JoinStage =
  | { stage: "loading" }
  | {
      stage: "preview";
      preview: CloudJoinPreview;
      consent: ConsentTicket;
      /** The device name as typed, starting from the preview's default label. */
      label: string;
      sending?: boolean;
      /** The preview was redrawn because more than the name changed. Said, so it is read again. */
      changed?: boolean;
      /** Joining from a link: the workspace it lands in. */
      target?: JoinTargetView;
    }
  | { stage: "waiting"; started: CloudJoinStarted & { workspace?: string }; transient?: boolean }
  | { stage: "joined"; name: string | null; endpoint: string; workspace?: string; auto?: boolean }
  | { stage: "denied"; code: string }
  | { stage: "expired"; code: string }
  | { stage: "too_many"; cap: number }
  | { stage: "error"; message: string };

export interface JoinDialogActions {
  onRequest: () => void;
  /** The Device field changed. Local: nothing is sent, and no preview is asked for, per keystroke. */
  onLabel: (label: string) => void;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
  /** After joining from a link: go to the workspace that was joined. */
  onOpenWorkspace?: () => void;
}

/** "VP invited you to join ai-inbox-supabase", for a preview that came from a link. */
export function invitationLine(preview: CloudJoinPreview): string | null {
  if (!preview.link) return null;
  return `${preview.link.sharedBy ?? "Someone"} invited you to join ${preview.link.name}`;
}

/** The code, copied, or shown selected where the clipboard cannot be reached. */
function CopyCode({ code }: { code: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "fallback">("idle");
  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-copy-code
        data-copied={result === "copied" ? "" : undefined}
        onClick={() => {
          const board = typeof navigator === "undefined" ? null : (navigator.clipboard ?? null);
          const secure = typeof window === "undefined" ? true : window.isSecureContext !== false;
          void copyText(code, board, secure).then(setResult);
        }}
      >
        {result === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        {result === "copied" ? "Copied" : "Copy code"}
      </Button>
      {result === "fallback" ? (
        <Input
          readOnly
          autoFocus
          value={code}
          aria-label="The join code, selected"
          data-copy-fallback
          onFocus={(event) => event.currentTarget.select()}
          className="w-40 text-center font-mono"
        />
      ) : null}
    </div>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-[13px]">
      <dt className="text-text-tertiary">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** The dialog's body for one stage. Pure: the storyboard's screens are its arguments. */
export function JoinDialogView({
  state,
  slug,
  now,
  actions,
}: {
  state: JoinStage;
  slug: string;
  now: number;
  actions: JoinDialogActions;
}) {
  switch (state.stage) {
    case "loading":
      return <p className="text-[13px] text-muted-foreground">Reading this workspace&apos;s sync settings…</p>;

    case "preview": {
      const { preview } = state;
      return (
        <div data-join-stage="preview" className="space-y-4">
          {state.changed ? (
            <p role="alert" data-join-preview-changed className="rounded-md border px-3 py-2 text-[13px]">
              This workspace&apos;s sync settings changed while the dialog was open. Read the details again before you
              request to join.
            </p>
          ) : null}
          {invitationLine(preview) ? (
            <p data-join-invitation className="text-[14px] font-medium">
              {invitationLine(preview)}
            </p>
          ) : null}
          <dl className="space-y-1.5 rounded-lg border bg-surface-sunken p-3">
            <Fact term={preview.link ? "Workspace" : "Repository"}>
              {preview.link?.name ?? slug}
              {preview.link?.prefix ? <span className="text-text-tertiary"> ({preview.link.prefix})</span> : null} ·{" "}
              <span className="font-mono">{preview.repositoryId.slice(0, 8)}</span>
              {state.target ? (
                <span data-join-target className="mt-1 block text-[12px] text-text-tertiary">
                  {state.target.fromCheckout
                    ? "Uses the workspace in this checkout."
                    : state.target.created
                      ? `A workspace named "${state.target.name}" is made on this computer, after you continue.`
                      : `Joins your workspace "${state.target.name}".`}
                </span>
              ) : null}
            </Fact>
            <Fact term="Service">
              {preview.endpoint}
              {preview.endpointSource === "manifest" ? (
                <span className="text-text-tertiary"> (from .staple/repository.json)</span>
              ) : null}
            </Fact>
            <Fact term="Device">
              <Input
                aria-label="Device name"
                data-join-label
                value={state.label}
                maxLength={120}
                onChange={(event) => actions.onLabel(event.target.value)}
                className="h-control-sm"
              />
              <span className="mt-1 block text-[12px] text-text-tertiary">
                Sent to the service and shown to the member who approves you.
              </span>
            </Fact>
            <Fact term="Auto sync">
              <span data-join-auto-sync>On (this is a shared workspace)</span>
            </Fact>
            <Fact term="Credential">
              {preview.credentialMechanism === "keychain"
                ? "macOS keychain"
                : preview.credentialMechanism === "secret-tool"
                  ? "the system secret service"
                  : "a 0600 file in your staple home"}
            </Fact>
          </dl>
          <p data-join-warning className="rounded-md border border-dashed px-3 py-2 text-[13px]">
            Not end-to-end encrypted. Whoever runs the service, and every member, can read synced tasks.
          </p>
          <p className="text-[12px] text-muted-foreground">
            Nothing is sent until you continue. Then a member approves this device by comparing a short code with you.
            Once you join, this device syncs automatically, like every device in a shared workspace.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={actions.onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={actions.onRequest}
              disabled={state.sending === true || state.label.trim().length === 0}
              data-join-request-button
            >
              {state.sending ? "Sending…" : "Request to join"}
            </Button>
          </div>
        </div>
      );
    }

    case "waiting":
      return (
        <div data-join-stage="waiting" className="space-y-4 text-center">
          <p className="text-[13px] text-muted-foreground">Read this code to a member of {slug}</p>
          <p data-join-code className="font-mono text-4xl font-semibold tracking-[0.2em] max-md:text-3xl">
            {state.started.code}
          </p>
          <CopyCode code={state.started.code} />
          <p className="text-[13px] text-muted-foreground" aria-live="polite">
            Waiting for approval · expires in {countdown(state.started.expiresAt, now)}
            {state.transient ? " · the service did not answer, still trying" : ""}
          </p>
          <p className="text-[12px] text-muted-foreground">
            The code only names your request. It is not a password, and nothing secret needs to be sent over chat.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={actions.onCancel} data-join-cancel>
            Cancel request
          </Button>
        </div>
      );

    case "joined":
      return (
        <div data-join-stage="joined" className="space-y-3">
          <p className="text-[13px]">
            Joined {slug}
            {state.name ? (
              <>
                {" "}
                as <span className="font-medium">{state.name}</span>
              </>
            ) : null}
            . This device has its own credential, stored on this computer.
          </p>
          <p className="text-[12px] text-muted-foreground" data-joined-auto={state.auto === false ? "off" : "on"}>
            {state.auto === false
              ? "Automatic sync is off on this device. Sync now to fill in the board."
              : "Automatic sync is on: this is a shared workspace, so it stays the same on every device."}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            {state.workspace && actions.onOpenWorkspace ? (
              <Button type="button" size="sm" onClick={actions.onOpenWorkspace} data-join-open-workspace>
                Open {state.workspace}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={actions.onClose}>
                Done
              </Button>
            )}
          </div>
        </div>
      );

    case "expired":
      return (
        <div data-join-stage="expired" className="space-y-3">
          <p className="text-[13px]">No one approved {state.code} within 10 minutes. Nothing was stored on this device.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={actions.onClose}>
              Close
            </Button>
            <Button type="button" size="sm" onClick={actions.onRetry}>
              Get a new code
            </Button>
          </div>
        </div>
      );

    case "denied":
      return (
        <div data-join-stage="denied" className="space-y-3">
          <p className="text-[13px]">
            A member declined request {state.code}. Nothing was sent to this device.
          </p>
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={actions.onClose}>
              Close
            </Button>
          </div>
        </div>
      );

    case "too_many":
      return (
        <div data-join-stage="too_many" className="space-y-3">
          <p className="text-[13px]">
            {slug} already has {state.cap} join requests waiting. Ask a member to clear them, or try again later.
          </p>
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={actions.onClose}>
              Close
            </Button>
          </div>
        </div>
      );

    case "error":
      return (
        <div data-join-stage="error" className="space-y-3">
          <p role="alert" className="text-[13px] text-[var(--status-task-icon-blocked)]">
            {state.message}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={actions.onClose}>
              Close
            </Button>
            <Button type="button" size="sm" onClick={actions.onRetry}>
              Start again
            </Button>
          </div>
        </div>
      );
  }
}

/** The title for each stage: the storyboard's headings. */
export function joinTitle(state: JoinStage, slug: string): string {
  switch (state.stage) {
    case "waiting":
      return "Waiting for approval";
    case "joined":
      return `Joined ${state.workspace ?? slug}`;
    case "expired":
      return "Code expired";
    case "denied":
      return "Request denied";
    case "too_many":
      return "Too many waiting";
    case "error":
      return "Could not join";
    case "preview":
      return `Join ${state.preview.link?.name ?? slug}`;
    default:
      return `Join ${slug}`;
  }
}

/**
 * "Request to join", given what the preview stage holds.
 *
 * The label is part of what the person consents to, so it is inside the consent ticket's
 * digest. When they changed it, the ticket on screen no longer describes the request. So the
 * label goes back through `previewJoin` first, the same way `staple cloud join --label` builds
 * its preview. `previewJoin` is answered by this computer from local files and contacts no
 * service, so nothing leaves the machine until `startJoin`.
 *
 * The fresh preview is read from files that may have changed since the screen was drawn (a
 * pull can rewrite `.staple/repository.json` to name another service). So it may only be
 * acted on unseen when the name is the ONLY difference. Anything else (the service, the
 * repository, the device, where the credential goes, a connection now on file) comes back as
 * `review`: the dialog shows the new preview and waits for a fresh "Request to join".
 */
export type RequestJoinOutcome =
  | { kind: "started"; started: CloudJoinStarted }
  | { kind: "review"; preview: CloudJoinPreview; consent: ConsentTicket };

/** Does `next` describe the same request as `shown`, apart from the device name? */
export function sameRequestApartFromLabel(shown: CloudJoinPreview, next: CloudJoinPreview): boolean {
  return (
    shown.endpoint === next.endpoint &&
    shown.repositoryId === next.repositoryId &&
    shown.deviceId === next.deviceId &&
    shown.credentialMechanism === next.credentialMechanism &&
    shown.credentialFallbackReason === next.credentialFallbackReason &&
    shown.alreadyConnected === next.alreadyConnected &&
    shown.existingEndpoint === next.existingEndpoint &&
    shown.endpointSource === next.endpointSource
  );
}

export async function requestJoin(
  input: { slug: string; preview: CloudJoinPreview; consent: ConsentTicket; label: string },
  api: {
    previewJoin: (target: { slug: string; label?: string }) => Promise<CloudJoinPreviewResponse>;
    startJoin: (target: { slug: string; consent: ConsentTicket }) => Promise<CloudJoinStarted>;
  },
): Promise<RequestJoinOutcome> {
  const label = input.label.trim();
  let consent = input.consent;
  if (label !== input.preview.label) {
    const fresh = await api.previewJoin({ slug: input.slug, label });
    if (!sameRequestApartFromLabel(input.preview, fresh.preview)) {
      return { kind: "review", preview: fresh.preview, consent: fresh.consent };
    }
    consent = fresh.consent;
  }
  return { kind: "started", started: await api.startJoin({ slug: input.slug, consent }) };
}

/** A refusal to START, as the stage that explains it. */
export function stageForStartFailure(error: unknown): JoinStage {
  if (error instanceof ApiError && error.code === "rate_limited" && error.detail?.["pendingCap"] !== undefined) {
    return { stage: "too_many", cap: Number(error.detail["pendingCap"]) };
  }
  return { stage: "error", message: error instanceof Error ? error.message : String(error) };
}

/**
 * The two ways a join is described to the server: a registered workspace (by slug), or a share
 * link. Both preview locally and start only on "Request to join"; a link also says where the
 * join lands, and that workspace is created only by the start.
 */
export function joinApi(slug: string, link: string | undefined): Parameters<typeof requestJoin>[1] & {
  preview: (label?: string) => Promise<{ preview: CloudJoinPreview; consent: ConsentTicket; target?: JoinTargetView }>;
} {
  if (link === undefined) {
    return {
      preview: (label) => previewJoin({ slug, ...(label ? { label } : {}) }),
      previewJoin,
      startJoin,
    };
  }
  return {
    preview: (label) => previewLinkJoin({ link, ...(label ? { label } : {}) }),
    previewJoin: (target) =>
      previewLinkJoin({ link, ...(target.label ? { label: target.label } : {}) }).then((answer) => ({
        slug: answer.target.name,
        preview: answer.preview,
        consent: answer.consent,
      })),
    startJoin: (target) => startLinkJoin({ link, consent: target.consent }),
  };
}

export function JoinDialog({
  open,
  slug,
  link,
  onClose,
  onJoined,
  onOpenWorkspace,
}: {
  open: boolean;
  slug: string;
  /** A share link: preview from it, and land in the workspace it names. */
  link?: string;
  onClose: () => void;
  onJoined: (result: { name: string | null; endpoint: string; workspace?: string; auto?: boolean }) => void;
  /** Go to the workspace a link join connected. Absent: the dialog offers Done instead. */
  onOpenWorkspace?: (workspace: string) => void;
}) {
  const api = joinApi(slug, link);
  const [state, setState] = useState<JoinStage>({ stage: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const live = useRef(true);
  const joinId = useRef<string | null>(null);
  /** The workspace a link join is landing in, from the start's answer. */
  const landed = useRef<string | null>(null);

  const preview = useCallback(() => {
    setState({ stage: "loading" });
    joinApi(slug, link)
      .preview()
      .then(
        (answer) =>
          live.current &&
          setState({
            stage: "preview",
            preview: answer.preview,
            consent: answer.consent,
            label: answer.preview.label,
            ...(answer.target ? { target: answer.target } : {}),
          }),
        (error: unknown) => live.current && setState({ stage: "error", message: error instanceof Error ? error.message : String(error) }),
      );
  }, [slug, link]);

  useEffect(() => {
    live.current = true;
    if (open) preview();
    return () => {
      live.current = false;
    };
  }, [open, preview]);

  // The countdown: once a second while waiting, and only then.
  useEffect(() => {
    if (state.stage !== "waiting") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.stage]);

  // The poll, backing off from two seconds to ten, while waiting.
  useEffect(() => {
    if (state.stage !== "waiting") return;
    const id = state.started.joinId;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = () => {
      timer = setTimeout(() => {
        pollJoin({ joinId: id }).then(
          (answer) => {
            if (stopped || !live.current) return;
            if (answer.status === "pending") {
              setState((current) => (current.stage === "waiting" ? { ...current, transient: answer.transient === true } : current));
              attempt += 1;
              tick();
              return;
            }
            joinId.current = null;
            if (answer.status === "joined") {
              const workspace = link === undefined ? undefined : landed.current ?? undefined;
              setState({ stage: "joined", name: answer.member?.name ?? null, endpoint: answer.endpoint, workspace, auto: answer.auto });
              onJoined({ name: answer.member?.name ?? null, endpoint: answer.endpoint, workspace, auto: answer.auto });
            } else if (answer.status === "denied" || answer.status === "expired") {
              setState({ stage: answer.status, code: answer.code });
            } else if (answer.status === "failed") {
              setState({ stage: "error", message: answer.message });
            }
          },
          (error: unknown) => {
            if (stopped || !live.current) return;
            joinId.current = null;
            setState({ stage: "error", message: error instanceof Error ? error.message : String(error) });
          },
        );
      }, joinPollDelay(attempt));
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // Keyed on the join, not on every state change: `transient` updates must not restart the backoff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.stage === "waiting" ? state.started.joinId : null]);

  const cancel = () => {
    const id = joinId.current;
    joinId.current = null;
    if (id) void cancelJoin({ joinId: id }).catch(() => undefined);
    onClose();
  };

  const actions: JoinDialogActions = {
    onRequest: () => {
      if (state.stage !== "preview") return;
      setState({ ...state, sending: true });
      requestJoin({ slug, preview: state.preview, consent: state.consent, label: state.label }, api).then(
        (outcome) => {
          if (!live.current) return;
          if (outcome.kind === "review") {
            // Something besides the name changed: show what a request would now do, and ask again.
            setState({
              stage: "preview",
              preview: outcome.preview,
              consent: outcome.consent,
              label: outcome.preview.label,
              changed: true,
            });
            return;
          }
          const { started } = outcome;
          joinId.current = started.joinId;
          landed.current = (started as { workspace?: string }).workspace ?? null;
          setNow(Date.now());
          setState({ stage: "waiting", started });
        },
        (error: unknown) => live.current && setState(stageForStartFailure(error)),
      );
    },
    onLabel: (label) => setState((current) => (current.stage === "preview" ? { ...current, label } : current)),
    onCancel: cancel,
    onRetry: preview,
    onClose: cancel,
    ...(onOpenWorkspace && state.stage === "joined" && state.workspace
      ? { onOpenWorkspace: () => onOpenWorkspace(state.workspace!) }
      : {}),
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : cancel())}>
      <DialogContent data-join-dialog className="w-[min(30rem,calc(100vw-2rem))]">
        <DialogTitle>{joinTitle(state, slug)}</DialogTitle>
        <DialogDescription className="sr-only">
          Join the shared workspace {slug} on {state.stage === "preview" ? serviceName(state.preview.endpoint) : "its sync service"}.
        </DialogDescription>
        <JoinDialogView state={state} slug={slug} now={now} actions={actions} />
      </DialogContent>
    </Dialog>
  );
}
