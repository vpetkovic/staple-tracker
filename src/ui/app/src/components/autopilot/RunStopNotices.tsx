/**
 * "Autopilot stopped" — a notice on every page when a run ends, naming why and the reference
 * that needs a person, with a link to it, Details, and a dismiss.
 *
 * The notices are DERIVED from the page's one `/api/runs` read (lib/run-stops.ts): the ended
 * runs this browser has not seen. So a notice appears within one refresh of the stop, a poll
 * that reads the same stop again adds nothing, and a reload shows it again until it is
 * dismissed or its link is followed. "Seen" is per run, in localStorage, and another tab's
 * dismissal is heard through the `storage` event.
 *
 *   ON A DESK   a stack in the bottom-right corner, at most three, above the detail drawer
 *               (z-50, modal): `pointer-events-auto` keeps it clickable while the drawer
 *               has made the rest of the page inert, so a stop is seen even mid-reading.
 *   ON A PHONE  in the flow above the run strip and the tab bar, so it never covers them.
 */
import { Bot, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { attentionLabel, loadStopSeen, pendingStopNotices, saveStopSeen, STOP_SEEN_KEY, type StopNotice, type StopSeen, withSeen } from "@/lib/run-stops";
import { useRuns } from "@/lib/runs";
import { isAllWorkspaces, useSession } from "@/lib/session";
import { openRunHistory } from "@/lib/shell-events";
import { cn } from "@/lib/utils";
import { RunStatePill } from "./RunParts";

/** How many notices show at once; the rest wait behind "and N more". */
export const NOTICE_LIMIT = 3;

const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

/** One notice. Pure: what it does is the caller's. */
export function RunStopNoticeCard({
  notice,
  showWorkspace = false,
  onOpenRef,
  onDetails,
  onDismiss,
}: {
  notice: StopNotice;
  showWorkspace?: boolean;
  onOpenRef: (notice: StopNotice) => void;
  onDetails: (notice: StopNotice) => void;
  onDismiss: (notice: StopNotice) => void;
}) {
  const label = `${notice.title}: ${notice.reason}`;
  return (
    <article
      data-run-stop-notice={notice.runId}
      aria-label={label}
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border bg-surface-raised px-3 py-2.5 text-body shadow-md"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Bot aria-hidden className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
        <p className="m-0 min-w-0 flex-1 font-medium text-foreground">
          <span className="wrap-anywhere">{notice.title}</span>
          {showWorkspace ? <span className="font-normal text-text-tertiary"> · {notice.workspace}</span> : null}
        </p>
        <button
          type="button"
          aria-label={`Dismiss: ${label}`}
          data-run-stop-dismiss={notice.runId}
          onClick={() => onDismiss(notice)}
          className="-mt-1 -mr-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-foreground focus-ring pointer-coarse:size-11"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div className="pl-6">
        <RunStatePill text={notice.reason} tone={notice.tone} className="whitespace-normal" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        {notice.attention ? (
          <button
            type="button"
            data-run-stop-open={notice.attention.ref}
            onClick={() => onOpenRef(notice)}
            className="inline-flex h-8 items-center rounded-md bg-primary px-2.5 text-label font-medium text-primary-foreground hover:bg-primary/90 focus-ring pointer-coarse:h-11"
          >
            {attentionLabel(notice.attention)}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onDetails(notice)}
          className="inline-flex h-8 items-center gap-0.5 rounded-md px-2 text-label text-text-secondary hover:bg-surface-hover hover:text-foreground focus-ring pointer-coarse:h-11"
        >
          Details
          <ChevronRight aria-hidden className="size-3.5" />
        </button>
      </div>
    </article>
  );
}

/** The stack, pure: the notices to show, the overflow, and the one dismiss-all. */
export function RunStopNoticeList({
  notices,
  placement,
  showWorkspace = false,
  onOpenRef,
  onDetails,
  onDismiss,
  onDismissAll,
}: {
  notices: readonly StopNotice[];
  placement: "corner" | "strip";
  showWorkspace?: boolean;
  onOpenRef: (notice: StopNotice) => void;
  onDetails: (notice: StopNotice) => void;
  onDismiss: (notice: StopNotice) => void;
  onDismissAll: () => void;
}) {
  // The live region is always in the DOM, so a notice added to it is announced.
  const shown = notices.slice(0, NOTICE_LIMIT);
  const more = notices.length - shown.length;
  return (
    <section
      aria-label="Autopilot notices"
      aria-live="polite"
      data-run-stop-notices={placement}
      // A press here is not a press "outside" the open detail drawer: without this the
      // drawer's dismiss-on-outside closes it and swallows the link's open.
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        notices.length === 0 && "hidden",
        placement === "corner"
          ? "pointer-events-auto fixed right-4 bottom-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
          : "flex shrink-0 flex-col gap-1.5 border-t bg-card px-2 py-2",
      )}
    >
      {shown.map((notice) => (
        <RunStopNoticeCard key={notice.key} notice={notice} showWorkspace={showWorkspace} onOpenRef={onOpenRef} onDetails={onDetails} onDismiss={onDismiss} />
      ))}
      {notices.length > 1 ? (
        <div className="flex items-center justify-end gap-2 text-label text-text-secondary">
          {more > 0 ? <span>and {more} more</span> : null}
          <button
            type="button"
            onClick={onDismissAll}
            className="inline-flex h-8 items-center rounded-md px-2 font-medium hover:bg-surface-hover hover:text-foreground focus-ring pointer-coarse:h-11"
          >
            Dismiss all
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** The notices, wired: `/api/runs` through `useRuns`, "seen" in localStorage. */
export function RunStopNotices({ placement }: { placement: "corner" | "strip" }) {
  const session = useSession();
  const { entries } = useRuns();
  const [seen, setSeen] = useState<StopSeen>(() => loadStopSeen(storage()));

  // Another tab dismissed one: take its list, so the two tabs agree.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STOP_SEEN_KEY) setSeen(loadStopSeen(storage()));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const notices = useMemo(() => pendingStopNotices(entries, seen), [entries, seen]);

  const markSeen = useCallback((keys: string[]) => {
    setSeen((current) => {
      const next = withSeen(current, keys);
      saveStopSeen(storage(), next);
      return next;
    });
  }, []);

  return (
    <RunStopNoticeList
      notices={notices}
      placement={placement}
      showWorkspace={isAllWorkspaces(session)}
      onOpenRef={(notice) => {
        markSeen([notice.key]);
        if (notice.attention) session.open(notice.workspace, notice.attention.ref);
      }}
      onDetails={(notice) => {
        markSeen([notice.key]);
        openRunHistory({ runId: notice.runId });
      }}
      onDismiss={(notice) => markSeen([notice.key])}
      onDismissAll={() => markSeen(notices.map((notice) => notice.key))}
    />
  );
}
