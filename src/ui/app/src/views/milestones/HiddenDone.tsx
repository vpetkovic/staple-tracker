/**
 * "3 finished items hidden · Show done": what a milestone's member list says when the Done
 * toggle hides some of its rows, and, when it hides all of them, what it says instead of
 * "nothing is in this milestone" — the state a goal run leaves for a person's approval, every
 * member finished. One component for the Milestones page and the milestone's task detail.
 */
import { Button } from "@/components/ui/button";

export function hiddenDoneText(count: number): string {
  return count === 1 ? "1 finished item hidden" : `${count} finished items hidden`;
}

export function HiddenDoneNotice({ count, all, onShowDone }: { count: number; all: boolean; onShowDone?: () => void }) {
  if (count === 0) return null;
  return (
    <div
      data-hidden-done={count}
      data-hidden-all={all ? "" : undefined}
      className={all ? "flex flex-col items-start gap-2 rounded-lg border border-dashed px-4 py-3" : "mt-1 flex items-center gap-2 px-2"}
    >
      <p className="m-0 text-label text-text-secondary">
        {hiddenDoneText(count)}
        {all ? ". Everything in this milestone is finished; Done is hidden." : ""}
      </p>
      {onShowDone ? (
        <Button variant={all ? "outline" : "ghost"} size="sm" onClick={onShowDone} data-show-done="" className="max-md:min-h-11">
          Show done
        </Button>
      ) : null}
    </div>
  );
}
