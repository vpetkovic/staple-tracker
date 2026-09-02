/**
 * "Someone is working on this RIGHT NOW" — V5 (STA-97) §7. The element the ticket exists for.
 *
 * A held ticket and an abandoned one are the same pixels until something says otherwise.
 * `lib/claim.ts` makes that argument at the top of the file; this is the visual half of it.
 *
 * ── THE FOUR STATES, AND THE ONE THRESHOLD ────────────────────────────────────────────
 *
 *   live     claim != null && !isStaleClaim(claim)   breathing pill
 *   stale    claim != null &&  isStaleClaim(claim)   the existing StaleClaimBadge, unmoving
 *   held     claim == null && checkoutAgent != null  static "held" pill, no dot
 *   free     neither                                 nothing
 *
 * NO NEW CONSTANT. `STALE_CLAIM_SECONDS` is the one judgement this app makes about idleness
 * and it is shared with the takeover buttons by construction, so what the badge claims and
 * what the button asks the store for are the same number rather than two numbers somebody
 * has to remember to keep equal.
 *
 * `checkoutAgent` ALONE IS NOT LIVENESS. It says a claim exists, not that anyone is awake.
 * Only the endpoint that carries `claim` has the idle reading, which is why the third state
 * is static and grey: the page has no reason to believe anything is happening, so it does
 * not animate. The page never invents a fact.
 *
 * THE STALE BADGE REPLACES THE PILL; they never appear together. `IssueCard.tsx` already
 * made that call and the reasoning holds — the badge names the holder, and printing the
 * holder twice on a 36px row turns a signal into noise.
 *
 * NOTHING TICKS. `idleSeconds` is a server reading frozen at response time and refreshed by
 * the existing 1.5s fingerprint poll. A client-side counter would look smoother while being
 * strictly less true: it would keep counting up against a claim that has already been taken
 * over, and it would keep counting in a backgrounded tab.
 *
 * THE ANIMATION IS NOT A TIMER. It says "live", nothing more, and it must never be readable
 * as progress. See tree-row.css for why it is the dot and only the dot that moves.
 */
import { StaleClaimBadge } from "@/components/StaleClaimBadge";
import { formatAgo, isStaleClaim, staleClaimSummary } from "@/lib/claim";
import type { ClaimActivity } from "@/lib/types";
import { cn } from "@/lib/utils";
import { initials } from "./avatar";

/**
 * Agents and humans differ in SHAPE, never in colour.
 *
 * A rounded square is a machine, a circle is a person — the convention GitHub already
 * taught everyone with organisations vs users. It survives greyscale, it survives 18px,
 * and it costs nothing from a palette whose whole language is monochrome plus one accent.
 *
 * The earlier draft of this spec tinted agent avatars from the `--agent-{n}a/b` brand
 * gradients. V1 is fossilising that set and is right to: ten saturated gradients would be
 * the loudest thing on the page, and they would spend more colour on an AVATAR than on the
 * status glyph that actually carries meaning. The only hue in this entire pill is the 6px
 * breathing dot — which is correct, because "something is happening right now" is the one
 * fact on the row worth spending colour on.
 */
export function Avatar({
  name,
  kind,
  size = 20,
  className,
}: {
  name: string;
  kind: "agent" | "human";
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn("staple-avatar", className)}
      data-kind={kind}
      style={{ width: size, height: size }}
      role="img"
      aria-label={kind === "human" ? `@${name}` : name}
      title={kind === "human" ? `@${name}` : name}
    >
      {initials(name)}
    </span>
  );
}

/**
 * Up to three overlapping agent avatars.
 *
 * Today the stack is always exactly one — `checkoutAgent` is single-valued. The prop is
 * `holders: string[]` anyway, which is not speculative layout: it is one prop typed
 * honestly, so a multi-agent claim needs no redesign. The 2px ring that cuts the overlap
 * has to follow the row's background through hover and selection, or the seam reappears
 * the moment the pointer crosses the row — see `--staple-row-bg` in tree-row.css.
 */
export function AvatarStack({ holders }: { holders: string[] }) {
  const shown = holders.slice(0, 3);
  return (
    <span className="staple-avatar-stack">
      {shown.map((holder, index) => (
        <Avatar
          key={holder}
          name={holder}
          kind="agent"
          size={18}
          // First avatar on top, so the stack reads left-to-right like text does.
          className={index === 0 ? undefined : "staple-avatar-stacked"}
        />
      ))}
    </span>
  );
}

function WorkingPill({ claim }: { claim: ClaimActivity }) {
  return (
    <span
      className="staple-working-pill"
      data-testid="working-pill"
      aria-label={`${claim.heldBy} is working — held ${formatAgo(claim.heldSeconds)}, active ${formatAgo(claim.idleSeconds)} ago`}
      // The same sentence the card and the detail panel show, so three surfaces cannot
      // end up disagreeing about one claim.
      title={staleClaimSummary(claim)}
    >
      <AvatarStack holders={[claim.heldBy]} />
      <span className="staple-working-dot" aria-hidden="true" />
      <span className="staple-working-label">Working…</span>
    </span>
  );
}

function HeldPill({ agent }: { agent: string }) {
  return (
    <span
      className="staple-held-pill"
      data-testid="held-pill"
      aria-label={`held by ${agent}; no liveness reading`}
      title={`held by ${agent} — no liveness reading available`}
    >
      <Avatar name={agent} kind="agent" size={18} />
      <span className="staple-held-label">{agent}</span>
    </span>
  );
}

/**
 * The single decision point. Every caller passes the row's two fields and gets whichever of
 * the four states is true — so there is exactly one place the liveness rule is written down.
 */
export function RowClaimSlot({
  claim,
  checkoutAgent,
}: {
  claim: ClaimActivity | null;
  checkoutAgent: string | null;
}) {
  if (claim) {
    return isStaleClaim(claim) ? (
      <StaleClaimBadge claim={claim} variant="compact" className="staple-row-stale" />
    ) : (
      <WorkingPill claim={claim} />
    );
  }
  return checkoutAgent ? <HeldPill agent={checkoutAgent} /> : null;
}
