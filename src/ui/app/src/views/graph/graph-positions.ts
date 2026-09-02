/**
 * Where the nodes STAY — G2 (STA-55).
 *
 * Manual arrangement is the whole reason this ticket exists: a graph you can tidy for a
 * meeting and come back to is a different tool from one that re-randomizes on reload.
 * That makes localStorage part of the feature rather than an implementation detail, and
 * therefore something worth testing — which is why every function here takes the Storage
 * in rather than reaching for `window`.
 *
 * NOTHING HERE THROWS. A private-mode browser, a full quota, or a key someone hand-edited
 * to garbage must cost you your saved arrangement and nothing else; the graph still
 * renders, canonically. Storage is a nicety and is treated like one.
 */
import type { UiMode } from "@/lib/types";
import type { XY } from "./graph-layout";

/**
 * `v1` is in the key so a future change to the stored shape can be ignored rather than
 * migrated — the cost of a wrong guess here is that someone re-drags a few nodes.
 */
const PREFIX = "staple:graph-positions:v1";

/**
 * One arrangement per scope, where scope is (hub-vs-single, workspace filter).
 *
 * BOTH HALVES EARN THEIR PLACE. Hub mode and single-workspace mode draw different node
 * SETS under the same identifiers, so a layout tidied in one is nonsense in the other.
 * And the ws filter is in there because narrowing to one workspace and tidying it must
 * not shove those same tickets around inside the all-workspaces view — they are two
 * different pictures that happen to share tickets.
 *
 * `"*"` rather than `""` for "every workspace": an empty segment makes the key end in a
 * colon, which is the kind of thing that reads as a bug in a devtools listing.
 */
export function positionsKey(mode: UiMode, ws: string): string {
  return `${PREFIX}:${mode}:${ws === "" ? "*" : ws}`;
}

/** Shape guard — hand-edited or stale storage must not become NaN positions on screen. */
function isXY(value: unknown): value is XY {
  if (typeof value !== "object" || value === null) return false;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y);
}

/**
 * Read an arrangement. `null` means "nothing saved" AND "something unreadable was
 * saved" — the caller does the same thing either way (fall back to canonical), and
 * collapsing the two is what keeps that caller free of a try/catch.
 *
 * Entries are filtered individually rather than all-or-nothing: one corrupt node should
 * not throw away the other forty.
 */
export function loadPositions(storage: Storage, key: string): Record<string, XY> | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null; // storage disabled entirely
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, XY> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isXY(value)) out[id] = { x: value.x, y: value.y };
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Write an arrangement. Rounded to whole pixels — a drag produces sub-pixel floats,
 * and thirteen decimal places per coordinate is a lot of quota to spend on a difference
 * nobody can see.
 */
export function savePositions(storage: Storage, key: string, positions: Record<string, XY>): void {
  try {
    const rounded: Record<string, XY> = {};
    for (const [id, { x, y }] of Object.entries(positions)) {
      rounded[id] = { x: Math.round(x), y: Math.round(y) };
    }
    storage.setItem(key, JSON.stringify(rounded));
  } catch {
    // Quota or private mode. The arrangement stays correct on screen for this session.
  }
}

/**
 * Forget the manual arrangement for a scope.
 *
 * This is auto-arrange's other half. The button does not merely re-run dagre — it puts
 * you back on the canonical arrangement AND stops the old manual one from reappearing
 * on the next reload. Re-laying out while leaving the stored overrides in place would
 * look identical for one render and then undo itself, which is the worst of both.
 */
export function clearPositions(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to do and nothing worth saying.
  }
}
