/**
 * "Autopilot stopped" — a notice on every page when a run ends, naming why and the reference
 * that needs a person, with a link to it, the run's details, and a dismiss.
 *
 * The notices are DERIVED from the page's one `/api/runs` read (lib/run-stops.ts): the ended
 * runs this browser has not seen. So a notice appears within one refresh of the stop, a poll
 * that reads the same stop again adds nothing, and a reload shows it again until it is
 * dismissed or its link is followed. "Seen" is one list per tab (lib/stop-seen-store.ts),
 * kept in localStorage and shared with Stop, which marks the run it stopped.
 *
 * ONE COMPACT CARD, WHEREVER IT IS. Each place shows the newest notice only, as one card
 * (title, reason, link, dismiss); "N more" expands to three, and past three the history has
 * them all. A stack of full cards took 493px of an 844px phone.
 *
 *   ON A DESK   the bottom-right corner, over the page.
 *   ON A PHONE  in the flow above the run strip and the tab bar, so it never covers them.
 *   IN THE DETAIL  while a task is open the shell's notices step aside and the drawer (or the
 *               phone's sheet) shows them in its own flow, as its last row. The drawer is
 *               modal: it traps focus and makes the page inert, so a notice outside it could
 *               neither be tabbed to nor sit anywhere but over the drawer's own content.
 *               Inside it, it covers nothing and is one Tab away.
 *
 * The live region is always rendered, empty and unpadded when there is nothing to say, so
 * the first notice is announced; the padded, bordered box exists only around notices.
 */
