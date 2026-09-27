/**
 * Who is on this task — the desktop row's single "who" cue.
 *
 * The desktop row used to draw a claim pill (holder avatar, dot, "Working…") and then the
 * assignee avatar beside it, which for the common case of an agent assigned to its own work
 * put the same initials on the row twice, and "Working…" read as text cut short.
 *
 * Here each person is drawn once. The holder of the claim gets one avatar and one plain word
 * ("Working", "Quiet 46m", "Picked up"); the assignee gets an avatar only when it is somebody
 * else. The full sentence (who, for how long, when last active) is the accessible name and
 * the tooltip, so nothing the old pill said is lost.
 *
 * Compact (phone) rows and the palette keep `RowClaimSlot`: this is the `desk` row only.
 */
import { formatAgo, isStaleClaim, staleClaimDetail, staleClaimSummary } from "@/lib/claim";
import type { ClaimActivity } from "@/lib/types";
import { initials } from "./avatar";

export type WhoState = "working" | "quiet" | "held" | "assigned";

export interface WhoFacts {
  state: WhoState;
  /** Who holds the claim. Null when nobody does and the cue is only the assignee. */
  holder: string | null;
  /** The assignee, only when it is a different person from the holder. */
  assignee: string | null;
  /** The one plain word (or two) drawn beside the avatar. Empty for an assignee alone. */
  word: string;
  /** The whole sentence, for the tooltip and the accessible name. */
  sentence: string;
}

/**
 * What the cue says. Pure, so the "drawn once" rule is testable without a DOM.
 *
 * Null when nobody is on the task and nobody is assigned: the slot stays, empty, so the
 * dates below and above it still form a column.
 */
export function whoFacts(input: {
  claim: ClaimActivity | null;
  checkoutAgent: string | null;
  assignee: string | null;
}): WhoFacts | null {
  const { claim, checkoutAgent } = input;
  const holder = claim?.heldBy ?? checkoutAgent ?? null;
  // The same person is drawn once: an assignee who IS the holder adds nothing.
  const assignee = input.assignee && input.assignee !== holder ? input.assignee : null;
  const assignedClause = assignee ? `; assigned to @${assignee}` : "";

  if (claim && isStaleClaim(claim)) {
    return {
      state: "quiet",
      holder,
      assignee,
      word: `Quiet ${formatAgo(claim.idleSeconds)}`,
      sentence: `${claim.heldBy} has gone quiet — ${staleClaimDetail(claim)}${assignedClause}`,
    };
  }
  if (claim) {
    return {
      state: "working",
      holder,
      assignee,
      word: "Working",
      sentence: `${claim.heldBy} is working on this — ${staleClaimSummary(claim)}${assignedClause}`,
    };
  }
  if (holder) {
    return {
      state: "held",
      holder,
      assignee,
      word: "Picked up",
      sentence: `Picked up by ${holder}; no recent activity reading${assignedClause}`,
    };
  }
  if (input.assignee) {
    return {
      state: "assigned",
      holder: null,
      assignee: input.assignee,
      word: "",
      sentence: `Assigned to @${input.assignee}`,
    };
  }
  return null;
}

export function WhoCue({
  claim,
  checkoutAgent,
  assignee,
  showWord = true,
}: {
  claim: ClaimActivity | null;
  checkoutAgent: string | null;
  assignee: string | null;
  /** The word beside the avatar. Off below 880px, where the ladder drops the working label. */
  showWord?: boolean;
}) {
  const facts = whoFacts({ claim, checkoutAgent, assignee });
  return (
    <span className="staple-row-who" data-testid="who-slot" data-word={showWord ? undefined : "off"}>
      {facts ? (
        <span
          className="staple-who"
          data-testid="who-cue"
          data-state={facts.state}
          role="img"
          aria-label={facts.sentence}
          title={facts.sentence}
        >
          {facts.assignee ? (
            <span
              className="staple-avatar staple-who-assignee"
              data-kind="human"
              aria-hidden="true"
              style={{ width: 20, height: 20 }}
            >
              {initials(facts.assignee)}
            </span>
          ) : null}
          {facts.holder ? (
            <span className="staple-who-holder" aria-hidden="true">
              <span className="staple-avatar" data-kind="agent" style={{ width: 20, height: 20 }}>
                {initials(facts.holder)}
              </span>
              {facts.state === "working" ? <span className="staple-who-dot staple-working-dot" /> : null}
            </span>
          ) : null}
          {showWord && facts.word ? (
            <span className="staple-who-word" aria-hidden="true">
              {facts.word}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
