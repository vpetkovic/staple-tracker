/**
 * The panel that shows why a drop was refused — owned by U6 (views/board/).
 *
 * It renders one thing above all: `refusal.message`, exactly as the store wrote it.
 * Everything else on this panel is chrome around that sentence. There is no copy table
 * here, and adding one would be the bug — staple's guards live in the store, so any
 * sentence the board composes itself is a sentence about a rule that may not exist.
 */
import { AlertTriangle, X } from "lucide-react";
import type { Refusal } from "./refusal";

export function GuardRefusal({ refusal, onDismiss }: { refusal: Refusal; onDismiss: () => void }) {
  return (
    <div role="alert" data-guard-refusal className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <AlertTriangle
          aria-hidden
          className="mt-px size-4 shrink-0 text-[var(--status-task-blocked)]"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">
            refused by the store
          </div>
          {/* The store's own sentence. Verbatim, wrap-anywhere so a long blocker list
              does not widen the popover. */}
          <p data-guard-message className="mt-1 text-[13px] leading-snug wrap-anywhere">
            {refusal.message}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mt-1 -mr-1 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {refusal.blockers.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 pl-6">
          {refusal.blockers.map((blocker) => (
            <span
              key={blocker}
              data-status="blocked"
              className="rounded-sm border px-1.5 py-0.5 font-mono text-[11px] text-[var(--sc)]"
            >
              {blocker}
            </span>
          ))}
        </div>
      ) : null}

      <div className="pl-6 text-[11px] text-muted-foreground">
        <span className="font-mono">{refusal.code}</span>
        {refusal.retryable ? " · retryable" : " · not retryable — change something first"}
      </div>
    </div>
  );
}
