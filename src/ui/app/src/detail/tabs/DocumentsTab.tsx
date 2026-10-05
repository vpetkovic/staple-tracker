/**
 * Documents — the plan document as the ticket, not as an attachment to it.
 * Screenshots, video, PDFs and logs are the Files tab. This tab stays on the
 * strip when nothing has been written yet.
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
 * A document an agent wrote as base64 evidence (a `Media type:` and `SHA-256:` header
 * over base64) reads as the file it holds, or as a flag when the bytes do not match
 * what it claims: ./EvidenceDocument.tsx.
 *
 * Diffing itself lives in ../diff.ts (pure) and ../DocumentDiff.tsx (presentation);
 * this file is only the fetch plumbing and the mode switch.
 */
import { useCallback, useMemo, useState } from "react";
import { FileText, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { action, ApiError, getDocument, getRevisions } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import type { DocumentRevision } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { diffBodies } from "../diff";
import { DocumentDiff } from "../DocumentDiff";
import { EmptyState, PersonChip, RelativeTime, SectionHeading, cn, personActor } from "../parts";
import { Dot } from "./Dot";
import { EvidenceDocument } from "./EvidenceDocument";
import { restoreWrite } from "./writes";
import { takePendingDocumentKey, type TabProps } from "./registry";
import "./tabs.css";

/** `plan` -> `Plan`, `design-notes` -> `Design notes`: a key as a name. */
const documentName = (key: string, title?: string | null) =>
  title?.trim() || (key.charAt(0).toUpperCase() + key.slice(1)).replace(/[-_]+/g, " ");

const personKind = (name: string) => (/[-_]/.test(name) ? "agent" : "human");

/** A two- or three-way choice drawn as one segmented control. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: React.ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 rounded-lg bg-surface-sunken p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "text-body focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-3 transition-colors duration-150 max-sm:h-9",
            value === option.value
              ? "bg-surface-raised text-foreground shadow-[0_0_0_1px_var(--border)]"
              : "text-text-secondary hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const SELECT =
  "focus-ring h-9 rounded-lg border border-border bg-surface-raised px-2.5 text-body text-foreground max-sm:h-10";

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

/** One row of the revision log: which version, who wrote it, when, and what changed. */
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
    <li className="flex flex-col gap-2 border-b border-border px-3.5 py-3 last:border-b-0 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body">
          <button
            type="button"
            onClick={onRead}
            className="focus-ring rounded-sm font-medium text-foreground underline-offset-2 hover:underline"
          >
            Revision {rev.revision}
          </button>
          {current ? (
            <span className="rounded-full bg-surface-sunken px-2 text-caption leading-5 text-text-secondary">Latest</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-label text-text-secondary">
          {rev.author ? <PersonChip name={rev.author} kind={personKind(rev.author)} /> : <span>Unknown author</span>}
          <Dot />
          <RelativeTime iso={rev.createdAt} inSentence />
        </div>
        {rev.changeSummary ? <p className="text-body text-pretty text-text-secondary">{rev.changeSummary}</p> : null}
      </div>
      <div className="flex shrink-0 gap-1.5">
        {rev.revision > 1 ? (
          <Button size="sm" variant="ghost" className="max-sm:h-10" onClick={onDiff}>
            Compare with previous
          </Button>
        ) : null}
        {current ? null : (
          <Button size="sm" variant={restoring ? "default" : "ghost"} className="max-sm:h-10" onClick={onRestore}>
            {restoring ? "Confirm restore" : "Restore"}
          </Button>
        )}
      </div>
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
    () => takePendingDocumentKey(ref) ?? defaultKey(detail.documents.map((doc) => doc.key)),
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
      const write = restoreWrite(workspace, detail.issue.id, key, revision, currentRevision, personActor());
      await action(write.target, write.payload);
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

  if (detail.documents.length === 0) {
    return (
      <EmptyState icon={FileText}>
        No plan or notes on this ticket yet. Screenshots and other files are under Files.
      </EmptyState>
    );
  }

  const defaultFrom = Math.max(1, currentRevision - 1);

  return (
    <div className="w-full max-w-readable space-y-4">
      {detail.documents.length > 1 ? (
        <div role="group" aria-label="Documents" className="flex flex-wrap gap-1.5">
          {detail.documents.map((doc) => (
            <button
              key={doc.key}
              type="button"
              aria-pressed={doc.key === key}
              onClick={() => selectKey(doc.key)}
              className={cn(
                "text-body focus-ring inline-flex h-8 items-center gap-1.5 rounded-full border px-3 transition-colors duration-150 max-sm:h-10",
                doc.key === key
                  ? "border-foreground/20 bg-surface-sunken text-foreground"
                  : "border-border text-text-secondary hover:text-foreground",
              )}
            >
              <FileText aria-hidden className="size-3.5" />
              {documentName(doc.key, doc.title)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-title font-medium text-foreground">{meta ? documentName(meta.key, meta.title) : ""}</h3>
          {meta ? (
            <p className="text-label text-text-secondary">
              Updated <RelativeTime iso={meta.updatedAt} inSentence />
              <Dot />
              revision {meta.currentRevision}
            </p>
          ) : null}
        </div>
        <Segmented
          label="Document view"
          value={mode}
          onChange={setMode}
          options={[
            { value: "read", label: "Read" },
            {
              value: "history",
              label: (
                <>
                  History
                  {revisions.data ? <span className="text-text-tertiary">{revisions.data.length}</span> : null}
                </>
              ),
            },
          ]}
        />
      </div>

      {writeError ? (
        <p className="rounded-xl border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3.5 py-2.5 text-body">
          {writeError}
        </p>
      ) : null}

      {mode === "read" ? (
        <>
          {reading !== null && reading !== currentRevision ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--status-task-in_review)]/40 bg-[var(--status-task-in_review)]/10 px-3.5 py-2.5 text-body">
              <History aria-hidden className="size-4 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1">
                You are reading revision {reading}. The latest is revision {currentRevision}.
              </span>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" className="max-sm:h-10" onClick={() => setReading(null)}>
                  Back to latest
                </Button>
                <Button
                  size="sm"
                  variant={arming === reading ? "default" : "outline"}
                  className="max-sm:h-10"
                  disabled={busy}
                  onClick={() => void restore(reading)}
                >
                  <RotateCcw aria-hidden className="size-3.5" />
                  {arming === reading ? "Confirm restore" : "Restore this version"}
                </Button>
              </div>
            </div>
          ) : null}

          {body.error ? <ErrorState error={body.error} /> : null}
          {!body.data && body.loading ? <LoadingState rows={3} /> : null}
          {body.data ? (
            <article className="rounded-xl border border-border bg-surface-raised px-4 py-4 sm:px-6 sm:py-5">
              {body.data.author ? (
                <header className="mb-3 flex flex-wrap items-center gap-x-1.5 border-b border-border pb-3 text-label text-text-secondary">
                  <span>Written by</span>
                  <PersonChip name={body.data.author} kind={personKind(body.data.author)} />
                  <Dot />
                  <RelativeTime iso={body.data.createdAt} inSentence />
                </header>
              ) : null}
              {body.data.evidence ? (
                <EvidenceDocument
                  workspace={workspace}
                  issueRef={ref}
                  docKey={body.data.key}
                  revision={body.data.revision}
                  evidence={body.data.evidence}
                  name={meta ? documentName(meta.key, meta.title) : body.data.key}
                  body={body.data.body}
                />
              ) : body.data.body.trim() ? (
                <Markdown text={body.data.body} className="tab-prose text-reading text-foreground" />
              ) : (
                <p className="text-reading text-text-secondary">This revision is empty.</p>
              )}
            </article>
          ) : null}
        </>
      ) : (
        <>
          {revisions.error ? <ErrorState error={revisions.error} /> : null}
          {!revisions.data && revisions.loading ? <LoadingState rows={2} /> : null}

          {revisions.data && revisions.data.length > 1 ? (
            <section aria-label="Compare revisions" className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-body text-text-secondary">
                <span>Compare</span>
                <select
                  aria-label="Diff from revision"
                  className={SELECT}
                  value={range?.from ?? defaultFrom}
                  onChange={(e) =>
                    setRange({
                      from: Number(e.currentTarget.value),
                      to: range?.to ?? currentRevision,
                    })
                  }
                >
                  {revisions.data.map((rev) => (
                    <option key={rev.revision} value={rev.revision}>
                      Revision {rev.revision}
                    </option>
                  ))}
                </select>
                <span>with</span>
                <select
                  aria-label="Diff to revision"
                  className={SELECT}
                  value={range?.to ?? currentRevision}
                  onChange={(e) =>
                    setRange({
                      from: range?.from ?? defaultFrom,
                      to: Number(e.currentTarget.value),
                    })
                  }
                >
                  {revisions.data.map((rev) => (
                    <option key={rev.revision} value={rev.revision}>
                      Revision {rev.revision}
                    </option>
                  ))}
                </select>
                {range === null ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="max-sm:h-10"
                    onClick={() => setRange({ from: defaultFrom, to: currentRevision })}
                  >
                    Show changes
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" className="max-sm:h-10" onClick={() => setRange(null)}>
                    Close
                  </Button>
                )}
              </div>

              {from.error ? <ErrorState error={from.error} /> : null}
              {to.error ? <ErrorState error={to.error} /> : null}
              {range && diff ? (
                <DocumentDiff diff={diff} fromLabel={`Revision ${range.from}`} toLabel={`Revision ${range.to}`} />
              ) : null}
            </section>
          ) : null}

          {revisions.data ? (
            revisions.data.length === 0 ? (
              <EmptyState icon={History}>No revisions yet.</EmptyState>
            ) : (
              <section aria-label="Revisions">
                <SectionHeading>All revisions</SectionHeading>
                <ul className="overflow-hidden rounded-xl border border-border bg-surface-raised">
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
              </section>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
