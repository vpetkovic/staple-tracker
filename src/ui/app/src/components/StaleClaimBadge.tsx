/**
 * "Nobody is coming back for this one" — C3 (STA-49).
 *
 * The whole ticket in one component: a held issue and an abandoned one are the same
 * pixels until something says otherwise. This is the something.
 *
 * IT RENDERS NOTHING UNDER THE THRESHOLD. Not a quieter version, not a grey dot —
 * nothing. Below thirty minutes of silence the card keeps its existing "held by X" line
 * and says no more, because a badge that appears on every in-progress ticket is furniture
 * within a day and stops being read. The badge earns its loudness by being rare.
 *
 * COLOUR. `data-stale-claim` maps to the blocked hue in app.css and the element wears
 * `.status-chip`, the shared chip recipe — so this introduces no colour, and it
 * tracks a light/dark theme change for free. The blocked tone is the honest one: a stale
 * claim is not an error, it is work that is stuck behind an agent that is not coming back.
 */
import type { ClaimActivity } from "@/lib/types";
import { staleClaimDetail, staleClaimSummary } from "@/lib/claim";
import { cn } from "@/lib/utils";

export function StaleClaimBadge({
  claim,
  variant = "compact",
  className,
}: {
  claim: ClaimActivity;
  /** `compact` for a card, `detail` for the panel header (adds the last-activity stamp). */
  variant?: "compact" | "detail";
  className?: string;
}) {
  const text = variant === "detail" ? staleClaimDetail(claim) : staleClaimSummary(claim);
  return (
    <span
      data-stale-claim=""
      data-held-by={claim.heldBy}
      // Spoken, not just coloured: the visual weight of the chip is the signal for
      // sighted users, and this sentence is the same signal for everyone else.
      title={staleClaimDetail(claim)}
      aria-label={`stale claim — ${staleClaimDetail(claim)}`}
      className={cn(
        // WRAPS RATHER THAN TRUNCATES, and that is the considered choice. A board column
        // is 15rem, and this string is a few characters wider than that — so an ellipsis
        // eats the tail, which is "silent 45m", which is the entire diagnosis. Losing it
        // leaves a red pill that says a ticket is held, which the card already said. Two
        // lines on a narrow column is a cheap price for keeping the evidence on screen.
        // `rounded-md` because a pill that wraps stops looking like a pill.
        "status-chip inline-block max-w-full rounded-md border px-1.5 py-px",
        "font-mono text-[10px] leading-4 font-medium wrap-anywhere",
        className,
      )}
    >
      {text}
    </span>
  );
}
