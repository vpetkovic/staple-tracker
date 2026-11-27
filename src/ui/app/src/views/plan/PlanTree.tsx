/**
 * A horizon's plan drawn as an outline (design/plan.md, "Presentation"): the one component the
 * Horizons lens, the horizon drawer and the Milestones view render, from `plan-tree.ts`. A tree
 * grid of rows with the columns Idea, Progress, Next and Planned; a parent folds its sub-ideas,
 * and two or more shipped leaves under it gather into one line. The layout follows the tree's own
 * width (`@container/tree`), so a narrow drawer gets the compact two-line rows on a wide screen:
 * under 760px a row is its title, then its state, progress, flags and step on a second line, and
 * groups start folded. Rows are one tab stop with roving focus. Every number is the server's.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { IdeaData } from "@/lib/plan-types";
import { useIsDesk, useMediaQuery } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { ideaPlanHref } from "@/detail/PlannedIdeaLinks";
import { STATE_WORDS } from "@/detail/plan-record";
import { ShippedCheck } from "@/detail/ShippedMark";
import { Amber, Flag, IdeaNumber, PLAN_WIDTH, SegmentedBar, StateGlyph, planIncomplete, useElementWidth } from "./plan-parts";
import { dayLabel } from "./plan-model";
import { outlineEntries, outlineKey, type OutlineEntry } from "./plan-outline";
import type { TreeRow } from "./plan-tree";

export { SegmentedBar } from "./plan-parts";

/** How a row opens its record: in place (the lens's drawer), or as a link to it in Plan (the drawer and Milestones). */
export type TreeOpener = { onOpen: (id: string) => void } | { workspace: string };

/** The grid every line of the outline shares: two columns on a compact tree, four from 760px, five from 1040px. */
const GRID =
  "grid grid-cols-[minmax(0,1fr)_36px] items-center gap-x-2 px-3 @min-[760px]/tree:grid-cols-[minmax(0,1fr)_130px_200px_28px] @min-[760px]/tree:gap-x-4 @min-[760px]/tree:px-4 @min-[1040px]/tree:grid-cols-[minmax(0,1fr)_150px_250px_140px_28px]";
const LINE = "relative min-h-9 cursor-pointer border-b border-border/60 outline-none hover:bg-surface-hover focus-ring-inset";

/**
 * The tree's rows. `menu` draws a row's `⋯` (the lens's move menu; never on a reserved or dimmed
 * row); `drag` lets a delivery row be dragged to another section, on a wide tree under a fine
 * pointer only; `unfold` (a focus or filter is on) folds nothing away.
 */
