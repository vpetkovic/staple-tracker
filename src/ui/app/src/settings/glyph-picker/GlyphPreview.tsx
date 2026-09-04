/**
 * WHAT A CHOICE WILL LOOK LIKE, before it is saved — R5d (STA-184).
 *
 * The preview is not a second renderer. An `emoji` or `svg` record is handed to the
 * same `KindGlyph` the rows draw, with the same `appearance` prop, at the two sizes
 * that exist in the app: `KIND_GLYPH_SIZE` (12px, the identifier cluster) and the
 * 14px the graph's `EpicKindMark` uses. What the picker shows is therefore what the
 * row and the graph node will show, by construction rather than by resemblance.
 *
 * A `lucide` choice is the one arm drawn here: `KindGlyph`'s Lucide wiring belongs to
 * R5e (STA-185), so until then this component draws the catalog icon itself, through
 * `loadIconComponent` — the lazy chunk, never a static import, so the main bundle does
 * not grow by the catalog. Before the chunk lands (or for a key the catalog does not
 * know) it draws `KindGlyph`, which is the built-in mark: the same thing a row draws
 * for a `lucide` record today. When R5e moves the Lucide arm into `KindGlyph`, this
 * file loses it and keeps the sizes.
 */
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { KIND_GLYPH_SIZE, KindGlyph } from "@/components/task-list";
import { loadIconComponent } from "@/lib/icon-catalog";
import type { KindAppearance } from "@/lib/kind-appearance";
import { cn } from "@/lib/utils";

/** The row's size and the graph node's size — the two places a kind glyph is drawn. */
export const PREVIEW_SIZES = { row: KIND_GLYPH_SIZE, graph: 14 } as const;

/** The catalog icon for a key, once its chunk has loaded; `undefined` before, or for an unknown key. */
export function useLucideIcon(key: string | null): LucideIcon | undefined {
  const [icon, setIcon] = useState<{ key: string; component: LucideIcon } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    void loadIconComponent(key).then((component) => {
      if (alive && component) setIcon({ key, component });
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return icon && icon.key === key ? icon.component : undefined;
}

export interface GlyphPreviewProps {
  kind: string;
  appearance: KindAppearance;
  size: number;
  className?: string;
}

/** One glyph at one size. Decorative: the preview's caption names it in text. */
export function GlyphPreview({ kind, appearance, size, className }: GlyphPreviewProps) {
  const Icon = useLucideIcon(appearance.source === "lucide" ? appearance.value : null);
  if (Icon) {
    return (
      <span
        className={cn("staple-kind-glyph inline-flex", className)}
        data-testid="glyph-preview"
        data-glyph-source="lucide"
        data-issue-kind={kind}
      >
        <Icon size={size} aria-hidden="true" focusable="false" />
      </span>
    );
  }
  return (
    <span className={cn("inline-flex", className)} data-testid="glyph-preview" data-glyph-source={appearance.source}>
      <KindGlyph kind={kind} appearance={appearance} size={size} labelled={false} />
    </span>
  );
}
