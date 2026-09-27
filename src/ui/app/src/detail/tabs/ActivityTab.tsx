/**
 * Activity — the whole history of one issue in one column.
 *
 * Comments were always here. The other half — status transitions, claims and releases,
 * blocker wakes, subtree completions, document revisions — lived in the event log and
 * the revision table, where nobody looked. Merging them is the point: "the plan was
 * rewritten" and "and then it went back to todo" only mean something next to each
 * other, in order.
 *
 * The merge and the day grouping are in ../timeline.ts and are pure. This file fetches,
 * renders, and keeps the composer at the bottom, where a thread that reads downward
 * puts it.
 *
 * ── How it reads ─────────────────────────────────────────────────────────────────────
 *
 * A timeline, cut into days (Today / Yesterday / a date). Two kinds of row, and they are
 * meant to look different at a glance:
 *
 *   comment   a card: the person, when, and the words at reading size.
 *   event     one quiet line on the rail: an icon, the person, what happened in plain
 *             words ("moved to In progress"), and when.
 *
 * Times are relative inside today ("12 min ago") and a clock time on older days, where
 * the day heading already says the date. The exact instant is always in the tooltip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CirclePlus,
  CircleStop,
  Clock,
  ListOrdered,
  ShieldCheck,
  Timer,
  Diamond,
  FileText,
  Link2,
  ListChecks,
  MessageSquare,
  Play,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { action, ApiError, getEvents, getRevisions } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { statusLabel } from "@/lib/settings";
import { WORKLOG_KEY, type DocumentRevision } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { EmptyState, PersonChip, PersonDisc, RelativeTime, actorLabel, cn, formatExact, useNow } from "../parts";
import { Dot } from "./Dot";
import { buildTimeline, groupByDay, type TimelineEntry } from "../timeline";
import type { TabProps } from "./registry";
import "./tabs.css";

/** `authorType` on a comment, or a guess from the handle for an event actor. */
function personKind(entry: TimelineEntry): "agent" | "human" {
  if (entry.authorType) return entry.authorType === "agent" ? "agent" : "human";
  return entry.actor && /[-_]/.test(entry.actor) ? "agent" : "human";
}

/** 3:04 PM, in the viewer's zone. */
const clock = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));

function When({ iso, today, now }: { iso: string; today: boolean; now: Date }) {
  // Mid-line, after "moved to Backlog ·": "just now", not "Just now".
  if (today) return <RelativeTime iso={iso} now={now} inSentence className="text-text-tertiary" />;
  return (
    <time dateTime={iso} title={formatExact(iso) ?? undefined} className="whitespace-nowrap text-text-tertiary">
      {clock(iso)}
    </time>
  );
}

const EVENT_ICON: Record<string, LucideIcon> = {
  "created this task": CirclePlus,
  "started working on it": Play,
  "stopped working on it": CircleStop,
};

/** The small glyph an event sits on. Status rows borrow the status glyph the list uses. */
function RailIcon({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === "status" && entry.status) {
    return <StatusIcon status={entry.status} className="size-3.5" />;
  }
  const Icon =
    entry.kind === "checkpoint"
      ? Diamond
      : entry.kind === "revision"
        ? FileText
        : entry.kind === "blocker"
          ? entry.summary.startsWith("all sub-tasks")
            ? ListChecks
            : Link2
          : (EVENT_ICON[entry.summary] ??
            (entry.summary.includes("estimate")
              ? Clock
              : entry.summary.includes("work session")
                ? Timer
                : entry.summary.includes("review")
                  ? ShieldCheck
                  : entry.summary.includes("queue")
                    ? ListOrdered
                    : Sparkles));
  return <Icon aria-hidden className={cn("size-3.5", entry.kind === "checkpoint" ? "text-foreground" : "text-text-tertiary")} />;
}

/** What happened, in words. A status row names the workspace's own label for the status. */
function Sentence({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === "status" && entry.status) {
    return (
      <span title={entry.from ? `from ${statusLabel(entry.from)}` : undefined}>
        moved to <span className="font-medium text-foreground">{statusLabel(entry.status)}</span>
      </span>
    );
  }
  if (entry.kind === "checkpoint") {
    return <span className="text-foreground">saved a checkpoint</span>;
  }
  if (entry.kind === "revision" && entry.document) {
    return (
      <span>
        updated <span className="text-foreground">{entry.document.key}</span>
      </span>
    );
  }
  return <span>{entry.summary}</span>;
}

