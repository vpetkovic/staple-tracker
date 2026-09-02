/**
 * Activity — the whole history of one issue in one column.
 *
 * Comments were always here. The other half — status transitions, claims and releases,
 * blocker wakes, subtree completions, document revisions — lived in the event log and
 * the revision table, where nobody looked. Merging them is the point: "the plan was
 * rewritten" and "and then it went back to todo" only mean something next to each
 * other, in order.
 *
 * The merge is in ../timeline.ts and is pure. This file fetches, renders, and keeps the
 * composer where it was.
 */
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { action, ApiError, getEvents, getRevisions } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import type { DocumentRevision } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState } from "@/views/ViewChrome";
import { buildTimeline, type TimelineEntry } from "../timeline";
import type { TabProps } from "./registry";

const stamp = (iso: string) => iso.slice(0, 16).replace("T", " ");

/**
 * The left rail. Status entries borrow the status colour so a run of transitions reads
 * as a colour sequence; everything else stays muted, because a timeline where every
 * row shouts is a timeline nobody scans.
 */
function Rail({ entry }: { entry: TimelineEntry }) {
  return (
    <span
      aria-hidden
      data-status={entry.status}
      className={cn(
        "mt-1.5 h-2 w-2 shrink-0 rounded-full",
        entry.status ? "status-chip" : entry.kind === "comment" ? "bg-foreground/40" : "bg-muted-foreground/30",
      )}
    />
  );
}

function Entry({ entry }: { entry: TimelineEntry }) {
  return (
    <li data-timeline-kind={entry.kind} className="flex gap-2 border-t py-2 first:border-t-0">
      <Rail entry={entry} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-muted-foreground">
          <span className={cn(entry.kind === "comment" && "text-foreground")}>
            {entry.actor ?? "system"}
          </span>
          {entry.authorType ? <span>({entry.authorType})</span> : null}
          <span>{entry.summary}</span>
          <span className="ml-auto font-mono">{stamp(entry.at)}</span>
        </div>
        {entry.chips?.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.chips.map((chip) => (
              <span key={chip} className="rounded border px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                {chip}
              </span>
            ))}
          </div>
        ) : null}
        {entry.body ? <Markdown text={entry.body} className="mt-0.5 text-[13px]" /> : null}
      </div>
    </li>
  );
}

export function ActivityTab({ detail, workspace, onAuthError, refresh }: TabProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>("");
  const [sending, setSending] = useState(false);
  const ref = detail.issue.identifier;

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

  const timeline = useMemo(
    () =>
      buildTimeline({
        comments: detail.comments,
        events: events.data ?? [],
        revisions: revisions.data ?? [],
      }),
    [detail.comments, events.data, revisions.data],
  );

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      await action({ ws: workspace, ref }, { type: "comment", body });
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
    <div className="space-y-3">
      {/* A failed side-source degrades the thread, it does not replace it: the comments
          are already in hand, so keep rendering them and say what is missing. */}
      {events.error ? <ErrorState error={events.error} /> : null}
      {revisions.error ? <ErrorState error={revisions.error} /> : null}

      {loading ? <LoadingState rows={3} /> : null}

      {!loading && timeline.length === 0 ? (
        <EmptyState>nothing has happened on this issue yet</EmptyState>
      ) : null}

      {timeline.length > 0 ? (
        <ul>
          {timeline.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder="add a comment"
          aria-label="Add a comment"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <Button size="sm" onClick={() => void send()} disabled={sending || draft.trim() === ""}>
          send
        </Button>
      </div>
      {error ? <p className="text-[13px] text-[var(--status-task-blocked)]">{error}</p> : null}
    </div>
  );
}
