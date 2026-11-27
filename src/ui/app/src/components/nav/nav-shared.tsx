/**
 * What the desk's rail and the phone's More sheet both read and both draw, kept here so
 * there is one copy of each: the integrations' health, the scope's projects with their open
 * counts, the marks on a row's right, and how a phone sheet (More, the workspace list) hands
 * the focus back when it closes. (The theme is `useTheme` in lib/theme.ts and the way to a
 * view `navigateTo` in lib/session.ts; both are the page's, not the navigation's.)
 *
 * The two never share a screen (the rail is the desk's, the sheet the phone's), so each
 * holds its own instance of these reads; neither keeps a second copy of the logic.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { integrationRead } from "@/lib/api";
import { projectsForWorkspace } from "@/lib/projects";
import { useSession } from "@/lib/session";
import { isResolvedStatus } from "@/lib/settings";
import type { ProjectRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CONNECTIONS_CHANGED, type ConnectionView } from "@/integrations/connection-status";
import { needsAttention } from "@/settings/integrations/integrations-model";

/**
 * The connections' last known health. The list never probes, so it is read on mount, again
 * when the tab comes back into view, and whenever another surface reports a change; nothing
 * here polls or checks.
 */
export function useConnections(): ReadonlyArray<Pick<ConnectionView, "health">> {
  const session = useSession();
  const [connections, setConnections] = useState<Array<Pick<ConnectionView, "health">>>([]);
  useEffect(() => {
    let active = true;
    const read = () =>
      void integrationRead<{ connections: ConnectionView[] }>({ action: "connections" }, session.ws || undefined)
        .then((answer) => active && setConnections(answer.connections))
        .catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    read();
    document.addEventListener("visibilitychange", onVisible);
    // Settings, the link dialog and the External links tab announce what they learn, so the dot follows a fix at once.
    window.addEventListener(CONNECTIONS_CHANGED, read);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CONNECTIONS_CHANGED, read);
    };
    // Connections belong to the computer: one read per mount, whatever workspace is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return connections;
}

/** Does any connection need attention? The Integrations row's dot. */
export function useIntegrationsAttention(): boolean {
  return needsAttention(useConnections());
}

/**
 * A phone sheet has no trigger of its own to hand the focus back to: when it closes (`open`
 * turns false while `enabled`), `target` takes the focus, unless something else has taken it
 * already. `target` is read when the frame runs, after the sheet is gone.
 *
 * `then`, when it holds something, runs right after: how a sheet opens a dialog. The dialog
 * opens with the focus already on `target`, so that is where it hands the focus back when it
 * closes; opened while the sheet was still there, it would hand it back to a row that is gone.
 */
export function useFocusOnClose(
  open: boolean,
  target: () => HTMLElement | null | undefined,
  enabled = true,
  then?: { current: (() => void) | null },
): void {
  const wasOpen = useRef(false);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed || !enabled) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) target()?.focus();
      const next = then?.current;
      if (then) then.current = null;
      next?.();
    });
    return () => cancelAnimationFrame(frame);
    // `target` is a lookup, read once the frame runs; only a close starts one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, enabled]);
}

export interface ScopeProjects {
  /** The scope's projects: all of them on "All workspaces", one workspace's otherwise. */
  rows: ProjectRow[];
  /** The workspaces the rows span; more than one means each row is captioned with its own. */
  workspaces: ReadonlySet<string>;
  /** Each project's OPEN issues, from the rows the page already holds (no second fetch). */
  openCounts: ReadonlyMap<string, number>;
  /** The project Tasks is filtered to, when it is on screen filtered to exactly one of these rows. */
  activeId: string | null;
}

export function useScopeProjects(): ScopeProjects {
  const session = useSession();
  // The page's list is every workspace's (see lib/projects.ts); the scope is the page's.
  const rows = useMemo(
    () => projectsForWorkspace(session.projects.data ?? [], session.ws),
    [session.projects.data, session.ws],
  );
  const workspaces = useMemo(() => new Set(rows.map((row) => row.workspace)), [rows]);
  const openCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of session.issues.data ?? []) {
      const id = row.issue.projectId;
      if (!id || isResolvedStatus(row.issue.status)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [session.issues.data]);
  const selected = session.filters.dims.project ?? [];
  // The place moves to a project row only when that row is on screen: a filter naming a project
  // the list does not show (still loading, a failed read, another workspace's) leaves Tasks it.
  const only = session.view === "tree" && selected.length === 1 ? selected[0] : undefined;
  const activeId = only !== undefined && rows.some((row) => row.project.id === only) ? only : null;
  return { rows, workspaces, openCounts, activeId };
}

// ---------------------------------------------------------------- forced colours

/**
 * Under forced colours (Windows High Contrast and the like) backgrounds are replaced, so a
 * filled row says nothing. The row that is the place says it with an inset outline in the
 * system's `Highlight` instead. A parent whose child is the place has none, as it has no fill.
 */
