/**
 * The canvas's controls — G3 (STA-56).
 *
 * One row above the canvas rather than a floating panel on it: the graph is already the
 * densest surface in the app, and every pixel of overlay is a pixel of the thing you
 * came to look at. It sits beside the legend, which is where the eye already goes to ask
 * "what am I looking at".
 *
 * This component holds no state. Collapse, filter and (from G4) the planning modes all
 * live in GraphView, because the canvas has to read them too and two copies of "which
 * epics are collapsed" is how a toolbar and a diagram start disagreeing.
 *
 * ── O4a (STA-133): THE ROW SPEAKS THE TREE'S LANGUAGE ─────────────────────────────────
 *
 * The five unlabelled toggles this row used to be were a private dialect. The tree view
 * had already settled the question next door — `view-options/GroupByMenu.tsx` and
 * `filters/FilterBar.tsx` — so the graph now says the same thing the same way:
 *
 *   1. **One trigger that states its own state.** "Group" becomes "Group: Status"; here
 *      "View" becomes "View: Frontier · done faded". Nothing has to be inferred from a
 *      highlight, and the label is the accessible name, so a screen reader hears the
 *      state too. That is also why there is no `aria-label` on the trigger — one would
 *      overwrite the very words that carry the information.
 *   2. **Muted until it is doing something.** `text-muted-foreground` at rest,
 *      `text-foreground` once the view is non-default. Same rule as Filter and Group.
 *   3. **Radiogroups with hints, not toggles.** The old modes made "off" the act of
 *      pressing the lit button again — a state with no name and no way to discover it.
 *      `Off` is now an option you can read. The old done control cycled through three
 *      states behind one label, which asked the user to remember an order; three rows
 *      state all three at once and mark the one that is true.
 *
 * Export and Copy link stay buttons at the end of the row: they are what you reach for
 * when you have finished looking, and neither is view state.
 */
import { Check, Download, Link2, SlidersHorizontal } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { DoneMode, PlanningMode } from "./graph-planning";

/**
 * One row of a radiogroup. `hint` is not decoration: it is the difference between a menu
 * of nouns and a menu that tells you what you are choosing, which is the rule
 * GROUP_BY_OPTIONS already follows.
 */
interface ViewOption<T extends string> {
  id: T;
  label: string;
  hint: string;
}

const MODE_OPTIONS: readonly ViewOption<PlanningMode>[] = [
  { id: "off", label: "Off", hint: "Every ticket at full strength" },
  { id: "frontier", label: "Frontier", hint: "Only what could be picked up right now" },
  {
    id: "path",
    label: "Path to target",
    hint: "Only the unfinished work between today and the selected ticket",
  },
];

/**
 * Shown as the hint on Path to target while nothing is selected. The row is disabled
 * rather than hidden — a control that appears when you happen to click a node is a
 * control nobody discovers — and a disabled row with no reason is just a dead end.
 */
const NO_TARGET_HINT = "Select a ticket on the canvas first — this mode needs a target";

const DONE_OPTIONS: readonly ViewOption<DoneMode>[] = [
  { id: "show", label: "Shown", hint: "Finished work stays on the canvas" },
  { id: "fade", label: "Faded", hint: "Finished work dims into the background" },
  { id: "hide", label: "Hidden", hint: "Finished work leaves and its edges bridge across it" },
];

/** The trigger's words, in the same shape GroupByMenu uses. Exported so a test can drive
 *  every combination without rendering a popover. */
export function viewTriggerLabel(mode: PlanningMode, doneMode: DoneMode): string {
  const parts: string[] = [];
  if (mode !== "off") parts.push(MODE_OPTIONS.find((o) => o.id === mode)?.label ?? "");
  if (doneMode !== "show") parts.push(`done ${doneMode === "fade" ? "faded" : "hidden"}`);
  return parts.length === 0 ? "View" : `View: ${parts.join(" · ")}`;
}

/**
 * Which option an arrow key should move to, or null when the key is not ours.
 *
 * ARROWS MOVE FOCUS, THEY DO NOT SELECT. A textbook radiogroup selects as it moves, but
 * every one of these radios repaints the canvas, so a keyboard user scanning the menu
 * would strobe the graph they are trying to read. Enter and Space choose, which is what
 * the Group menu's rows do; Enter opens and Escape closes come from Radix unchanged.
 *
 * The list is BOTH groups end to end, because it is one menu to the eye and Down out of
 * the last mode should land on the first done option rather than stopping at a heading.
 * Pure and exported so the behaviour is testable without a DOM.
 */
