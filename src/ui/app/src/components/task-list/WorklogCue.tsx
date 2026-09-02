/**
 * "Can somebody else pick this up?" — W4 (STA-116), STA-108 spec §3 option C and §4.
 *
 * The board-scan element. VP reads 114 rows asking which one is worth opening and which
 * claim is a handoff risk; every other element on the row answers a different question.
 * This one answers that one, in one glyph and two numbers, and it is the only argument
 * that buys it width on a row where thirteen elements already compete for it.
 *
 * ── IT IS NOT A SECOND LIVENESS BADGE, AND THAT IS THE WHOLE DESIGN ───────────────────
 *
 * `RowClaimSlot` owns the four claim states and is the single place the liveness rule is
 * written down. This sits BESIDE it and adds an orthogonal fact:
 *
 *     claim.lastActivityAt  — when the holder last did ANYTHING (a status change, a
 *                             one-word comment). "Is anyone there."
 *     worklog.updatedAt     — when the holder last left a HANDOFF. "Could anyone else
 *                             take over."
 *
 * Those come apart in exactly the case the epic exists for: an agent who is busy and has
 * stopped checkpointing looks live on the first and behind on the second. So nothing in
 * this file says "silent", "idle" or "working" — two badges that both meant quiet would
 * be the noise the epic is trying to remove, and the row would be saying one thing twice
 * instead of two things once.
 *
 * The judgement itself is NOT made here. `worklogStaleness()` in lib/worklog.ts owns it,
 * argues its own one-hour margin, and deliberately does not import `STALE_CLAIM_SECONDS`.
 * This component imports the answer, never the arithmetic.
 *
 * ── FOUR STATES, AND WHY THE FOURTH IS NOTHING ────────────────────────────────────────
 *
 *   fresh   summary present, not behind the work   solid page,  `r3 · 41m`, tertiary
 *   stale   summary present, behind the work       torn page,   `r3 · 4h`,  foreground
 *   empty   HELD and no summary at all             dashed page, `—`,        foreground
 *   —       unheld and no summary                  nothing in the DOM
 *
 * The empty variant is the loudest cell in §4's table: hours of work with nothing written
 * down, and today it is invisible. It is drawn only where somebody is holding the ticket,
 * because on an unheld row a missing worklog is not a finding — it is what most of a
 * backlog looks like, and a column of dashes down 114 rows is noise, not signal.
 *
 * An `unknown` freshness (nobody holding it, so no activity to compare against) renders
 * as FRESH, not as a third alarm. A finished, well-documented ticket must not be flagged
 * as a handoff risk six hours later merely because six hours passed; nothing has happened
 * that its worklog fails to explain. That is the same argument that made the judgement
 * relative rather than absolute in the first place.
 *
 * ── NO HUE, NO SECOND ELEMENT ─────────────────────────────────────────────────────────
 *
 * The row spends its only colour on the working dot, deliberately — "the one fact on the
 * row worth spending colour on". So the three states separate by SHAPE first (three
 * different silhouettes, which is what survives greyscale) and by text WEIGHT second. The
 * markup carries no token at all: every stroke is `currentColor` and task-list.css picks
 * the neutral text token per `data-state`. §4's instruction was that if the cue needed a
 * second element or a colour to be legible, that would be evidence it does not belong on
 * the row. It needed neither.
 *
 * ── NOTHING TICKS ─────────────────────────────────────────────────────────────────────
 *
 * `updatedAt` is a server reading refreshed by the existing 1.5s fingerprint poll, and
 * the age is rendered through `formatRowDate` — the same vocabulary as the date column
 * eighty pixels to the right, so the row does not look like two systems talking.
 */
import { worklogStaleness } from "@/lib/worklog";
import type { ClaimActivity, WorklogSummary } from "@/lib/types";
import { formatRowDate } from "./row-date";

/** Which of the three drawable states this row is in. `null` means draw nothing. */
export type WorklogCueState = "fresh" | "stale" | "empty";

/**
 * The state machine, separated from the drawing so it can be read in one screen.
 *
 * Held is `claim || checkoutAgent` — the same two fields `RowClaimSlot` consults, and for
 * the same reason: `checkoutAgent` alone says a claim exists on an endpoint that carried
 * no liveness reading. Somebody has it. Whether they are awake is not this element's
 * question.
 */