import { Bot, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { attentionIsOpen, attentionLabel, pendingStopNotices, type StopNotice } from "@/lib/run-stops";
import { markStopsSeen, reconcileStopSeen, useStopSeen } from "@/lib/stop-seen-store";
import { useRuns } from "@/lib/runs";
import { isAllWorkspaces, useSession } from "@/lib/session";
import { openRunHistory } from "@/lib/shell-events";
import { cn } from "@/lib/utils";
import { RunStatePill } from "./RunParts";

/** How many notices show once expanded; the rest wait behind "and N more" (the history lists them all). */
export const NOTICE_LIMIT = 3;

export type NoticePlacement = "corner" | "strip" | "drawer";

/** One notice, compact. Pure: what it does is the caller's. */
export function RunStopNoticeCard({
  notice,
  raised = false,
  showWorkspace = false,
  more = 0,
  onMore,
  openRef = null,
  onOpenRef,
  onDetails,
  onDismiss,
}: {
  notice: StopNotice;
  /** The issue open in the detail, if any: a link to it is not offered (it is on screen). */
  openRef?: { workspace: string; ref: string } | null;
  /** Over the page (the desk's corner): a shadow separates it from what is under it. */
  raised?: boolean;
  showWorkspace?: boolean;
  /** Notices behind this one, offered as "N more" when `onMore` is given. */
  more?: number;
  onMore?: () => void;
  onOpenRef: (notice: StopNotice) => void;
  onDetails: (notice: StopNotice) => void;
  onDismiss: (notice: StopNotice) => void;
}) {
  const label = `${notice.title}: ${notice.reason}${notice.note ? ` ("${notice.note}")` : ""}`;
  const link = notice.attention && !attentionIsOpen(notice, openRef) ? notice.attention : null;
  return (
    <article
      data-run-stop-notice={notice.runId}
      aria-label={label}
      className={cn("flex min-w-0 items-start gap-2 rounded-lg border bg-surface-raised py-1.5 pr-1 pl-2.5 text-body", raised && "shadow-md")}
    >
      <Bot aria-hidden className="mt-2 size-4 shrink-0 text-text-tertiary" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1 py-1">
        {/* The title is the way to the run's details. */}
        <button
          type="button"
          data-run-stop-details={notice.runId}
          onClick={() => onDetails(notice)}
          title={`${notice.title}. Show the run`}
          className="max-w-full truncate rounded-sm text-left font-medium text-foreground hover:underline focus-ring"
        >
          {notice.short}
          {showWorkspace ? <span className="font-normal text-text-tertiary"> · {notice.workspace}</span> : null}
        </button>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <RunStatePill text={notice.reason} tone={notice.tone} wrap />
          {onMore && more > 0 ? (
            <button
              type="button"
              data-run-stop-more={more}
              onClick={onMore}
              className="rounded-sm text-label font-medium text-text-secondary underline underline-offset-2 hover:text-foreground focus-ring pointer-coarse:min-h-11"
            >
              {more} more
            </button>
          ) : null}
        </div>
        {notice.note ? (
          <p data-run-stop-note="" className="m-0 line-clamp-2 max-w-full text-label text-text-secondary wrap-anywhere">
            &ldquo;{notice.note}&rdquo;
          </p>
        ) : null}
      </div>
      {link ? (
        <button
          type="button"
          data-run-stop-open={link.ref}
          onClick={() => onOpenRef(notice)}
          className="mt-0.5 inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-2.5 text-label font-medium text-primary-foreground hover:bg-primary/90 focus-ring pointer-coarse:h-11"
        >
          {attentionLabel(link)}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Dismiss: ${label}`}
        data-run-stop-dismiss={notice.runId}
        onClick={() => onDismiss(notice)}
        className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-foreground focus-ring pointer-coarse:size-11"
      >
        <X aria-hidden className="size-4" />
      </button>
    </article>
  );
}

const REGION: Record<NoticePlacement, string | undefined> = {
  // Over the page; `pointer-events-auto` keeps it clickable under another layer's inert page.
  corner: "pointer-events-auto fixed right-4 bottom-4 z-[60] w-[26rem] max-w-[calc(100vw-2rem)]",
  strip: undefined,
  drawer: "shrink-0",
};

const BOX: Record<NoticePlacement, string> = {
  corner: "flex flex-col gap-2",
  strip: "flex flex-col gap-1.5 border-t bg-card px-2 py-1.5",
  drawer: "flex flex-col gap-1.5 border-t bg-card px-3 py-2",
};

/** The notices, pure: the newest one, or up to three once expanded, and the one dismiss-all. */
export function RunStopNoticeList({
  notices,
  placement,
  showWorkspace = false,
  initiallyExpanded = false,
  openRef = null,
  onOpenRef,
  onDetails,
  onDismiss,
  onDismissAll,
}: {
  notices: readonly StopNotice[];
  placement: NoticePlacement;
  openRef?: { workspace: string; ref: string } | null;
  showWorkspace?: boolean;
  initiallyExpanded?: boolean;
  onOpenRef: (notice: StopNotice) => void;
  onDetails: (notice: StopNotice) => void;
  onDismiss: (notice: StopNotice) => void;
  onDismissAll: () => void;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const open = expanded && notices.length > 1;
  const shown = notices.slice(0, open ? NOTICE_LIMIT : 1);
  const behind = notices.length - shown.length;
  const card = (notice: StopNotice, index: number) => (
    <RunStopNoticeCard
      key={notice.key}
      notice={notice}
      raised={placement === "corner"}
      showWorkspace={showWorkspace}
      more={!open && index === 0 ? behind : 0}
      onMore={() => setExpanded(true)}
      openRef={openRef}
      onOpenRef={onOpenRef}
      onDetails={onDetails}
      onDismiss={onDismiss}
    />
  );
  return (
    <section
      aria-label="Autopilot notices"
      aria-live="polite"
      data-run-stop-notices={placement}
      // A press here is not a press "outside" an open dialog: without this a dialog's
      // dismiss-on-outside would close it and swallow the link's open.
      onPointerDown={(event) => event.stopPropagation()}
      className={REGION[placement]}
    >
      {notices.length > 0 ? (
        <div className={BOX[placement]} data-run-stop-box="">
          {shown.map(card)}
          {open ? (
            <div className="flex items-center justify-end gap-2 text-label text-text-secondary">
              {behind > 0 ? (
                <button type="button" onClick={() => onDetails(notices[NOTICE_LIMIT]!)} className="rounded-sm underline underline-offset-2 hover:text-foreground focus-ring pointer-coarse:min-h-11">
                  and {behind} more
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="inline-flex h-8 items-center rounded-md px-2 font-medium hover:bg-surface-hover hover:text-foreground focus-ring pointer-coarse:h-11"
              >
                Show fewer
              </button>
              <button
                type="button"
                onClick={onDismissAll}
                className="inline-flex h-8 items-center rounded-md px-2 font-medium hover:bg-surface-hover hover:text-foreground focus-ring pointer-coarse:h-11"
              >
                Dismiss all
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The notices, wired: `/api/runs` through `useRuns`, "seen" through the tab's store. The
 * shell's pair steps aside (an empty live region) while a task's detail is open, and the
 * detail's own takes over. The shell's also keeps the list in step with the server: it starts
 * the count on the server's clock and drops the keys of runs no longer served.
 */
export function RunStopNotices({ placement }: { placement: NoticePlacement }) {
  const session = useSession();
  const { entries, now } = useRuns();
  const seen = useStopSeen();
  const inShell = placement !== "drawer";

  useEffect(() => {
    if (inShell) reconcileStopSeen(entries, now);
  }, [inShell, entries, now]);

  const pending = useMemo(() => pendingStopNotices(entries, seen), [entries, seen]);
  const notices = inShell && session.selection !== null ? [] : pending;

  return (
    <RunStopNoticeList
      notices={notices}
      placement={placement}
      showWorkspace={isAllWorkspaces(session)}
      openRef={session.selection}
      onOpenRef={(notice) => {
        markStopsSeen([notice.key]);
        if (notice.attention) session.open(notice.workspace, notice.attention.ref);
      }}
      onDetails={(notice) => {
        markStopsSeen([notice.key]);
        openRunHistory({ runId: notice.runId });
      }}
      onDismiss={(notice) => markStopsSeen([notice.key])}
      onDismissAll={() => markStopsSeen(notices.map((notice) => notice.key))}
    />
  );
}
