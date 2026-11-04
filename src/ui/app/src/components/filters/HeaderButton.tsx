/**
 * The one button recipe every control on the toolbar wears — Group, Sort, Filter, Done and
 * the search trigger — so the row reads as one vocabulary: 32px (h-control-md), text-body
 * (13px), a 16px icon, 6px between icon and word, 8px corners, ghost until hovered, and the
 * one focus ring.
 *
 * `compact` drops the word and leaves the icon; the word then lives in the tooltip and in
 * `aria-label`, so a narrow header is read out exactly as a wide one. A tooltip is shown
 * in both forms when `hint` is given — the sort control uses it for the full reading of the
 * direction, which no longer fits on the trigger.
 */
import { forwardRef, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const HEADER_BUTTON_CLASS = cn(
  "h-control-md gap-1.5 rounded-lg px-2.5 text-body font-normal focus-ring [&_svg:not([class*='size-'])]:size-4",
  // A phone: every control is a 44px target, and the icon grows to match.
  "max-md:h-11 max-md:min-w-11 max-md:[&_svg:not([class*='size-'])]:size-5",
  // A desk-width tablet under a finger: the same 44px floor, the desk's drawing.
  "pointer-coarse:h-11 pointer-coarse:min-w-11",
  "text-muted-foreground hover:text-foreground",
);

/** The compact form: a 32px square. */
const HEADER_ICON_CLASS = "size-control-md px-0 max-md:size-11 pointer-coarse:size-11";

/**
 * Can this device hover? A tooltip is a hover affordance: on a touch screen it opens when
 * focus lands on the button — after a menu closes and hands focus back — and then sits
 * over the page with nothing to dismiss it. Touch devices get the accessible name instead.
 * True where nothing can answer (a string render), which is the desktop behaviour.
 */
const HOVER_QUERY = "(hover: hover)";
function subscribeHover(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(HOVER_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}
function readHover(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(HOVER_QUERY).matches;
}
export function useCanHover(): boolean {
  return useSyncExternalStore(subscribeHover, readHover, () => true);
}

export type HeaderButtonProps = Omit<ComponentProps<typeof Button>, "children"> & {
  icon: ReactNode;
  /** The word beside the icon; dropped when compact, kept for the accessible name. */
  label: string;
  compact?: boolean;
  /** The tooltip. Defaults to the label when compact; absent otherwise. */
  hint?: ReactNode;
  /** Lit when the control is "on" — a filter applied, a grouping chosen. */
  active?: boolean;
  /** A trailing badge, e.g. the filter count. Survives the compact form. */
  badge?: ReactNode;
};

export const HeaderButton = forwardRef<HTMLButtonElement, HeaderButtonProps>(function HeaderButton(
  { icon, label, compact = false, hint, active = false, badge, className, "aria-label": ariaLabel, ...props },
  ref,
) {
  const canHover = useCanHover();
  const button = (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      aria-label={ariaLabel ?? label}
      data-compact={compact ? "" : undefined}
      // Compact is a 32px square — unless a badge rides along, when the square would
      // crowd the icon against the count and the button keeps its side padding instead.
      className={cn(
        HEADER_BUTTON_CLASS,
        compact && (badge ? "px-1.5" : HEADER_ICON_CLASS),
        active && "text-foreground",
        className,
      )}
      {...props}
    >
      {icon}
      {compact ? null : label}
      {badge}
    </Button>
  );
  const tooltip = hint ?? (compact ? label : null);
  if (tooltip === null || !canHover) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
});
