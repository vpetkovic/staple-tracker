/**
 * The member behind a change or a ticket: two initials on a stable colour.
 *
 * On an activity row it sits next to the agent that acted, because the agent string is
 * free text and the member is not: it comes from the device the server stamped on the
 * change, so it cannot be typed in. A removed member's chip still renders, muted, so the
 * history keeps a name.
 */
import { memberHue, memberInitials } from "@/lib/members";
import { cn } from "./cn";

export function MemberChip({
  member,
  you = false,
  withName = false,
  className,
}: {
  member: { memberId: string; name: string; removed?: boolean };
  /** This machine's member: the tooltip says so. */
  you?: boolean;
  /** Draw the name beside the disc (the picker); an activity row shows the disc alone. */
  withName?: boolean;
  className?: string;
}) {
  const removed = member.removed === true;
  const hue = memberHue(member.memberId);
  const title = `${member.name}${you ? " (you)" : ""}${removed ? " (removed)" : ""}`;
  return (
    <span
      data-member-chip={member.memberId}
      data-member-removed={removed ? "" : undefined}
      title={title}
      role={withName ? undefined : "img"}
      aria-label={withName ? undefined : `member ${title}`}
      className={cn("inline-flex min-w-0 items-center gap-1.5 align-middle", removed && "opacity-55", className)}
    >
      <span
        aria-hidden
        data-member-hue={hue}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold select-none",
          removed && "border border-dashed border-border bg-surface-sunken text-text-secondary",
        )}
        style={removed ? undefined : { background: `var(--chart-${hue})`, color: "var(--background)" }}
      >
        {memberInitials(member.name)}
      </span>
      {withName ? (
        <span className={cn("min-w-0 truncate", removed ? "text-text-secondary line-through" : "text-foreground")}>
          {member.name}
          {you ? <span className="text-text-secondary"> (you)</span> : null}
        </span>
      ) : null}
    </span>
  );
}
