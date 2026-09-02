/**
 * The flat task list — R4 (STA-102).
 *
 * THE consumer surface for anywhere that is not the tree: a detail panel's children, a
 * search result set, a milestone's contents. One import, one element, no configuration
 * required beyond naming the container it lives in:
 *
 *     <TaskList rows={children} preset="panel" onOpen={session.open} />
 *
 * ── WHY THIS IS A SEPARATE COMPONENT FROM TreeGrid ────────────────────────────────────
 *
 * TreeGrid does three things this does not: it buckets rows into status groups, it renders
 * sticky collapsible headers, and it implements the tree keyboard map (ArrowRight steps
 * INTO a subtree, ArrowLeft walks out to a parent). None of that is meaningful for a list
 * with no hierarchy, and a component that supported both would spend most of its body
 * deciding which of the two it currently is.
 *
 * What they genuinely share is extracted rather than duplicated: the row (`TaskRowLine`),
 * the geometry and model (`model.ts`), the stylesheet (`task-list.css`), and the one-tab-
 * stop contract (`roving.ts`). That is the whole of the overlap, and it is now impossible
 * for the two lists to drift on any of it.
 *
 * ── LISTBOX, NOT TREEGRID ─────────────────────────────────────────────────────────────
 *
 * `role="listbox"` / `role="option"`. A treegrid announces "there is a hierarchy here and
 * you can navigate it by level", which is a promise a flat list cannot keep. Listbox is
 * what "a set of things, pick one" actually is, and it comes with the roving tab stop and
 * `aria-selected` this list already wanted.
 */
import { useCallback, useMemo } from "react";
import type { KeyboardEvent } from "react";
import { TaskRowLine } from "./TaskRowLine";
import { resolveTaskListConfig, type TaskListDensity, type TaskListPreset } from "./config";
import { flatRow, type TaskRow, type TaskSource } from "./model";
import { clampIndex, useRovingFocus } from "./roving";
import "./task-list.css";

export function TaskList({
  rows,
  preset = "panel",
  density,
  label,
  currentRef = null,
  empty = null,
  onOpen,
}: {
  /** Either raw API rows or fully-placed ones — a flat list needs no placement pass. */
  rows: readonly (TaskSource | TaskRow)[];
  preset?: TaskListPreset;
  density?: TaskListDensity;
  /** The accessible name of the list. A listbox without one is "list box, 4 items". */
  label: string;
  /** Identifier currently open in the detail drawer, so the list can mark it. */
  currentRef?: string | null;
  empty?: React.ReactNode;
  onOpen: (workspace: string, identifier: string) => void;
}) {
  const config = useMemo(() => resolveTaskListConfig(preset, { density }), [preset, density]);

  const placed = useMemo<TaskRow[]>(
    () => rows.map((row) => ("depth" in row ? row : flatRow(row))),
    [rows],
  );

  // One clock reading per render rather than one per row, so ten rows cannot disagree
  // about what "3h" means.
  const now = useMemo(() => new Date(), [placed]);

  const keys = useMemo(() => placed.map((row) => row.issue.id), [placed]);
  const focus = useRovingFocus(keys);

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, index: number) => {
      const at = (i: number) => placed[clampIndex(i, placed.length)];
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focus.go(at(index + 1)!.issue.id);
          return;
        case "ArrowUp":
          event.preventDefault();
          focus.go(at(index - 1)!.issue.id);
          return;
        case "Home":
          event.preventDefault();
          focus.go(placed[0]!.issue.id);
          return;
        case "End":
          event.preventDefault();
          focus.go(placed[placed.length - 1]!.issue.id);
          return;
        case "Enter":
        case " ": {
          event.preventDefault();
          const row = placed[index]!;
          onOpen(row.workspace, row.issue.identifier);
          return;
        }
        default:
          return;
      }
    },
    [placed, focus, onOpen],
  );

  if (placed.length === 0) return <>{empty}</>;

  return (
    <div
      role="listbox"
      aria-label={label}
      className="staple-task-list"
      data-density={config.density}
      data-preset={preset}
    >
      {placed.map((row, index) => (
        <TaskRowLine
          key={row.issue.id}
          row={row}
          config={config}
          semantics="list"
          now={now}
          isCurrent={currentRef === row.issue.identifier}
          isFocused={focus.activeKey === row.issue.id}
          onOpen={() => onOpen(row.workspace, row.issue.identifier)}
          onFocus={() => focus.set(row.issue.id)}
          onKeyDown={(event) => handleKey(event, index)}
          registerRef={focus.register(row.issue.id)}
        />
      ))}
    </div>
  );
}
