/**
 * What a key does on a row NESTED under a plan entry: a descendant a queued container expands
 * to, or a row of the work that is not in the plan.
 *
 * Those rows sit inside the plan entry's reorder row, and the reorder row moves its entry on
 * Alt and an arrow from anything inside it. A nested row is not a plan entry: there is nothing
 * of its own to move, and moving the container it hangs under is a much larger act than the
 * keys imply. So Alt and an arrow stop at the nested row and do nothing; a plain arrow moves
 * focus along the list; Enter and Space on the row itself open it.
 */
export type NestedRowKey = "next" | "previous" | "open" | "swallow" | null;

export function nestedRowKey(
  event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  onRowItself: boolean,
): NestedRowKey {
  const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
  if (arrow && event.altKey) return "swallow";
  if (arrow && (event.ctrlKey || event.metaKey)) return null;
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "previous";
  if ((event.key === "Enter" || event.key === " ") && onRowItself) return "open";
  return null;
}
