/**
 * "Join the shared workspace": the card on the empty task list and under Settings →
 * Cloud account, and the one-time banner after joining that offers automatic sync.
 *
 * The card shows only when the committed `.staple/repository.json` names a sync service
 * (`staple cloud share-endpoint`) and this computer is not connected to it. Deciding that is a
 * local read (`getJoinOffer`), so a page that shows nothing has asked nobody anything.
 *
 * After joining, nothing syncs by itself: the banner offers "Sync now" (one sync, the person's
 * press) and "Turn on" (the automatic-sync consent), and dismissing it leaves both off.
 */
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getJoinOffer, setWorkspaceConsent, syncWorkspace } from "@/lib/api";
import type { CloudJoinOffer } from "@/lib/types";
import { cn } from "@/lib/utils";
import { serviceName } from "@/settings/members-settings";
import { JoinDialog } from "./JoinDialog";

/** Should the card show? An endpoint to join through, and no connection here yet. */
export function offersJoin(offer: CloudJoinOffer | null): boolean {
  return offer !== null && offer.endpoint !== null && !offer.connected;
}

export interface JoinedInfo {
  name: string | null;
  /** What the banner's buttons have done so far. */
  synced: "no" | "syncing" | "yes" | string;
  auto: "off" | "turning" | "on";
}

export function JoinOfferView({
  offer,
  joined,
  className,
  onJoin,
  onSync,
  onAuto,
  onDismiss,
}: {
  offer: CloudJoinOffer | null;
  joined: JoinedInfo | null;
  className?: string;
  onJoin: () => void;
  onSync: () => void;
  onAuto: () => void;
  onDismiss: () => void;
}) {
  if (joined) {
    return (
      <div role="status" data-joined-banner className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-surface-raised px-3 py-2 text-[13px]", className)}>
        <span>
          Joined {offer?.slug ?? "this workspace"}
          {joined.name ? (
            <>
              {" "}
              as <span className="font-medium">{joined.name}</span>
            </>
          ) : null}
          .{" "}
          {joined.auto === "on" ? "Automatic sync is on for this device." : "Automatic sync is off."}
          {joined.synced === "yes" ? " Synced." : joined.synced !== "no" && joined.synced !== "syncing" ? ` ${joined.synced}` : ""}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          {joined.synced !== "yes" ? (
            <Button type="button" variant="outline" size="sm" disabled={joined.synced === "syncing"} onClick={onSync} data-joined-sync>
              {joined.synced === "syncing" ? "Syncing…" : "Sync now"}
            </Button>
          ) : null}
          {joined.auto !== "on" ? (
            <Button type="button" size="sm" disabled={joined.auto === "turning"} onClick={onAuto} data-joined-auto>
              Turn on auto sync
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </span>
      </div>
    );
  }
  if (!offersJoin(offer)) return null;
  return (
    <div data-join-offer className={cn("space-y-3 rounded-lg border bg-surface-raised p-4", className)}>
      <div className="flex items-start gap-3">
        <Users aria-hidden className="mt-0.5 size-5 shrink-0 text-text-tertiary" />
        <div className="space-y-1">
          <p className="text-[13px] font-medium">This repository already has a shared tracker</p>
          <p className="text-[13px] text-muted-foreground">
            It syncs through <span className="font-medium text-foreground">{serviceName(offer!.endpoint!)}</span>. Join it to see
            the shared tasks here. A member approves your device; nothing is sent until you agree.
          </p>
          {offer!.removedBy ? (
            <p className="text-[12px] text-muted-foreground">{offer!.removedBy} removed you earlier. Ask to rejoin with a new request.</p>
          ) : null}
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={onJoin} data-join-open>
          Join the shared workspace
        </Button>
      </div>
    </div>
  );
}

/** The card, its dialog and the joined banner, for one workspace. */
export function JoinOfferCard({ ws, className, onSynced }: { ws: string; className?: string; onSynced?: () => void }) {
  const [offer, setOffer] = useState<CloudJoinOffer | null>(null);
  const [open, setOpen] = useState(false);
  const [joined, setJoined] = useState<JoinedInfo | null>(null);

  useEffect(() => {
    let live = true;
    setOffer(null);
    getJoinOffer({ ws }).then(
      (answer) => live && setOffer(answer),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [ws]);

  return (
    <>
      <JoinOfferView
        offer={offer}
        joined={joined}
        className={className}
        onJoin={() => setOpen(true)}
        onSync={() => {
          setJoined((current) => (current ? { ...current, synced: "syncing" } : current));
          syncWorkspace({ slug: ws }).then(
            (answer) => {
              const failed = answer.outcome?.status === "failed";
              setJoined((current) => (current ? { ...current, synced: failed ? answer.outcome.detail : "yes" } : current));
              if (!failed) onSynced?.();
            },
            (error: unknown) =>
              setJoined((current) => (current ? { ...current, synced: error instanceof Error ? error.message : String(error) } : current)),
          );
        }}
        onAuto={() => {
          setJoined((current) => (current ? { ...current, auto: "turning" } : current));
          setWorkspaceConsent({ slug: ws, consent: "auto", value: true }).then(
            () => setJoined((current) => (current ? { ...current, auto: "on" } : current)),
            () => setJoined((current) => (current ? { ...current, auto: "off" } : current)),
          );
        }}
        onDismiss={() => setJoined(null)}
      />
      {open ? (
        <JoinDialog
          open={open}
          slug={ws}
          onClose={() => setOpen(false)}
          onJoined={(result) => {
            setOffer((current) => (current ? { ...current, connected: true, removedBy: null } : current));
            // A join ends in a shared workspace, which syncs automatically; the result says so.
            setJoined({ name: result.name, synced: "no", auto: result.auto ? "on" : "off" });
          }}
        />
      ) : null}
    </>
  );
}
