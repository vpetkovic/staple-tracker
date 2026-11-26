/**
 * The Queue page: the order agents take work in, one workspace at a time or every workspace's
 * plan in its own section on All workspaces.
 *
 * THE PAGE is one dense list, the full width of the content card and its one scroller, like
 * the Inbox. Under each header the first row is the pinned next row: what an agent asking now
 * would be handed, and why that one. Then the plan's entries in order; a container entry rolls
 * up its tasks and opens to them (paged, first five), with an epic caption above the tasks it
 * holds. Then the band of open work after the plan, folded. The words for every state are
 * queue-words.ts; which rows are drawn is queue-lines.ts; the rows are QueueRow.tsx and
 * QueueParts.tsx.
 *
 * THE DATA is `use-workspace-queue.ts`: `useWorkspaceQueue` for a workspace page, `useHubQueue`
 * plus `sectionRead` and `useQueueSection` per section on All workspaces. Nothing about order
 * or eligibility is decided here; every write goes through the section's own callbacks.
 *
 * REORDER. Drag the plan number (queue-drag.ts), Alt and an arrow, Alt Home or End, or the
 * row's menu: every path ends in the section's `move(from, to)` or `moveToEdge`. A move is
 * announced politely once the plan answers.
 *
 * THE KEYBOARD. Every row of every open section is one tab stop (`useRovingFocus`): Up and
 * Down (and k, j) move, Home and End jump, Right and Left open and fold a container, Enter or
 * Space opens the task, Alt and the arrows move an entry. Alt and an arrow on a task under an
 * entry does nothing (`nestedRowKey`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { QueueRowMenu, queueRowMenuState } from "@/components/QueueRowMenu";
import { onRowItself, useRovingFocus, type RovingFocus } from "@/components/task-list/roving";
import type { TaskRow } from "@/components/task-list";
import type { AuthError } from "@/lib/api";
import { useRuns } from "@/lib/runs";
import { useSession } from "@/lib/session";
import { openSettings } from "@/lib/shell-events";
import type { Issue, WorkspaceRef } from "@/lib/types";
import { useIsDesk } from "@/lib/use-media";
import { ErrorState } from "@/views/ViewChrome";
import { workspaceScope } from "@/views/workspace-scope";
import { FailedBanner } from "@/views/attention/InboxParts";
import "./queue.css";
import { useEntryDrag } from "./queue-drag";
import { nestedRowKey } from "./queue-keys";
import { NO_FOLDS, revealKey, revealOf, rowKey, sectionLayout, withReveal, type RowPlace, type SectionFolds } from "./queue-lines";
import { queueSummary } from "./queue-summary";
import { issueFromEffective } from "./queue-tree";
import { hasOpenWork, moveAnnouncement, nothingPickable, whyNext } from "./queue-words";
import {
  AddToQueue,
  AllStrip,
  AutopilotLink,
  EmptyPlan,
  FoldAllButton,
  KeyHint,
  PageStrip,
  PolicyTag,
  QueueSkeleton,
  SectionHeader,
  Standing,
  type NextState,
} from "./QueueParts";
import { SectionBody } from "./QueueSection";
import { sectionRead, useHubQueue, useQueueSection, useWorkspaceQueue, type QueueSection } from "./use-workspace-queue";

export type { QueueWriteFailure } from "./use-workspace-queue";

export function QueueView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const scope = workspaceScope(session.mode, session.ws, session.workspaces);
  if (scope.kind === "choose") return <AllWorkspacesQueue onAuthError={onAuthError} />;
  // Keyed, so switching workspace starts the page clean (folds, a failed write).
  return <WorkspaceQueue key={scope.slug} workspace={scope.slug} onAuthError={onAuthError} />;
}

// ---------- the page frame: one scroller, one roving list, one live region ----------

interface PageRows {
  roving: RovingFocus;
  report: (workspace: string, keys: readonly string[]) => void;
  announce: (text: string) => void;
}

function usePageRows(order: readonly string[]): PageRows & { keys: string[]; announcement: string } {
  const [reported, setReported] = useState<Record<string, readonly string[]>>({});
  const [announcement, setAnnouncement] = useState("");
  const keys = useMemo(() => order.flatMap((workspace) => reported[workspace] ?? []), [order, reported]);
  const roving = useRovingFocus(keys);
  const report = useCallback((workspace: string, next: readonly string[]) => {
    setReported((current) => {
      const now = current[workspace];
      if (now && now.length === next.length && now.every((key, i) => key === next[i])) return current;
      return { ...current, [workspace]: next };
    });
  }, []);
  return { keys, roving, report, announce: setAnnouncement, announcement };
}

/** The phone shell's slot beside the page title (AppShell), or null on the desk. */
function usePhoneHeaderSlot(): HTMLElement | null {
  const desk = useIsDesk();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setSlot(desk ? null : document.querySelector<HTMLElement>("[data-phone-header-slot]")), [desk]);
  return slot;
}

