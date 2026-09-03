/**
 * The canvas as a pasteable link — G5 (STA-58).
 *
 * A prepared view is worth something only if it survives being sent to someone. Everything
 * G3 and G4 added — which epics are collapsed, which epics are pinned, which planning
 * mode is on, what done work is doing, which ticket is the target — is view state, and
 * view state that lives only in a component dies when the tab does.
 *
 * Collapsed and pinned are TWO FIELDS and always have been, which is what makes O4b's
 * "selecting an epic must not change its collapse state" true of the link as well as of
 * the control: nothing in this file can move one when the other changes.
 *
 * ── The format ───────────────────────────────────────────────────────────────────────
 *
 *     graph=<flags>_<epicFilters.list>_<collapsed.list>_<target>
 *     graph=ph_STA-24.STA-30_STA-1.STA-12_STA-37
 *
 * Field 2 became a LIST in O4b (STA-134) and the format did not have to change to allow
 * it: a scalar IS a one-element `.`-list, so `ph_STA-24_STA-1_STA-37` — every link
 * anyone has already pasted into a doc — keeps decoding, into `["STA-24"]`.
 *
 * SEPARATORS ARE `_` AND `.` ON PURPOSE. Both are in form-urlencoding's safe set, so
 * `URLSearchParams` leaves them alone and the link stays legible; `~` and `:` — the more
 * obvious choices — come back as `%7E` and `%3A` and turn a link somebody is about to
 * paste into a meeting into noise. Neither character can occur in a task identifier
 * (`PREFIX-123` is letters, a hyphen and digits), so the split is never ambiguous.
 *
 * THE TOKEN IS NOT THIS MODULE'S BUSINESS. Nothing here reads, writes, or even names it.
 * The caller rewrites exactly one query parameter on the existing URL, which is what
 * keeps auth out of a feature that is about view state — the link is a view, not a
 * credential, and it is only usable by someone who already has the token.
 *
 * DECODING IS TOTAL. Every field is optional, unknown flag characters fall back to the
 * default, and extra fields are ignored. A link that has aged badly — an epic that was
 * deleted, a param from a future version — must degrade to a working graph rather than
 * an error, because the person opening it cannot fix it and did not write it.
 */
import type { DoneMode, PlanningMode } from "./graph-planning";

/** The whole shareable state of the canvas. */
export interface GraphViewState {
  mode: PlanningMode;
  doneMode: DoneMode;
  /**
   * The epics the canvas is pinned to. Empty means the whole graph.
   *
   * O4b (STA-134) widened this from a single `epicFilter` to a list, and the wire format
   * absorbed it for free: field 2 was already a scalar in a `_`-delimited record, and a
   * scalar is a one-element `.`-list. An old link carrying `_STA-24_` therefore decodes
   * to `["STA-24"]` with no legacy branch, no version flag, and no second parser — see
   * `decodeGraphView`.
   */
  epicFilters: string[];
  collapsed: string[];
  /** The selected ticket, which path-to-target aims at. */
  target: string | null;
}

/** The query parameter this module owns. It owns no other. */
export const GRAPH_PARAM = "graph";

const FIELD = "_";
const LIST = ".";

const MODE_TO_CHAR: Record<PlanningMode, string> = { off: "o", frontier: "f", path: "p" };
const CHAR_TO_MODE: Record<string, PlanningMode> = { o: "off", f: "frontier", p: "path" };
const DONE_TO_CHAR: Record<DoneMode, string> = { show: "s", fade: "f", hide: "h" };
const CHAR_TO_DONE: Record<string, DoneMode> = { s: "show", f: "fade", h: "hide" };

export const DEFAULT_VIEW_STATE: GraphViewState = {
  mode: "off",
  doneMode: "show",
  epicFilters: [],
  collapsed: [],
  target: null,
};

/** A `.`-joined field, sorted and de-duplicated. See `encodeGraphView`. */
function list(values: readonly string[]): string {
  return [...new Set(values)].sort().join(LIST);
}

/**
 * State to param value.
 *
 * Both lists are SORTED so that the same view always produces the same link. Two people
 * who arrived at an identical canvas by collapsing epics in a different order should be
 * able to compare links by eye, and a link that changes for no reason looks like it
 * encodes something it does not. Selection order carries no meaning here — the canvas
 * shows the union — so sorting the filter list costs nothing and buys the same property.
 */
export function encodeGraphView(state: GraphViewState): string {
  const flags = `${MODE_TO_CHAR[state.mode]}${DONE_TO_CHAR[state.doneMode]}`;
  return [flags, list(state.epicFilters), list(state.collapsed), state.target ?? ""].join(
    FIELD,
  );
}

/**
 * Param value to state. Never throws; every field independently falls back.
 *
 * `null` for "there was no parameter" is a DIFFERENT answer from a decoded state with an
 * empty collapse list, and the caller depends on the difference: no parameter means "use
 * the size-based default", while an empty list in a link means "the sender had everything
 * expanded, show that". Collapsing the two would make every shared link of an expanded
 * big graph silently re-collapse on arrival, which is precisely the thing the sender was
 * trying to avoid.
 */
export function decodeGraphView(raw: string | null): GraphViewState | null {
  if (raw === null || raw === "") return null;
  const [flags = "", epicFilters = "", collapsed = "", target = ""] = raw.split(FIELD);
  return {
    mode: CHAR_TO_MODE[flags[0] ?? ""] ?? DEFAULT_VIEW_STATE.mode,
    doneMode: CHAR_TO_DONE[flags[1] ?? ""] ?? DEFAULT_VIEW_STATE.doneMode,
    // THIS LINE IS THE WHOLE BACK-COMPAT STORY. A pre-O4b link wrote one identifier here
    // and `"STA-24".split(".")` is `["STA-24"]`, so the old shape decodes to the new one
    // without a version check, a try/catch, or a second code path that only old links
    // ever take — which is the code path that rots, because nothing new exercises it.
    epicFilters: epicFilters === "" ? [] : epicFilters.split(LIST).filter(Boolean),
    collapsed: collapsed === "" ? [] : collapsed.split(LIST).filter(Boolean),
    target: target === "" ? null : target,
  };
}

/**
 * The current page URL with the view state on it, and everything else left alone.
 *
 * Takes the href in rather than reaching for `window` so it can be tested, and so the one
 * thing that must not happen — disturbing `token` — is visible in a test rather than
 * asserted in a comment.
 *
 * A default-looking state DELETES the parameter instead of writing `os___`. The address
 * bar of someone who has touched nothing should look like the address bar of someone who
 * just arrived.
 */
export function withGraphView(href: string, state: GraphViewState): string {
  const url = new URL(href);
  const encoded = encodeGraphView(state);
  if (encoded === encodeGraphView(DEFAULT_VIEW_STATE)) url.searchParams.delete(GRAPH_PARAM);
  else url.searchParams.set(GRAPH_PARAM, encoded);
  return url.toString();
}
