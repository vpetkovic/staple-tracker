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
import { fetchJoinRequests } from "@/lib/api";
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
    let live = true;
    const ask = () =>
      fetchJoinRequests({ slug }).then(
        (answer) => {
          if (!live) return;
          setRequests(answer.requests);
          setPendingJoinRequests(answer.requests.length);
        },
        () => undefined,
      );
    void ask();
    const timer = setInterval(() => void ask(), JOIN_REQUEST_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
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
