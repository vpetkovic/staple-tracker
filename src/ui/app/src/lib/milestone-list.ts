/**
 * THE MILESTONES THE FILTER MENU OFFERS — every workspace's on All workspaces.
 *
 * `/api/milestones` with no `ws` answers for the server's FIRST registered workspace, so on
 * All workspaces the menu used to offer only that workspace's milestones — the
 * first-workspace fallback, one level down. Each workspace is read on its own and the
 * answers joined, every row keeping the workspace it came from so its members are fetched
 * from the right place. A workspace that cannot answer (no milestone kind configured)
 * contributes nothing rather than failing the menu; an auth failure still fails it.
 *
 * Pure over an injected reader, so the rule is pinned without a server
 * (milestone-list.test.ts); App.tsx wires `getMilestones` in.
 */
import { AuthError } from "./api";
import type { MilestoneListRow } from "./types";

export interface MilestoneListEntry {
  row: MilestoneListRow;
  ws: string;
}

export type ReadMilestones = (options: { ws: string; all: boolean }) => Promise<MilestoneListRow[]>;

export async function readMilestoneList(
  scope: {
    /** Has bootstrap answered? Before it, nobody knows whether "" means All workspaces. */
    booted: boolean;
    allWorkspaces: boolean;
    ws: string;
    /** Every registered workspace, in hub order. */
    workspaces: readonly string[];
    showDone: boolean;
  },
  read: ReadMilestones,
): Promise<MilestoneListEntry[]> {
  if (!scope.booted) return [];
  if (!scope.allWorkspaces) {
    return (await read({ ws: scope.ws, all: scope.showDone })).map((row) => ({ row, ws: scope.ws }));
  }
  const lists = await Promise.all(
    scope.workspaces.map((slug) =>
      read({ ws: slug, all: scope.showDone }).then(
        (rows) => rows.map((row) => ({ row, ws: slug })),
        (error: unknown) => {
          if (error instanceof AuthError) throw error;
          return [];
        },
      ),
    ),
  );
  return lists.flat();
}
