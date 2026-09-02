/**
 * Documents — the plan document as the ticket, not as an attachment to it.
 *
 * Two modes over one document key:
 *
 *   Read     the rendered markdown of any revision, with a restore affordance when
 *            what you are looking at is not the current one.
 *   History  a from → to comparison, the diff, and the revision log.
 *
 * Restore never rewrites history: it writes the old body forward as revision n+1, with
 * `baseRevision` set to what this page believed was current. If an agent wrote to the
 * document while you were reading it, the store answers revision_conflict and this tab
 * says so instead of quietly overwriting the agent.
 *
 * Diffing itself lives in ../diff.ts (pure) and ../DocumentDiff.tsx (presentation);
 * this file is only the fetch plumbing and the mode switch.
 */
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { action, ApiError, getDocument, getRevisions } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import type { DocumentRevision } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState } from "@/views/ViewChrome";
import { diffBodies } from "../diff";
import { DocumentDiff } from "../DocumentDiff";
import { takePendingDocumentKey, type TabProps } from "./registry";

const stamp = (iso: string) => iso.slice(0, 16).replace("T", " ");

/**
 * Which document opens first.
 *
 * `listDocuments` orders by key, so an issue with `notes` and `plan` would open on
 * `notes` — which is exactly backwards for this tab, whose whole premise is that the
 * plan document is the ticket. Prefer `plan`, then anything that reads like one, then
 * fall back to the first key.
 */
const PREFERRED_KEYS = ["plan", "design", "spec"];

function defaultKey(keys: readonly string[]): string | undefined {
  for (const preferred of PREFERRED_KEYS) {
    if (keys.includes(preferred)) return preferred;
  }
  return keys[0];
}

/** One row of the revision log. */
function RevisionRow({
  rev,
  current,
  onRead,
  onDiff,
  onRestore,
  restoring,
}: {
  rev: DocumentRevision;
  current: boolean;
  onRead: () => void;
  onDiff: () => void;
  onRestore: () => void;
  restoring: boolean;
}) {
  return (
    <li className="border-t py-1.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px]">
        <button
          type="button"
          onClick={onRead}
          className={cn("font-mono hover:underline", current && "font-semibold")}
        >
          r{rev.revision}
        </button>
        {current ? <span className="text-muted-foreground">current</span> : null}
        <span className="font-mono text-muted-foreground">{stamp(rev.createdAt)}</span>
        <span className="text-muted-foreground">{rev.author ?? "unknown"}</span>
        <div className="ml-auto flex gap-1">
          {rev.revision > 1 ? (
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={onDiff}>
              diff vs r{rev.revision - 1}
            </Button>
          ) : null}
          {current ? null : (
            <Button
              size="sm"
              variant={restoring ? "default" : "ghost"}
              className="h-6 px-2"
              onClick={onRestore}
            >
              {restoring ? "confirm restore" : "restore"}
            </Button>
          )}
        </div>
      </div>
      {rev.changeSummary ? (
        <p className="mt-0.5 text-[12px] text-muted-foreground">{rev.changeSummary}</p>
      ) : null}
    </li>
  );
}

