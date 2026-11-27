/**
 * THE TICKET CHIP: a ticket as one openable unit, its status glyph, identifier and title,
 * wherever a run (or anything else) names a ticket. And `RefText`, a sentence whose ticket
 * references become inline chips.
 *
 * Props in, no context: the caller says what opening means. A chip without `onOpen` is a
 * plain span; a deleted issue (`issue === null`) prints the reference it had, says
 * "deleted", and opens nothing.
 *
 * Variants: `row` fills its cell and truncates the title; `boxed` stands alone with a border;
 * `inline` is the glyph and identifier inside a sentence; `lead` is the large one in a run's
 * Now panel, its title wrapping to three lines.
 */
import { Fragment, type ReactNode } from "react";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { statusLabel } from "@/lib/settings";
import type { RunIssue } from "@/lib/types";
import { cn } from "@/lib/utils";

export type TicketChipVariant = "row" | "boxed" | "inline" | "lead";

/** The issue a run names, by id; null when the run does not carry it (deleted, or an older payload). */
export function issueOf(entry: { issues?: readonly RunIssue[] }, issueId: string): RunIssue | null {
  return (entry.issues ?? []).find((issue) => issue.issueId === issueId) ?? null;
}

const SHELL: Record<TicketChipVariant, string> = {
  row: "-ml-1 gap-[7px] px-1.5 py-0.5 pointer-coarse:min-h-11",
  boxed: "gap-[7px] border border-border bg-card px-2 py-[3px] pointer-coarse:min-h-11",
  inline: "-mx-px gap-[5px] px-1 align-baseline",
  lead: "-ml-1 items-start gap-2 px-1.5 py-0.5 pointer-coarse:min-h-11",
};

export function TicketChip({
  issue,
  fallbackRef,
  onOpen,
  variant = "row",
  className,
}: {
  issue: RunIssue | null;
  /** The identifier to print when the issue is gone. */
  fallbackRef: string;
  onOpen?: (ref: string) => void;
  variant?: TicketChipVariant;
  className?: string;
}) {
  const base = cn("inline-flex min-w-0 max-w-full items-center rounded-[6px] text-left", SHELL[variant], className);
  if (issue === null) {
    return (
      <span data-ticket-chip={fallbackRef} data-deleted="" data-variant={variant} className={cn(base, "text-text-tertiary")}>
        <span className="shrink-0 font-mono text-label">{fallbackRef}</span>
        <span className="text-label">deleted</span>
      </span>
    );
  }
  const lead = variant === "lead";
  const inline = variant === "inline";
  const body = (
    <>
      <StatusIcon status={issue.status} category={issue.category ?? undefined} className={cn("size-3.5 shrink-0", lead && "mt-1")} />
      <span
        className={cn(
          "shrink-0 font-mono",
          inline ? "text-label font-medium text-foreground" : "text-label text-text-secondary",
          lead && "text-body leading-[22px]",
        )}
      >
        {issue.identifier}
      </span>
      {inline ? null : (
        <span
          className={cn(
            "min-w-0 text-foreground",
            lead ? "line-clamp-3 text-title leading-[22px] font-semibold text-pretty" : "truncate text-body",
          )}
        >
          {issue.title}
        </span>
      )}
    </>
  );
  const shared = {
    "data-ticket-chip": issue.identifier,
    "data-variant": variant,
    title: issue.title,
  };
  if (!onOpen) {
    return (
      <span {...shared} className={base}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      {...shared}
      aria-label={`${issue.identifier}: ${issue.title}, ${statusLabel(issue.status)}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(issue.identifier);
      }}
      className={cn(base, "focus-ring cursor-pointer hover:bg-surface-hover")}
    >
      {body}
    </button>
  );
}

/**
 * A whole ticket identifier: "STA-12", "AB2-3"; never part of a longer word, nor the tail of an
 * idea number ("I-STA-12" names an idea, not the ticket STA-12).
 */
const REF = /(?<![\w-])[A-Z][A-Z0-9]*-\d+\b/g;

/** A sentence with every identifier of one of `issues` drawn as an inline chip; anything else stays text. */
export function RefText({ text, issues, onOpen }: { text: string; issues: readonly RunIssue[]; onOpen?: (ref: string) => void }) {
  const byRef = new Map(issues.map((issue) => [issue.identifier, issue]));
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(REF)) {
    const issue = byRef.get(match[0]);
    if (!issue) continue;
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(<TicketChip key={at} issue={issue} fallbackRef={match[0]} onOpen={onOpen} variant="inline" />);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((part, i) => (typeof part === "string" ? <Fragment key={`t${i}`}>{part}</Fragment> : part))}</>;
}