export function PlanTree({
  rows,
  opener,
  drag = false,
  unfold = false,
  selected = null,
  menu,
  onDrag,
  label = "Ideas",
}: {
  rows: TreeRow[];
  opener: TreeOpener;
  drag?: boolean;
  unfold?: boolean;
  selected?: string | null;
  menu?: (row: TreeRow, tabIndex: number) => ReactNode;
  onDrag?: (idea: IdeaData | null) => void;
  label?: string;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const desk = useIsDesk();
  const fine = useMediaQuery("(pointer: fine)", true);
  // The tree's own width once laid out; before that (and in a string render), the shell's.
  const compact = width === null ? !desk : width < PLAN_WIDTH.compact;
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [shipOpen, setShipOpen] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  // A group starts open on a wide tree and folded on a compact one, until the person says otherwise.
  const isOpen = (id: string) => opened[id] ?? !compact;
  const entries = outlineEntries(rows, { isOpen, shipOpen, unfold });
  const current = entries.some((entry) => entry.key === active) ? active : (entries[0]?.key ?? null);

  const focusLine = (key: string) => ref.current?.querySelector<HTMLElement>(`[data-plan-outline-key="${CSS.escape(key)}"]`)?.focus();
  useEffect(() => {
    if (pending.current === null) return;
    focusLine(pending.current);
    pending.current = null;
  });
  const toggle = (id: string) => setOpened((all) => ({ ...all, [id]: !isOpen(id) }));
  const openShipped = (parent: string) => {
    setShipOpen((all) => new Set([...all, parent]));
    // The line it was is gone: focus moves to the first leaf it gathered.
    const first = entries.find((entry) => entry.kind === "shipped" && entry.parent === parent);
    if (first?.kind === "shipped" && first.rows[0]) {
      setActive(first.rows[0].idea.id);
      pending.current = first.rows[0].idea.id;
    }
  };
  const activate = (id: string, line: HTMLElement | null) => {
    if ("onOpen" in opener) opener.onOpen(id);
    else line?.querySelector<HTMLAnchorElement>("a[data-open-plan-idea]")?.click();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const line = event.target as HTMLElement;
    const key = line.dataset.planOutlineKey;
    // Keys belong to the line itself; its ⋯ menu keeps its own.
    if (key === undefined) return;
    const move = outlineKey(entries, key, event.key, !unfold);
    if (move === null) return;
    event.preventDefault();
    if ("focus" in move) {
      setActive(move.focus);
      focusLine(move.focus);
    } else if ("toggle" in move) toggle(move.toggle);
    else if ("shipOpen" in move) openShipped(move.shipOpen);
    else activate(move.activate, line);
  };

  return (
    <div ref={ref} className="@container/tree min-w-0">
      <div role="treegrid" aria-label={label} className="min-w-0" data-plan-tree="" onKeyDown={onKeyDown}>
        <div aria-hidden className={cn(GRID, "hidden border-b bg-surface-sunken py-1.5 text-caption text-text-tertiary @min-[760px]/tree:grid")}>
          <span>Idea</span>
          <span>Progress</span>
          <span>Next</span>
          <span className="hidden text-right @min-[1040px]/tree:block">Planned</span>
          <span />
        </div>
        {entries.map((entry) => {
          const tabIndex = entry.key === current ? 0 : -1;
          const focus = () => setActive(entry.key);
          if (entry.kind === "shipped") return <ShippedLine key={entry.key} entry={entry} tabIndex={tabIndex} onFocus={focus} onOpen={() => openShipped(entry.parent)} />;
          const { row } = entry;
          const delivery = !row.reserved && row.where === null;
          return (
            <OutlineRow
              key={entry.key}
              entry={entry}
              opener={opener}
              tabIndex={tabIndex}
              folds={!unfold}
              selected={selected === row.idea.id}
              drag={drag && delivery && !compact && fine ? onDrag ?? (() => {}) : null}
              menu={menu && delivery ? menu(row, tabIndex) : null}
              onFocus={focus}
              onToggle={() => toggle(row.idea.id)}
              onActivate={(line) => activate(row.idea.id, line)}
            />
          );
        })}
      </div>
    </div>
  );
}

function OutlineRow({
  entry,
  opener,
  tabIndex,
  folds,
  selected,
  drag,
  menu,
  onFocus,
  onToggle,
  onActivate,
}: {
  entry: Extract<OutlineEntry, { kind: "row" }>;
  opener: TreeOpener;
  tabIndex: number;
  /** False while a focus or filter is on: every group is open and nothing can fold, so no chevron is drawn. */
  folds: boolean;
  selected: boolean;
  drag: ((idea: IdeaData | null) => void) | null;
  menu: ReactNode;
  onFocus: () => void;
  onToggle: () => void;
  onActivate: (line: HTMLElement) => void;
}) {
  const { row, depth, open } = entry;
  const { idea } = row;
  const shipped = idea.state === "shipped";
  const dimmed = row.where !== null;
  // A row with its delivery menu is the lens's card for it: the part the old board's card played.
  const card = menu !== null;
  const flags = (
    <>
      {idea.late && !shipped ? <Flag tone="late" /> : null}
      {idea.notStarted ? <Flag tone="notStarted" /> : null}
    </>
  );
  return (
    <div
      data-plan-tree-row={idea.id}
      data-plan-tree-depth={depth}
      data-plan-tree-reserved={row.reserved ? "" : undefined}
      data-plan-tree-where={row.where ?? undefined}
      data-plan-outline-key={entry.key}
      data-plan-card={card ? idea.id : undefined}
      data-plan-card-shipped={card && shipped ? "" : undefined}
      role="row"
      aria-level={depth + 1}
      aria-expanded={folds ? (open ?? undefined) : undefined}
      aria-selected={selected}
      tabIndex={tabIndex}
      draggable={drag ? true : undefined}
      onDragStart={
        drag
          ? (event) => {
              event.dataTransfer.setData("text/plain", idea.id);
              event.dataTransfer.effectAllowed = "move";
              drag(idea);
            }
          : undefined
      }
      onDragEnd={drag ? () => drag(null) : undefined}
      onFocus={onFocus}
      onClick={(event: MouseEvent<HTMLDivElement>) => {
        // The title, the chevron and the menu do their own thing.
        if ((event.target as HTMLElement).closest("a, button, [role=menu]")) return;
        onActivate(event.currentTarget);
      }}
      style={{ "--d": depth } as CSSProperties}
      className={cn(
        GRID,
        LINE,
        "group/row",
        selected && "bg-surface-selected hover:bg-surface-selected",
        dimmed && "opacity-55",
        // On a compact tree a sub-idea's indent is a rule down its left edge, not guides.
        depth > 0 && "@max-[760px]/tree:shadow-[inset_2px_0_0_var(--color-border)]",
      )}
    >
      <div role="gridcell" className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 py-[7px] @max-[760px]/tree:items-start @max-[760px]/tree:pt-[9px] @max-[760px]/tree:pb-0 @max-[760px]/tree:pl-[calc(var(--d)*16px)] @min-[760px]/tree:col-auto @min-[760px]/tree:row-auto">
        {Array.from({ length: depth }, (_, index) => (
          <span key={index} aria-hidden className="relative -my-[7px] w-[18px] shrink-0 self-stretch before:absolute before:-top-px before:-bottom-px before:left-2 before:w-px before:bg-border @max-[760px]/tree:hidden" />
        ))}
        {open === null || !folds ? (
          <span aria-hidden className="size-[18px] shrink-0" />
        ) : (
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? "Hide sub-ideas" : "Show sub-ideas"}
            aria-expanded={open}
            data-plan-tree-disclosure={idea.id}
            onClick={onToggle}
            className="relative inline-flex size-[18px] min-h-0 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-active @max-[760px]/tree:mt-[1px] @max-[760px]/tree:before:absolute @max-[760px]/tree:before:-inset-[9px] @max-[760px]/tree:before:content-['']"
          >
            {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          </button>
        )}
        <StateGlyph state={idea.state} percent={idea.percent} className="@max-[760px]/tree:mt-[3px]" />
        <IdeaNumber idea={idea} className="@max-[760px]/tree:mt-[2px]" />
        <RowTitle idea={idea} opener={opener} strong={depth === 0} shipped={shipped} />
        {depth === 0 && row.parentTitle ? <span className="max-w-[30%] shrink truncate text-caption text-text-tertiary @max-[760px]/tree:hidden">in {row.parentTitle}</span> : null}
        <span className="flex shrink-0 items-center gap-1.5 @max-[760px]/tree:hidden">{flags}</span>
      </div>
      {/* On a compact tree, the second line; from 760px its cells are the row's own columns. */}
      <div className="col-span-full row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 pb-[9px] pl-[calc(var(--d)*16px+48px)] text-label text-text-secondary @min-[760px]/tree:contents">
        <div role="gridcell" className="flex min-w-0 items-center gap-2">
          <ProgressCell row={row} />
        </div>
        <span className="flex items-center gap-1.5 empty:hidden @min-[760px]/tree:hidden">{flags}</span>
        <div role="gridcell" className="min-w-0 @min-[760px]/tree:truncate">
          <NextCell row={row} />
        </div>
        {open === false ? (
          <span className="@min-[760px]/tree:hidden">
            {row.children.length} sub-idea{row.children.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      <div role="gridcell" className="hidden truncate text-right text-label text-text-tertiary tabular-nums @min-[1040px]/tree:block">
        {plannedWords(idea)}
      </div>
      <div
        role="gridcell"
        className="col-start-2 row-start-1 -mb-3 flex justify-end self-start pt-1 @min-[760px]/tree:mb-0 [&_button]:m-0 [&_button]:size-9 @min-[760px]/tree:col-auto @min-[760px]/tree:row-auto @min-[760px]/tree:self-center @min-[760px]/tree:pt-0 @min-[760px]/tree:opacity-0 @min-[760px]/tree:[&_button]:size-7 @min-[760px]/tree:group-hover/row:opacity-100 @min-[760px]/tree:group-focus-visible/row:opacity-100 @min-[760px]/tree:focus-within:opacity-100 @min-[760px]/tree:[@media(hover:none)]:opacity-100"
      >
        {menu}
      </div>
    </div>
  );
}

/** `3 shipped: R0 …, R1 …, R2 …`: a parent's shipped leaves as one line, until it is opened. */
function ShippedLine({ entry, tabIndex, onFocus, onOpen }: { entry: Extract<OutlineEntry, { kind: "shipped" }>; tabIndex: number; onFocus: () => void; onOpen: () => void }) {
  const titles = entry.rows.map((row) => row.idea.title).join(", ");
  return (
    <div
      data-plan-outline-key={entry.key}
      data-plan-shipped-fold={entry.parent}
      role="row"
      aria-level={entry.depth + 1}
      aria-expanded={false}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onOpen}
      style={{ "--d": entry.depth } as CSSProperties}
      className={cn(GRID, LINE, "@max-[760px]/tree:shadow-[inset_2px_0_0_var(--color-border)]")}
    >
      <div role="gridcell" className="col-span-full flex min-w-0 items-center gap-2 py-[7px] text-label text-text-tertiary @min-[760px]/tree:col-span-1 @max-[760px]/tree:items-start @max-[760px]/tree:py-[9px] @max-[760px]/tree:pl-[calc(var(--d)*16px)]">
        {Array.from({ length: entry.depth }, (_, index) => (
          <span key={index} aria-hidden className="relative -my-[7px] w-[18px] shrink-0 self-stretch before:absolute before:-top-px before:-bottom-px before:left-2 before:w-px before:bg-border @max-[760px]/tree:hidden" />
        ))}
        <ChevronRight aria-hidden className="size-[18px] shrink-0 p-0.5 @max-[760px]/tree:mt-[1px]" />
        <ShippedCheck label="" className="size-3.5 shrink-0 [&_svg]:size-2.5 @max-[760px]/tree:mt-[3px]" />
        <span className="min-w-0 truncate @max-[760px]/tree:line-clamp-2 @max-[760px]/tree:whitespace-normal @max-[760px]/tree:text-reading" title={titles}>
          {entry.rows.length} shipped: {titles}
        </span>
      </div>
    </div>
  );
}

/** Where the row stands: its bar and the server's percent, or its state in words, or where it is carried instead. */
function ProgressCell({ row }: { row: TreeRow }) {
  const { idea } = row;
  if (row.where !== null) {
    return (
      <span className="truncate text-text-secondary" data-plan-tree-elsewhere>
        {row.where}
      </span>
    );
  }
  if (idea.state === "shipped") {
    return (
      <span className="truncate text-text-secondary" data-plan-tree-state="shipped">
        {idea.actual.end ? `Shipped ${dayLabel(idea.actual.end, false)}` : "Shipped"}
        {idea.delivered !== null ? <span className="text-text-tertiary"> outside the tracker</span> : null}
      </span>
    );
  }
  const word = STATE_WORDS[idea.state] ?? idea.state;
  if (idea.percent !== null && row.units.total > 0) {
    return (
      <>
        {/* Said by the glyph on a wide tree, so only read out there; printed on a compact one. */}
        <span className="sr-only @max-[760px]/tree:not-sr-only" data-plan-tree-state={idea.state}>
          {word}
        </span>
        {/* Not shipped, so not complete: a whole 100 here says incomplete. On a compact tree, the percent before a short bar. */}
        <SegmentedBar
          units={row.units}
          percent={idea.percent}
          complete={false}
          className="mt-0 min-w-0 flex-1 [&>span]:text-label [&>span]:text-text-secondary @max-[760px]/tree:flex-none @max-[760px]/tree:flex-row-reverse @max-[760px]/tree:[&>div]:w-14 @max-[760px]/tree:[&>div]:flex-none @min-[760px]/tree:[&>span]:w-[38px] @min-[760px]/tree:[&>span]:text-right"
        />
      </>
    );
  }
  return (
    <span className="truncate" data-plan-tree-state={idea.state}>
      {word}
      {idea.state === "shaped" && row.units.planned > 0 ? ` · ${row.units.planned} planned` : null}
      {idea.unsized && row.children.length === 0 ? " · unsized" : null}
    </span>
  );
}

/** What comes next: open questions (unless the step asks them), what the plan still lacks, the step, or the work under way. */
function NextCell({ row }: { row: TreeRow }) {
  const { idea } = row;
  const dimmed = row.where !== null;
  const shipped = idea.state === "shipped";
  const parts: ReactNode[] = [];
  if (idea.openQuestions > 0 && !shipped && idea.nextStep?.need !== "answer_questions") {
    parts.push(
      <Amber key="q" data-plan-tree-questions={idea.openQuestions}>
        {idea.openQuestions} question{idea.openQuestions === 1 ? "" : "s"}
      </Amber>,
    );
  }
  // Shaped, but its plan no longer passes the gate: Scaffold is held back until it does.
  if (!dimmed && planIncomplete(idea)) parts.push(<Amber key="pi" data-plan-card-incomplete="">plan incomplete</Amber>);
  if (row.step && !dimmed) {
    parts.push(
      <span key="s" className={cn(row.step.person ? "font-medium text-foreground" : "text-text-secondary")} data-plan-tree-step={idea.nextStep?.need} data-plan-tree-person={row.step.person ? "" : undefined}>
        {row.step.label}
      </span>,
    );
  } else if (!dimmed && idea.state === "started") {
    parts.push(
      <span key="w">
        {idea.linkCount} linked · {row.units.open} open
      </span>,
    );
  }
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? " · " : null}
          {part}
        </span>
      ))}
    </>
  );
}

