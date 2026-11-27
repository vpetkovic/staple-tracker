/**
 * What the navigation rail holds, as data, and the shell's rail shortcut.
 *
 * ── Groups are an array, not JSX ──────────────────────────────────────────────────────
 *
 * The rail's zones are `NAV_GROUPS`: a list of groups, each a list of items, each item a
 * view. Moving a view between zones, or reordering one, is an edit to this array and
 * nothing else: `NavRail.tsx` iterates it and has no opinion about what is in it, and the
 * command palette lists the views in the same order. The grouping is expected to keep
 * changing, and a rail laid out by hand would have to be re-laid every time.
 *
 * ── Why the shortcut lives here ───────────────────────────────────────────────────────
 *
 * `[` and cmd-\ switch the rail between full and narrow (`railKeyAction`). The rule is pure,
 * a keystroke in and an answer out, so it sits next to the data it belongs to and is tested
 * without a DOM. The width itself is `rail-mode.ts`'s.
 */
import type { LucideIcon } from "lucide-react";
import { BatteryMedium, Bot, Gauge, GitFork, Inbox, Layers, Lightbulb, ListOrdered, Milestone } from "lucide-react";
import { TOP_VIEWS, VIEWS, VIEW_LABELS, isMachineView, isTopView, type ViewName } from "@/lib/session";

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
  /** The zone's name. The rail draws no labels (zones are set apart by space); it names the group in code and tests. */
  label: string;
  items: readonly NavItem[];
}

const ICONS: Record<ViewName, LucideIcon> = {
  tree: Layers,
  queue: ListOrdered,
  attention: Inbox,
  autopilot: Bot,
  graph: GitFork,
  milestones: Milestone,
  plan: Lightbulb,
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
 * The rail's zones of VIEWS, top to bottom, under the scope at the rail's head:
 *
 *   top      now (`TOP_VIEWS`): Inbox, Autopilot and Queue, what waits on a person, what
 *            agents are doing and what they take next.
 *   views    the workspace's records: every other view in `VIEWS` order. The tuple is the
 *            registry and the rail must not keep a second copy of it.
 *   machine  the machine's views, at the foot of the rail with Integrations and Settings:
 *            the provider budget is this computer's and reads the same whichever workspace
 *            is chosen, so filing it among the workspace's views would say otherwise.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "top", label: "", items: TOP_VIEWS.map(item) },
  {
    id: "views",
    label: "Views",
    items: VIEWS.filter((view) => !isTopView(view) && !isMachineView(view)).map(item),
  },
  {
    id: "machine",
    // The same words Settings uses for its computer-wide half.
    label: "This computer",
    items: VIEWS.filter(isMachineView).map(item),
  },
];

/** A group of `NAV_GROUPS` by its id. */
export function navGroup(id: "top" | "views" | "machine"): NavGroup {
  return NAV_GROUPS.find((group) => group.id === id)!;
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
  /** A dialog, menu, listbox or popover is open and owns the keyboard. */
  surfaceOpen: boolean;
  /** The event came out of a text field. */
  typing: boolean;
}

export type RailKeyAction = "toggle" | null;

/**
 * What the shell does with a keystroke, ONE decision, in order:
 *
 *   1. An open floating surface owns the keyboard: `[` does not switch the rail under an
 *      open menu, and Escape is that surface's (Radix closes it).
 *   2. The toggle shortcut, except a bare `[` typed into a text field, which is text.
 */
export function railKeyAction(event: KeyLike, context: RailKeyContext): RailKeyAction {
  if (context.surfaceOpen) return null;
  if (!isRailToggleKey(event)) return null;
  if (event.key === "[" && context.typing) return null;
  return "toggle";
}

// ---------------------------------------------------------------- the old preference

/**
 * Where the rail's hidden-or-shown choice was kept before it had two widths. Never written
 * now; `rail-mode.ts` reads it once, for a browser that has not chosen a width yet.
 */
export const RAIL_STORAGE_KEY = "staple:rail:v1";

/** The old value: `"collapsed"`, or anything else, which was the rail shown. */
export function decodeRailCollapsed(raw: string | null): boolean {
  return raw === "collapsed";
}
