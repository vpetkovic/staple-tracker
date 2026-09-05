/**
 * The page's projects, narrowed to one workspace.
 *
 * `/api/projects` is fetched ONCE for the whole page and UNSCOPED — in hub mode every
 * workspace's projects, in single-workspace mode the one workspace's — because the
 * detail panel can hold an issue from a workspace the page is not on (a cross-workspace
 * blocker opened from the drawer), and a list scoped to the page would offer that issue
 * nothing and quietly unfile it on the first pick. The list is small; the narrowing is
 * this one pure function, applied where the rows are consumed: the rail, the filter
 * context, the create dialog, the detail row.
 *
 * `""` is "every workspace" (hub mode, nothing chosen), the same reading `session.ws`
 * gives it everywhere else.
 */
import type { ProjectRow } from "./types";

export function projectsForWorkspace(rows: readonly ProjectRow[], workspace: string): ProjectRow[] {
  if (workspace === "") return [...rows];
  return rows.filter((row) => row.workspace === workspace);
}
