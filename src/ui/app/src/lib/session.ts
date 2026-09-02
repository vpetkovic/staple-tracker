/**
 * The page's own state — what is on screen, filtered how, with what selected.
 *
 * Kept as one context rather than scattered useState so every surface (the palette, a
 * tree row, a graph node, the header) can drive navigation without any one of them
 * owning it.
 */
import { createContext, useContext } from "react";
import type { UiMode, WorkspaceRef } from "./types";

/**
 * The views, in the order the header shows them. FIRST IS THE DEFAULT.
 *
 * V2 (STA-87) cut this from four to two. `inbox` and `board` were removed on VP's
 * decision, and this constant is the mechanism: the header tabs, the palette's "Go to …"
 * commands and the switch in App.tsx are all derived from it, so shrinking the tuple
 * removed all three without any of them being edited to know about it. That is what the
 * tuple was for, and it is worth keeping true — a fifth view should be one line here plus
 * one line in App.tsx's map, and nothing else.
 *
 * What went with them, so nobody goes looking in git for it:
 *   - `views/board/refusal.ts`   -> `lib/refusal.ts`        (salvaged, unchanged)
 *   - `views/board/GuardRefusal` -> `components/GuardRefusal` (salvaged, now shared)
 *   - `views/board/guards.ts`    -> deleted. It only ever answered "how should this
 *     COLUMN look while a card is in the air", which is a question no surviving surface
 *     asks. Its useful half (`transitionWarnings`) is nine lines and is recoverable from
 *     history if a status control ever wants pre-write hints.
 */
export const VIEWS = ["tree", "graph"] as const;
export type ViewName = (typeof VIEWS)[number];

/**
 * Where the app lands. Tree is the product now — the list is what you look at, and the
 * graph is where you go to answer a question about shape. Declared rather than written
 * as a literal in App.tsx so "what is the default view" has one answer.
 */
export const DEFAULT_VIEW: ViewName = VIEWS[0];

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
  /** The single navigation primitive: open an issue in the detail drawer. */
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
