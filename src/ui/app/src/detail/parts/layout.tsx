/**
 * The small layout primitives every part of the detail is built from, so the frame and the
 * tabs share one look: a sentence-case section heading, a card (surface, 12px radius,
 * hairline), and an empty state that says what is missing in one plain sentence.
 */
import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A section heading in sentence case: `text-label`, secondary text, never ALL CAPS.
 * `action` sits at the right end of the heading row (a "Show all", a count).
 */
export function SectionHeading({
  children,
  as: Tag = "h3",
  action,
  id,
  className,
}: {
  children: ReactNode;
  as?: "h2" | "h3" | "h4";
  action?: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <div className={cn("mb-2 flex min-w-0 items-center gap-2", className)} data-section-heading="">
      <Tag id={id} className="min-w-0 flex-1 truncate text-label font-medium text-text-secondary">
        {children}
      </Tag>
      {action ? <div className="flex shrink-0 items-center gap-1 text-label text-text-secondary">{action}</div> : null}
    </div>
  );
}

/**
 * A card: the raised surface, a 12px radius and a hairline border. No shadow. `padded`
 * (the default) gives it the standard 16px inset; pass `false` for a card whose rows
 * reach the edges (a list).
 */
export function DetailCard({
  padded = true,
  className,
  children,
  ...rest
}: { padded?: boolean } & ComponentProps<"div">) {
  return (
    <div data-detail-card="" className={cn("min-w-0 rounded-xl border border-border bg-surface-raised", padded && "p-4", className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * Nothing to show, said plainly: a quiet icon, one sentence, and optionally the one thing
 * the reader can do about it.
 */
export function EmptyState({
  icon: Icon,
  children,
  action,
  className,
}: {
  icon?: LucideIcon;
  /** One plain sentence. */
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div data-empty-state="" className={cn("flex flex-col items-center gap-2 px-4 py-8 text-center", className)}>
      {Icon ? (
        <span className="flex size-9 items-center justify-center rounded-full bg-surface-sunken text-text-tertiary">
          <Icon aria-hidden className="size-4.5" />
        </span>
      ) : null}
      <p className="max-w-[36ch] text-reading text-text-secondary text-pretty">{children}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
