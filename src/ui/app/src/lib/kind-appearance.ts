/**
 * KIND APPEARANCE, as the browser sees it — R5a (STA-181).
 *
 * The record `src/core/kind-appearance.ts` defines, mirrored field for field because
 * src/core is Node-only and this app cannot import it. The server resolves every kind
 * and serves the record on each row of `/api/settings` `kinds[]`; what this module adds
 * is the same built-in table, so the FIRST PAINT — before that fetch resolves — wears
 * the right marks for a default workspace rather than six generic dots, and so an id
 * the server has not named yet still gets a total answer. `test/kind-appearance.test.ts`
 * holds the two tables equal.
 *
 * No colour here, and none on the wire: hue is a STATUS CATEGORY property (see
 * `styles/app.css`) and a kind glyph is monochrome by design (`KindGlyph.tsx`). The
 * catalog check — does this Lucide key exist? — is `resolveIcon` in `icon-catalog.ts`;
 * an unknown key answers `undefined` there, which is the cue to draw the built-in mark.
 */
import type { WorkspaceKind } from "./types.js";

export const KIND_APPEARANCE_SOURCES = ["lucide", "emoji", "svg", "none"] as const;
export type KindAppearanceSource = (typeof KIND_APPEARANCE_SOURCES)[number];

/** One kind's resolved appearance, exactly as served. */
export interface KindAppearance {
  /** Where the web icon comes from. `none` means "no web icon: draw the built-in mark". */
  source: KindAppearanceSource;
  /** A canonical Lucide key, an emoji, sanitised SVG (STA-183), or `""` for `none`. */
  value: string;
  /** The accessible name — the configured kind label unless the operator set one. */
  label: string;
  /** What a terminal prints in place of the icon. */
  fallback: string;
}

/** A served kind row. `appearance` is absent only from a server older than R5a. */
export interface KindRow extends WorkspaceKind {
  appearance?: KindAppearance;
}

/** The mark for a kind nobody has given one. Mirror of core's `GENERIC_KIND_FALLBACK`. */
export const GENERIC_KIND_FALLBACK = "•";

/** Mirror of core's `BUILTIN_KIND_APPEARANCE`: canonical Lucide keys and terminal fallbacks by kind id. */
export const BUILTIN_KIND_APPEARANCE: Readonly<Record<string, Omit<KindAppearance, "label">>> = Object.freeze({
  milestone: { source: "lucide", value: "milestone", fallback: "⚑" },
  epic: { source: "lucide", value: "layers", fallback: "◆" },
  task: { source: "lucide", value: "square-check", fallback: "◇" },
  bug: { source: "lucide", value: "bug", fallback: "✱" },
  chore: { source: "lucide", value: "wrench", fallback: "↻" },
  spike: { source: "lucide", value: "zap", fallback: "↯" },
});

/**
 * The appearance of a kind the server has not resolved for us: the built-in mark for a
 * seeded id, the generic mark otherwise, labelled with the kind's own label. Mirror of
 * core's `resolveKindAppearance` with nothing stored.
 */
export function fallbackKindAppearance(kind: Pick<WorkspaceKind, "id" | "label">): KindAppearance {
  const base = BUILTIN_KIND_APPEARANCE[kind.id] ?? { source: "none", value: "", fallback: GENERIC_KIND_FALLBACK };
  return { source: base.source, value: base.value, label: kind.label, fallback: base.fallback };
}
