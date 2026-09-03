/**
 * One control for epics — O4b (STA-134).
 *
 * ── WHAT THIS REPLACES, AND WHY IT WAS WRONG ─────────────────────────────────────────
 *
 * The row used to carry TWO epic controls sitting next to each other:
 *
 *   - a popover listing every epic, where clicking a row toggled COLLAPSE;
 *   - a `<Select>` beside it, where choosing an epic set the FILTER.
 *
 * Two lists of the same nouns, a hand's width apart, where the same gesture means two
 * different things. VP's note on the ticket — "those two are confused today" — is the
 * predictable result: you cannot tell from the control which question you are answering,
 * and the Select could only ever hold ONE epic, so "show me these two and how they
 * relate" was not askable at all.
 *
 * This is one list where BOTH answers are visible on every row and neither can be given
 * by accident. The row body selects (a checkbox, on the left, where a checkbox lives).
 * The trailing chevron collapses (aria-pressed, at the far right, away from the body).
 * Selecting never touches collapse and collapsing never touches selection — they are two
 * pieces of state in GraphView and two callbacks here, with nothing joining them.
 *
 * ── WHY IT IS NOT `SearchableSelect` ─────────────────────────────────────────────────
 *
 * R7's control is the right LANGUAGE and the wrong CONTAINER, for two reasons:
 *
 *   1. ARIA. `SearchableSelect` is cmdk, so its rows are `role="option"` inside a
 *      listbox. An option may not contain a button — a listbox is a list of values, not
 *      of widgets — and a per-row collapse toggle is exactly a button inside a row. The
 *      picker is therefore a group of buttons, not a listbox, and says so.
 *   2. Its `SelectOption` has no depth, and hierarchy is half of this ticket.
 *
 * So this file borrows R7's rules rather than its component, and where it borrows it
 * borrows exactly: own filtering that PRESERVES ORDER (a fuzzy scorer puts `STA-118`
 * above `STA-1` for the query "STA-1", which makes a list of identifiers unaimable),
 * `StatusIcon` from the task-list barrel so "done" looks like done everywhere, chips
 * below/beside the trigger in the same markup, and a trigger that describes what it
 * holds. The filtering itself lives in `graph-clusters.ts` as pure functions with tests,
 * for the same reason R7 keeps `filterOptions` outside cmdk: filtering that lives inside
 * a third-party component is filtering no test can reach.
 *
 * ── KEYBOARD ────────────────────────────────────────────────────────────────────────
 *
 * Up/Down move between rows, Home/End jump, and — because this list is a TREE — Left and
 * Right collapse and expand the focused epic, which is what those keys mean in every
 * tree a user has ever met. That is also why arrows do not select: selection repaints the
 * canvas, and a keyboard user scanning the list would strobe the graph they are reading.
 * Space and Enter on the row select, which is what a checkbox does. Same rule O4a wrote
 * into the View menu next door; the arithmetic is literally the same function.
 */
