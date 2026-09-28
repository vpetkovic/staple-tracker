/**
 * THE MILESTONE'S DUE DATE, as one control wherever a milestone shows one: the Milestones page
 * header and the milestone's own task detail.
 *
 * It says the date in words (`dueText`): the target the person set, else the projection from
 * the work still estimated in it, marked "(estimated)", else "No due date". Beside it a
 * calendar button opens a date field that sets the milestone's own target — the store's
 * `/api/milestone/update`, the same write as `staple milestone set --target` and MCP
 * `update_milestone`. A set target overrides the projection; clearing it falls back to the
 * projection again. The projection itself is never stored.
 */
import { CalendarDays } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { updateMilestoneDates } from "@/lib/api";
import { useBackToClose } from "@/lib/back-to-close";
import { describeRefusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import type { MilestoneState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { dueText, localIso, projectionNote, type ProjectedDue } from "./milestone-plain";

export interface DueMilestone {
  targetDate: string | null;
  state: MilestoneState;
}

/** The write, and what went wrong with the last one. `set(null)` clears the target. */
export function useSetMilestoneTarget(workspace: string | undefined, milestoneId: string) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = useCallback(
    async (targetDate: string | null): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await updateMilestoneDates({ ws: workspace, ref: milestoneId, targetDate });
        session.refresh();
        return true;
      } catch (caught) {
        setError(describeRefusal(caught).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [workspace, milestoneId, session],
  );
  return { set, busy, error };
}

export function MilestoneDueControl({
  milestone,
  projection,
  now,
  completedAt = null,
  editable = true,
  busy = false,
  error = null,
  onSetTarget,
  className,
  defaultOpen = false,
}: {
  milestone: DueMilestone;
  projection: ProjectedDue | null;
  now: Date;
  completedAt?: string | null;
  /** False on a finished milestone, where a new due date means nothing. */
  editable?: boolean;
  busy?: boolean;
  error?: string | null;
  onSetTarget?: (targetDate: string | null) => Promise<boolean> | void;
  className?: string;
  /** Tests render the field open; the page opens it on a click. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useBackToClose(open, () => setOpen(false));
  const projected = !milestone.targetDate && projection !== null && milestone.state !== "done" && milestone.state !== "cancelled";
  const [draft, setDraft] = useState(milestone.targetDate ?? (projection ? localIso(projection.at) : ""));
  const text = dueText(milestone, projection, now, completedAt);
  const save = async (value: string | null) => {
    const ok = await onSetTarget?.(value);
    if (ok !== false) setOpen(false);
  };

  const words = (
    <span
      data-milestone-target=""
      data-due-source={milestone.targetDate ? "target" : projected ? "estimate" : "none"}
      title={projected ? projectionNote(projection!) : undefined}
      className={cn(milestone.state === "overdue" && "text-[var(--plain-risk-fg)]")}
    >
      {text}
    </span>
  );
  if (!editable || !onSetTarget) return <span className={cn("inline-flex items-center gap-1", className)}>{words}</span>;

  return (
    <span className={cn("inline-flex items-center gap-1", className)} data-milestone-due-control="">
      {words}
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setDraft(milestone.targetDate ?? (projection ? localIso(projection.at) : ""));
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={milestone.targetDate ? "Change the due date" : "Set a due date"}
            title={milestone.targetDate ? "Change the due date" : "Set a due date"}
            data-milestone-due-button=""
            disabled={busy}
          >
            <CalendarDays aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72" data-milestone-due-picker="">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft) void save(draft);
            }}
          >
            <label className="flex flex-col gap-1.5 text-label font-medium">
              Due date
              <Input
                type="date"
                value={draft}
                aria-label="Due date"
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
                className="h-9 text-body"
              />
            </label>
            <p className="m-0 text-label text-text-secondary">
              {milestone.targetDate
                ? "Your date overrides the estimate. Clear it to go back to the estimate."
                : projection
                  ? "Pre-filled from the estimated work left. Save to make it the milestone's own date."
                  : "No estimates to go on yet. Pick the day it should be finished by."}
            </p>
            {error ? (
              <p role="alert" className="m-0 text-label text-[var(--plain-risk-fg)]" data-milestone-due-error="">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              {milestone.targetDate ? (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)} data-milestone-due-clear="">
                  {projection ? "Use the estimate" : "Clear date"}
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={busy || !draft || draft === milestone.targetDate} data-milestone-due-save="">
                Save
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </span>
  );
}
