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
  guideX,
  indentPx,
  INDENT_STEP,
  MAX_INDENT_DEPTH,
  ROW_PAD_LEFT,
  STATUS_LABEL,
  type Breadcrumb,
  type TaskRow,
  type TaskSource,
} from "./model";
