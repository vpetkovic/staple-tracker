/**
 * What the navigation rail holds, as data — and the two shell rules that go with it.
 *
 * ── Groups are an array, not JSX ──────────────────────────────────────────────────────
 *
 * The rail's sections are `NAV_GROUPS`: a list of groups, each a labelled list of items,
 * each item a view. Moving a view between groups, adding a group, or reordering a section
 * is an edit to this array and nothing else — `NavRail.tsx` iterates it and has no
 * opinion about what is in it. That is the whole point: the grouping is expected to keep
 * changing, and a rail laid out by hand would have to be re-laid every time.
 *
 * ── Why the shortcut and the storage envelope live here ───────────────────────────────
 *
 * `[` and cmd-\ toggle the rail, and whether it is collapsed is remembered. Both rules
 * are pure — a keystroke in, a boolean out; a stored string in, a boolean out — so they
 * sit next to the data they belong to and are tested without a DOM, the way
 * `lib/view-prefs.ts` treats the sort envelope.
 */
import type { LucideIcon } from "lucide-react";
import { BatteryMedium, Gauge, GitFork, Layers, ListOrdered, Milestone } from "lucide-react";
import { MACHINE_VIEWS, VIEWS, VIEW_LABELS, isMachineView, type ViewName } from "@/lib/session";

export interface NavItem {
  /** Stable id; the DOM key and the test hook. */
  id: string;
  /** What the row says. */
  label: string;
  /** The view the row switches to. */
  view: ViewName;
  icon: LucideIcon;
  /**
   * An inline action on the row's right — visible on hover and focus, always in the tab
   * order. Only `new-project` exists today; the rail maps the id to a verb.
   */
  action?: { id: "new-project"; label: string };
  /**
   * What the row lists beneath itself. Only `projects` exists today: the tracked
   * projects, each a sub-row with its own settings gear.
   */
  subItems?: "projects";
}

export interface NavGroup {
  id: string;
  /** The section label, rendered as an eyebrow above the rows. */
  label: string;
  items: readonly NavItem[];
}

const ICONS: Record<ViewName, LucideIcon> = {
  tree: Layers,
  queue: ListOrdered,
  graph: GitFork,
  milestones: Milestone,
  calibration: Gauge,
  budget: BatteryMedium,
};

/** The icon a view wears everywhere it is listed — the rail row and the phone's tab bar. */
export function viewIcon(view: ViewName): LucideIcon {
  return ICONS[view];
}

function item(view: ViewName): NavItem {
  const base: NavItem = { id: `view:${view}`, label: VIEW_LABELS[view], view, icon: ICONS[view] };
  // Projects hang off Tasks: the `+` makes one, and each one is a sub-row that narrows
  // the list to its issues. They are a property of the Tasks row, not of the group.
  if (view === "tree") {
    return { ...base, action: { id: "new-project", label: "New project" }, subItems: "projects" };
  }
  return base;
}

/**
 * The rail's sections of VIEWS, top to bottom. (The workspaces the views are scoped to are
 * listed above them from the session, not from here: they are data, not a registry.)
 *
 * The Views group lists every view in `VIEWS` order — the tuple is the registry and the rail
 * must not keep a second copy of it — except the machine's views, which sit in "This
 * computer" at the foot of the rail (`MACHINE_VIEWS`): the provider budget is this
 * computer's and reads the same whichever workspace is chosen, so filing it among the
 * workspace's views would say otherwise.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "views",
    label: "Views",
    items: VIEWS.filter((view) => !isMachineView(view)).map(item),
  },
  {
    id: "machine",
    // The same words Settings uses for its computer-wide half.
    label: "This computer",
    items: MACHINE_VIEWS.map(item),
  },
];

/** How many workspaces the rail lists before the rest go behind "More workspaces". */
export const RAIL_WORKSPACE_LIMIT = 6;

export interface RailWorkspaceRow {
  /** "" is All workspaces. */
  value: string;
  name: string;
  /** One or two letters for the row's tile. */
  initials: string;
  current: boolean;
}

/**
 * The workspaces the rail lists, and how many did not fit.
 *
 * Hub mode: All workspaces first, then every workspace in registry order — capped at
 * `limit`, with the CURRENT one always kept (it replaces the last listed one when it would
 * have been cut), so the rail never hides where you are. A single-workspace page lists that
 * one workspace, current, and nothing to switch to.
 */
