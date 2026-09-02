/**
 * Sizing the agent's context window — pure, so the arithmetic is testable.
 *
 * The number this produces is the whole point of the "what the agent sees" pane, so two
 * things about it have to be right:
 *
 * 1. It is measured on the COMPACT JSON. `ok()` in src/mcp.ts sends
 *    `JSON.stringify(payload)` with no indentation; the pane displays an indented copy
 *    for reading. Estimating the indented string would overstate the real cost by
 *    roughly a third — on a pane whose job is honesty about size, that is the one
 *    number that must not flatter.
 * 2. It is labelled an estimate wherever it is shown. chars ÷ 4 is a heuristic that is
 *    close for English prose and wrong for dense JSON punctuation in the safe
 *    direction; a reader who thinks it is exact will make worse decisions than one who
 *    knows it is not.
 */

/** The divisor behind the estimate. Roughly one token per four characters of English. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Exactly what mcp.ts puts on the wire for a tool result's text block. */
export function wireJson(payload: unknown): string {
  return JSON.stringify(payload);
}

export interface PayloadSlice {
  key: string;
  chars: number;
  tokens: number;
  /** 0..1 of the whole payload. */
  share: number;
  /** Rows for the collections that grow without bound; null for scalar-ish keys. */
  count: number | null;
}

/**
 * Per-top-level-key share of the payload.
 *
 * By key rather than by depth because the three that grow without bound — comments,
 * documents, children — are top-level. Turning "this context is big" into "your comment
 * thread is 60% of it" is the difference between a number and an action.
 *
 * Shares are computed against the sum of the parts, not against the whole serialized
 * object, so they add to 1 and the bars line up. The few characters of envelope
 * punctuation the whole-object length includes are not attributable to any key.
 */
export function breakdown(payload: Record<string, unknown>): PayloadSlice[] {
  const sizes = Object.entries(payload).map(([key, value]) => ({
    key,
    chars: wireJson(value).length,
    count: Array.isArray(value) ? value.length : null,
  }));
  const total = sizes.reduce((sum, slice) => sum + slice.chars, 0) || 1;
  return sizes
    .map((slice) => ({
      ...slice,
      tokens: estimateTokens(wireJson(payload[slice.key])),
      share: slice.chars / total,
    }))
    .sort((a, b) => b.chars - a.chars);
}

/** 12345 -> "12,345". Intl would work too; this avoids a locale surprise in a CLI tool. */
export function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
