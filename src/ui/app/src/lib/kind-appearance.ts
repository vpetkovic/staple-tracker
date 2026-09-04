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
 *
 * R5c (STA-183) adds `safeGlyph`, the browser's own gate on an `emoji` or `svg` record.
 * The server stores nothing but the sanitiser's canonical output, but the browser does
 * not get to assume that: the record crossed a wire, and the wire could come from an
 * older or a stranger server. So before anything is injected, the value is held to the
 * exact SHAPE of `src/core/svg-sanitize.ts`'s output — one root with the attributes the
 * sanitiser writes, in its order; only the elements it emits; no handler, no URL, no
 * reference that is not local — and to the same grapheme rule for an emoji. Anything
 * else answers null, which every renderer treats as "draw the fallback". The Node side
 * (`test/kind-appearance.test.ts`) holds this gate to the sanitiser's real output.
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

/** Mirror of core's emoji bounds: grapheme clusters, with a UTF-16 unit ceiling. */
export const EMOJI_MAX_GRAPHEMES = 2;
export const EMOJI_MAX_UNITS = 32;
/** Mirror of core's `SVG_MAX_BYTES`: the browser refuses to look at anything larger. */
export const SVG_MAX_BYTES = 8 * 1024;

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

/**
 * Mirror of core's `emojiGlyphProblem`, as a yes/no: 1 to 2 grapheme clusters, at most
 * 32 UTF-16 units, no whitespace, control characters or lone surrogates, and at least
 * one visible code point.
 */
export function isEmojiGlyph(value: string): boolean {
  if (value.length === 0 || value.length > EMOJI_MAX_UNITS) return false;
  if (/[\s\p{Cc}\p{Cs}]/u.test(value)) return false;
  if (!/[^\p{Cf}\p{Mn}\p{Me}]/u.test(value)) return false;
  let graphemes = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) graphemes += 1;
  return graphemes <= EMOJI_MAX_GRAPHEMES;
}

/**
 * The sanitiser's root, exactly as it writes it: namespace, a four-number viewBox,
 * `role="img"`, the escaped label, then any surviving root presentation attributes;
 * then the one `<title>`, then the body. Captures: viewBox, label, root attributes, body.
 */
const CANONICAL_ROOT =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="(-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+)" role="img" aria-label="([^"<>]*)"((?: [a-zA-Z-]+="[^"<>]*")*)><title>[^<>]*<\/title>([\s\S]*)<\/svg>$/;
/** The elements the sanitiser can emit in a body. Everything else is a refusal, whatever else the string says. */
const CANONICAL_ELEMENTS = new Set(["g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "clipPath", "symbol", "use"]);
/** A tag as the sanitiser writes one: a name, then plain `name="value"` attributes, then `>` or `/>`. */
const TAG = /<\/?([A-Za-z]+)((?: [a-zA-Z-]+="[^"<>]*")*)\/?>/g;
const ATTRIBUTE = /([a-zA-Z-]+)="([^"]*)"/g;
const HOSTILE = /javascript:|vbscript:|data:|@import|expression\(|<!|<\?|\son[a-z]+=/i;

/** No handler, and no reference that is not local. */
function attributesAreSafe(attributes: string): boolean {
  for (const [, name, value] of attributes.matchAll(ATTRIBUTE)) {
    if (name!.startsWith("on")) return false;
    if (name === "href" ? !/^#[\w.:-]+$/.test(value!) : /url\(/i.test(value!) && !/^url\(#[\w.:-]+\)$/.test(value!)) return false;
  }
  return true;
}

/**
 * Is this string the sanitiser's canonical SVG, and nothing else? Deliberately stricter
 * than "does it look safe": the gate recognises ONE shape and refuses every other, so a
 * value that would need a real parser to judge is never judged here — it falls back.
 */
export function isCanonicalSvg(value: string): boolean {
  if (value.length > SVG_MAX_BYTES || HOSTILE.test(value)) return false;
  const root = CANONICAL_ROOT.exec(value);
  if (!root || !attributesAreSafe(root[3]!)) return false;
  const body = root[4]!;
  for (const [, name, attributes] of body.matchAll(TAG)) {
    if (!CANONICAL_ELEMENTS.has(name!) || !attributesAreSafe(attributes!)) return false;
  }
  // Between the tags there is nothing at all: the sanitiser writes no text outside <title>.
  return body.replace(TAG, "") === "";
}

/** What a renderer draws for an `emoji` or `svg` record — or null, meaning "draw the fallback". */
export type SafeGlyphSpec =
  | { source: "emoji"; text: string; label: string }
  | { source: "svg"; viewBox: string; label: string; body: string };

/**
 * Turn a served record into something safe to draw, or null. For `svg`, `body` is the
 * canonical document's content — the `<title>` and the shapes — for a caller to place
 * inside its own `<svg>` wrapper, which is what sizes it. `lucide` and `none` are not
 * this function's to answer: the catalog resolves the one, and the other means "the
 * built-in mark".
 */
export function safeGlyph(appearance: Pick<KindAppearance, "source" | "value" | "label">): SafeGlyphSpec | null {
  switch (appearance.source) {
    case "emoji":
      return isEmojiGlyph(appearance.value) ? { source: "emoji", text: appearance.value, label: appearance.label } : null;
    case "svg": {
      if (!isCanonicalSvg(appearance.value)) return null;
      const viewBox = CANONICAL_ROOT.exec(appearance.value)![1]!;
      // Everything after the root tag and before the close: the <title> and the shapes.
      const body = appearance.value.slice(appearance.value.indexOf("<title>"), -"</svg>".length);
      return { source: "svg", viewBox, label: appearance.label, body };
    }
    default:
      return null;
  }
}
