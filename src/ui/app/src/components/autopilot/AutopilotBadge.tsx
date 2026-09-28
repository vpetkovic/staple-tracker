/**
 * "An autopilot run is working on this" — on a task row and in the task's detail.
 *
 * A row wears it while a LIVE run holds the row as its open ticket (`useRuns().claimed`, the
 * join lib/runs.ts does once per poll). The claim pill beside it already says WHO holds the
 * task; this says that the holder is a run, which is the difference between an agent a person
 * is talking to and one that will pick up the next ticket on its own when this one is done.
 *
 * Glyph and word, never colour alone: a robot glyph and "Autopilot" on a desk, the glyph on
 * a phone row (the word is in the accessible name and the tooltip), in the neutral chip tone
 * so it does not compete with the status glyph for attention.
 */
import { Bot } from "lucide-react";
import { scopeText } from "@/lib/run-text";
import { useRunClaim } from "@/lib/runs";
import { openRunHistory } from "@/lib/shell-events";
import type { RunEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The sentence the badge stands for: its tooltip and its accessible name. */
export function autopilotSentence(entry: Pick<RunEntry, "run">): string {
  const scope = scopeText(entry.run);
  const over = scope === "Queue" ? "the queue" : scope;
  const paused = entry.run.state === "paused" ? " (paused)" : "";
  return `Autopilot: ${entry.run.actor}'s run over ${over} is working on this${paused}`;
}

export function AutopilotBadge({
  workspace,
  issueId,
  compact = false,
  decorative = false,
  className,
}: {
  workspace: string;
  issueId: string;
  /** The glyph alone (a phone row); the word stays in the accessible name. */
  compact?: boolean;
  /** Beside a sentence that already says it (the detail's notice): hidden from a screen reader. */
  decorative?: boolean;
  className?: string;
}) {
  const entry = useRunClaim(workspace, issueId);
  if (!entry) return null;
  const sentence = autopilotSentence(entry);
  return (
    <span
      data-autopilot-badge={entry.run.id}
      title={sentence}
      aria-hidden={decorative || undefined}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border bg-surface-raised text-caption font-medium text-foreground",
        compact ? "w-5 justify-center" : "px-1.5",
        className,
      )}
    >
      <Bot aria-hidden className="size-3 shrink-0" />
      {compact ? null : <span aria-hidden>Autopilot</span>}
      {decorative ? null : <span className="sr-only">{sentence}</span>}
    </span>
  );
}

/**
 * The detail's line: the badge, what the run is, and the way to its details. Nothing when no
 * live run holds the task.
 */
export function AutopilotNotice({ workspace, issueId, className }: { workspace: string; issueId: string; className?: string }) {
  const entry = useRunClaim(workspace, issueId);
  if (!entry) return null;
  return (
    <p data-autopilot-notice={entry.run.id} className={cn("m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body text-text-secondary", className)}>
      <AutopilotBadge workspace={workspace} issueId={issueId} decorative />
      <span className="min-w-0">
        {entry.run.actor}'s run over {scopeText(entry.run) === "Queue" ? "the queue" : scopeText(entry.run)} is working on this
        {entry.run.state === "paused" ? ", paused" : ""}.
      </span>
      <button
        type="button"
        onClick={() => openRunHistory({ runId: entry.run.id })}
        className="rounded-sm text-body font-medium text-foreground underline underline-offset-2 hover:no-underline focus-ring pointer-coarse:min-h-11"
      >
        See the run
      </button>
    </p>
  );
}