import { ChevronDown, ChevronRight, Layers, Search, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
// Through the barrel, never from a file inside it — the same rule searchable-select.tsx
// follows. A second set of status shapes is a second set to keep in step.
import { StatusIcon, KindGlyph } from "@/components/task-list";
import { cn } from "@/lib/utils";
import type { IssueKind } from "@/lib/types";
import { filterEpicRows, flattenEpics, type EpicSummary } from "./graph-clusters";
import { nextOptionIndex } from "./GraphToolbar";

/**
 * The trigger's words, in the idiom O4a settled for this row: the control states its own
 * state rather than signalling it with a highlight, so the label is also the accessible
 * name and a screen reader hears the state instead of a generic "Epics".
 *
 * The two numbers are deliberately never merged. "2 selected · 5 collapsed" is the whole
 * point of the ticket said in four words — they are different facts about different
 * things, and a single count would put us back where we started.
 */
export function epicTriggerLabel(selectedCount: number, collapsedCount: number): string {
  const parts: string[] = [];
  if (selectedCount > 0) parts.push(`${selectedCount} selected`);
  if (collapsedCount > 0) parts.push(`${collapsedCount} collapsed`);
  return parts.length === 0 ? "Epics" : `Epics: ${parts.join(" · ")}`;
}

/** One indent step, in pixels. Matches the task list's own `INDENT_STEP` feel at menu size. */
export const EPIC_INDENT_PX = 14;

export interface EpicPickerProps {
  epics: readonly EpicSummary[];
  /** Which epics the canvas is pinned to. Empty means the whole graph. */
  selected: ReadonlySet<string>;
  onToggleSelect: (epic: string) => void;
  onClearSelection: () => void;
  /** Which epics are drawn as super-nodes. Independent of `selected`, always. */
  collapsed: ReadonlySet<string>;
  /** Absolute rather than a toggle, because Left/Right are directions, not flips. */
  onSetCollapse: (epic: string, collapse: boolean) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}

export function EpicPicker({
  epics,
  selected,
  onToggleSelect,
  onClearSelection,
  collapsed,
  onSetCollapse,
  onCollapseAll,
  onExpandAll,
}: EpicPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Clear on every OPEN rather than on close: a list that reopens still holding the last
  // query looks broken, and clearing on close happens under the animation. R7's rule.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // No epics means no parent information (hub mode) or a genuinely flat workspace. Either
  // way every control here would be a no-op, and a row of dead buttons is worse than no
  // row. Same call `EpicControls` made before this replaced it.
  if (epics.length === 0) return null;

  const collapsedCount = epics.filter((epic) => collapsed.has(epic.id)).length;
  const label = epicTriggerLabel(selected.size, collapsedCount);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-epic-picker
            data-epic-selected={selected.size}
            data-epic-collapsed={collapsedCount}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              label !== "Epics" && "text-foreground",
            )}
          >
            <Layers className="size-3.5" aria-hidden />
            {label}
          </Button>
        </PopoverTrigger>
        {/* Wider than the View menu because these rows carry an identifier, a title and a
            count; narrower and the title truncates to nothing on the rows that matter. */}
        <PopoverContent align="end" className="w-[26rem] p-0">
          <EpicPickerBody
            epics={epics}
            query={query}
            onQuery={setQuery}
            selected={selected}
            onToggleSelect={onToggleSelect}
            onClearSelection={onClearSelection}
            collapsed={collapsed}
            onSetCollapse={onSetCollapse}
            onCollapseAll={onCollapseAll}
            onExpandAll={onExpandAll}
          />
        </PopoverContent>
      </Popover>

      {/*
        The selection as chips, beside the trigger rather than under it — this is a
        toolbar row, and a second line appearing under one button would shove the canvas
        down every time somebody picked an epic. Same markup as R7's chips so the two
        controls cannot drift apart visually.
      */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-1" data-epic-chips>
          {epics
            .filter((epic) => selected.has(epic.id))
            .map((epic) => (
              <span
                key={epic.id}
                data-epic-chip={epic.id}
                className="border-input bg-surface-hover flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1.5 text-[12px]"
              >
                <StatusIcon status={epic.status} className="size-3.5 shrink-0" />
                <span className="font-mono">{epic.id}</span>
                <button
                  type="button"
                  onClick={() => onToggleSelect(epic.id)}
                  aria-label={`Remove ${epic.id}`}
                  data-epic-chip-remove={epic.id}
                  className={cn(
                    "flex size-4 items-center justify-center rounded-sm text-text-tertiary transition-colors",
                    "hover:bg-surface-hover hover:text-foreground",
                    "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  )}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The popover's contents.
 *
 * SEPARATE FROM THE POPOVER, AND EXPORTED, for the reason `ViewOptions` is: Radix renders
 * content through a portal and only while open, so a closed popover has no markup this
 * repo's `react-dom/server` tests can see, and forcing one open in a server render tests
 * Radix rather than this ticket. Every claim STA-134 makes about the list — the rows, the
 * indentation, the two independent states, the header buttons — is a claim about THIS
 * element, so this is the element the test renders.
 *
 * Query is lifted to the parent so that it resets on open in one place.
 */
export function EpicPickerBody({
  epics,
  query,
  onQuery,
  selected,
  onToggleSelect,
  onClearSelection,
  collapsed,
  onSetCollapse,
  onCollapseAll,
  onExpandAll,
}: EpicPickerProps & { query: string; onQuery: (query: string) => void }) {
  const rows = filterEpicRows(flattenEpics(epics), query);
  const collapsedCount = epics.filter((epic) => collapsed.has(epic.id)).length;

  /**
   * Focus movement, and the tree keys.
   *
   * Reads the DOM rather than tracking an index, exactly as `ViewOptions` does: the row
   * set changes as you type, and a remembered index is precisely the thing that goes
   * stale when the list narrows underneath it.
   *
   * The guard on the search box is load-bearing. Left/Right/Home/End inside a text field
   * belong to the text field — hijacking them to collapse an epic would make the search
   * box unusable — but Down out of the box has nowhere else to mean anything, so it
   * moves into the list.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const inSearch = (event.target as HTMLElement)?.dataset?.epicSearch !== undefined;
    if (inSearch && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-epic-select]"),
    ];
    if (buttons.length === 0) return;

    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const epic = (document.activeElement as HTMLElement | null)?.dataset?.epicSelect;
      if (epic === undefined) return;
      event.preventDefault();
      onSetCollapse(epic, event.key === "ArrowLeft");
      return;
    }

    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    // From the search box `from` is -1, which `nextOptionIndex` refuses; Down should
    // still enter the list, so aim at the first row explicitly.
    if (from < 0) {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      buttons[0]?.focus();
      return;
    }
    const next = nextOptionIndex(buttons.length, from, event.key);
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div data-epic-picker-body onKeyDown={onKeyDown}>
      {/* Styled as cmdk's own CommandInput wrapper, so the search box in this popover and
          the one in the create dialog's pickers are the same object to the eye. */}
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <Search className="size-4 shrink-0 opacity-50" aria-hidden />
        <input
          type="text"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          data-epic-search
          aria-label="Search epics"
          placeholder="Search epics by identifier or title"
          className="placeholder:text-muted-foreground flex h-9 w-full bg-transparent text-base outline-hidden md:text-sm"
        />
      </div>

      {/*
        The header. Collapse all and Expand all act on EVERY epic, not on the rows the
        query happens to be showing — a button labelled "all" that quietly meant "the six
        of forty you can currently see" is the more surprising of the two readings, and
        the count beside it says what "all" is.
      */}
      <div className="flex items-center gap-1 border-b px-1.5 py-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-epic-collapse-all
          onClick={onCollapseAll}
          className="text-muted-foreground hover:text-foreground"
        >
          Collapse all
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-epic-expand-all
          onClick={onExpandAll}
          className="text-muted-foreground hover:text-foreground"
        >
          Expand all
        </Button>
        <span className="ml-auto pr-1 text-[11px] text-muted-foreground tabular-nums">
          {collapsedCount}/{epics.length} collapsed
        </span>
      </div>

      {/*
        A scroll cap because the epic count is the workspace's, not ours — eight today,
        forty on a repo that has been running a while, and a popover taller than the
        viewport has no way back to its own buttons.
      */}
      <div
        role="group"
        aria-label="Epics"
        data-epic-rows
        className="max-h-[18rem] overflow-y-auto p-1"
      >
        {rows.length === 0 ? (
          <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">
            no epic matches
          </p>
        ) : (
          rows.map((row, index) => (
            <EpicPickerRow
              key={row.epic.id}
              epic={row.epic}
              depth={row.depth}
              matched={row.matched}
              selected={selected.has(row.epic.id)}
              collapsed={collapsed.has(row.epic.id)}
              /* One tab stop for the whole list — the roving pattern O4a uses. The first
                 row is it, because "the selected one" is not a single row here. */
              tabStop={index === 0}
              onToggleSelect={onToggleSelect}
              onSetCollapse={onSetCollapse}
            />
          ))
        )}
      </div>

      {/*
        Only when there is something to clear. "Empty selection is the whole graph" is a
        rule that has to be reachable in one click, and hunting for the last chip's X is
        not one click.
      */}
      {selected.size > 0 ? (
        <div className="border-t px-1.5 py-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-epic-clear
            onClick={onClearSelection}
            className="text-muted-foreground hover:text-foreground"
          >
            Show the whole graph
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One row: the search popup's anatomy, plus an indent and a collapse control.
 *
 *   [indent] [checkbox] [kind] [status] [STA-53] [title…] [3/9] │ [chevron]
 *
 * The two buttons are siblings, not nested — a button inside a button is invalid HTML and
 * the browser's own hit-testing gives up on it, which is how a "collapse" click becomes a
 * "select" click on somebody's machine and nobody else's.
 *
 * The indent is inline `paddingLeft` rather than a class because depth is data. A
 * Tailwind class per level would cap the hierarchy at however many levels somebody
 * remembered to write, and JIT would drop the ones no fixture happened to use.
 */
function EpicPickerRow({
  epic,
  depth,
  matched,
  selected,
  collapsed,
  tabStop,
  onToggleSelect,
  onSetCollapse,
}: {
  epic: EpicSummary;
  depth: number;
  matched: boolean;
  selected: boolean;
  collapsed: boolean;
  tabStop: boolean;
  onToggleSelect: (epic: string) => void;
  onSetCollapse: (epic: string, collapse: boolean) => void;
}) {
  return (
    <div
      className="flex items-center gap-0.5"
      data-epic-row={epic.id}
      data-epic-depth={depth}
      style={{ paddingLeft: depth * EPIC_INDENT_PX }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        tabIndex={tabStop ? 0 : -1}
        onClick={() => onToggleSelect(epic.id)}
        data-epic-select={epic.id}
        data-epic-matched={matched ? "" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-muted",
          "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          // A row present only to hold up a match's indentation is context, not a result.
          !matched && "opacity-60",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
            selected ? "border-primary bg-primary" : "border-border-strong",
          )}
        />
        <EpicKindMark kind={epic.kind} />
        <StatusIcon status={epic.status} className="size-3.5 shrink-0" />
        <span className="w-[4.5rem] shrink-0 font-mono text-[11px] text-muted-foreground">
          {epic.id}
        </span>
        <span className="truncate text-[12px]">{epic.title}</span>
        <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground tabular-nums">
          {epic.resolved}/{epic.total}
        </span>
      </button>
      <button
        type="button"
        aria-pressed={collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${epic.id}`}
        tabIndex={-1}
        onClick={() => onSetCollapse(epic.id, !collapsed)}
        data-epic-collapse={epic.id}
        data-collapsed={collapsed ? "" : undefined}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors",
          "hover:bg-muted",
          "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          collapsed ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {collapsed ? (
          <ChevronRight className="size-3.5" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5" aria-hidden />
        )}
      </button>
    </div>
  );
}

/**
 * The kind glyph — the shared one from the task list, so a graph popover and a tree row
 * draw an epic with the same mark. A cluster without a kind on the wire is an epic by
 * construction (it has children), hence the fallback.
 */
function EpicKindMark({ kind }: { kind?: IssueKind }) {
  return (
    <KindGlyph
      kind={kind ?? "epic"}
      size={14}
      labelled={false}
      className="shrink-0 text-muted-foreground"
    />
  );
}
