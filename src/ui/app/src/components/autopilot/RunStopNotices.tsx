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
 * (the run by name, why it ended with the tickets it names as chips, the one thing to do,
 * "View run" to the run's page, dismiss); "N more" expands to three, and past three the history has
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
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { attentionIsOpen, attentionLabel, pendingStopNotices, stopKey, type StopNotice } from "@/lib/run-stops";
import { markStopsSeen, reconcileStopSeen, useStopSeen } from "@/lib/stop-seen-store";
import { useRuns } from "@/lib/runs";
import { isAllWorkspaces, useSession } from "@/lib/session";
import type { RunEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RefText } from "@/components/ticket/TicketChip";

/** How many notices show once expanded; the rest wait behind "and N more" (the history lists them all). */
export const NOTICE_LIMIT = 3;

export type NoticePlacement = "corner" | "strip" | "drawer";

/** The run a notice is about, when the page's read holds it: its name, and the issues its reason names. */
export type NoticeRun = Pick<RunEntry, "run" | "title" | "issues">;

/** "Autopilot stopped: Quick wins wave". Without the run, the notice's own title (it names the scope). */
export function noticeHeading(notice: Pick<StopNotice, "title">, run: Pick<NoticeRun, "run" | "title"> | null): string {
  return run ? `Autopilot ${run.run.state === "completed" ? "finished" : "stopped"}: ${run.title}` : notice.title;
}

/** One notice, compact. Pure: what it does is the caller's. */
export function RunStopNoticeCard({
  notice,
  run = null,
  raised = false,
  showWorkspace = false,
  more = 0,
  onMore,
  openRef = null,
  onOpenRef,
  onOpenTicket,
  onDetails,
  onDismiss,
}: {
  notice: StopNotice;
  /** The run itself, for its name and for the tickets its reason names. */
  run?: NoticeRun | null;
  /** The issue open in the detail, if any: a link to it is not offered (it is on screen). */
  openRef?: { workspace: string; ref: string } | null;
  /** Over the page (the desk's corner): a shadow separates it from what is under it. */
  raised?: boolean;
  showWorkspace?: boolean;
  /** Notices behind this one, offered as "N more" when `onMore` is given. */
  more?: number;
  onMore?: () => void;
  onOpenRef: (notice: StopNotice) => void;
  /** A ticket named inside the reason. */
  onOpenTicket?: (notice: StopNotice, ref: string) => void;
  onDetails: (notice: StopNotice) => void;
  onDismiss: (notice: StopNotice) => void;
}) {
  const label = `${notice.title}: ${notice.reason}${notice.note ? ` ("${notice.note}")` : ""}`;
  const link = notice.attention && !attentionIsOpen(notice, openRef) ? notice.attention : null;
  const heading = noticeHeading(notice, run);
  return (
    <article
      data-run-stop-notice={notice.runId}
      aria-label={label}
      className={cn("flex min-w-0 items-start gap-2.5 rounded-xl border bg-surface-raised py-2.5 pr-1.5 pl-3 text-body", raised && "shadow-md")}
    >
      {/* The tone as a dot; the reason beside it says it in words. */}
      <span aria-hidden data-run-state={notice.tone} className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: `var(--plain-${notice.tone}-fg)` }} />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <p className="m-0 max-w-full truncate font-semibold text-foreground" title={heading} data-run-stop-heading="">
          {heading}
        </p>
        <p className="m-0 max-w-full text-label text-text-secondary wrap-anywhere" data-run-stop-reason="">
          <RefText text={notice.reason} issues={run?.issues ?? []} onOpen={onOpenTicket ? (ref) => onOpenTicket(notice, ref) : undefined} />
          {showWorkspace ? <span className="text-text-tertiary"> · {notice.workspace}</span> : null}
        </p>
        {notice.note ? (
          <p data-run-stop-note="" className="m-0 line-clamp-2 max-w-full text-label text-text-secondary wrap-anywhere">
            &ldquo;{notice.note}&rdquo;
          </p>
        ) : null}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {link ? (
            <button
              type="button"
              data-run-stop-open={link.ref}
              onClick={() => onOpenRef(notice)}
              className="inline-flex h-7 shrink-0 items-center rounded-md bg-primary px-2.5 text-label font-medium text-primary-foreground hover:bg-primary/90 focus-ring pointer-coarse:h-11"
            >
              {attentionLabel(link)}
            </button>
          ) : null}
          <button
            type="button"
            data-run-stop-details={notice.runId}
            onClick={() => onDetails(notice)}
            title={`${notice.title}. Show the run`}
            className="inline-flex h-7 shrink-0 items-center rounded-md border border-border-strong bg-card px-2.5 text-label font-medium text-foreground hover:bg-surface-hover focus-ring pointer-coarse:h-11"
          >
            View run
          </button>
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
      </div>
      <button
        type="button"
        aria-label={`Dismiss: ${label}`}
        data-run-stop-dismiss={notice.runId}
        onClick={() => onDismiss(notice)}
        className="-mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-foreground focus-ring pointer-coarse:size-11"
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
  runOf,
  showWorkspace = false,
  initiallyExpanded = false,
  openRef = null,
  onOpenRef,
  onOpenTicket,
  onDetails,
  onDismiss,
  onDismissAll,
}: {
  notices: readonly StopNotice[];
  placement: NoticePlacement;
  /** The run behind a notice, by the notice's key; a notice without one keeps its own title. */
  runOf?: (notice: StopNotice) => NoticeRun | null;
  openRef?: { workspace: string; ref: string } | null;
  showWorkspace?: boolean;
  initiallyExpanded?: boolean;
  onOpenRef: (notice: StopNotice) => void;
  onOpenTicket?: (notice: StopNotice, ref: string) => void;
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
      run={runOf?.(notice) ?? null}
      raised={placement === "corner"}
      showWorkspace={showWorkspace}
      more={!open && index === 0 ? behind : 0}
      onMore={() => setExpanded(true)}
      openRef={openRef}
      onOpenRef={onOpenRef}
      onOpenTicket={onOpenTicket}
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
  const runs = useMemo(() => new Map(entries.map((entry) => [stopKey(entry), entry])), [entries]);

  return (
    <RunStopNoticeList
      notices={notices}
      placement={placement}
      runOf={(notice) => runs.get(notice.key) ?? null}
      showWorkspace={isAllWorkspaces(session)}
      openRef={session.selection}
      // A ticket named in the reason opens in the drawer; the notice stays until it is dismissed or its own action is taken.
      onOpenTicket={(notice, ref) => session.open(notice.workspace, ref)}
      onOpenRef={(notice) => {
        markStopsSeen([notice.key]);
        if (notice.attention) session.open(notice.workspace, notice.attention.ref);
      }}
      onDetails={(notice) => {
        markStopsSeen([notice.key]);
        session.openRun(notice.runId);
      }}
      onDismiss={(notice) => markStopsSeen([notice.key])}
      onDismissAll={() => markStopsSeen(notices.map((notice) => notice.key))}
    />
  );
}
