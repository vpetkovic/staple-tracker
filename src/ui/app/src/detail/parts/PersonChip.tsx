/**
 * A person or an agent: a small initial disc plus the name, in the normal font.
 *
 * The shape follows the task list's avatar convention, so the two surfaces agree on sight:
 * a circle is a person, a rounded square is an agent. Shape rather than colour, so it
 * survives greyscale and needs nothing from the palette. The initials come from the same
 * helper the list rows use.
 */
import { MonitorSmartphone } from "lucide-react";
import type { ReactNode } from "react";
import { initials } from "@/components/task-list/avatar";
import { cn } from "./cn";

export type PersonKind = "agent" | "human";

/**
 * The name the web app writes under when nobody told it who is at the keyboard. It is not a
 * person, so it is never shown as one.
 */
export function isWebAppActor(name: string | null | undefined): boolean {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || trimmed.toLowerCase() === "ui";
}

/** A name as a person reads it: the web app's default actor becomes "Someone in the web app". */
export function actorLabel(name: string | null | undefined): string {
  return isWebAppActor(name) ? "Someone in the web app" : name!.trim();
}

/**
 * The initials are drawn by CSS from `data-initials` (a `::before`), not written as text: a
 * copied line then reads "claude", not "CLclaude", and a screen reader hears the name once.
 */
export function PersonDisc({ name, kind = "human", size = "sm", className }: { name: string; kind?: PersonKind; size?: "sm" | "md"; className?: string }) {
  return (
    <span
      aria-hidden
      data-person-disc={kind}
      data-initials={initials(name)}
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-border bg-surface-sunken font-semibold text-text-secondary select-none before:content-[attr(data-initials)]",
        size === "sm" ? "size-5 text-[9px]" : "size-6 text-[10px]",
        kind === "agent" ? "rounded-[5px]" : "rounded-full",
        className,
      )}
    />
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
  const webApp = isWebAppActor(name);
  const label = actorLabel(name);
  // A short name that IS its initials ("VP") would say itself twice; show it once.
  const discIsName = !webApp && initials(label) === label.toUpperCase();
  return (
    <span
      data-person={name}
      data-person-kind={webApp ? "web-app" : kind}
      title={webApp ? label : kind === "agent" ? `${label} (agent)` : label}
      className={cn("inline-flex min-w-0 items-center gap-1.5 align-middle", className)}
    >
      {webApp ? (
        <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-surface-sunken text-text-secondary", size === "sm" ? "size-5" : "size-6")}>
          <MonitorSmartphone className="size-3" />
        </span>
      ) : discIsName ? null : (
        <PersonDisc name={label} kind={kind} size={size} />
      )}
      <span className="min-w-0 truncate text-foreground">{label}</span>
      {suffix ? <span className="shrink-0 text-text-secondary">{suffix}</span> : null}
    </span>
  );
}
