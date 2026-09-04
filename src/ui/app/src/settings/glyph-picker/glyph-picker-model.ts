/**
 * What the GLYPH PICKER decides that needs no DOM — R5d (STA-184).
 *
 * Same discipline as settings-ops.ts and form/form-model.ts: every decision the picker
 * makes is a function here, so the suite can pin it by calling it. This file owns
 * the ONE form contract every choice is expressed in, the gate a choice passes before
 * it enters the draft, how the Kinds draft carries the `kinds.appearance` map and
 * turns it into the store's `set`/`reset` op, the arithmetic of the windowed grid and
 * its keyboard, and the bounded recents list.
 *
 * ── ONE CONTRACT FOR THREE SOURCES ────────────────────────────────────────────────────
 *
 * A Lucide key, an emoji and a sanitised SVG are all `{ source, value, label, fallback }`
 * (`GlyphChoice`) — the browser mirror of the record core stores. The picker's tabs
 * differ in how a `value` is obtained; nothing downstream of the choice knows which
 * tab it came from. `toStoredGlyph` drops the label when it is the kind's own, so a
 * workspace that later renames the kind is still heard by every screen reader.
 *
 * ── THE GATE IS A MIRROR, THE STORE STILL DECIDES ─────────────────────────────────────
 *
 * `glyphChoiceProblem` runs the browser's own gates (`resolveIcon`, `isEmojiGlyph`,
 * `isCanonicalSvg`) plus the two bounds core states for `fallback` and `label`. It
 * stops a draft from holding a record the store would refuse; the store's sentence is
 * still the one that lands if they disagree. An `svg` value is accepted here ONLY in
 * the sanitiser's canonical shape — a raw document is never a choice, which is why
 * the SVG tab goes through `POST /api/glyph/sanitize` before it can offer one.
 */
import { resolveIcon, type IconCatalogEntry } from "../../lib/icon-catalog";
import { fallbackKindAppearance, isCanonicalSvg, isEmojiGlyph, type KindAppearance } from "../../lib/kind-appearance";
import { settingValueIn, type SettingOp, type WorkspaceSettingsEnvelope } from "../../lib/settings";
import { sameValue } from "../form/form-model";

// ---------------------------------------------------------------- the contract

export type GlyphSource = "lucide" | "emoji" | "svg";

/** One choice, whatever tab produced it. `label` is the accessible name; `fallback` what a terminal prints. */
export interface GlyphChoice {
  source: GlyphSource;
  value: string;
  label: string;
  fallback: string;
}

/** The mirror of core's `StoredKindAppearance`: what one entry of `kinds.appearance` holds. */
export interface StoredGlyph {
  source: GlyphSource | "none";
  value: string;
  fallback: string;
  label?: string;
}

/** The mirror of core's `KindAppearanceMap`: the value of `kinds.appearance`, keyed by kind id. */
export type GlyphMap = Readonly<Record<string, StoredGlyph>>;

export const GLYPH_SETTING_KEY = "kinds.appearance";

/** Mirror of core's bounds on the two text fields. */
export const FALLBACK_MAX_UNITS = 4;
export const LABEL_MAX = 80;

/** A catalog entry as a choice, keeping the kind's label and terminal fallback. */
export function lucideChoice(entry: IconCatalogEntry, current: Pick<GlyphChoice, "label" | "fallback">): GlyphChoice {
  return { source: "lucide", value: entry.key, label: current.label, fallback: current.fallback };
}

export function emojiChoice(value: string, current: Pick<GlyphChoice, "label" | "fallback">): GlyphChoice {
  return { source: "emoji", value, label: current.label, fallback: current.fallback };
}

/** The sanitiser's canonical output as a choice; `label` is the name the sanitiser wrote into it. */
export function svgChoice(canonical: string, current: Pick<GlyphChoice, "label" | "fallback">): GlyphChoice {
  return { source: "svg", value: canonical, label: current.label, fallback: current.fallback };
}

/** Why a choice cannot enter the draft, or null. The browser's gates plus core's two text bounds. */
export function glyphChoiceProblem(choice: GlyphChoice): string | null {
  switch (choice.source) {
    case "lucide":
      if (resolveIcon(choice.value) === undefined) return `"${choice.value}" is not an icon in the catalog.`;
      break;
    case "emoji":
      if (!isEmojiGlyph(choice.value)) return "One or two visible characters, with no whitespace.";
      break;
    case "svg":
      if (!isCanonicalSvg(choice.value)) return "Custom SVG must be sanitised before it can be used.";
      break;
  }
  return fallbackProblem(choice.fallback) ?? labelProblem(choice.label);
}