/** A system event: one quiet line on the rail. */
function EventRow({ entry, today, now }: { entry: TimelineEntry; today: boolean; now: Date }) {
  // Revision and checkpoint rows carry the author's own words about the change; the
  // sentence above already says "updated plan", so the words go underneath, quoted.
  const note =
    (entry.kind === "revision" || entry.kind === "checkpoint") && entry.document
      ? entry.summary.replace(/^checkpoint · /, "")
      : null;
  const noteIsFallback = note !== null && entry.document && note === `wrote ${entry.document.key}`;
  return (
    <li data-timeline-kind={entry.kind} className="activity-item relative flex gap-3 py-1.5">
      <span className="activity-node" data-status={entry.status}>
        <RailIcon entry={entry} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        {/* Inline text, not a flex row: a long sentence wraps like a sentence, under the
            name, instead of dropping to a line of its own. */}
        <p className="text-body text-text-secondary [overflow-wrap:anywhere]">
          {entry.actor ? (
            <PersonChip name={entry.actor} kind={personKind(entry)} className="mr-1.5 max-w-full" />
          ) : (
            <span className="mr-1.5 font-medium text-foreground">Staple</span>
          )}
          <Sentence entry={entry} />
          {entry.chips?.length && entry.kind === "blocker"
            ? entry.chips.map((chip) => (
                <span key={chip} className="ml-1.5 inline-block rounded-md bg-surface-sunken px-1.5 text-label text-text-secondary">
                  {chip}
                </span>
              ))
            : null}
          <Dot />
          <When iso={entry.at} today={today} now={now} />
        </p>
        {note && !noteIsFallback ? (
          <p
            className={cn(
              "mt-1 text-body text-pretty",
              entry.kind === "checkpoint"
                ? "rounded-lg border-l-2 border-foreground/40 bg-surface-sunken px-3 py-1.5 text-foreground"
                : "text-text-secondary",
            )}
          >
            {note}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** A comment: a readable card with the person and the time on top. */
function CommentRow({ entry, today, now }: { entry: TimelineEntry; today: boolean; now: Date }) {
  const kind = personKind(entry);
  return (
    <li data-timeline-kind="comment" className="activity-item relative flex gap-3 py-2">
      <span className="activity-node activity-node--person">
        <PersonDisc name={entry.actor ?? "?"} kind={kind} size="md" />
      </span>
      <article className="min-w-0 flex-1 rounded-xl border border-border bg-surface-raised">
        <header className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-3.5 pt-2.5 text-body">
          <span className="min-w-0 truncate font-medium text-foreground">{actorLabel(entry.actor)}</span>
          {kind === "agent" ? (
            <span className="rounded-md bg-surface-sunken px-1.5 text-caption text-text-secondary">agent</span>
          ) : null}
          <span className="text-text-tertiary">commented</span>
          <Dot />
          <When iso={entry.at} today={today} now={now} />
        </header>
        {entry.body ? (
          <Markdown text={entry.body} className="activity-comment-body px-3.5 pt-1 pb-3 text-reading [overflow-wrap:anywhere]" />
        ) : null}
      </article>
    </li>
  );
}

export function ActivityTab({ detail, workspace, onAuthError, refresh }: TabProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>("");
  const [sending, setSending] = useState(false);
  const ref = detail.issue.identifier;
  const now = useNow();
  const composer = useRef<HTMLDivElement>(null);

  /**
   * Keep the comment box in sight while a phone keyboard is up. The keyboard shrinks the
   * viewport AFTER the browser has scrolled the focused box into view, so the detail's
   * scroller gets shorter and the box ends up under its bottom edge (just above the action
   * bar). When the viewport resizes while the box has focus, bring it back into view.
   */
  useEffect(() => {
    const keepInView = () => {
      const box = composer.current;
      if (box && box.contains(document.activeElement)) box.scrollIntoView({ block: "nearest" });
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", keepInView);
    window.addEventListener("resize", keepInView);
    return () => {
      viewport?.removeEventListener("resize", keepInView);
      window.removeEventListener("resize", keepInView);
    };
  }, []);

  // Both refetch when the issue changes under us: the panel reloads `detail` on every
  // fingerprint change, and comment count / updatedAt move whenever anything here does.
  const revisionFingerprint = detail.documents.map((doc) => `${doc.key}@${doc.currentRevision}`).join(",");

  const events = useResource(
    useCallback(() => getEvents({ ws: workspace, issue: ref }), [workspace, ref]),
    [workspace, ref, detail.issue.updatedAt, detail.comments.length, revisionFingerprint],
    onAuthError,
  );

  /**
   * One request per document key. Fine at this scale — an issue has one or two
   * documents — and it is the only source that knows a revision's change summary; the
   * doc_updated event carries it, but not the author, and the revision row carries
   * both when the write came through the CLI.
   */
  const revisions = useResource<Array<DocumentRevision & { key: string }>>(
    useCallback(
      async () =>
        (
          await Promise.all(
            detail.documents.map(async (doc) =>
              (await getRevisions({ ws: workspace, ref, key: doc.key })).map((rev) => ({ ...rev, key: doc.key })),
            ),
          )
        ).flat(),
      [workspace, ref, revisionFingerprint],
    ),
    [workspace, ref, revisionFingerprint],
    onAuthError,
  );

  /**
   * `worklogKey` is passed rather than left to `timeline.ts`'s default: that module
   * compiles under the Node tsconfig for `test/`, where `@/*` does not resolve, so it
   * keeps a local literal it cannot check. This file can see the mirror in lib/types,
   * so the value the UI actually renders comes from one place.
   */
  const timeline = useMemo(
    () =>
      buildTimeline({
        comments: detail.comments,
        events: events.data ?? [],
        revisions: revisions.data ?? [],
        worklogKey: WORKLOG_KEY,
      }),
    [detail.comments, events.data, revisions.data],
  );
  // Regrouped when the minute ticks, so a tab left open past midnight moves today's rows
  // under "Yesterday" rather than keeping a stale heading.
  const minute = Math.floor(now.getTime() / 60_000);
  const days = useMemo(() => groupByDay(timeline, { now }), [timeline, minute]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      // By id: the pane's issue, whatever number it holds now (`lib/write-ref.ts`).
      await action({ ws: workspace, ref: detail.issue.id }, { type: "comment", body });
      setDraft("");
      refresh();
      events.reload();
    } catch (caught) {
      // AuthError never lands here — the api client hands those to the shell, which
      // swaps the whole page. Everything else is this tab's problem to show.
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  };

  const loading = (events.loading && !events.data) || (revisions.loading && !revisions.data);

  return (
    <div className="activity-tab w-full max-w-readable space-y-4">
      {/* A failed side-source degrades the thread, it does not replace it: the comments
          are already in hand, so keep rendering them and say what is missing. */}
      {events.error ? <ErrorState error={events.error} /> : null}
      {revisions.error ? <ErrorState error={revisions.error} /> : null}

      {loading ? <LoadingState rows={3} /> : null}

      {!loading && timeline.length === 0 ? (
        <EmptyState icon={MessageSquare}>Nothing has happened here yet. Comments and changes will show up as they come in.</EmptyState>
      ) : null}

      {days.map((day) => (
        <section key={day.key} aria-label={day.label} className="space-y-1">
          <h3 className="flex items-center gap-3 text-label font-medium text-text-secondary">
            <span>{day.label}</span>
            <span aria-hidden className="h-px flex-1 bg-border" />
          </h3>
          <ol className="activity-rail">
            {day.entries.map((entry) =>
              entry.kind === "comment" ? (
                <CommentRow key={entry.id} entry={entry} today={day.today} now={now} />
              ) : (
                <EventRow key={entry.id} entry={entry} today={day.today} now={now} />
              ),
            )}
          </ol>
        </section>
      ))}

      <div
        ref={composer}
        data-activity-composer=""
        className="flex scroll-mb-3 items-center gap-2 rounded-xl border border-border bg-surface-raised p-1.5 pl-3 focus-within:border-ring/60"
      >
        <Input
          value={draft}
          placeholder="Write a comment…"
          aria-label="Add a comment"
          className="h-9 border-0 bg-transparent px-0 text-[14px] shadow-none focus-visible:ring-0 max-sm:h-10 dark:bg-transparent"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <Button className="shrink-0 max-sm:h-10" onClick={() => void send()} disabled={sending || draft.trim() === ""}>
          Comment
        </Button>
      </div>
      {error ? <p className="text-body text-[var(--status-task-blocked)]">{error}</p> : null}
    </div>
  );
}