export function worklogCueState(input: {
  worklog?: WorklogSummary | null;
  claim: ClaimActivity | null;
  checkoutAgent: string | null;
}): WorklogCueState | null {
  if (!input.worklog) return input.claim || input.checkoutAgent ? "empty" : null;
  return worklogStaleness({
    worklogUpdatedAt: input.worklog.updatedAt,
    claimLastActivityAt: input.claim?.lastActivityAt,
  }) === "stale"
    ? "stale"
    : "fresh";
}

/**
 * A page, at three levels of completeness. Same 12×12 silhouette, three different
 * interiors:
 *
 *   fresh  three ruled lines filling the page — a written page
 *   stale  one solid rule, one dashed, and an empty bottom third — the writing trails
 *          off; the record stops short of the work
 *   empty  a dashed outline and nothing at all inside — a page nobody has written
 *
 * THE CHANNEL IS FILL DENSITY, not stroke style, and that is the whole reason the glyph
 * works at 12px. Whether a small box is full, half full, or empty is legible at a glance
 * and at a distance; whether its third rule is dashed is not. Dashes here are a second-
 * order cue for anyone who does look closely, never the thing carrying the state — which
 * is the same discipline `PrioritySignal` uses for its ascending bars.
 *
 * `currentColor` throughout. The stroke width is the PrBadge glyph's, so the two elements
 * sitting next to each other in `.staple-row-meta` read as one family.
 */
function PageGlyph({ state }: { state: WorklogCueState }) {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect
        x="2.1"
        y="1.1"
        width="7.8"
        height="9.8"
        rx="1.4"
        {...stroke}
        // A page that was never started is drawn as one that was never finished.
        strokeDasharray={state === "empty" ? "1.8 1.5" : undefined}
      />
      {state === "empty" ? null : (
        <>
          <path d="M4.1 4 H7.9" {...stroke} />
          {state === "stale" ? (
            // Half a rule, then nothing: two thirds of the page left blank.
            <path d="M4.1 6 H7.9" {...stroke} strokeDasharray="1.2 1.3" />
          ) : (
            <>
              <path d="M4.1 6 H7.9" {...stroke} />
              <path d="M4.1 8 H6.6" {...stroke} />
            </>
          )}
        </>
      )}
    </svg>
  );
}

/** Under a day `formatRowDate` yields a duration; past it, a calendar date. */
const DAY_SECONDS = 24 * 60 * 60;

/**
 * The age, as a phrase a screen reader can finish. `formatRowDate` returns two different
 * kinds of string — `41m` and `Jun 9` — and "last written Jun 9 ago" is not a sentence,
 * so the preposition is chosen from the same boundary that helper switches on.
 */
function agePhrase(iso: string, now: Date): string {
  const shown = formatRowDate(iso, now);
  if (shown === "") return "at an unknown time";
  const age = (now.getTime() - new Date(iso).getTime()) / 1000;
  return age < DAY_SECONDS ? `${shown} ago` : `on ${shown}`;
}

export function WorklogCue({
  worklog,
  claim,
  checkoutAgent,
  now,
}: {
  worklog?: WorklogSummary | null;
  claim: ClaimActivity | null;
  checkoutAgent: string | null;
  now: Date;
}) {
  const state = worklogCueState({ worklog, claim, checkoutAgent });
  if (!state) return null;

  // The one place the three states become words. `aria-label` and `title` are the SAME
  // sentence: a pointer user and a screen-reader user are being told the same thing, and
  // neither is being told something the drawer does not also say.
  const text = worklog ? `r${worklog.revisions} · ${formatRowDate(worklog.updatedAt, now)}` : "—";
  const label = worklog
    ? `${state === "stale" ? "worklog behind the work" : "worklog"}, ${worklog.revisions} ` +
      `checkpoint${worklog.revisions === 1 ? "" : "s"}, last written ${agePhrase(worklog.updatedAt, now)}`
    : "no worklog yet";

  return (
    <span
      className="staple-worklog-cue"
      data-testid="worklog-cue"
      data-state={state}
      aria-label={label}
      title={label}
    >
      <PageGlyph state={state} />
      {/* Tabular figures, matching `.staple-row-date`, so a column of counts is a column
          and not a ragged edge. */}
      <span className="staple-worklog-text">{text}</span>
    </span>
  );
}
