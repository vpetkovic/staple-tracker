import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge, told about the design system's own names (styles/system-tokens.css).
 *
 * Without this it reads `text-body` as a text COLOUR — any unknown `text-*` is — and a
 * `cn("text-body", "text-muted-foreground")` silently drops the size, or a caller's
 * `text-body` drops the primitive's colour. Registering the scale makes the two groups merge
 * the way they do for Tailwind's own `text-sm`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["caption", "label", "body", "reading", "title", "heading", "display"],
      spacing: ["rail", "topbar", "toolbar", "gutter", "page", "control-sm", "control-md", "control-lg"],
      container: ["readable", "wide", "page"],
    },
  },
});

/** shadcn's class merger. Every ui/ primitive expects to find it here. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
