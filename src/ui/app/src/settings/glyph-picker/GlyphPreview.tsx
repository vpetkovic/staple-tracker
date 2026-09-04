/**
 * WHAT A CHOICE WILL LOOK LIKE, before it is saved — R5d (STA-184).
 *
 * The preview is not a second renderer. The draft appearance is handed to the same
 * `KindGlyph` the rows draw, through the same `appearance` prop, at the two sizes that
 * exist in the app: `KIND_GLYPH_SIZE` (12px, the identifier cluster) and the 14px the
 * graph's node mark uses. What the picker shows is therefore what the row and the graph
 * node will show, by construction rather than by resemblance.
 *
 * R5d had to draw a `lucide` choice here itself, because `KindGlyph` had no Lucide arm
 * yet. R5e (STA-185) put it there — one resolver for every source — so this file is now
 * what its header always said it was: the two sizes, and nothing else.
 */
import { KIND_GLYPH_SIZE, KindGlyph } from "@/components/task-list";
import type { KindAppearance } from "@/lib/kind-appearance";
import { cn } from "@/lib/utils";

/** The row's size and the graph node's size — the two places a kind glyph is drawn. */
export const PREVIEW_SIZES = { row: KIND_GLYPH_SIZE, graph: 14 } as const;

export interface GlyphPreviewProps {
  kind: string;
  appearance: KindAppearance;
  size: number;
  className?: string;
}

/** One glyph at one size. Decorative: the preview's caption names it in text. */
export function GlyphPreview({ kind, appearance, size, className }: GlyphPreviewProps) {
  return (
    <span className={cn("inline-flex", className)} data-testid="glyph-preview" data-glyph-source={appearance.source}>
      <KindGlyph kind={kind} appearance={appearance} size={size} labelled={false} />
    </span>
  );
}
