/**
 * KIND APPEARANCE — R5a (STA-181).
 *
 * What a kind LOOKS like, as one typed record per kind: where the web icon comes
 * from, the value that names it, the label assistive tech reads, and the
 * character a terminal prints instead. Every surface that shows a kind — the
 * task list, the graph, `staple kinds ls`, `list_kinds`, `/api/settings` —
 * resolves through here, so the same kind wears the same mark everywhere.
 *
 * ## Persisted as a registry value, not a column
 *
 * The operator's choices live in ONE workspace setting, `kinds.appearance`
 * (see `settings-registry.ts`): a map from kind id to a stored record, holding
 * only the kinds somebody customised. The built-in marks below are code, not
 * rows, which is what makes the upgrade lossless: a database on disk needs no
 * backfill to resolve `epic` to its canonical icon, a custom kind resolves to
 * the generic mark until it is given one, and the configured ORDER of
 * `workspace_kinds` is never touched. The registry supplies versioning, read
 * and write validation, provenance and unknown-key preservation, so the record
 * does not carry a second version of its own.
 *
 * ## Appearance is not colour
 *
 * The record has no colour field and the validator refuses any field it does
 * not know. Hue belongs to a STATUS CATEGORY (`styles/app.css` maps the eight
 * categories onto the theme's status hues) and a kind glyph is monochrome by
 * design — see `KindGlyph.tsx`. An appearance that could name a colour would
 * be a second, kind-shaped status axis, and the row would say two things with
 * one hue.
 *
 * ## Why core validates the KEY and not the CATALOG
 *
 * The Lucide catalog (`src/ui/app/src/lib/icon-catalog.ts`) is browser code and
 * names ~1800 icons; importing it into core would drag the manifest into every
 * CLI process. Core therefore checks that a `lucide` value is SHAPED like a
 * Lucide key, and the browser's `resolveIcon` decides whether the key exists —
 * an unknown key resolves to `undefined` there, which is the cue to draw the
 * fallback. Both answers are deterministic, which is the criterion.
 */
import { VOCABULARY_ID_PATTERN, type WorkspaceKind } from "./types.js";

export const KIND_APPEARANCE_SOURCES = ["lucide", "emoji", "svg", "none"] as const;
export type KindAppearanceSource = (typeof KIND_APPEARANCE_SOURCES)[number];

/** One kind's RESOLVED appearance — what every read surface serves. */
export interface KindAppearance {
  /** Where the web icon comes from. `none` means "no web icon: draw the built-in mark". */
  source: KindAppearanceSource;
  /** A canonical Lucide key, an emoji, sanitised SVG (STA-183), or `""` for `none`. */
  value: string;
  /** The accessible name — the configured kind label unless the operator set one. */
  label: string;
  /** What a terminal prints in place of the icon. Text or a single Unicode glyph. */
  fallback: string;
}

/** What the operator stores. `label` is optional: absent means "the kind's own label". */
export interface StoredKindAppearance {
  source: KindAppearanceSource;
  value: string;
  fallback: string;
  label?: string;
}

/** The persisted value of `kinds.appearance`: only the kinds somebody customised. */
export type KindAppearanceMap = Readonly<Record<string, StoredKindAppearance>>;

/** A configured kind row with its resolved appearance — the `list_kinds` / `kinds ls --json` row. */
export interface KindWithAppearance extends WorkspaceKind {
  appearance: KindAppearance;
}

/** Lucide keys are lowercase kebab-case (`triangle-alert`); the catalog's `normalizeIconKey` produces exactly this. */
export const LUCIDE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LUCIDE_KEY_MAX = 64;
const EMOJI_MAX_UNITS = 16;
const FALLBACK_MAX_UNITS = 4;
const LABEL_MAX = 80;

/** The mark for a kind nobody has given one: present, neutral, impersonating nothing. */
export const GENERIC_KIND_FALLBACK = "•";

/**
 * The built-in marks, keyed by kind id and applied when nothing is stored.
 * Canonical Lucide keys (`test/kind-appearance.test.ts` and the UI mirror's
 * test prove each resolves in the generated catalog) with a text-presentation
 * Unicode fallback each — none of them an emoji, because an emoji is two
 * columns wide in most terminals and would shift every line it sits on; and
 * none of them a glyph the CLI already uses for a status or a priority.
 *
 * `milestone` is here without being in `BUILTIN_KIND_SEED`: the vocabulary is
 * data and a workspace that adds the kind should get its canonical mark rather
 * than the generic one. Nothing here changes which kinds exist or their order.
 */
