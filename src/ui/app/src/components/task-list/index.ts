/**
 * The public surface of THE task list — R4 (STA-102).
 *
 * Import from `@/components/task-list`, never from a file inside it. What is re-exported
 * here is what another domain is allowed to depend on; everything else (the individual row
 * bits, the roving-focus hook, the stylesheet) is an implementation detail that the tree
 * and this module's own components reach for directly.
 *
 * The two entry points, in the order you will want them:
 *
 *   <TaskList rows={…} preset="panel" label="Children" onOpen={session.open} />
 *       A whole list, keyboard included. This is almost always the right one.
 *
 *   <TaskRowLine row={…} config={…} semantics="bare" now={now} />
 *       One line, no roles, no tab stop, for a host that already owns both — cmdk's
 *       CommandItem, today.
 */
export { TaskList } from "./TaskList";
export { TaskRowLine, RowSkeleton, type TaskRowLineProps, type TaskRowSemantics } from "./TaskRowLine";
export { StatusIcon } from "./StatusIcon";
/**
 * The one-tab-stop contract. Exported because the QUEUE is now a second list outside this
 * module that owes it: its rows are `TaskRowLine`s in a listbox of its own, and a list whose
 * rows can only be reached with a mouse is the defect this hook exists to prevent. The
 * module header calls the hook an implementation detail; that was true while the tree and
 * `TaskList` were its only callers, and a third caller in another domain is exactly the
 * moment it stops being one.
 */
export { useRovingFocus, clampIndex, type RovingFocus } from "./roving";
/**
 * O1b (STA-125). Exported because the row is not the only surface with kinds on it: the
 * graph canvas draws one per node and O4b left an `EpicKindMark` placeholder for it. That
 * placeholder should become this import rather than a second set of paths — two glyph sets
 * for one vocabulary is how the canvas and the list start disagreeing about what an epic
 * looks like. It takes a `size` (16 matches StatusIcon) and a `labelled` switch for a
 * surface that already names the kind in text.
 */
export { KindGlyph, KIND_GLYPH_SIZE, type KindGlyphProps } from "./KindGlyph";
export { PrioritySignal } from "./PrioritySignal";
export {
  NEVER_DROPPED,
  resolveTaskListConfig,
  TASK_LIST_PRESETS,
  type TaskListColumns,
  type TaskListConfig,
  type TaskListDensity,
  type TaskListPreset,
} from "./config";
export {
  flatRow,
  forEachAncestor,
  guideX,
  indentPx,
  INDENT_STEP,
  MAX_INDENT_DEPTH,
  parentRollups,
  ROLLUP_SEGMENTS,
  rollupSegmentOf,
  ROW_PAD_LEFT,
  STATUS_LABEL,
  type Breadcrumb,
  type ParentRollup,
  type RollupInput,
  type RollupLive,
  type RollupOptions,
  type RollupPlan,
  type RollupSegment,
  type TaskRow,
  type TaskSource,
} from "./model";
/**
 * R4c (STA-188). The ungrouped row's plan cues: the vocabulary and the browser-side join
 * against `GET /api/queue`. Exported because the WIRING lives outside this module — the
 * tree fetches the queue and attaches the result — while the derivation and the words
 * belong here with the row that renders them.
 */
export {
  attachRowCues,
  buildRowCueIndex,
  EMPTY_ROW_CUE_INDEX,
  MILESTONE_CUE_GLYPH,
  milestoneCueSentence,
  ROW_CUE_PRESENTATION,
  rowCueSentence,
  rowCueShort,
  type RowCueIndex,
} from "./row-cues";
