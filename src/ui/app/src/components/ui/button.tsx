import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-(--tp-color-background-color-border-color-box-shadow-opacity) disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3) aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Geist's primary button is the INVERSE of the page: near-black on white,
        // white on near-black. `--primary` / `--primary-foreground` already flip
        // that way, so this variant needed no new classes to become correct.
        // A DISABLED FILLED BUTTON IS NOT A TRANSLUCENT FILLED BUTTON. The base
        // `disabled:opacity-50` is fine for a ghost or a link and actively wrong
        // here: half-opacity white on a #111 panel is a bright grey slab, so the
        // loudest object in the detail panel was the one control you cannot press.
        // Disabled drops to the muted surface with tertiary text — visibly inert,
        // and quieter than everything around it, which is the point.
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/85 disabled:opacity-100 disabled:bg-muted disabled:text-text-tertiary disabled:shadow-none",
        cta: "bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/85 disabled:opacity-100 disabled:bg-muted disabled:text-text-tertiary disabled:shadow-none",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 active:bg-destructive/85 focus-visible:ring-destructive/30 disabled:opacity-100 disabled:bg-muted disabled:text-text-tertiary disabled:shadow-none",
        // The Geist secondary: NO fill, one hairline, and hover moves the BORDER as
        // much as the surface. Explicitly not `bg-field` — a field is inset (in dark
        // mode it sits BELOW the panel it is on) and a button is not; giving the
        // button the field surface made "claim" and "release" read as sunken wells
        // next to the select they sit beside.
        outline:
          "border border-input bg-transparent hover:border-border-strong hover:bg-surface-hover active:bg-surface-active",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-surface-active",
        ghost: "hover:bg-surface-hover active:bg-surface-active",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        // Geist runs tighter than stock shadcn: its default control is 32px and its
        // large one 40px, where shadcn starts at 40px for everything. On a dense
        // tracker — a header full of controls, a detail panel of inline editors —
        // the 40px default was the single biggest source of the "generic admin
        // dashboard" read. Every step drops one notch; `lg` keeps 40px so a real
        // primary action still has presence.
        default: "h-9 px-3.5 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-2.5 text-[13px] has-[>svg]:px-2",
        lg: "h-10 rounded-md px-5 has-[>svg]:px-4",
        icon: "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean
    }
>(function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}, ref) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
})

Button.displayName = "Button"

export { Button, buttonVariants }
