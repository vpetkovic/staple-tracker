/**
 * The approval toast: "thinkpad wants to join AII · code K7QX-29MB  [Later] [Review]".
 *
 * ## When the page asks, and when it does not
 *
 * Asking for pending requests is a request to the sync service, so the page makes it on its
 * own only when this device already agreed to background traffic for the workspace (automatic
 * sync is on) and only while the tab is visible, every 20 seconds (`mayPollJoinRequests`).
 * In manual mode the page asks nobody, and requests show when a person opens Settings →
 * Members or runs `staple cloud requests`.
 *
 * The count it hears also feeds the Settings badge (`lib/pending-requests.ts`).
 */
import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchJoinRequests, getMembersCache } from "@/lib/api";
import { setPendingJoinRequests } from "@/lib/pending-requests";
import { openSettings } from "@/lib/shell-events";
import type { CloudJoinRequest, CloudSurfaceReport } from "@/lib/types";
import { JOIN_REQUEST_POLL_MS, mayPollJoinRequests } from "@/settings/members-settings";

/** The newest request this page has not been told to put off. */
export function toastRequest(requests: readonly CloudJoinRequest[], dismissed: ReadonlySet<string>): CloudJoinRequest | null {
  const open = requests.filter((request) => !dismissed.has(request.code));
  return open.length === 0 ? null : open.reduce((a, b) => ((b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a));
}

export function JoinRequestToastView({
  request,
  slug,
  onLater,
  onReview,
}: {
  request: CloudJoinRequest;
  slug: string;
  onLater: () => void;
  onReview: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-join-toast={request.code}
      className="fixed right-4 bottom-4 z-50 w-[min(22rem,calc(100vw-2rem))] space-y-2 rounded-lg border bg-popover p-3 shadow-lg max-md:right-4 max-md:left-4 max-md:w-auto"
    >
      <div className="flex items-start gap-2">
        <UserPlus aria-hidden className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
        <div className="min-w-0 space-y-0.5">
          <p className="text-[13px] font-medium">Join request</p>
          <p className="text-[13px] text-muted-foreground">
            {request.label ?? "A device"} wants to join {slug} · code <span className="font-mono text-foreground">{request.code}</span>
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onLater}>
          Later
        </Button>
        <Button type="button" size="sm" onClick={onReview} data-join-toast-review>
          Review
        </Button>
      </div>
    </div>
  );
}

/** Why the watch stopped asking: no member list here, or the server held it to the consent. */
export type WatchStop = "no_members" | "auto_sync_off" | string;

/**
 * The toast's loop, without React, so its two refusals can be tested with a hand-turned clock.
 *
 * First a LOCAL read: does this machine hold a member list for the workspace? Without one the
 * workspace is not shared here, or the service does not support members, and the loop stops
 * before asking the service anything. A single-person workspace gains no traffic at all.
 *
 * Then it asks every `every` ms, marked as background, and the server refuses it unless
 * automatic sync is on for the workspace right now. That refusal ends the loop for good: the
 * page's copy of the consent was stale, and asking again would only be refused again.
 */
export function watchJoinRequests(deps: {
  every: number;
  hasMembers: () => Promise<boolean>;
  fetchRequests: () => Promise<{ requests: CloudJoinRequest[] }>;
  onRequests: (requests: CloudJoinRequest[]) => void;
  onStop: (reason: WatchStop) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  let stopped = false;
  let timer: unknown = null;
  const stop = (reason?: WatchStop) => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (reason !== undefined) deps.onStop(reason);
  };
  const ask = () =>
    deps.fetchRequests().then(
      (answer) => {
        if (!stopped) deps.onRequests(answer.requests);
      },
      (error: unknown) => {
        const reason = (error as { detail?: Record<string, unknown> } | null)?.detail?.["reason"];
        if (reason === "auto_sync_off" || reason === "no_members") stop(reason);
      },
    );
  deps.hasMembers().then(
    (has) => {
      if (stopped) return;
      if (!has) {
        stop("no_members");
        return;
      }
      void ask();
      if (!stopped) timer = setTimer(() => void ask(), deps.every);
    },
    () => stop("no_members"),
  );
  return () => stop();
}

/** Polls (only when allowed), shows the toast, and publishes the count for the badge. */
export function JoinRequestWatcher({ report, slug }: { report: CloudSurfaceReport | null; slug: string }) {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const [requests, setRequests] = useState<CloudJoinRequest[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const allowed = slug !== "" && mayPollJoinRequests(report, visible);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    setRequests([]);
    setDismissed(new Set());
  }, [slug]);

  useEffect(() => {
    if (!allowed) return;
    return watchJoinRequests({
      every: JOIN_REQUEST_POLL_MS,
      hasMembers: () => getMembersCache({ ws: slug }).then((cache) => cache !== null),
      fetchRequests: () => fetchJoinRequests({ slug, background: true }),
      onRequests: (next) => {
        setRequests(next);
        setPendingJoinRequests(next.length);
      },
      onStop: () => setRequests([]),
    });
  }, [allowed, slug]);

  const request = toastRequest(requests, dismissed);
  if (request === null) return null;
  return (
    <JoinRequestToastView
      request={request}
      slug={slug}
      onLater={() => setDismissed((current) => new Set(current).add(request.code))}
      onReview={() => {
        setDismissed((current) => new Set(current).add(request.code));
        openSettings({ section: "members", workspace: slug });
      }}
    />
  );
}