export function nextOptionIndex(count: number, current: number, key: string): number | null {
  if (count === 0 || current < 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** G4 — the planning modes. */
export interface GraphToolbarProps {
  /** Which planning question the canvas is answering. */
  mode: PlanningMode;
  onMode: (mode: PlanningMode) => void;
  doneMode: DoneMode;
  onDoneMode: (mode: DoneMode) => void;
  /**
   * Path-to-target needs a target. Without a selection the row is disabled rather than
   * hidden, because a control that appears when you happen to click a node is a control
   * nobody discovers.
   */
  hasTarget: boolean;
  /** G5 — meeting affordances. */
  onExport: (format: "svg" | "png") => void;
  onCopyLink: () => void;
  /** Transient confirmation text, or null. The parent owns the timer. */
  copied: string | null;
}

export function GraphToolbar({
  mode,
  onMode,
  doneMode,
  onDoneMode,
  hasTarget,
  onExport,
  onCopyLink,
  copied,
}: GraphToolbarProps) {
  const [open, setOpen] = useState(false);
  const label = viewTriggerLabel(mode, doneMode);
  const active = label !== "View";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-graph-view
            data-graph-mode={mode}
            data-graph-done={doneMode}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              active && "text-foreground",
            )}
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
            {label}
          </Button>
        </PopoverTrigger>

        {/*
          One popover, two questions, and it stays open after a choice. GroupByMenu closes
          on select because there is never a second thing to pick; here there always is,
          and closing after Mode would make setting both a two-visit job. Escape and
          click-away close it, which is what those gestures mean everywhere else.
        */}
        <PopoverContent align="end" className="w-72 p-1">
          <ViewOptions
            mode={mode}
            onMode={onMode}
            doneMode={doneMode}
            onDoneMode={onDoneMode}
            hasTarget={hasTarget}
          />
        </PopoverContent>
      </Popover>

      {/*
        Copy link and export are the two things someone reaches for at the END of looking
        at this, so they sit at the end of the row. Copy link reports the result in its
        own label rather than through a toast: the confirmation belongs where the click
        was, and this app has no toast system to borrow.
      */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-graph-copy
        onClick={onCopyLink}
        className="text-muted-foreground hover:text-foreground"
      >
        <Link2 className="size-3.5" aria-hidden />
        {copied ?? "Copy link"}
      </Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-graph-export
            className="text-muted-foreground hover:text-foreground"
          >
            <Download className="size-3.5" aria-hidden />
            Export
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[13rem] p-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => onExport("png")}
          >
            PNG — for a slide
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => onExport("svg")}
          >
            SVG — vector, editable
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The two radiogroups, and the only keyboard code in this file.
 *
 * SEPARATE FROM THE POPOVER ON PURPOSE. Radix renders its content through a portal and
 * only while open, so a popover body is unreachable to this repo's `react-dom/server`
 * tests. Everything the ticket asks to be true of the menu — the groups, the hints, the
 * disabled Path to target, the roving tab stop — is true of THIS element, and a test can
 * render it directly.
 *
 * The key handler treats both groups as one list because that is what the eye sees: Down
 * out of the last mode should land on the first done option, not stop at a heading. It
 * reads the DOM rather than tracking an index in state, because the enabled set changes
 * with `hasTarget` and a remembered index is exactly the thing that goes stale when a row
 * disables itself underneath it.
 */
export function ViewOptions({
  mode,
  onMode,
  doneMode,
  onDoneMode,
  hasTarget,
}: Pick<GraphToolbarProps, "mode" | "onMode" | "doneMode" | "onDoneMode" | "hasTarget">) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])'),
    ];
    const from = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextOptionIndex(rows.length, from, event.key);
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <div data-graph-view-options onKeyDown={onKeyDown}>
      {/*
        The planning modes are mutually exclusive because they answer different questions
        about the same graph — "what can I start" and "what is in the way of this one
        thing" have different answers and only one set of nodes can be lit.
      */}
      <ViewSection title="Mode" label="Planning mode">
        {MODE_OPTIONS.map((option) => {
          const unreachable = option.id === "path" && !hasTarget;
          return (
            <ViewRadio
              key={option.id}
              option={option}
              checked={mode === option.id}
              disabled={unreachable}
              hint={unreachable ? NO_TARGET_HINT : option.hint}
              group="mode"
              onChoose={() => onMode(option.id)}
            />
          );
        })}
      </ViewSection>

      <ViewSection title="Done" label="Finished work">
        {DONE_OPTIONS.map((option) => (
          <ViewRadio
            key={option.id}
            option={option}
            checked={doneMode === option.id}
            hint={option.hint}
            group="done"
            onChoose={() => onDoneMode(option.id)}
          />
        ))}
      </ViewSection>
    </div>
  );
}

/**
 * A titled radiogroup inside the View popover.
 *
 * The heading is a real one rather than a first disabled row: two radiogroups in one
 * popover need names, and `aria-label` on the group carries the long form ("Finished
 * work") while the eye gets the short one ("Done") that fits the row.
 */
function ViewSection({
  title,
  label,
  children,
}: {
  title: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="py-0.5 first:pt-0 last:pb-0">
      <div className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">{title}</div>
      <div role="radiogroup" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/**
 * One option row, in GroupByMenu's markup exactly: a tick column that is always present
 * so the label never shifts, the label, and the hint under it.
 *
 * `tabIndex` roves — the checked row is the group's single tab stop and the arrow handler
 * above moves between rows from there. A disabled row is dropped from the tab order by
 * `disabled` itself, so a Path to target with no target is skipped rather than trapped.
 */
function ViewRadio<T extends string>({
  option,
  checked,
  hint,
  disabled = false,
  group,
  onChoose,
}: {
  option: ViewOption<T>;
  checked: boolean;
  hint: string;
  disabled?: boolean;
  group: "mode" | "done";
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      tabIndex={checked && !disabled ? 0 : -1}
      onClick={onChoose}
      data-view-group={group}
      data-view-option={option.id}
      className={cn(
        "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-accent",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center",
          checked ? "text-foreground" : "text-transparent",
        )}
        aria-hidden
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px]">{option.label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

/*
 * G3's `EpicControls` LIVED HERE AND IS GONE — O4b (STA-134).
 *
 * It was two controls answering two different questions with the same nouns a hand's
 * width apart: a popover whose rows toggled COLLAPSE, and a `<Select>` beside it that set
 * the FILTER to exactly one epic. `views/graph/EpicPicker.tsx` is the single control that
 * replaces both, and the `Select` primitive left this file with it — the View menu is a
 * popover of radios, and nothing in this row is a native select any more.
 */
