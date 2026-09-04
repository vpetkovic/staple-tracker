/**
 * A CONFIGURED GLYPH, drawn safely — R5c (STA-183).
 *
 * The one place in the browser that puts an operator's `emoji` or `svg` appearance on
 * screen. An emoji is text, and text is safe by construction. An SVG is markup, and
 * this component draws it by injecting a string — so the rule is absolute: the ONLY
 * string that ever reaches `dangerouslySetInnerHTML` here is the sanitiser's canonical
 * output, recognised by `safeGlyph` in `lib/kind-appearance.ts`, which holds the value
 * to the exact shape `src/core/svg-sanitize.ts` writes and answers null for anything
 * else. Null draws the record's terminal fallback as text. There is no path from an
 * arbitrary string to the DOM through this file, and `safe-glyph.test.tsx` proves it
 * with hostile inputs.
 *
 * The injected string sits INSIDE an `<svg>` this component owns: the wrapper carries
 * the size, the viewBox the sanitiser recorded, and the accessible name, so a custom
 * glyph is sized exactly like `KindGlyph`'s built-in marks and coloured by
 * `currentColor` like them (the sanitiser normalised every fill and stroke).
 *
 * Standalone, the glyph is an image with a name (`role="img"` and `aria-label`) — the
 * picker's preview and a group header want that. Inside a cluster that already names
 * the kind in text, the caller passes `decorative` and the glyph is hidden from
 * assistive tech, for the reason `KindGlyph` gives: one fact, read once.
 */
import { safeGlyph, type KindAppearance } from "@/lib/kind-appearance";
import { cn } from "@/lib/utils";

export interface SafeGlyphProps {
  appearance: Pick<KindAppearance, "source" | "value" | "label" | "fallback">;
  /** Rendered size in px. 12 is the identifier cluster; 16 matches StatusIcon. */
  size?: number;
  className?: string;
  /** Hide from assistive tech because the surrounding text already names the kind. */
  decorative?: boolean;
}

export function SafeGlyph({ appearance, size = 12, className, decorative = false }: SafeGlyphProps) {
  const spec = safeGlyph(appearance);
  const aria = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": appearance.label };
  const box = { width: size, height: size, fontSize: size, lineHeight: 1 };

  if (spec?.source === "svg") {
    return (
      <svg
        className={cn("staple-safe-glyph shrink-0", className)}
        data-testid="safe-glyph"
        data-glyph-source="svg"
        width={size}
        height={size}
        viewBox={spec.viewBox}
        focusable="false"
        {...aria}
        // The sanitiser's canonical output and nothing else: `safeGlyph` answered non-null
        // only because the value matched that exact shape. See the header.
        dangerouslySetInnerHTML={{ __html: spec.body }}
      />
    );
  }

  // Text, either way: the emoji itself, or the terminal fallback when the record could not be drawn.
  const text = spec?.source === "emoji" ? spec.text : appearance.fallback;
  return (
    <span
      className={cn("staple-safe-glyph inline-flex shrink-0 select-none items-center justify-center", className)}
      data-testid="safe-glyph"
      data-glyph-source={spec ? "emoji" : "fallback"}
      style={box}
      {...aria}
    >
      {text}
    </span>
  );
}
