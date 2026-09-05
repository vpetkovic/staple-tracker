/**
 * The one button recipe every control on the content header wears — Group, Sort, Filter,
 * Done and the search trigger — so the row reads as one vocabulary: 28px, 13px, a 16px icon,
 * 6px between icon and word, ghost until hovered.
 *
 * `compact` drops the word and leaves the icon; the word then lives in the tooltip and in
 * `aria-label`, so a narrow header is read out exactly as a wide one. A tooltip is shown
 * in both forms when `hint` is given — the sort control uses it for the full reading of the
 * direction, which no longer fits on the trigger.
 */
import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const HEADER_BUTTON_CLASS = cn(
  "h-7 gap-1.5 rounded-md px-2 text-[13px] font-normal [&_svg:not([class*='size-'])]:size-4",
  "text-muted-foreground hover:text-foreground",
);

/** The compact form: a 28px square. */
const HEADER_ICON_CLASS = "size-7 px-0";

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
  const button = (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      aria-label={ariaLabel ?? label}
      data-compact={compact ? "" : undefined}
      // Compact is a 28px square — unless a badge rides along, when the square would
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
  if (tooltip === null) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
});
