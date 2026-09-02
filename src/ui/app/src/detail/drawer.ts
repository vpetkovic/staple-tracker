/**
 * The overlay's two modes: what each one IS, and the one piece of state that
 * outlives a selection.
 *
 * V3 (STA-88) turned the detail from a grid column into an overlay that can be a
 * right-anchored drawer or a near-full-screen modal. R3 (STA-104) kept the first
 * and replaced the second: expanded is now a PAGE — edge to edge, no scrim, no cap.
 * Which of the two you are in is a WORKING PREFERENCE, not a property of the issue:
 * someone reading a long plan document expands once and expects every ticket they
 * open afterwards to open expanded. So the mode lives here, keyed in localStorage,
 * rather than in the panel — where it would reset on every `session.open()` because
 * the panel is remounted per issue.
 *
 * Why this is a module and not three lines inline: both functions have to survive a
 * storage that refuses. Safari in private mode, and any browser with site data
 * blocked, throw a SecurityError from `localStorage.getItem` itself — not from the
 * value, from the access. Inline, that exception lands inside a `useState`
 * initialiser or a click handler and takes the whole panel down with it, which is a
 * spectacular failure mode for a feature whose entire job is to remember a boolean.
 */

export const DETAIL_MODE_KEY = "staple:detail-mode";

/**
 * `drawer` overlays the right edge at roughly 46rem; `full` is the whole viewport.
 * Two, not a spectrum — a resizable drawer is a different ticket, and a third
 * intermediate size would be a preference nobody could name. R3 made the gap
 * between them wider on purpose: the old `full` was 96% of the screen, which is
 * near enough to the drawer's sibling that the button read as "make it bigger".
 * A drawer and a page are two different ways to work, and the toggle now says so.
 */
export type DetailMode = "drawer" | "full";

const MODES: readonly string[] = ["drawer", "full"];

/**
 * The expand button's whole model. Written as an involution so the button label,
 * the icon, and the state it sets are derived from one function rather than from
 * three ternaries that can disagree about what "expanded" currently means.
 */
export function otherMode(mode: DetailMode): DetailMode {
  return mode === "drawer" ? "full" : "drawer";
}

/**
 * WHERE THE PANEL SITS, per mode, and the only place either geometry is written.
 *
 *   drawer — 46rem (736px), flush to the right edge, full height. Roughly twice the
 *            pre-V3 column. The width is chosen against content rather than against
 *            a breakpoint: the widest thing this panel renders is DocumentDiff's
 *            side-by-side revision compare, which needs two ~40ch columns plus
 *            gutters before it starts wrapping mid-word. `94vw` is the floor so the
 *            drawer is still a drawer on a small laptop rather than a full cover.
 *            R3 did not touch this. The drawer was never the complaint.
 *
 *   full   — `inset-0`. The viewport, exactly, with no radius and no border.
 *
 * ─── WHY `full` IS A PAGE NOW, WHEN V3 ARGUED IT MUST NOT BE ───────────────────
 *
 * V3 shipped `inset-2 … lg:inset-6 max-w-[86rem] rounded-xl border shadow-xl` and
 * defended the margin as load-bearing: an overlay reaching all four edges "has
 * stopped being an overlay and become a page, at which point closing it feels like
 * navigating back, and the scrim — the thing telling you the list is still there
 * behind this — has nowhere to show".
 *
 * Every clause of that is true. It is an argument for a modal, and expanded is not
 * a modal any more; VP looked at the result and called it what it was, a 98%
 * modal. The tell is the scrim itself. A scrim's job is to say "the thing behind
 * this is still there, and you can get back to it by touching it" — and this one
 * could not keep the second half, because the panel covered the click target
 * everywhere it mattered. You saw 24px of dimmed list down each edge, you could not
 * use it, and you left the way you came in: the expand button. So the frame was
 * making a promise the interaction never kept.
 *
 * Removing the inset does not lose anything real. It costs the illusion of the list
 * being reachable, and buys the honest version of the same thing: an expanded
 * detail is a place you go, and the button you went in by is the way out. The
 * drawer is still there for the "I am working in the list" case, unchanged, one
 * click away — which is the mode that actually needs to show its context.
 *
 * WHAT THE CAP BECAME. `max-w-[86rem]` is gone from the panel and lives on the
 * CONTENT ROW inside it (IssueDetailPanel). The reason for a cap was always the
 * reading measure, never the surface: a 2560px-wide description is unreadable at
 * any font size. Capping the surface solved that by making the window smaller,
 * which is the crude version. Capping the content solves it where the problem is
 * and leaves the chrome edge to edge, which is what every page-mode detail worth
 * copying does. Below 1376px — every laptop this is used on — the cap is inert.
 */
const PANEL_CLASS: Record<DetailMode, string> = {
  drawer: "inset-y-0 right-0 w-[min(46rem,94vw)] border-l",
  full: "inset-0",
};

export function panelClass(mode: DetailMode): string {
  return PANEL_CLASS[mode];
}

/**
 * The stored preference, or the drawer.
 *
 * The drawer is the floor for every failure — no storage, a throwing storage, an
 * absent key, and a value this build does not recognise all land there. That last
 * one matters more than it looks: if a later version ever adds a third mode and a
 * user rolls back, the stored string would name a mode with no CSS behind it, and
 * the panel would render at whatever size a missing class implies. Unknown means
 * drawer, always.
 */
export function loadMode(storage: Storage | undefined): DetailMode {
  if (!storage) return "drawer";
  try {
    const stored = storage.getItem(DETAIL_MODE_KEY);
    return stored && MODES.includes(stored) ? (stored as DetailMode) : "drawer";
  } catch {
    return "drawer";
  }
}

/** Best-effort persistence. Losing the preference is not worth an exception. */
export function saveMode(storage: Storage | undefined, mode: DetailMode): void {
  if (!storage) return;
  try {
    storage.setItem(DETAIL_MODE_KEY, mode);
  } catch {
    /* private mode: the choice lasts for this page load, which is enough */
  }
}