/** Mirror of core's fallback bound: 1 to 4 UTF-16 units, no control characters. */
export function fallbackProblem(fallback: string): string | null {
  if (fallback.length === 0 || fallback.length > FALLBACK_MAX_UNITS || /[\p{Cc}\n\r]/u.test(fallback)) {
    return `A terminal fallback is 1 to ${FALLBACK_MAX_UNITS} characters.`;
  }
  return null;
}

/** Mirror of core's label bound. Empty is allowed here: it means "the kind's own label". */
export function labelProblem(label: string): string | null {
  return label.length > LABEL_MAX ? `A label is at most ${LABEL_MAX} characters.` : null;
}

/**
 * The stored record for a choice. `label` is written only when it differs from the
 * kind's own, so renaming the kind later keeps renaming what assistive tech hears.
 */
export function toStoredGlyph(choice: GlyphChoice, kindLabel: string): StoredGlyph {
  const label = choice.label.trim();
  return {
    source: choice.source,
    value: choice.value,
    fallback: choice.fallback,
    ...(label !== "" && label !== kindLabel ? { label } : {}),
  };
}

/**
 * What a kind wears under the draft map: the stored entry resolved against the kind's
 * label, or the built-in mark when it has none — the mirror of the server's
 * `resolveKindAppearance`, run over the draft so the list and the preview show what
 * Save will produce.
 */
export function draftAppearance(map: GlyphMap, kind: { id: string; label: string }): KindAppearance {
  const stored = map[kind.id];
  if (!stored) return fallbackKindAppearance(kind);
  return { source: stored.source, value: stored.value, label: stored.label?.trim() || kind.label, fallback: stored.fallback };
}

/** The appearance as a choice the picker can edit, or null for `none` (nothing to edit). */
export function choiceOf(appearance: KindAppearance): GlyphChoice | null {
  if (appearance.source === "none") return null;
  return { source: appearance.source, value: appearance.value, label: appearance.label, fallback: appearance.fallback };
}

// ---------------------------------------------------------------- the map in the draft

/** The empty map, shared so a served envelope with no entry does not make a new object per render. */
export const NO_GLYPHS: GlyphMap = Object.freeze({});

function isStoredGlyph(value: unknown): value is StoredGlyph {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.source === "lucide" || record.source === "emoji" || record.source === "svg" || record.source === "none") &&
    typeof record.value === "string" &&
    typeof record.fallback === "string" &&
    (record.label === undefined || typeof record.label === "string")
  );
}

/**
 * The served `kinds.appearance` map, out of the settings envelope the dialog already
 * holds. Read through `settingValueIn`, so a workspace that has never customised a
 * glyph gets the registry's own default (`{}`) rather than a second empty-case here.
 * Anything not shaped like a record is dropped rather than trusted: the editor's draft
 * must never hold a value it cannot then describe.
 */
export function servedGlyphMap(envelope: WorkspaceSettingsEnvelope): GlyphMap {
  const value = settingValueIn(envelope, GLYPH_SETTING_KEY)?.value;
  if (typeof value !== "object" || value === null) return NO_GLYPHS;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, StoredGlyph] =>
    isStoredGlyph(entry[1]),
  );
  return entries.length === 0 ? NO_GLYPHS : Object.fromEntries(entries);
}

/** The map with one kind's entry replaced, or removed when `stored` is null ("Reset to default"). */
export function withGlyph(map: GlyphMap, id: string, stored: StoredGlyph | null): GlyphMap {
  const next: Record<string, StoredGlyph> = { ...map };
  if (stored === null) delete next[id];
  else next[id] = stored;
  return next;
}

export function isGlyphMapDirty(draft: GlyphMap, served: GlyphMap): boolean {
  return !sameValue(draft, served);
}

/** How many kinds the draft map changes — set, replaced or reset — for the ActionBar's summary. */
export function changedGlyphs(served: GlyphMap, draft: GlyphMap): number {
  return Object.keys({ ...served, ...draft }).filter((id) => !sameValue(served[id], draft[id])).length;
}

/**
 * The op Save posts for the map: `set` with the whole map, or `reset` when nothing is
 * customised any more — the store's own convention when `kinds rm` drops the last
 * entry. Only configured kinds are named, because the store refuses any other key;
 * an entry for a kind the same draft removed simply goes with it. Empty when the map
 * Save would write is the map the server holds, so a draft that came back to where it
 * started posts nothing.
 */
