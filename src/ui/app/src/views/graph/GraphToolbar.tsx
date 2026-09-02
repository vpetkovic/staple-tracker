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
 */
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { EpicSummary } from "./graph-clusters";
import type { DoneMode, PlanningMode } from "./graph-planning";

/**
 * Radix forbids an empty-string item value, so "no filter" needs a sentinel. Same
 * device, same reason, as ALL_WORKSPACES in AppShell.
 */
const ALL_EPICS = "__all__";

/** The done control cycles rather than offering three buttons; see the note below. */
const DONE_NEXT: Record<DoneMode, DoneMode> = { show: "fade", fade: "hide", hide: "show" };
const DONE_LABEL: Record<DoneMode, string> = {
  show: "done: shown",
  fade: "done: faded",
  hide: "done: hidden",
};

/** G4 — the planning modes. */
export interface GraphToolbarProps {
  /** Which planning question the canvas is answering. */
  mode: PlanningMode;
  onMode: (mode: PlanningMode) => void;
  doneMode: DoneMode;
  onDoneMode: (mode: DoneMode) => void;
  /**
   * Path-to-target needs a target. Without a selection the toggle is disabled rather
   * than hidden, because a control that appears when you happen to click a node is a
   * control nobody discovers.
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
  /** A mode toggle is its own off switch: pressing the active one returns to `off`. */
  const toggleMode = (next: PlanningMode) => onMode(mode === next ? "off" : next);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/*
        The planning modes are mutually exclusive because they answer different
        questions about the same graph — "what can I start" and "what is in the way of
        this one thing" have different answers and only one set of nodes can be lit.
        Radio semantics via aria-pressed rather than a segmented control: there is a
        real third state (neither), and a segmented control has to invent a name for it.
      */}
      <Button
        type="button"
        variant={mode === "frontier" ? "secondary" : "outline"}
        size="sm"
        aria-pressed={mode === "frontier"}
        onClick={() => toggleMode("frontier")}
        title="Highlight only what could be picked up right now"
      >
        frontier
      </Button>
      <Button
        type="button"
        variant={mode === "path" ? "secondary" : "outline"}
        size="sm"
        aria-pressed={mode === "path"}
        disabled={!hasTarget}
        onClick={() => toggleMode("path")}
        title={
          hasTarget
            ? "Light only the unfinished work standing between today and the selected ticket"
            : "Select a ticket first — this mode needs a target"
        }
      >
        path to target
      </Button>
      {/*
        One cycling button rather than three. The three states are ordered (more shown →
        less shown), the control is pressed repeatedly during a meeting, and its label
        always states the CURRENT state rather than the next one — a button that says
        what it will do leaves you unable to read what is true right now.
      */}
      <Button
        type="button"
        variant={doneMode === "show" ? "outline" : "secondary"}
        size="sm"
        onClick={() => onDoneMode(DONE_NEXT[doneMode])}
        title="Cycle finished work: shown → faded → hidden"
      >
        {DONE_LABEL[doneMode]}
      </Button>

      {/*
        Copy link and export are the two things someone reaches for at the END of looking
        at this, so they sit at the end of the row. The button reports the result in its
        own label rather than through a toast: the confirmation belongs where the click
        was, and this app has no toast system to borrow.
      */}
      <Button type="button" variant="outline" size="sm" onClick={onCopyLink}>
        {copied ?? "copy view link"}
      </Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            export
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

/** G3 — the epic controls. Separate because they vanish when a graph has no epics. */
export interface EpicControlsProps {
  epics: readonly EpicSummary[];
  collapsed: ReadonlySet<string>;
  onToggle: (epic: string) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  /** The epic the canvas is pinned to, or null for the whole graph. */
  filter: string | null;
  onFilter: (epic: string | null) => void;
}

export function EpicControls({
  epics,
  collapsed,
  onToggle,
  onCollapseAll,
  onExpandAll,
  filter,
  onFilter,
}: EpicControlsProps) {
  // No epics means no parent information (hub mode) or a genuinely flat workspace.
  // Either way these controls would all be no-ops, and a row of dead buttons is worse
  // than no row.
  if (epics.length === 0) return null;

  const collapsedCount = epics.filter((epic) => collapsed.has(epic.id)).length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            epics
            <span className="ml-1 tabular-nums text-muted-foreground">
              {collapsedCount}/{epics.length} collapsed
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[22rem] p-1.5">
          <div className="flex items-center gap-1 px-1 pb-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={onCollapseAll}>
              collapse all
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onExpandAll}>
              expand all
            </Button>
          </div>
          {/*
            A scroll cap because the epic count is the workspace's, not ours — eight
            today, forty on a repo that has been running a while, and a popover taller
            than the viewport has no way back to its own buttons.
          */}
          <div className="max-h-[16rem] overflow-y-auto">
            {epics.map((epic) => {
              const isCollapsed = collapsed.has(epic.id);
              return (
                <button
                  key={epic.id}
                  type="button"
                  onClick={() => onToggle(epic.id)}
                  aria-pressed={isCollapsed}
                  className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-muted"
                >
                  <span
                    data-status={epic.status}
                    className="staple-accent-edge h-4 w-1 shrink-0 rounded-full"
                    aria-hidden
                  />
                  <span className="w-[4.5rem] shrink-0 font-mono text-[11px] text-muted-foreground">
                    {epic.id}
                  </span>
                  <span className="truncate text-[12px]">{epic.title}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-[11px] text-muted-foreground">
                    {epic.resolved}/{epic.total}
                  </span>
                  <span
                    className={cn(
                      "w-[4.5rem] shrink-0 text-right text-[11px]",
                      isCollapsed ? "text-foreground" : "text-muted-foreground/60",
                    )}
                  >
                    {isCollapsed ? "collapsed" : "expanded"}
                  </span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      <Select
        value={filter ?? ALL_EPICS}
        onValueChange={(value) => onFilter(value === ALL_EPICS ? null : value)}
      >
        <SelectTrigger size="sm" className="w-[11rem]" aria-label="Epic filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_EPICS}>all epics</SelectItem>
          {epics.map((epic) => (
            <SelectItem key={epic.id} value={epic.id}>
              {epic.id} · {epic.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