export function railWorkspaces(
  scope: { mode: string; ws: string; workspaces: readonly { slug: string; prefix: string }[] },
  limit: number = RAIL_WORKSPACE_LIMIT,
): { rows: RailWorkspaceRow[]; hidden: number } {
  const tile = (slug: string, prefix: string) => (prefix || slug).slice(0, 1).toUpperCase();
  if (scope.mode !== "hub") {
    const only = scope.workspaces[0];
    return only ? { rows: [{ value: only.slug, name: only.slug, initials: tile(only.slug, only.prefix), current: true }], hidden: 0 } : { rows: [], hidden: 0 };
  }
  const all: RailWorkspaceRow = { value: "", name: "All workspaces", initials: "", current: scope.ws === "" };
  let listed = scope.workspaces.slice(0, limit);
  const current = scope.workspaces.find((workspace) => workspace.slug === scope.ws);
  if (current && !listed.includes(current)) listed = [...listed.slice(0, Math.max(0, limit - 1)), current];
  const rows = listed.map((workspace) => ({
    value: workspace.slug,
    name: workspace.slug,
    initials: tile(workspace.slug, workspace.prefix),
    current: workspace.slug === scope.ws,
  }));
  return { rows: [all, ...rows], hidden: scope.workspaces.length - listed.length };
}

/**
 * What a click on a workspace row does: switch to it — unless it is already the one on
 * screen, or the page is a single workspace and has nothing to switch to.
 */
export function chooseRailWorkspace(scope: { mode: string; setWs: (ws: string) => void }, row: RailWorkspaceRow): void {
  if (scope.mode === "hub" && !row.current) scope.setWs(row.value);
}

/**
 * How a project sub-row is captioned. The workspace joins the name only when the rows on
 * hand span more than one workspace — hub mode with every workspace showing — because
 * that is the one case two projects can share a name and the caption is what tells them
 * apart. Everywhere else the caption would say what the switcher already says.
 */
export function projectCaption(workspace: string, workspaces: ReadonlySet<string>): string | null {
  return workspaces.size > 1 ? workspace : null;
}

/** The rail item for a view, or undefined if no group lists it. */
export function navItemForView(view: ViewName): NavItem | undefined {
  for (const group of NAV_GROUPS) {
    const found = group.items.find((entry) => entry.view === view);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------- the toggle shortcut

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Does this keystroke ask to toggle the rail? Two spellings, Linear's own: a bare `[`,
 * or `\` with the platform modifier. Anything with another modifier is somebody else's
 * shortcut. Whether the user is typing is the caller's question, not this one's — the
 * predicate is about the keys.
 */
export function isRailToggleKey(event: KeyLike): boolean {
  if (event.altKey) return false;
  if (event.key === "[") return !event.metaKey && !event.ctrlKey && !event.shiftKey;
  if (event.key === "\\") return (event.metaKey || event.ctrlKey) && !event.shiftKey;
  return false;
}

/** What the shell knows when a key arrives, as booleans so the decision needs no DOM. */
export interface RailKeyContext {
  /** The narrow-viewport sheet is open. */
  overlayOpen: boolean;
  /** A dialog, menu, listbox or popover is open and owns the keyboard. */
  surfaceOpen: boolean;
  /** The event came out of a text field. */
  typing: boolean;
}

export type RailKeyAction = "close-overlay" | "toggle" | null;

/**
 * What the shell does with a keystroke — ONE decision, in order:
 *
 *   1. An open floating surface owns the keyboard. Escape closes THAT (Radix does it),
 *      not the sheet behind it; `[` does not collapse the rail under an open menu.
 *   2. Escape closes the sheet when it is open, and is nobody's otherwise.
 *   3. The toggle shortcut — except a bare `[` typed into a text field, which is text.
 */
export function railKeyAction(event: KeyLike, context: RailKeyContext): RailKeyAction {
  if (context.surfaceOpen) return null;
  if (event.key === "Escape") return context.overlayOpen ? "close-overlay" : null;
  if (!isRailToggleKey(event)) return null;
  if (event.key === "[" && context.typing) return null;
  return "toggle";
}

/**
 * Where focus goes when the sheet's open state changes. Opening: into the rail, so the
 * keyboard lands inside it rather than behind it. Closing: back to the "Show navigation"
 * button that opened it, rather than dropping to `<body>`. Nothing when nothing changed.
 */
export function overlayFocusTarget(previouslyOpen: boolean, open: boolean): "rail" | "show-navigation" | null {
  if (previouslyOpen === open) return null;
  return open ? "rail" : "show-navigation";
}

// ---------------------------------------------------------------- persistence

export const RAIL_STORAGE_KEY = "staple:rail:v1";

/** `"collapsed"` or absent. Anything else is treated as the default: open. */
export function decodeRailCollapsed(raw: string | null): boolean {
  return raw === "collapsed";
}

export function encodeRailCollapsed(collapsed: boolean): string {
  return collapsed ? "collapsed" : "open";
}

export function loadRailCollapsed(storage: Pick<Storage, "getItem"> | undefined): boolean {
  if (!storage) return false;
  try {
    return decodeRailCollapsed(storage.getItem(RAIL_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function saveRailCollapsed(storage: Pick<Storage, "setItem"> | undefined, collapsed: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(RAIL_STORAGE_KEY, encodeRailCollapsed(collapsed));
  } catch {
    /* private mode: the choice lasts for this page load */
  }
}