export function DocumentsTab({ detail, workspace, onAuthError, refresh }: TabProps) {
  const ref = detail.issue.identifier;
  /**
   * `takePendingDocumentKey` first — W3 (STA-115). Arriving here from Overview's
   * "Show all" means the reader has already named the document they want, and
   * `defaultKey` would otherwise open `plan` on top of them. It only ever returns
   * non-null on the render that immediately follows an `openDetailTab(…, key)`, so
   * every other visit to this tab still gets `PREFERRED_KEYS`.
   */
  const [key, setKey] = useState<string | undefined>(
    () => takePendingDocumentKey() ?? defaultKey(detail.documents.map((doc) => doc.key)),
  );
  const [mode, setMode] = useState<"read" | "history">("read");
  /** null = "whatever is current". A number pins the view to one revision. */
  const [reading, setReading] = useState<number | null>(null);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  /** The revision whose restore button is armed — restore is deliberately two-click. */
  const [arming, setArming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState("");

  const meta = detail.documents.find((doc) => doc.key === key);
  const currentRevision = meta?.currentRevision ?? 0;

  // currentRevision is in the dep list so a restore (which does not touch the issue's
  // updated_at) still invalidates every fetch on this tab.
  const revisions = useResource<DocumentRevision[]>(
    useCallback(
      () => (key ? getRevisions({ ws: workspace, ref, key }) : Promise.resolve([])),
      [workspace, ref, key],
    ),
    [workspace, ref, key, currentRevision],
    onAuthError,
  );

  const shown = reading ?? currentRevision;
  const body = useResource(
    useCallback(
      () => (key ? getDocument({ ws: workspace, ref, key, revision: shown || undefined }) : Promise.resolve(undefined)),
      [workspace, ref, key, shown],
    ),
    [workspace, ref, key, shown, currentRevision],
    onAuthError,
  );

  const from = useResource(
    useCallback(
      () =>
        key && range ? getDocument({ ws: workspace, ref, key, revision: range.from }) : Promise.resolve(undefined),
      [workspace, ref, key, range?.from],
    ),
    [workspace, ref, key, range?.from, currentRevision],
    onAuthError,
  );
  const to = useResource(
    useCallback(
      () => (key && range ? getDocument({ ws: workspace, ref, key, revision: range.to }) : Promise.resolve(undefined)),
      [workspace, ref, key, range?.to],
    ),
    [workspace, ref, key, range?.to, currentRevision],
    onAuthError,
  );

  const diff = useMemo(
    () => (from.data && to.data ? diffBodies(from.data.body, to.data.body) : undefined),
    [from.data, to.data],
  );

  const selectKey = (next: string) => {
    setKey(next);
    setReading(null);
    setRange(null);
    setArming(null);
    setWriteError("");
  };

  const openDiff = (to_: number) => {
    setRange({ from: Math.max(1, to_ - 1), to: to_ });
    setMode("history");
  };

  const restore = async (revision: number) => {
    if (!key) return;
    if (arming !== revision) {
      setArming(revision);
      return;
    }
    setBusy(true);
    setWriteError("");
    try {
      await action({ ws: workspace, ref }, { type: "doc_restore", key, revision, baseRevision: currentRevision });
      setArming(null);
      setReading(null);
      refresh();
      revisions.reload();
      body.reload();
    } catch (caught) {
      // AuthError never lands here — the api client hands those to the shell.
      setWriteError(
        caught instanceof ApiError
          ? caught.retryable
            ? `${caught.message} (someone wrote to this document first — reload and try again)`
            : caught.message
          : String(caught),
      );
      setArming(null);
    } finally {
      setBusy(false);
    }
  };

  if (detail.documents.length === 0) return <EmptyState>no documents on this issue</EmptyState>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {detail.documents.map((doc) => (
          <Button
            key={doc.key}
            size="sm"
            variant={doc.key === key ? "secondary" : "outline"}
            onClick={() => selectKey(doc.key)}
          >
            <span className="font-mono">{doc.key}</span>
            <span className="text-muted-foreground">@r{doc.currentRevision}</span>
          </Button>
        ))}
      </div>

      <div className="flex items-center gap-1 border-b pb-2">
        <Button
          size="sm"
          variant={mode === "read" ? "secondary" : "ghost"}
          className="h-7"
          onClick={() => setMode("read")}
        >
          Read
        </Button>
        <Button
          size="sm"
          variant={mode === "history" ? "secondary" : "ghost"}
          className="h-7"
          onClick={() => setMode("history")}
        >
          History
          {revisions.data ? (
            <span className="ml-1 text-muted-foreground">{revisions.data.length}</span>
          ) : null}
        </Button>
        {meta ? (
          <span className="ml-auto text-[11px] text-muted-foreground">
            updated {stamp(meta.updatedAt)}
          </span>
        ) : null}
      </div>

      {writeError ? (
        <p className="rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3 py-2 text-[13px]">
          {writeError}
        </p>
      ) : null}

      {mode === "read" ? (
        <>
          {reading !== null && reading !== currentRevision ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--status-task-in_review)]/40 bg-[var(--status-task-in_review)]/10 px-3 py-2 text-[12px]">
              <span>
                Viewing revision {reading} — the current revision is {currentRevision}.
              </span>
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setReading(null)}>
                  back to current
                </Button>
                <Button
                  size="sm"
                  variant={arming === reading ? "default" : "outline"}
                  className="h-6 px-2"
                  disabled={busy}
                  onClick={() => void restore(reading)}
                >
                  {arming === reading ? "confirm restore" : "restore this revision"}
                </Button>
              </div>
            </div>
          ) : null}

          {body.error ? <ErrorState error={body.error} /> : null}
          {!body.data && body.loading ? <LoadingState rows={3} /> : null}
          {body.data ? (
            <article className="rounded-md border bg-muted/40 px-4 py-3">
              <header className="mb-2 flex flex-wrap items-baseline gap-2 text-[11px] text-muted-foreground">
                <span className="font-mono">{body.data.key}</span>
                {body.data.title ? <span>{body.data.title}</span> : null}
                <span>revision {body.data.revision}</span>
                {body.data.author ? <span>by {body.data.author}</span> : null}
                <span className="ml-auto font-mono">{stamp(body.data.createdAt)}</span>
              </header>
              <Markdown text={body.data.body} className="text-[13px]" />
            </article>
          ) : null}
        </>
      ) : (
        <>
          {revisions.error ? <ErrorState error={revisions.error} /> : null}
          {!revisions.data && revisions.loading ? <LoadingState rows={2} /> : null}

          {revisions.data && revisions.data.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <label className="flex items-center gap-1">
                <span className="text-muted-foreground">from</span>
                <select
                  aria-label="Diff from revision"
                  className="rounded border bg-background px-1.5 py-0.5 font-mono"
                  value={range?.from ?? Math.max(1, currentRevision - 1)}
                  onChange={(e) =>
                    setRange({
                      from: Number(e.currentTarget.value),
                      to: range?.to ?? currentRevision,
                    })
                  }
                >
                  {revisions.data.map((rev) => (
                    <option key={rev.revision} value={rev.revision}>
                      r{rev.revision}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <span className="text-muted-foreground">to</span>
                <select
                  aria-label="Diff to revision"
                  className="rounded border bg-background px-1.5 py-0.5 font-mono"
                  value={range?.to ?? currentRevision}
                  onChange={(e) =>
                    setRange({
                      from: range?.from ?? Math.max(1, currentRevision - 1),
                      to: Number(e.currentTarget.value),
                    })
                  }
                >
                  {revisions.data.map((rev) => (
                    <option key={rev.revision} value={rev.revision}>
                      r{rev.revision}
                    </option>
                  ))}
                </select>
              </label>
              {range === null ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2"
                  onClick={() => setRange({ from: Math.max(1, currentRevision - 1), to: currentRevision })}
                >
                  compare
                </Button>
              ) : (
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setRange(null)}>
                  clear
                </Button>
              )}
            </div>
          ) : null}

          {from.error ? <ErrorState error={from.error} /> : null}
          {to.error ? <ErrorState error={to.error} /> : null}
          {range && diff ? (
            <DocumentDiff diff={diff} fromLabel={`r${range.from}`} toLabel={`r${range.to}`} />
          ) : null}

          {revisions.data ? (
            revisions.data.length === 0 ? (
              <EmptyState>no revisions</EmptyState>
            ) : (
              <ul>
                {revisions.data.map((rev) => (
                  <RevisionRow
                    key={rev.revision}
                    rev={rev}
                    current={rev.revision === currentRevision}
                    restoring={arming === rev.revision}
                    onRead={() => {
                      setReading(rev.revision === currentRevision ? null : rev.revision);
                      setMode("read");
                    }}
                    onDiff={() => openDiff(rev.revision)}
                    onRestore={() => void restore(rev.revision)}
                  />
                ))}
              </ul>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