export const FORCED_CURRENT_CLASS =
  "forced-colors:[&[aria-current]:not([data-child-current])]:outline-2 forced-colors:[&[aria-current]:not([data-child-current])]:outline-[Highlight] forced-colors:[&[aria-current]:not([data-child-current])]:-outline-offset-2";

// ---------------------------------------------------------------- focus across the two widths

/**
 * Where the focus goes in the other shape of the rail when it switches width (`[` pressed in
 * it): the same destination by its hook, a sub-row's parent row for a project or a run, and
 * "" for anything else (the caller then falls back to the top bar's toggle).
 */
export function railFocusSelector(element: Pick<Element, "closest">): string {
  const item = element.closest("[data-nav-item]")?.getAttribute("data-nav-item");
  if (item) return `[data-nav-item="${item}"]`;
  if (element.closest("[data-nav-project], [data-nav-project-settings], [data-nav-action]")) return '[data-nav-item="view:tree"]';
  if (element.closest("[data-nav-run], [data-nav-run-more]")) return '[data-nav-item="view:autopilot"]';
  if (element.closest("[data-workspace-switcher]")) return '[data-workspace-switcher="head"]';
  for (const hook of ["data-nav-settings", "data-nav-integrations", "data-nav-theme"]) {
    if (element.closest(`[${hook}]`)) return `[${hook}]`;
  }
  return "";
}

// ---------------------------------------------------------------- marks

/**
 * WHILE THE PAGE CANNOT REACH THE SERVER (`useConnection`, lib/useStaple.ts), every count and
 * dot on screen is the last one heard and may be stale. The container that holds marks says so
 * with `data-stale`, and this one rule dims every mark inside it (`data-nav-mark`). Rows stay
 * as they are: they still work. It is a filter, not `opacity`, so it multiplies with a mark's
 * own fading (a project count giving way to its gear) instead of fighting it.
 *
 * 80%, not half: dimmed marks must stay readable. Measured against the rail, a tertiary count
 * keeps 3.25:1 (light) and 3.72:1 (dark), a run's state dot 3.22:1 and 5.47:1, and the "new"
 * dot 3.03:1 and 3.95:1; at half they fell to about 2:1.
 */
export const STALE_MARKS_CLASS = "[&[data-stale]_[data-nav-mark]]:[filter:opacity(0.8)]";

/** The reconnecting dot: the waiting tone, breathing as a working run's dot does, never under reduced motion. */
export function ConnectionDot() {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full bg-[var(--plain-tight-fg)] forced-color-adjust-none motion-safe:animate-[staple-breathe_var(--motion-working-pulse)_var(--motion-ease-standard)_infinite]"
    />
  );
}

/**
 * A row's mark, on its right: `text-label`, tabular, tertiary. A count is a plain number;
 * something new or waiting is a 6px accent dot before it; live is a run's state dot before
 * "n live". One register for every row.
 */
export const MARK_CLASS = "ml-auto flex shrink-0 items-center gap-1.5 text-label font-normal text-text-tertiary tabular-nums";

/** The 6px accent dot that says "new" or "waiting on you". */
export function AccentDot({ className, ...rest }: { className?: string } & Record<`data-${string}`, string | boolean>) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-[var(--status-task-in_progress)] forced-color-adjust-none", className)} {...rest} />;
}

/** How many join requests are waiting, as the dot and the number. Nothing when none. */
export function PendingMark({ pending, className }: { pending: number; className?: string }) {
  if (pending === 0) return null;
  return (
    <span
      data-settings-badge={pending}
      data-nav-mark
      aria-label={pendingWords(pending) ?? undefined}
      className={cn(MARK_CLASS, className)}
    >
      <AccentDot />
      <span aria-hidden>{pending}</span>
    </span>
  );
}

/** The Integrations dot: a connection needs attention. */
export function AttentionMark({ className }: { className?: string }) {
  return (
    <>
      <span aria-hidden data-integrations-attention data-nav-mark className={cn("ml-auto size-1.5 shrink-0 rounded-full bg-[var(--status-task-todo)] forced-color-adjust-none", className)} />
      <span className="sr-only">, needs attention</span>
    </>
  );
}

/**
 * A count badge on an icon's corner (the narrow rail, the phone's tab bar): 16px, 10px
 * semibold, ringed in the surface it sits on. Quiet by default (the selected tint, laid on that
 * surface so the icon under it never shows through); it takes the accent only when something
 * in it is new to this browser.
 */
export function countBadgeClass(fresh: boolean, on: "sidebar" | "card"): string {
  return cn(
    // Forced colours would strip a badge's fill and ring: it keeps its own colours there.
    "flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums ring-2 forced-color-adjust-none",
    on === "sidebar" ? "bg-sidebar ring-sidebar" : "bg-card ring-card",
    fresh
      ? "bg-[var(--badge-fresh)] text-background"
      : "bg-linear-to-r from-surface-selected to-surface-selected text-foreground",
  );
}

/** "2 join requests waiting", for a spoken name or a tooltip; null when none. */
export function pendingWords(pending: number): string | null {
  return pending > 0 ? `${pending} join ${pending === 1 ? "request" : "requests"} waiting` : null;
}
