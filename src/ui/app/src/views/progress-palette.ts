/**
 * ONE meaning per colour, on every progress bar on the desk (Queue, Milestones, Graph), and
 * the same meaning the task rows' status glyphs give the same colour:
 *
 *   green  finished            (the done status)
 *   blue   being worked on     (the in-progress status)
 *   purple waiting for review  (the in-review status)
 *   amber  ready to pick up    (the to-do status)
 *   red    waiting / blocked   (the blocked status)
 *   grey   not started         (the backlog status)
 *
 * Amber used to mean "ready" on a row and "waiting" on the Queue and Milestones bars.
 */
export const PROGRESS_COLOR = {
  done: "var(--status-task-done)",
  active: "var(--status-task-in_progress)",
  review: "var(--status-task-in_review)",
  ready: "var(--status-task-todo)",
  waiting: "var(--status-task-blocked)",
  notStarted: "var(--status-task-backlog)",
} as const;
