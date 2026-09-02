import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // Same field treatment as <Input>, deliberately identical string order so
        // the two controls cannot drift: a textarea and a text input sitting in the
        // same form must be the same surface, the same border and the same focus.
        "border-input placeholder:text-text-tertiary bg-field focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/30 aria-invalid:border-destructive hover:border-border-strong flex field-sizing-content min-h-16 min-w-0 w-full max-w-full rounded-md border px-3 py-2 text-base shadow-xs transition-(--tp-color-box-shadow) outline-none focus-visible:ring-(length:--rad-3) disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
