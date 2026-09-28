/**
 * The small pieces every autopilot surface shares: the state pill, the Stop control and the
 * Pause / Resume control.
 *
 * THE PAGE WATCHES AND STOPS; IT NEVER STARTS. A run is started by talking to an agent, and
 * only its actor's `run continue` takes tickets (docs/runs.md). So the only verbs here are a
 * person's: stop (`stopped_by_human`, recorded with who pressed it and why), pause and resume.
 *
 * Stop always asks first. It ends the run for good (a stopped run cannot be resumed; a new
 * one has to be started by an agent), and a driver working a ticket ends that session within
 * one poll, so it is not a thing a stray tap should do. The confirm offers an optional note,
 * which the run keeps as `stop.note` beside the name of the person (`staple:me`, else "ui").
 *
 * A refusal is rendered, never swallowed: from a phone on the tailnet the server's Origin
 * check refuses every write, and `GuardRefusal` says so in words instead of failing silently.
 */
import { Pause, Play, Square } from "lucide-react";
import { useState } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { Button } from "@/components/ui/button";
import { personActor } from "@/detail/parts/person";
import { pauseRun, resumeRun, stopRun } from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { scopeText, type RunTone } from "@/lib/run-text";
import { stopKey } from "@/lib/run-stops";
import { useRuns } from "@/lib/runs";
import { markStopsSeen } from "@/lib/stop-seen-store";
import type { RunEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/settings/form/ConfirmDialog";

/** A state in a word and a tone: the reserved `--plain-*` pairs, each AA in both themes. */
/** `wrap` lets a long state (a stop reason in a notice) wrap instead of being cut short. */
export function RunStatePill({ text, tone, wrap = false, className }: { text: string; tone: RunTone; wrap?: boolean; className?: string }) {
  return (
    <span
      data-run-state={tone}
      title={text}
      className={cn("inline-flex max-w-full min-w-0 shrink-0 items-center rounded-full border px-2 py-0.5 text-caption font-medium", className)}
      style={{ color: `var(--plain-${tone}-fg)`, backgroundColor: `var(--plain-${tone}-bg)`, borderColor: `var(--plain-${tone}-border)` }}
    >
      <span className={wrap ? "wrap-anywhere" : "truncate"}>{text}</span>
    </span>
  );
}

/** The copy of the Stop confirm, fixed so every Stop button asks the same thing. */
export function stopConfirmCopy(entry: Pick<RunEntry, "run">): { title: string; description: string } {
  const scope = scopeText(entry.run);
  return {
    title: `Stop the autopilot run over ${scope === "Queue" ? "the queue" : scope}?`,
    description:
      `${entry.run.actor} takes no more tickets on this run. A ticket being worked now is ended and goes back to the queue. ` +
      "A stopped run cannot be resumed; an agent has to start a new one.",
  };
}

/**
 * Stop, confirmed. `touch` makes it a 44px target (the phone strip); the rail and the history
 * use the desk size, which a coarse pointer grows to 44px anyway.
 */
export function StopRunButton({ entry, touch = false, className }: { entry: RunEntry; touch?: boolean; className?: string }) {
  const { refresh } = useRuns();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const copy = stopConfirmCopy(entry);
  const noteId = `run-stop-note-${entry.run.id}`;

  const stop = async () => {
    setBusy(true);
    try {
      await stopRun({ ws: entry.workspace, id: entry.run.id, actor: personActor(), note: note.trim() || undefined });
      setConfirming(false);
      setNote("");
      setRefusal(null);
      // This page did it: no notice for a person's own press.
      markStopsSeen([stopKey(entry)]);
      refresh();
    } catch (error) {
      setConfirming(false);
      setRefusal(describeRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-run-stop={entry.run.id}
        aria-label={`Stop the autopilot run over ${scopeText(entry.run)}`}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          setRefusal(null);
          setConfirming(true);
        }}
        className={cn(
          "text-[var(--plain-risk-fg)] hover:text-[var(--plain-risk-fg)] pointer-coarse:h-11",
          touch && "h-11 min-w-11 px-3",
          className,
        )}
      >
        <Square aria-hidden className="size-3" fill="currentColor" />
        Stop
      </Button>
      {refusal ? <GuardRefusal refusal={refusal} onDismiss={() => setRefusal(null)} className="mt-2 basis-full" /> : null}
      <ConfirmDialog
        open={confirming}
        title={copy.title}
        description={copy.description}
        confirmLabel="Stop run"
        cancelLabel="Keep it running"
        destructive
        busy={busy}
        onConfirm={() => void stop()}
        onCancel={() => setConfirming(false)}
      >
        <label htmlFor={noteId} className="mt-3 block text-label font-medium text-text-secondary">
          Why? <span className="font-normal text-text-tertiary">(optional, kept with the run)</span>
        </label>
        <textarea
          id={noteId}
          data-run-stop-note
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          className="mt-1 w-full rounded-md border border-input bg-field px-3 py-2 text-body outline-none placeholder:text-text-tertiary focus-visible:border-ring max-md:text-[16px]"
          placeholder="For example: it is working on the wrong thing"
        />
      </ConfirmDialog>
    </>
  );
}

/** Pause a working run or resume a paused one. No confirm: both are undone by the other. */
export function PauseResumeButton({ entry, className }: { entry: RunEntry; className?: string }) {
  const { refresh } = useRuns();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const paused = entry.run.state === "paused";
  const act = async () => {
    setBusy(true);
    try {
      await (paused ? resumeRun : pauseRun)({ ws: entry.workspace, id: entry.run.id, actor: personActor() });
      setRefusal(null);
      // This page did it: no notice for a person's own press.
      markStopsSeen([stopKey(entry)]);
      refresh();
    } catch (error) {
      setRefusal(describeRefusal(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-run-pause={paused ? "resume" : "pause"}
        disabled={busy}
        onClick={() => void act()}
        className={cn("pointer-coarse:h-11", className)}
      >
        {paused ? <Play aria-hidden className="size-3" /> : <Pause aria-hidden className="size-3" />}
        {paused ? "Resume" : "Pause"}
      </Button>
      {refusal ? <GuardRefusal refusal={refusal} onDismiss={() => setRefusal(null)} className="mt-2 basis-full" /> : null}
    </>
  );
}
