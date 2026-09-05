/**
 * The row-action menu primitive.
 *
 * `TaskRowLine` has carried a `⋯` since V5 with a docstring promising that it "will be
 * where a real menu hangs the day one exists". This is that menu. It is a shadcn-shaped
 * wrapper over `radix-ui`'s `DropdownMenu` — already a dependency, so nothing is installed
 * for it — and it follows `popover.tsx` and `select.tsx` element for element: the same
 * `data-slot` naming, the same portal, the same open/close animation classes, the same
 * `bg-popover` surface.
 *
 * Radix owns the parts that are easy to get wrong and tedious to test: the roving focus
 * inside the menu, typeahead, Escape, outside-click, return-focus-to-trigger, and
 * `aria-disabled` on an item that cannot be chosen. A hand-rolled menu that got all of
 * those right would be this file plus several hundred lines.
 *
 * ── A DISABLED ITEM STILL SAYS WHY ────────────────────────────────────────────────────
 *
 * `DropdownMenuItem` takes an optional `reason`. A disabled item with no explanation is the
 * worst control on any surface — it tells a reader that the thing they want is possible in
 * principle and refuses to say what is in the way. The reason renders as a muted second
 * line inside the item AND as its `title`, so a pointer and a screen reader get the same
 * sentence. It is deliberately part of the primitive rather than left to each call site:
 * the first call site that forgets is the one that teaches everybody the menu lies.
 *
 * ── THE MENU'S EVENTS ARE THE MENU'S — REACT PORTALS BUBBLE THROUGH THE REACT TREE ────
 *
 * The content is portalled into `document.body`, so nothing it does reaches the host in the
 * DOM. React does not care: a synthetic event propagates up the COMPONENT tree regardless of
 * where the portal put the node, and this menu hangs off `TaskRowLine`'s `⋯` — inside a row
 * whose own `onClick` opens the detail drawer. So choosing "Add to queue" queued the task AND
 * opened it, and pressing Enter on an item did the same through the row's `onKeyDown`.
 *
 * Diagnosed rather than guessed: a native capture listener on the row saw NOTHING (the DOM
 * really is separate), while a stack trace from `session.open` showed the call arriving at
 * `TaskRowLine`'s `onOpen` through React's dispatcher.
 *
 * The stop belongs HERE and not at the call site. Every consumer of this primitive hangs it
 * off something, and "the thing I clicked the menu on also fired" is not a bug each of them
 * should have to rediscover. It is `click` and `keydown` only — the two a host acts on — and
 * it stops nothing INSIDE the menu: Radix's item handlers sit at or below this node, so they
 * have already run by the time propagation is halted here.
 */
import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  align = "end",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        align={align}
        sideOffset={sideOffset}
        // See the header: the host must not act on the menu's clicks and keys.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-44 origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg border p-1 shadow-lg outline-hidden",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  children,
  reason,
  disabled,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  /** Why this item cannot be chosen. Rendered muted under the label and in `title`. */
  reason?: string;
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      disabled={disabled}
      title={reason}
      className={cn(
        "relative flex cursor-default select-none flex-col gap-0.5 rounded-md px-2 py-1.5 text-[13px] outline-hidden",
        "focus:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-55",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      <span className="flex items-center gap-2">{children}</span>
      {reason ? (
        <span data-slot="dropdown-menu-reason" className="text-[11px] text-muted-foreground">
          {reason}
        </span>
      ) : null}
    </DropdownMenuPrimitive.Item>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
};
