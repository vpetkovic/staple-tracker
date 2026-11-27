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
import { useCallback, useEffect, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { personActor } from "@/detail/parts/person";
import { updateMilestoneDates } from "@/lib/api";
import { useBackToClose } from "@/lib/back-to-close";
import { describeRefusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import type { MilestoneState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { dueText, localIso, projectionNote, shownState, type ProjectedDue } from "./milestone-plain";

export interface DueMilestone {
  targetDate: string | null;
  state: MilestoneState;
  closedAt?: string | null;
}

/** The write, and what went wrong with the last one. `set(null)` clears the target. */
export function useSetMilestoneTarget(workspace: string | undefined, milestoneId: string) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed save belongs to the milestone it was for, and to that attempt: another milestone,
  // or opening the field again, starts clean.
  useEffect(() => setError(null), [workspace, milestoneId]);
  const clear = useCallback(() => setError(null), []);
  const set = useCallback(
    async (targetDate: string | null): Promise<boolean> => {
      // Never a write with no milestone named: the store would answer "No issue matches".
      if (!milestoneId) {
        setError("This milestone has not loaded yet. Try again in a moment.");
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        // Signed by the person, as every detail write is (`detail/parts/person.ts`).
        await updateMilestoneDates({ ws: workspace, ref: milestoneId, targetDate, actor: personActor() });
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
  return { set, busy, error, clear };
}

export function MilestoneDueControl({
  milestone,
  projection,
  now,
  editable = true,
  busy = false,
  error = null,
  onSetTarget,
  onOpen,
  className,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  button = true,
  anchor,
}: {
  milestone: DueMilestone;
  projection: ProjectedDue | null;
  now: Date;
  /** False on a finished milestone, where a new due date means nothing. */
  editable?: boolean;
  busy?: boolean;
  error?: string | null;
  onSetTarget?: (targetDate: string | null) => Promise<boolean> | void;
  /** The field opened: the caller clears the last attempt's error. */
  onOpen?: () => void;
  className?: string;
  /** Tests render the field open; the page opens it on a click. */
  defaultOpen?: boolean;
  /** Held open by the caller, who can open it from elsewhere (a menu's "Change due date"). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** False: no calendar button; the field opens from `open` and sits under the words. */
  button?: boolean;
  /** With no button: the element the field opens from instead of the words (a phone's stuck `⋯`, which stays in view). */
  anchor?: RefObject<HTMLElement | null>;
}) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  useBackToClose(open, () => setOpen(false));
  const projected = !milestone.targetDate && projection !== null && milestone.state !== "done" && milestone.state !== "cancelled";
  const [draft, setDraft] = useState(milestone.targetDate ?? (projection ? localIso(projection.at) : ""));
  // Opened by the caller (a menu's "Change due date"): start from the date it has now, as a click does.
  useEffect(() => {
    if (!openProp) return;
    setDraft(milestone.targetDate ?? (projection ? localIso(projection.at) : ""));
    onOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProp]);
  const text = dueText(milestone, projection, now);
  const save = async (value: string | null) => {
    const ok = await onSetTarget?.(value);
    if (ok !== false) setOpen(false);
  };

  const words = (
    <span
      data-milestone-target=""
      data-due-source={milestone.targetDate ? "target" : projected ? "estimate" : "none"}
      title={projected ? projectionNote(projection!) : undefined}
      className={cn(shownState(milestone, now) === "overdue" && "text-[var(--plain-risk-fg)]")}
    >
      {text}
    </span>
  );
  if (!editable || !onSetTarget) return <span className={cn("inline-flex items-center gap-1", className)}>{words}</span>;

  return (
    <span className={cn("inline-flex items-center gap-1", className)} data-milestone-due-control="">
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setDraft(milestone.targetDate ?? (projection ? localIso(projection.at) : ""));
            onOpen?.();
          }
          setOpen(next);
        }}
      >
        {button ? words : anchor ? (
          <>
            <PopoverAnchor virtualRef={anchor} />
            {words}
          </>
        ) : (
          <PopoverAnchor asChild>{words}</PopoverAnchor>
        )}
        {button ? (
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={milestone.targetDate ? "Change the due date" : "Set a due date"}
              title={milestone.targetDate ? "Change the due date" : "Set a due date"}
              data-milestone-due-button=""
              // Its look at every width; on a phone a 32px tap through an invisible inset.
              className="relative max-md:before:absolute max-md:before:-inset-1 max-md:before:content-['']"
              disabled={busy}
            >
              <CalendarDays aria-hidden />
            </Button>
          </PopoverTrigger>
        ) : null}
        <PopoverContent align={anchor && !button ? "end" : "start"} className="w-72" data-milestone-due-picker="">
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
                className="h-9 min-h-0 text-body"
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
                <Button type="button" variant="ghost" size="sm" className="min-h-0" disabled={busy} onClick={() => void save(null)} data-milestone-due-clear="">
                  {projection ? "Use the estimate" : "Clear date"}
                </Button>
              ) : null}
              <Button type="submit" size="sm" className="min-h-0" disabled={busy || !draft || draft === milestone.targetDate} data-milestone-due-save="">
                Save
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </span>
  );
}
