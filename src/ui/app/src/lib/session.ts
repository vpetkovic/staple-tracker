/**
 * The page's own state — what is on screen, filtered how, with what selected.
 *
 * Kept as one context rather than scattered useState so U6's board and U7's palette can
 * both drive navigation ("open STA-13", "switch to board") without either one owning it.
 */
import { createContext, useContext } from "react";
import type { UiMode, WorkspaceRef } from "./types";

export const VIEWS = ["inbox", "board", "tree", "graph"] as const;
export type ViewName = (typeof VIEWS)[number];

export interface Selection {
  workspace: string;
  ref: string;
}

export interface StapleSession {
  mode: UiMode;
  workspaces: WorkspaceRef[];

  view: ViewName;
  setView: (view: ViewName) => void;

  /** "" means every workspace, and is only reachable in hub mode. */
  ws: string;
  setWs: (ws: string) => void;

  assignee: string;
  setAssignee: (assignee: string) => void;

  selection: Selection | null;
  /** The single navigation primitive: open an issue in the detail panel. */
  open: (workspace: string, ref: string) => void;
  close: () => void;

  /** Ticks on every fingerprint change; every view refetches on it. */
  version: number;
  /** Force a refresh now, without waiting for the next poll. Call after a write. */
  refresh: () => void;
}

export const SessionContext = createContext<StapleSession | null>(null);

export function useSession(): StapleSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() outside <App/>");
  return session;
}
