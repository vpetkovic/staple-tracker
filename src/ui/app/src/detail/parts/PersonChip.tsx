/**
 * A person or an agent: a small initial disc plus the name, in the normal font.
 *
 * The shape follows the task list's avatar convention, so the two surfaces agree on sight:
 * a circle is a person, a rounded square is an agent. Shape rather than colour, so it
 * survives greyscale and needs nothing from the palette. The initials come from the same
 * helper the list rows use.
 */
import type { ReactNode } from "react";
import { initials } from "@/components/task-list/avatar";
import { cn } from "@/lib/utils";

export type PersonKind = "agent" | "human";

export function PersonDisc({ name, kind = "human", size = "sm", className }: { name: string; kind?: PersonKind; size?: "sm" | "md"; className?: string }) {
  return (
    <span
      aria-hidden
      data-person-disc={kind}
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-border bg-surface-sunken font-semibold text-text-secondary select-none",
        size === "sm" ? "size-5 text-[9px]" : "size-6 text-[10px]",
        kind === "agent" ? "rounded-[5px]" : "rounded-full",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

export function PersonChip({
  name,
  kind = "human",
  size = "sm",
  suffix,
  className,
}: {
  name: string;
  kind?: PersonKind;
  size?: "sm" | "md";
  /** Quiet trailing words, e.g. "· working now". */
  suffix?: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-person={name}
      data-person-kind={kind}
      title={kind === "agent" ? `${name} (agent)` : name}
      className={cn("inline-flex min-w-0 items-center gap-1.5 align-middle", className)}
    >
      <PersonDisc name={name} kind={kind} size={size} />
      <span className="min-w-0 truncate text-foreground">{name}</span>
      {suffix ? <span className="shrink-0 text-text-secondary">{suffix}</span> : null}
    </span>
  );
}
