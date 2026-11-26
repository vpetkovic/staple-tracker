/**
 * The Milestones page for one workspace, as an outline: the shape of Plan's Horizons lens. One
 * scroller of stacked sections, one per open milestone in `sortMilestones` order, then the
 * Finished shelf (one folded line, then a line per finished or cancelled milestone), then under
 * 760px of the page a full-width "Add a milestone" row. The full record (description, activity,
 * documents) opens in the detail drawer.
 *
 * FOLDING. Every open section folds with its chevron. The choice is remembered per workspace and
 * milestone in this browser (`milestones-memory.ts`); with none, a section is unfolded from 760px
 * and folded under it, so a phone's first screen is the overview. Collapse all / Expand all
 * writes the choice for every open milestone. The shelf's own open state is remembered too.
 *
 * LANDING. The address's focus (`?focus=`, `session.milestoneFocus`) is where a link lands: an
 * open milestone's section scrolls to the top, unfolds for the visit (nothing remembered
 * changes) and is marked for a moment; a finished one opens the shelf and its line; one the
 * list does not carry gets a line saying so with a way to open it. The page itself never sets
 * the focus: a name opens the drawer.
 */
import { ChevronDown, ChevronRight, Milestone, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState as PlainEmptyState } from "@/components/plain/States";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AuthError } from "@/lib/api";
import { useIsDesk } from "@/lib/use-media";
import { usePhoneHeaderSlot } from "@/lib/phone-header-slot";
import { useSession } from "@/lib/session";
import type { EffectiveQueueRow, MilestoneListRow } from "@/lib/types";
import { useElementWidth } from "@/views/plan/plan-parts";
import { TAP_TEXT } from "./milestone-parts";
import { FinishedLine, OpenSection } from "./MilestoneSection";
import { isFinishedMilestone, selectedMilestone } from "./milestones-model";
import { foldAllAction, loadMilestonesMemory, MILESTONES_NARROW, saveMilestonesMemory, sectionFolded, withAllFolded, type MilestonesMemory } from "./milestones-memory";
import { AddMilestoneRow, createMilestone, MilestonesToolbar } from "./MilestonesToolbar";

/** How long a landed section stays marked. */
const LANDED_MS = 1600;
/** How long a landing keeps its section at the top while the sections above it finish reading. */
const HOLD_MS = 3000;

/** The open milestones in plan order, and the finished ones, the most recently closed first. */
export function outlineGroups<T extends Pick<MilestoneListRow, "milestone">>(sorted: readonly T[]): { open: T[]; finished: T[] } {
  return {
    open: sorted.filter((row) => !isFinishedMilestone(row.milestone.state)),
    finished: sorted.filter((row) => isFinishedMilestone(row.milestone.state)).sort((a, b) => (b.milestone.closedAt ?? "").localeCompare(a.milestone.closedAt ?? "")),
  };
}

/** Where a focus lands: an open section, a finished line, or nowhere this list carries. */
export function landingOf(focus: string | null, groups: { open: readonly Pick<MilestoneListRow, "milestone">[]; finished: readonly Pick<MilestoneListRow, "milestone">[] }): { kind: "open" | "finished" | "missing"; identifier: string } | null {
  const identifier = selectedMilestone({ focus, listed: groups.open, fillPane: false });
  if (!identifier) return null;
  if (groups.open.some((row) => row.milestone.identifier === identifier)) return { kind: "open", identifier };
  if (groups.finished.some((row) => row.milestone.identifier === identifier)) return { kind: "finished", identifier };
  return { kind: "missing", identifier };
}

