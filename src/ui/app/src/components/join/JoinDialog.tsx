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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ApiError, cancelJoin, pollJoin, previewJoin, startJoin } from "@/lib/api";
import type { CloudJoinPreview, CloudJoinStarted, ConsentTicket } from "@/lib/types";
import { countdown, joinPollDelay, serviceName } from "@/settings/members-settings";

export type JoinStage =
  | { stage: "loading" }
  | { stage: "preview"; preview: CloudJoinPreview; consent: ConsentTicket; sending?: boolean }
  | { stage: "waiting"; started: CloudJoinStarted; transient?: boolean }
  | { stage: "joined"; name: string | null; endpoint: string }
  | { stage: "denied"; code: string }
  | { stage: "expired"; code: string }
  | { stage: "too_many"; cap: number }
  | { stage: "error"; message: string };

export interface JoinDialogActions {
  onRequest: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
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
          <dl className="space-y-1.5 rounded-lg border bg-surface-sunken p-3">
            <Fact term="Repository">
              {slug} · <span className="font-mono">{preview.repositoryId.slice(0, 8)}</span>
            </Fact>
            <Fact term="Service">
              {preview.endpoint}
              {preview.endpointSource === "manifest" ? (
                <span className="text-text-tertiary"> (from .staple/repository.json)</span>
              ) : null}
            </Fact>
            <Fact term="Device">{preview.label}</Fact>
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
            Automatic sync stays off.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={actions.onClose}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={actions.onRequest} disabled={state.sending === true} data-join-request-button>
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
          <p className="text-[12px] text-muted-foreground">
            Automatic sync is off. Sync now to fill in the board, and turn automatic sync on if you want it.
          </p>
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={actions.onClose}>
              Done
            </Button>
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
      return `Joined ${slug}`;
    case "expired":
      return "Code expired";
    case "denied":
      return "Request denied";
    case "too_many":
      return "Too many waiting";
    case "error":
      return "Could not join";
    default:
      return `Join ${slug}`;
  }
}

/** A refusal to START, as the stage that explains it. */
export function stageForStartFailure(error: unknown): JoinStage {
  if (error instanceof ApiError && error.code === "rate_limited" && error.detail?.["pendingCap"] !== undefined) {
    return { stage: "too_many", cap: Number(error.detail["pendingCap"]) };
  }
  return { stage: "error", message: error instanceof Error ? error.message : String(error) };
}

export function JoinDialog({
  open,
  slug,
  onClose,
  onJoined,
}: {
  open: boolean;
  slug: string;
  onClose: () => void;
  onJoined: (result: { name: string | null; endpoint: string }) => void;
}) {
  const [state, setState] = useState<JoinStage>({ stage: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const live = useRef(true);
  const joinId = useRef<string | null>(null);

  const preview = useCallback(() => {
    setState({ stage: "loading" });
    previewJoin({ slug }).then(
      (answer) => live.current && setState({ stage: "preview", preview: answer.preview, consent: answer.consent }),
      (error: unknown) => live.current && setState({ stage: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  }, [slug]);

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
              setState({ stage: "joined", name: answer.member?.name ?? null, endpoint: answer.endpoint });
              onJoined({ name: answer.member?.name ?? null, endpoint: answer.endpoint });
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
      startJoin({ slug, consent: state.consent }).then(
        (started) => {
          if (!live.current) return;
          joinId.current = started.joinId;
          setNow(Date.now());
          setState({ stage: "waiting", started });
        },
        (error: unknown) => live.current && setState(stageForStartFailure(error)),
      );
    },
    onCancel: cancel,
    onRetry: preview,
    onClose: cancel,
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
