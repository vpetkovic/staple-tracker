import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // An alpha fill rather than an opaque grey, so a skeleton has the right
      // weight whether it is standing in for a row on the page or for content
      // inside a card. The pulse is what tells you the app is waiting on the
      // network rather than showing you an empty list — a static grey block says
      // the wrong thing on a tracker that polls.
      className={cn("bg-surface-selected animate-pulse rounded-md", className)}
      {...props}
    />
  )
}

export { Skeleton }