export function MilestonesOutline({
  workspace,
  rows,
  effective,
  queueRevision,
  onAuthError,
}: {
  workspace: string;
  /** Every milestone, finished ones included, in `sortMilestones` order. */
  rows: readonly MilestoneListRow[];
  effective: readonly EffectiveQueueRow[];
  queueRevision: number | undefined;
  onAuthError: (error: AuthError) => void;
}) {
  const session = useSession();
  const desk = useIsDesk();
  const slot = usePhoneHeaderSlot();
  const { ref: frame, width } = useElementWidth<HTMLDivElement>();
  // The page container's width; before it is measured (and in a string render), the shell's.
  const narrow = width === null ? !desk : width < MILESTONES_NARROW;
  // Sections are drawn once the width is known, so none reads at a fold it does not keep.
  const measured = width !== null || typeof ResizeObserver === "undefined";
  const groups = useMemo(() => outlineGroups(rows), [rows]);
  const { open, finished } = groups;

  const [memory, setMemory] = useState<MilestonesMemory>(() => loadMilestonesMemory(workspace));
  const allIds = useMemo(() => rows.map((row) => row.milestone.id), [rows]);
  const remember = useCallback(
    (next: MilestonesMemory) => {
      setMemory(next);
      saveMilestonesMemory(workspace, next, allIds);
    },
    [workspace, allIds],
  );
  /** Sections a link unfolded for this visit, without changing what is remembered. */
  const [visitOpen, setVisitOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [visitShelf, setVisitShelf] = useState(false);
  const [finishedOpen, setFinishedOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [landed, setLanded] = useState<string | null>(null);

  const isFolded = (id: string) => !visitOpen.has(id) && sectionFolded(memory, id, narrow);
  const openIds = open.map((row) => row.milestone.id);
  const action = foldAllAction(openIds, isFolded);
  const foldAll = {
    action,
    disabled: openIds.length === 0,
    onClick: () => {
      setVisitOpen(new Set());
      remember(withAllFolded(memory, openIds, action === "collapse"));
    },
  };
  const fold = (id: string) => {
    const folded = isFolded(id);
    setVisitOpen((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    remember({ ...memory, folded: { ...memory.folded, [id]: !folded } });
  };
  const shelfOpen = memory.finished || visitShelf;
  const toggleShelf = () => {
    setVisitShelf(false);
    remember({ ...memory, finished: !shelfOpen });
  };
  const toggleFinished = (identifier: string) =>
    setFinishedOpen((current) => {
      const next = new Set(current);
      if (!next.delete(identifier)) next.add(identifier);
      return next;
    });

  // Landing: on a focus, once the list and the width are in.
  const sections = useRef(new Map<string, HTMLElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const register = (identifier: string) => (element: HTMLElement | null) => {
    if (element) sections.current.set(identifier, element);
    else sections.current.delete(identifier);
  };
  const landing = landingOf(session.milestoneFocus, groups);
  const landingKey = landing && measured ? `${landing.kind}:${landing.identifier}` : null;
  useEffect(() => {
    if (!landing || !landingKey || landing.kind === "missing") return;
    const { identifier } = landing;
    if (landing.kind === "open") {
      const id = open.find((row) => row.milestone.identifier === identifier)!.milestone.id;
      setVisitOpen((current) => new Set(current).add(id));
      setLanded(identifier);
    } else {
      setVisitShelf(true);
      setFinishedOpen((current) => new Set(current).add(identifier));
    }
    const toTop = () => sections.current.get(identifier)?.scrollIntoView({ block: "start" });
    const frameId = requestAnimationFrame(toTop);
    // Sections above it grow as their reads land (a gate, a goal): keep it at the top for a
    // moment, until the person scrolls or presses anything themselves.
    const box = scroller.current;
    const content = box?.firstElementChild;
    const hold = content && typeof ResizeObserver !== "undefined" ? new ResizeObserver(toTop) : null;
    if (hold && content) hold.observe(content);
    const release = () => hold?.disconnect();
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const event of events) box?.addEventListener(event, release, { passive: true });
    const held = window.setTimeout(release, HOLD_MS);
    const timer = window.setTimeout(() => setLanded((current) => (current === identifier ? null : current)), LANDED_MS);
    return () => {
      cancelAnimationFrame(frameId);
      release();
      for (const event of events) box?.removeEventListener(event, release);
      window.clearTimeout(held);
      window.clearTimeout(timer);
    };
    // Once per landing: the rows' identity changes on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landingKey]);

  return (
    // The frame is always drawn: it is what the width is measured on.
    <div ref={frame} className="@container/ms flex h-full min-h-0 flex-col" data-milestones-view={workspace}>
      {rows.length === 0 ? (
        <div className="h-full overflow-y-auto px-gutter py-10" data-milestones-empty="none">
          <PlainEmptyState compact icon={Milestone} title="No milestones here yet">
            A milestone gathers tasks that should be finished by a date. Create one, or ask an agent to.
          </PlainEmptyState>
          <div className="mt-3 flex justify-center">
            <Button variant="outline" size="sm" className="h-8 min-h-0" onClick={createMilestone} data-create-milestone="">
              <Plus aria-hidden />
              Milestone
            </Button>
          </div>
        </div>
      ) : (
        <>
          <MilestonesToolbar open={open.length} finished={finished.length} foldAll={foldAll} slot={slot} />
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6" data-milestones-outline="">
            {measured ? (
              <div data-milestones-content="">
                {landing?.kind === "missing" ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-label text-text-secondary @max-[760px]/ms:px-3" data-milestone-missing={landing.identifier}>
                    <span>{landing.identifier} is not in this list.</span>
                    <Button variant="outline" size="sm" className={TAP_TEXT} onClick={() => session.open(workspace, landing.identifier)}>
                      Open it
                    </Button>
                  </div>
                ) : null}
                {open.length === 0 ? (
                  <section className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b bg-surface-sunken py-2.5 pr-4 pl-[42px] @max-[760px]/ms:px-3" data-milestones-none-open="">
                    <span className="text-body font-semibold text-text-secondary">No open milestones</span>
                  </section>
                ) : null}
                {open.map((row) => (
                  <OpenSection
                    key={row.milestone.identifier}
                    row={row}
                    workspace={workspace}
                    effective={effective}
                    queueRevision={queueRevision}
                    onAuthError={onAuthError}
                    folded={isFolded(row.milestone.id)}
                    onFold={() => fold(row.milestone.id)}
                    narrow={narrow}
                    landed={landed === row.milestone.identifier}
                    sectionRef={register(row.milestone.identifier)}
                  />
                ))}
                {finished.length > 0 ? (
                  <section aria-label="Finished" data-milestones-finished="">
                    <button
                      type="button"
                      className="focus-ring-inset flex min-h-9 w-full items-center gap-2 border-b bg-surface-sunken py-1.5 pr-4 pl-[15px] text-left text-label text-text-secondary hover:bg-surface-hover @max-[760px]/ms:pl-[11px]"
                      aria-expanded={shelfOpen}
                      onClick={toggleShelf}
                      data-milestones-shelf=""
                    >
                      {shelfOpen ? <ChevronDown className="size-3.5 shrink-0 text-text-tertiary" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />}
                      <span className="ml-1.5 font-semibold">Finished</span>
                      <span className="tabular-nums text-text-tertiary">{finished.length}</span>
                      <span className="text-text-tertiary">· {shelfOpen ? "hide" : "show"}</span>
                    </button>
                    {shelfOpen
                      ? finished.map((row) => (
                          <div key={row.milestone.identifier} ref={register(row.milestone.identifier)}>
                            <FinishedLine
                              row={row}
                              workspace={workspace}
                              onAuthError={onAuthError}
                              open={finishedOpen.has(row.milestone.identifier)}
                              onToggle={() => toggleFinished(row.milestone.identifier)}
                            />
                          </div>
                        ))
                      : null}
                  </section>
                ) : null}
                <AddMilestoneRow />
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** While the list loads: two sections shaped like the header, as Plan's lens skeleton is. */
export function MilestonesSkeleton() {
  return (
    <div className="@container/ms flex h-full min-h-0 flex-col" aria-busy="true" data-milestones-loading="">
      <span role="status" className="sr-only">
        Loading the milestones
      </span>
      <div className="flex items-center gap-2 border-b px-gutter py-2 @max-[760px]/ms:hidden">
        <Skeleton className="h-3.5 w-32" />
        <span className="ms-auto" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-24" />
      </div>
      {[0, 1].map((key) => (
        <div key={key} className="flex items-start gap-3 border-b px-gutter py-3">
          <Skeleton className="mt-1 size-4 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3.5 w-28 @max-[760px]/ms:hidden" />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Skeleton className="h-2 w-[340px] max-w-full @max-[760px]/ms:w-full" />
              <Skeleton className="h-3.5 w-9" />
            </div>
            <Skeleton className="h-3 w-[420px] max-w-full" />
          </div>
          <Skeleton className="size-7 shrink-0" />
        </div>
      ))}
    </div>
  );
}
