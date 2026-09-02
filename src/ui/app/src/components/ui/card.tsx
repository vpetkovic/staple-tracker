import * as React from "react"

import { cn } from "@/lib/utils"

function Card({
  className,
  interactive = false,
  ...props
}: React.ComponentProps<"div"> & {
  /**
   * The whole card is a click target: quiet hover affordance (border darkens,
   * slight lift), pointer cursor, keyboard focus ring. Static containers omit
   * it — one Card, two modes.
   */
  interactive?: boolean
}) {
  return (
    <div
      data-slot="card"
      className={cn(
        // Geist cards run at a 16px rhythm, not shadcn's 24px. At 24px a card
        // holding three short lines is mostly padding, which reads as a marketing
        // panel rather than a piece of an application. Padding lives in the
        // sub-parts; this only owns the vertical rhythm and the shell.
        "bg-card text-card-foreground flex flex-col gap-4 rounded-lg border py-4",
        // Hover moves the BORDER and nothing else. No lift, no shadow: elevation
        // in this language means "floating above the page" and a card in a list is
        // not floating — saying so with a shadow makes the whole list feel like it
        // is hovering.
        interactive &&
          "cursor-pointer transition-colors hover:border-border-strong hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-(--gtr-1) items-start gap-2 px-4 has-data-[slot=card-action]:grid-cols-(--gtc-17) [.border-b]:pb-4",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-4 [.border-t]:pt-4", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