export function glyphMapOps(served: GlyphMap, draft: GlyphMap, configured: readonly string[]): SettingOp[] {
  const next = Object.fromEntries(Object.entries(draft).filter(([id]) => configured.includes(id)));
  if (sameValue(next, served)) return [];
  return Object.keys(next).length === 0
    ? [{ op: "reset", key: GLYPH_SETTING_KEY }]
    : [{ op: "set", key: GLYPH_SETTING_KEY, value: next }];
}

// ---------------------------------------------------------------- the windowed grid

export interface GridWindow {
  /** Index of the first option rendered. */
  start: number;
  /** One past the last option rendered. */
  end: number;
  /** Spacer heights standing in for the rows above and below, in px. */
  topPad: number;
  bottomPad: number;
}

/**
 * Which options a scroll position shows. Rows above and below the viewport are two
 * spacers, so the scrollbar is honest about the catalog's size while the DOM holds a
 * viewport's worth of cells plus `overscan` rows either side. Pure over its inputs:
 * the component measures, this decides.
 */
export function gridWindow(input: {
  count: number;
  columns: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}): GridWindow {
  const { count, rowHeight, viewportHeight } = input;
  const columns = Math.max(1, input.columns);
  const overscan = input.overscan ?? 2;
  const rows = Math.ceil(count / columns);
  const firstRow = Math.max(0, Math.floor(input.scrollTop / rowHeight) - overscan);
  const lastRow = Math.min(rows, Math.ceil((input.scrollTop + viewportHeight) / rowHeight) + overscan);
  return {
    start: Math.min(count, firstRow * columns),
    end: Math.min(count, lastRow * columns),
    topPad: firstRow * rowHeight,
    bottomPad: Math.max(0, rows - lastRow) * rowHeight,
  };
}

/** How many cells fit across `width`; never fewer than 4, so a narrow drawer still reads as a grid. */
export function gridColumns(width: number, cell: number): number {
  return Math.max(4, Math.floor(width / cell));
}

/**
 * Where the arrow keys move the active option in a grid of `columns`: left and right
 * step one, up and down step a row, Home and End jump. Null for a key the grid does
 * not handle, so the caller lets it through. The index is clamped rather than
 * wrapped — a grid that wraps is a grid you cannot find the end of.
 */
export function moveActive(input: { index: number; key: string; columns: number; count: number }): number | null {
  const { index, key, columns, count } = input;
  if (count === 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowRight":
      return Math.min(last, index + 1);
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowDown":
      return Math.min(last, index + columns);
    case "ArrowUp":
      return Math.max(0, index - columns);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/** The scrollTop that keeps `index`'s row inside the viewport, moving as little as possible. */
export function scrollTopFor(input: {
  index: number;
  columns: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
}): number {
  const { index, rowHeight, scrollTop, viewportHeight } = input;
  const columns = Math.max(1, input.columns);
  const top = Math.floor(index / columns) * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
  return scrollTop;
}

// ---------------------------------------------------------------- recents

export const RECENTS_KEY = "staple:glyph-recents";
export const RECENTS_MAX = 12;

/** The list as stored, or empty for anything missing or malformed. Never throws (private mode). */
export function readRecents(storage: Pick<Storage, "getItem"> | null | undefined): GlyphChoice[] {
  try {
    const raw = storage?.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecent).slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function isRecent(value: unknown): value is GlyphChoice {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.source === "lucide" || record.source === "emoji") &&
    typeof record.value === "string" &&
    typeof record.label === "string" &&
    typeof record.fallback === "string"
  );
}

/**
 * The list with `choice` at the front, once, at most `RECENTS_MAX` long. An `svg`
 * choice is not remembered: a canonical document is up to 8 KiB, and twelve of them
 * is not what a recents strip is for.
 */
export function pushRecent(recents: readonly GlyphChoice[], choice: GlyphChoice): GlyphChoice[] {
  if (choice.source === "svg") return [...recents];
  const rest = recents.filter((recent) => !(recent.source === choice.source && recent.value === choice.value));
  return [choice, ...rest].slice(0, RECENTS_MAX);
}

export function writeRecents(storage: Pick<Storage, "setItem"> | null | undefined, recents: readonly GlyphChoice[]): void {
  try {
    storage?.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, RECENTS_MAX)));
  } catch {
    /* private mode: recents live for this page load only */
  }
}