function QueuePage({ label, rows, children }: { label: string; rows: ReturnType<typeof usePageRows>; children: ReactNode }) {
  const { keys, roving } = rows;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = (event.target as HTMLElement).dataset.queueRow;
    if (key === undefined || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const at = keys.indexOf(key);
    let to: string | undefined;
    if (event.key === "ArrowDown" || event.key === "j") to = keys[Math.min(keys.length - 1, at + 1)];
    else if (event.key === "ArrowUp" || event.key === "k") to = keys[Math.max(0, at - 1)];
    else if (event.key === "Home") to = keys[0];
    else if (event.key === "End") to = keys.at(-1);
    else return;
    event.preventDefault();
    if (to) roving.go(to);
  };
  return (
    <div
      role="region"
      aria-label={label}
      data-queue-board
      className="q-page"
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-queue-row]");
        if (row?.dataset.queueRow) roving.set(row.dataset.queueRow);
      }}
    >
      {children}
      <KeyHint />
      <div aria-live="polite" className="sr-only" data-queue-announce="">
        {rows.announcement}
      </div>
    </div>
  );
}

// ---------- a workspace page ----------

function WorkspaceQueue({ workspace, onAuthError }: { workspace: string; onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const queue = useWorkspaceQueue(workspace, onAuthError);
  const order = useMemo(() => [workspace], [workspace]);
  const rows = usePageRows(order);
  const slot = usePhoneHeaderSlot();
  const prefix = session.workspaces.find((ref) => ref.slug === workspace)?.prefix ?? "";

  if (queue.error) {
    return (
      <div className="q-page px-4" data-queue-board>
        <ErrorState error={queue.error} />
      </div>
    );
  }
  const add = (
    <AddToQueue
      workspace={workspace}
      options={queue.candidates}
      onPick={(ref) => queue.add(ref)}
      disabled={queue.busy || queue.view === null}
      primary
      compact={slot === null}
    />
  );
  return (
    <QueuePage label={`${workspace} queue`} rows={rows}>
      {slot ? createPortal(add, slot) : null}
      <SectionController queue={queue} mode="page" prefix={prefix} rows={rows} folded={false} add={slot ? null : add} />
    </QueuePage>
  );
}

// ---------- All workspaces ----------

function AllWorkspacesQueue({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const hub = useHubQueue(onAuthError);
  const session = useSession();
  const slot = usePhoneHeaderSlot();
  const slugs = useMemo(() => hub.workspaces.map((section) => section.slug), [hub.workspaces]);
  const rows = usePageRows(slugs);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const allFolded = slugs.length > 0 && slugs.every((slug) => folded.has(slug));
  const onFoldAll = () => setFolded(allFolded ? new Set() : new Set(slugs));
  const toggle = useCallback(
    (slug: string, open?: boolean) =>
      setFolded((current) => {
        const next = new Set(current);
        if (open === true || (open === undefined && next.has(slug))) next.delete(slug);
        else next.add(slug);
        return next;
      }),
    [],
  );

  if (hub.error) {
    return (
      <div className="q-page px-4" data-queue-board>
        <ErrorState error={hub.error} />
      </div>
    );
  }
  const plans = hub.workspaces.filter((section) => section.entries.length > 0).length;
  const total = hub.workspaces.length + hub.failed.length;
  const foldAll = <FoldAllButton allFolded={allFolded} onFoldAll={onFoldAll} />;
  return (
    <QueuePage label="Every workspace's queue" rows={rows}>
      {slot && slugs.length > 0 ? createPortal(foldAll, slot) : null}
      {hub.failed.map((failure) => (
        <FailedBanner key={failure.workspace} workspace={failure.workspace} message={failure.message} />
      ))}
      {hub.loading && slugs.length === 0 ? (
        <QueueSkeleton rows={9} />
      ) : (
        <>
          {slot ? null : <AllStrip plans={plans} workspaces={total} allFolded={allFolded} onFoldAll={onFoldAll} />}
          {hub.workspaces.map((section) => (
            <HubSection
              key={section.slug}
              hub={hub}
              slug={section.slug}
              prefix={section.prefix || refPrefix(session.workspaces, section.slug)}
              rows={rows}
              folded={folded.has(section.slug)}
              onFold={toggle}
            />
          ))}
        </>
      )}
    </QueuePage>
  );
}

function refPrefix(workspaces: readonly WorkspaceRef[], slug: string): string {
  return workspaces.find((ref) => ref.slug === slug)?.prefix ?? "";
}

function HubSection({
  hub,
  slug,
  prefix,
  rows,
  folded,
  onFold,
}: {
  hub: ReturnType<typeof useHubQueue>;
  slug: string;
  prefix: string;
  rows: PageRows;
  folded: boolean;
  onFold: (slug: string, open?: boolean) => void;
}) {
  const queue = useQueueSection(slug, sectionRead(hub, slug));
  return <SectionController queue={queue} mode="all" prefix={prefix} rows={rows} folded={folded} onFold={onFold} />;
}

// ---------- one section: its folds, its keys, its drag, its menu ----------

function SectionController({
  queue,
  mode,
  prefix,
  rows,
  folded,
  onFold,
  add,
}: {
  queue: QueueSection;
  mode: "page" | "all";
  prefix: string;
  rows: PageRows;
  folded: boolean;
  onFold?: (slug: string, open?: boolean) => void;
  /** The workspace page's own Add, when it is not on the phone title line. */
  add?: ReactNode;
}) {
  const session = useSession();
  const runs = useRuns();
  const { workspace, view } = queue;
  const { roving, report, announce } = rows;
  const [folds, setFolds] = useState<SectionFolds>(() => ({ ...NO_FOLDS, containersOpen: mode === "page" }));
  const listRef = useRef<HTMLDivElement>(null);

  const layout = useMemo(
    () =>
      sectionLayout(
        { workspace, view: view ?? { effective: [], entries: [] }, rows: queue.rows, unqueued: queue.unqueued, next: queue.next, known: queue.known },
        folds,
      ),
    [workspace, view, queue.rows, queue.unqueued, queue.next, queue.known, folds],
  );
  const drawnKeys = folded || !view ? "" : layout.keys.join("\n");
  useEffect(() => report(workspace, drawnKeys ? drawnKeys.split("\n") : []), [report, workspace, drawnKeys]);

  const open = useCallback(
    (identifier: string) => {
      const owner = session.workspaces.find((ref) => ref.prefix && identifier.startsWith(`${ref.prefix}-`))?.slug ?? workspace;
      session.open(owner || workspace, identifier);
    },
    [session, workspace],
  );

  // ---- showing a row: open what hides it, then scroll to it, focus it and flash it ----
  const [showing, setShowing] = useState<{ key: string; tick: number } | null>(null);
  const show = useCallback(
    (identifier: string) => {
      const reveal = revealOf(queue, identifier);
      if (!reveal) {
        open(identifier);
        return;
      }
      if (folded) onFold?.(workspace, true);
      setFolds((current) => withReveal(current, reveal));
      setShowing((current) => ({ key: revealKey(workspace, reveal), tick: (current?.tick ?? 0) + 1 }));
    },
    [folded, onFold, open, queue, workspace],
  );
  useEffect(() => {
    if (!showing) return;
    const element = document.querySelector<HTMLElement>(`[data-queue-row="${CSS.escape(showing.key)}"]`);
    if (!element) return;
    setShowing(null);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    roving.set(showing.key);
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    if (!still) {
      element.removeAttribute("data-flash");
      void element.offsetWidth;
      element.setAttribute("data-flash", "");
      window.setTimeout(() => element.removeAttribute("data-flash"), 1500);
    }
  }, [showing, layout, roving]);

  // ---- moves: every path ends in move/moveToEdge; the answer is announced ----
  const moved = useRef<string | null>(null);
  const move = useCallback(
    (from: number, to: number) => {
      const identifier = view?.entries[from]?.identifier;
      if (!identifier || queue.busy) return;
      moved.current = identifier;
      queue.move(from, to);
    },
    [queue, view],
  );
  const moveToEdge = useCallback(
    (identifier: string, edge: "first" | "last") => {
      if (queue.busy) return;
      moved.current = identifier;
      queue.moveToEdge(identifier, edge);
    },
    [queue],
  );
  useEffect(() => {
    const identifier = moved.current;
    if (!identifier || queue.busy || !view) return;
    moved.current = null;
    if (queue.failure) return;
    const at = view.entries.findIndex((entry) => entry.identifier === identifier);
    if (at < 0) return;
    announce(moveAnnouncement(identifier, at, view.entries.length));
    // A row React moved in the DOM can lose focus on the way: give it back.
    const key = rowKey(workspace, "entry", identifier);
    const element = document.querySelector<HTMLElement>(`[data-queue-row="${CSS.escape(key)}"]`);
    if (element && (document.activeElement === null || document.activeElement === document.body)) {
      roving.set(key);
      element.focus({ preventScroll: true });
    }
    element?.scrollIntoView({ block: "nearest" });
  }, [announce, queue.busy, queue.failure, roving, view, workspace]);

  const drag = useEntryDrag(listRef, { disabled: queue.busy, onMove: move });

  const toggleContainer = useCallback(
    (identifier: string) =>
      setFolds((current) => {
        const flipped = new Set(current.flipped);
        if (flipped.has(identifier)) flipped.delete(identifier);
        else flipped.add(identifier);
        return { ...current, flipped };
      }),
    [],
  );

  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, key: string, place: RowPlace, identifier: string) => {
    const self = onRowItself(event);
    if (place === "entry") {
      const block = layout.entries.find((candidate) => candidate.key === key);
      if (!block) return;
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const from = block.index;
        const last = layout.entries.length - 1;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const to = from + (event.key === "ArrowUp" ? -1 : 1);
          if (to >= 0 && to <= last) move(from, to);
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          if ((event.key === "Home" && from > 0) || (event.key === "End" && from < last)) moveToEdge(identifier, event.key === "Home" ? "first" : "last");
        }
        return;
      }
      if (!self) return;
      if ((event.key === "ArrowRight" && block.container && !block.open) || (event.key === "ArrowLeft" && block.open)) {
        event.preventDefault();
        toggleContainer(identifier);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open(identifier);
      }
      return;
    }
    const action = nestedRowKey(event, self);
    if (action === "swallow") event.preventDefault();
    else if (action === "open") {
      event.preventDefault();
      open(identifier);
    }
  };

  const menu = (place: RowPlace, identifier: string, trigger: ReactNode) => {
    const at = place === "entry" ? queue.indexOf(identifier) : -1;
    const last = (view?.entries.length ?? 0) - 1;
    return (
      <QueueRowMenu
        plan
        trigger={trigger}
        identifier={identifier}
        state={menuState(queue, identifier, place === "entry" ? queue.queuedIds : NOTHING)}
        disabled={queue.busy || view === null}
        onOpen={() => open(identifier)}
        onQueueNext={() => queue.add(identifier, 1)}
        onQueueLast={() => queue.add(identifier)}
        onDequeue={() => queue.remove(identifier)}
        onMoveToTop={at > 0 ? () => moveToEdge(identifier, "first") : undefined}
        onMoveUp={at > 0 ? () => move(at, at - 1) : undefined}
        onMoveDown={at >= 0 && at < last ? () => move(at, at + 1) : undefined}
        onMoveToBottom={at >= 0 && at < last ? () => moveToEdge(identifier, "last") : undefined}
      />
    );
  };

  const policy = queue.policy ?? "advisory";
  const policyTag = <PolicyTag policy={policy} workspace={workspace} onOpenSettings={() => openSettings({ section: "queue", workspace })} />;
  const summary = useMemo(() => queueSummary(view?.effective ?? []), [view]);
  const finished = view ? view.entries.filter((entry) => entry.resolved).length : 0;
  const standing = view ? <Standing summary={summary} finished={finished} busy={queue.busy} onPrune={queue.prune} /> : null;
  const live = runs.live.find((entry) => entry.workspace === workspace && entry.run.scope.kind === "queue");
  const hasPlan = (view?.entries.length ?? 0) > 0;

  const header =
    mode === "page" ? (
      <PageStrip
        policy={policyTag}
        standing={standing}
        autopilot={live ? <AutopilotLink onOpen={() => session.openRun(live.run.id)} /> : undefined}
        add={add}
      />
    ) : (
      <SectionHeader
        workspace={workspace}
        prefix={prefix}
        folded={folded}
        onToggle={() => onFold?.(workspace)}
        policy={policyTag}
        standing={standing}
        add={<AddToQueue workspace={workspace} options={queue.candidates} onPick={(ref) => queue.add(ref)} disabled={queue.busy || view === null} compact />}
      />
    );

  let next: NextState = { kind: "empty" };
  if (view && queue.next) next = { kind: "pick", row: queue.next, why: whyNext(queue.next, queue.skipped, hasPlan) };
  else if (view && hasOpenWork(view.effective)) next = { kind: "none", text: nothingPickable(view.effective) };

  return (
    <section
      className="q-sec"
      aria-label={`${workspace} queue`}
      data-queue-section={workspace}
      data-folded={folded ? "" : undefined}
      data-queue-revision={view?.revision}
      data-page={mode === "page" ? "" : undefined}
    >
      {header}
      {!view ? (
        queue.error ? (
          <div className="px-4">
            <ErrorState error={queue.error} />
          </div>
        ) : (
          <QueueSkeleton header={false} />
        )
      ) : (
        <SectionBody
          workspace={workspace}
          layout={layout}
          next={next}
          folded={folded}
          hasPlan={hasPlan}
          busy={queue.busy}
          pending={queue.pending}
          failure={queue.failure}
          activeKey={roving.activeKey}
          register={roving.register}
          onOpen={open}
          onShow={show}
          onToggle={toggleContainer}
          onWhole={(identifier) =>
            setFolds((current) => {
              const whole = new Set(current.whole);
              if (whole.has(identifier)) whole.delete(identifier);
              else whole.add(identifier);
              return { ...current, whole };
            })
          }
          onBand={() => setFolds((current) => ({ ...current, bandOpen: !(layout.band?.open ?? false) }))}
          onBandWhole={() => setFolds((current) => ({ ...current, bandWhole: !current.bandWhole }))}
          onAdd={(identifier) => queue.add(identifier)}
          onRetry={queue.retry}
          onDismiss={queue.dismissFailure}
          onRowKey={onRowKey}
          menu={menu}
          drag={drag}
          listRef={listRef}
          empty={
            mode === "page" ? (
              <EmptyPlan
                add={<AddToQueue workspace={workspace} options={queue.candidates} onPick={(ref) => queue.add(ref)} disabled={queue.busy} primary />}
              />
            ) : undefined
          }
        />
      )}
    </section>
  );
}

const NOTHING: ReadonlySet<string> = new Set();

/**
 * What the row menu may offer for a row (`queueRowMenuState`): the page's own issue when it
 * has it, else the plan entry's or the wire's, with the holder the queue names, so a claimed
 * row's menu still says who holds it.
 */
function menuState(queue: QueueSection, identifier: string, queuedIds: ReadonlySet<string>) {
  const wire = queue.view?.effective.find((row) => row.identifier === identifier);
  const issue: Issue | undefined =
    queue.known.get(identifier)?.issue ??
    queue.rows.find((plan) => plan.entry.identifier === identifier)?.row.issue ??
    (wire ? issueFromEffective(wire) : undefined);
  if (!issue) return { queued: queuedIds.has(identifier), heldBy: null };
  const holder = issue.checkoutAgent ?? wire?.claim?.heldBy ?? (typeof wire?.detail?.heldBy === "string" ? wire.detail.heldBy : null);
  const row: Pick<TaskRow, "issue"> = { issue: { ...issue, checkoutAgent: holder } };
  return queueRowMenuState(row, queuedIds);
}
