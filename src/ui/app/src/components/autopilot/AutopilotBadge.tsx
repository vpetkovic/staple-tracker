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
import { useAutopilotMark, type AutopilotMark } from "@/lib/runs";
import { openRunHistory } from "@/lib/shell-events";
import { cn } from "@/lib/utils";

/** The sentence the badge stands for: its tooltip and its accessible name. */
export function autopilotSentence(mark: AutopilotMark): string {
  const { entry } = mark;
  const scope = scopeText(entry.run);
  const over = scope === "Queue" ? "the queue" : scope;
  const paused = entry.run.state === "paused" ? " (paused)" : "";
  if (mark.kind === "scope") return `Autopilot: ${entry.run.actor}'s run is working through this${paused}`;
  if (mark.kind === "inside") return `Autopilot working ${mark.refs.join(", ")} inside: ${entry.run.actor}'s run over ${over}${paused}`;
  return `Autopilot: ${entry.run.actor}'s run over ${over} is working on this${paused}`;
}

/**
 * The badge. `folded` is the row's fold: a folded parent hiding a ticket a live run works
 * wears it too ("working ABC-3 inside"), so a subtree on autopilot shows without opening it;
 * the run's scope row wears it folded or not. See `useAutopilotMark` for the order.
 */
export function AutopilotBadge({
  workspace,
  issueId,
  folded = false,
  compact = false,
  decorative = false,
  className,
}: {
  workspace: string;
  issueId: string;
  /** The row is a folded parent. */
  folded?: boolean;
  /** The glyph alone (a phone row); the word stays in the accessible name. */
  compact?: boolean;
  /** Beside a sentence that already says it (the detail's notice): hidden from a screen reader. */
  decorative?: boolean;
  className?: string;
}) {
  const mark = useAutopilotMark(workspace, issueId, folded);
  if (!mark) return null;
  const sentence = autopilotSentence(mark);
  return (
    <span
      data-autopilot-badge={mark.entry.run.id}
      data-autopilot-kind={mark.kind}
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
 * The detail's line: the badge, what the run is doing here, and the way to its details.
 * Nothing when no live run holds the task or works through it.
 */
export function AutopilotNotice({ workspace, issueId, className }: { workspace: string; issueId: string; className?: string }) {
  const mark = useAutopilotMark(workspace, issueId);
  if (!mark) return null;
  const { run } = mark.entry;
  const scope = scopeText(run) === "Queue" ? "the queue" : scopeText(run);
  return (
    <p data-autopilot-notice={run.id} className={cn("m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body text-text-secondary", className)}>
      <AutopilotBadge workspace={workspace} issueId={issueId} decorative />
      <span className="min-w-0">
        {mark.kind === "scope" ? `${run.actor}'s run is working through this` : `${run.actor}'s run over ${scope} is working on this`}
        {run.state === "paused" ? ", paused" : ""}.
      </span>
      <button
        type="button"
        onClick={() => openRunHistory({ runId: run.id })}
        className="rounded-sm text-body font-medium text-foreground underline underline-offset-2 hover:no-underline focus-ring pointer-coarse:min-h-11"
      >
        See the run
      </button>
    </p>
  );
}