export const BUILTIN_KIND_APPEARANCE: Readonly<Record<string, Omit<KindAppearance, "label">>> = Object.freeze({
  milestone: { source: "lucide", value: "milestone", fallback: "⚑" },
  epic: { source: "lucide", value: "layers", fallback: "◆" },
  task: { source: "lucide", value: "square-check", fallback: "◇" },
  bug: { source: "lucide", value: "bug", fallback: "✱" },
  chore: { source: "lucide", value: "wrench", fallback: "↻" },
  spike: { source: "lucide", value: "zap", fallback: "↯" },
});

/**
 * Resolve one kind: the stored record when there is one, the built-in mark for
 * a seeded id, the generic mark otherwise. Deterministic and total — the same
 * kind and the same stored value always give the same record, and there is no
 * input that gives none. The label is the kind's own unless the stored record
 * set a non-empty one, so a workspace that renamed `spike` to "Investigation"
 * is heard by every screen reader without re-saving its glyph.
 */
export function resolveKindAppearance(
  kind: Pick<WorkspaceKind, "id" | "label">,
  stored?: StoredKindAppearance,
): KindAppearance {
  const base = stored ?? BUILTIN_KIND_APPEARANCE[kind.id] ?? { source: "none", value: "", fallback: GENERIC_KIND_FALLBACK };
  const label = stored?.label?.trim() || kind.label;
  return { source: base.source, value: base.value, label, fallback: base.fallback };
}

const hasControlOrSpace = (text: string): boolean => /[\s\p{Cc}]/u.test(text);

/**
 * Why one stored record is not acceptable, or null when it is. The registry's
 * `kindAppearance` schema arm reports this through its own "must be …"
 * sentence, so the boundary refusal names the key AND the field.
 *
 * `svg` is refused in this version on purpose: STA-183 owns the sanitiser, and
 * until it exists nothing that could carry markup is written to disk. `emoji`
 * is bounded by UTF-16 units here; STA-183 replaces that with a grapheme count.
 */
export function kindAppearanceProblem(record: unknown): string | null {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return "an object";
  const known = new Set(["source", "value", "fallback", "label"]);
  for (const field of Object.keys(record)) {
    if (!known.has(field)) return `an appearance record without "${field}" (only source, value, fallback and label are allowed)`;
  }
  const { source, value, fallback, label } = record as Record<string, unknown>;
  if (typeof source !== "string" || !(KIND_APPEARANCE_SOURCES as readonly string[]).includes(source)) {
    return `a source of ${KIND_APPEARANCE_SOURCES.join(", ")}`;
  }
  if (typeof value !== "string") return "a string value";
  switch (source as KindAppearanceSource) {
    case "lucide":
      if (value.length > LUCIDE_KEY_MAX || !LUCIDE_KEY_PATTERN.test(value)) {
        return "a Lucide icon key for value (lowercase words joined by dashes, e.g. triangle-alert)";
      }
      break;
    case "emoji":
      if (value.length === 0 || value.length > EMOJI_MAX_UNITS || hasControlOrSpace(value)) {
        return `a short emoji or Unicode glyph for value (1 to ${EMOJI_MAX_UNITS} UTF-16 units, no whitespace)`;
      }
      break;
    case "svg":
      return "a source other than svg — custom SVG glyphs need the sanitiser (STA-183) before they can be stored";
    case "none":
      if (value !== "") return 'an empty value when source is "none"';
      break;
  }
  if (typeof fallback !== "string" || fallback.length === 0 || fallback.length > FALLBACK_MAX_UNITS || /[\p{Cc}\n\r]/u.test(fallback)) {
    return `a terminal fallback of 1 to ${FALLBACK_MAX_UNITS} characters with no control characters`;
  }
  if (label !== undefined && (typeof label !== "string" || label.length > LABEL_MAX)) {
    return `a label of at most ${LABEL_MAX} characters, or none`;
  }
  return null;
}

/** Why a whole `kinds.appearance` value is not acceptable, or null. Keys must be kind ids. */
export function kindAppearanceMapProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "a map of kind id to appearance record";
  }
  for (const [id, record] of Object.entries(value as Record<string, unknown>)) {
    if (!VOCABULARY_ID_PATTERN.test(id)) return `keyed by kind ids ("${id}" is not one)`;
    const problem = kindAppearanceProblem(record);
    if (problem) return `${problem} for "${id}"`;
  }
  return null;
}
