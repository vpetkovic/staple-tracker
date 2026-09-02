/**
 * What colour a label is — V5 (STA-97) §8.1.
 *
 * WHY A HASH AND NOT A STORED COLOUR. Labels in staple are free strings in a JSON array.
 * There is no label table, so there is nowhere to hang a colour without inventing a schema,
 * a migration, and a settings screen for a thing nobody asked to configure. A pure function
 * of the string gives a colour that is identical on every machine, in every view, forever,
 * and costs none of that. Collisions are harmless: the label NAME is always rendered next
 * to the dot, so colour is a scanning aid and never the identifier.
 *
 * Eight hues is the honest ceiling. Past that they stop being distinguishable at 6px and
 * the dot becomes decoration.
 *
 * The two tiers exist because a few label names already mean something to everyone who will
 * ever read this list. `bug` being some arbitrary teal because that is where FNV-1a landed
 * is a small, daily, avoidable annoyance.
 */

/** Fixed index meanings, so the override map can name a hue by intent. See tree-row.css. */
export const LABEL_HUE_COUNT = 8;

/** Tier 1 — labels with an established meaning get the colour people expect. */
const LABEL_HUE: Record<string, number> = {
  bug: 1,
  regression: 1,
  security: 1,
  performance: 3,
  perf: 3,
  design: 6,
  docs: 8,
  chore: 8,
  infra: 4,
  feature: 5,
  enhancement: 5,
};

/**
 * FNV-1a, 32-bit. Chosen because it is four lines, has no dependencies, and is stable
 * across sessions and machines by construction — it is a pure function of the bytes.
 * `Math.imul` keeps the multiply in 32-bit territory that plain `*` would lose to float.
 */
function hash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 1-based hue index for any label string. Stable forever. */
export function labelHue(label: string): number {
  const key = label.trim().toLowerCase();
  return LABEL_HUE[key] ?? (hash(key) % LABEL_HUE_COUNT) + 1;
}

/**
 * The first `max` labels, and the rest.
 *
 * SOURCE ORDER, not alphabetical and not by hue. Whoever typed `bug, wave-2` put `bug`
 * first for a reason, and re-sorting destroys information the row cannot recover. `max` of
 * zero is a real case — below 1024px the cluster degrades to bare dots and every label
 * moves into the overflow tooltip.
 */
export function splitLabels(
  labels: readonly string[],
  max: number,
): { shown: string[]; hidden: string[] } {
  const cap = Math.max(0, max);
  return { shown: labels.slice(0, cap), hidden: labels.slice(cap) };
}
