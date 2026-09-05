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
import { GitFork, Layers, ListOrdered, Milestone } from "lucide-react";
import { VIEWS, VIEW_LABELS, type ViewName } from "@/lib/session";

export interface NavItem {
  /** Stable id; the DOM key and the test hook. */
  id: string;
  /** What the row says. */
  label: string;
  /** The view the row switches to. */
  view: ViewName;
  icon: LucideIcon;
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
};

function item(view: ViewName): NavItem {
  return { id: `view:${view}`, label: VIEW_LABELS[view], view, icon: ICONS[view] };
}

/**
 * The rail's sections, top to bottom. One group today; the shape is a list so the next
 * one is an entry, not a layout.
 *
 * The Workspace group lists every view in `VIEWS` order — the tuple is the registry and
 * the rail must not keep a second copy of it. A view moved to another group would be
 * listed there explicitly and dropped from this derivation.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    items: VIEWS.map(item),
  },
];

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
