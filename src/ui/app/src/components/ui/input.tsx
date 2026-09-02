import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // `bg-field` rather than `bg-transparent`: a field has to read as a field
        // before you focus it. In light mode --field is white (so on a white card
        // only the border shows, which is correct); in dark it is #0a0a0a, one step
        // BELOW the #111 panel it sits on, so the control reads as inset. That
        // inset-in-dark / flush-in-light asymmetry is exactly how Vercel's inputs
        // behave, and it replaces the inherited `dark:bg-input/30` guess.
        "file:text-foreground placeholder:text-text-tertiary selection:bg-primary selection:text-primary-foreground border-input bg-field h-9 w-full min-w-0 rounded-md border px-3 py-1 text-base shadow-xs transition-(--tp-color-box-shadow) outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "hover:border-border-strong",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)",
        "aria-invalid:ring-destructive/30 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
