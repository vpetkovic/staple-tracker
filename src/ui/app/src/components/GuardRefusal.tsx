/**
 * The panel that shows why a write was refused.
 *
 * SALVAGED BY V2 (STA-87) from `views/board/GuardRefusal.tsx`. The board is gone; this
 * is not, because it was never about dragging — it is about the one thing every writing
 * surface in staple owes the user, which is the store's own sentence.
 *
 * It renders one thing above all: `refusal.message`, exactly as the store wrote it.
 * Everything else here is chrome around that sentence. There is no copy table here, and
 * adding one would be the bug — staple's guards live in the store, so any sentence the
 * UI composes itself is a sentence about a rule that may not exist.
 *
 * WHY IT IS SHARED NOW. The command palette used to hand-roll its own refusal strip: a
 * code and a message, and nothing else. It silently dropped `detail.blockers` and the
 * store's own `retryable` verdict — so the palette told you a start was refused and made
 * you go find out elsewhere WHICH blockers, while the board two tabs over showed them as
 * chips. One renderer, one answer. V3's drawer and V5's rows get it for free.
 *
 * `onDismiss` is optional: a strip that is replaced by the next attempt does not need an
 * X, and a dismiss control that leaves nothing behind is worse than none.
 */
import { AlertTriangle, X } from "lucide-react";
import type { Refusal } from "@/lib/refusal";
import { cn } from "@/lib/utils";

export function GuardRefusal({
  refusal,
  onDismiss,
  className,
}: {
  refusal: Refusal;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" data-guard-refusal className={cn("flex flex-col gap-2", className)}>
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
              does not widen whatever this is sitting in. */}
          <p data-guard-message className="mt-1 text-[13px] leading-snug wrap-anywhere">
            {refusal.message}
          </p>
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="-mt-1 -mr-1 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
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
