/**
 * The class merger for detail code: `lib/utils`' `cn`, taught the type scale.
 *
 * `styles/system-tokens.css` adds `text-caption … text-display` as font sizes, but the shared
 * `cn` (plain `twMerge`) does not know them, reads them as text COLOURS, and silently drops
 * one of `text-body` / `text-foreground` whenever both reach the same call. This merger
 * knows they are sizes, so a size and a colour always survive together.
 *
 * Classes handed to a `components/ui` primitive are merged again by that primitive's own
 * `cn`, so a size token passed there can still lose; use an arbitrary size (`text-[13px]`)
 * on those.
 */
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "label", "body", "reading", "title", "heading", "display"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
