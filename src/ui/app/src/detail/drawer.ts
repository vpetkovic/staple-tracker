/**
 * The overlay's two modes, and the only piece of state that outlives a selection.
 *
 * V3 (STA-88) turned the detail from a grid column into an overlay that can be a
 * right-anchored drawer or very nearly a full-screen modal. Which of the two you
 * are in is a WORKING PREFERENCE, not a property of the issue: someone reading a
 * long plan document expands once and expects every ticket they open afterwards to
 * open expanded. So the mode lives here, keyed in localStorage, rather than in the
 * panel — where it would reset on every `session.open()` because the panel is
 * remounted per issue.
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
 * `drawer` overlays the right edge at roughly 46rem; `full` is the near-full-screen
 * expansion. Two, not a spectrum — a resizable drawer is a different ticket, and a
 * third intermediate size would be a preference nobody could name.
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
