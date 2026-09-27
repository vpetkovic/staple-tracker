/**
 * A phone sheet: slides up from the bottom edge, rounded on top, a grab handle, a title
 * row with a 44px close button, and a body that scrolls with momentum inside the sheet
 * rather than scrolling the page behind it. The bottom padding includes the home-indicator
 * safe area, and the height is capped in `dvh` so the browser's collapsing toolbars never
 * push the last row off screen.
 *
 * Built on Radix Dialog, so focus is trapped inside while it is open, Escape and a tap on
 * the scrim close it, and the page behind is inert to a screen reader.
 */
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  name,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Read out with the title; visually hidden when absent. */
  description?: string;
  children: ReactNode;
  className?: string;
  /** Written to `data-sheet`, the test and measurement hook. */
  name?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="staple-sheet-overlay fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          data-bottom-sheet
          data-sheet={name}
          className={cn(
            "staple-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-2xl border-t bg-popover text-popover-foreground shadow-2xl outline-none",
            className,
          )}
        >
          <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
          <div className="flex shrink-0 items-center gap-2 px-4 pt-1 pb-2">
            <DialogPrimitive.Title className="min-w-0 flex-1 text-[17px] font-semibold tracking-tight">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-text-tertiary outline-none hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <XIcon className="size-5" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className={description ? "-mt-1 px-4 pb-2 text-[13px] text-muted-foreground" : "sr-only"}>
            {description ?? title}
          </DialogPrimitive.Description>
          <div className="staple-momentum min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