/** `Nov 10 – Jan 9`, `by Mar 5`, `from Sep 27`: the planned window; nothing once shipped. */
function plannedWords(idea: IdeaData): string {
  if (idea.state === "shipped") return "";
  const { start, target } = idea.planned;
  if (start && target) return `${dayLabel(start, false)} – ${dayLabel(target, false)}`;
  if (target) return `by ${dayLabel(target, false)}`;
  if (start) return `from ${dayLabel(start, false)}`;
  return "";
}

function RowTitle({ idea, opener, strong, shipped }: { idea: IdeaData; opener: TreeOpener; strong: boolean; shipped: boolean }) {
  const className = cn(
    "min-h-0 min-w-0 truncate text-left text-body hover:underline @max-[760px]/tree:line-clamp-2 @max-[760px]/tree:whitespace-normal @max-[760px]/tree:text-reading",
    strong && "font-medium",
    shipped ? "text-text-secondary" : "text-foreground",
  );
  // The row is the tab stop; its title opens the idea on a click.
  if ("onOpen" in opener) {
    return (
      <button type="button" tabIndex={-1} className={className} title={idea.title} data-plan-child={idea.id} onClick={() => opener.onOpen(idea.id)}>
        {idea.title}
      </button>
    );
  }
  return (
    <a href={ideaPlanHref(opener.workspace, idea.id)} tabIndex={-1} className={className} title={idea.title} data-open-plan-idea={idea.id}>
      {idea.title}
    </a>
  );
}
