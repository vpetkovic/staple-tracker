/**
 * C3 — the judgement the stale-claim badge is made of.
 *
 * What is worth pinning here is not "formatAgo renders 45m". It is the three ways this
 * feature could quietly become wrong:
 *
 *   1. The badge appearing on healthy claims. A badge on every in-progress ticket is
 *      furniture, and furniture is invisible — the feature would still "work" and would
 *      have stopped telling anyone anything.
 *   2. The threshold the badge is drawn at drifting away from the threshold the takeover
 *      button sends. Then the page shows a badge and the store refuses the steal it
 *      offered, or worse, offers a steal for a claim it called healthy.
 *   3. The wording losing one of the two durations. "held 2h" and "silent 45m" are
 *      different facts; a healthy long-running task and an abandoned one are told apart
 *      only by the second one.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so the
 * app's `@` alias (src/ui/app/vite.config.ts) does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import {
  STALE_CLAIM_SECONDS,
  formatAgo,
  isStaleClaim,
  staleClaimDetail,
  staleClaimSummary,
} from "./claim";
import type { ClaimActivity } from "./types";

function claim(overrides: Partial<ClaimActivity> = {}): ClaimActivity {
  return {
    heldBy: "opus-x",
    checkoutAt: "2026-09-01T10:00:00.000Z",
    lastActivityAt: "2026-09-01T11:15:00.000Z",
    heldSeconds: 7200,
    idleSeconds: 2700,
    ...overrides,
  };
}

describe("the threshold decides what the page even mentions", () => {
  it("says nothing about an unheld issue", () => {
    // null is not "stale", it is "nobody has this" — an ordinary, unremarkable state.
    expect(isStaleClaim(null)).toBe(false);
    expect(isStaleClaim(undefined)).toBe(false);
  });

  it("leaves a working agent alone", () => {
    // Held for two hours, active thirty seconds ago: this is what a long task looks
    // like, and flagging it would be an accusation the data does not support.
    expect(isStaleClaim(claim({ heldSeconds: 7200, idleSeconds: 30 }))).toBe(false);
  });

  it("flags a holder that has gone silent past the threshold", () => {
    expect(isStaleClaim(claim({ idleSeconds: STALE_CLAIM_SECONDS + 1 }))).toBe(true);
  });

  it("flags at exactly the threshold, because that is the second the steal would land", () => {
    // >= not >: the badge and the store's own comparison have to agree on the boundary,
    // or the page spends a moment offering a takeover it has not justified (or refusing
    // to offer one it has).
    expect(isStaleClaim(claim({ idleSeconds: STALE_CLAIM_SECONDS }))).toBe(true);
    expect(isStaleClaim(claim({ idleSeconds: STALE_CLAIM_SECONDS - 1 }))).toBe(false);
  });

  it("is thirty minutes, the same number the takeover buttons send", () => {
    // A guard on the constant itself. The buttons pass STALE_CLAIM_SECONDS straight
    // through as stealIfIdleSeconds/ifIdleSeconds, so changing this changes both the
    // badge and the write — which is the intended coupling, but it should be a decision,
    // not a side effect of tuning the visuals.
    expect(STALE_CLAIM_SECONDS).toBe(1800);
  });

  it("accepts a caller-supplied threshold without touching the default", () => {
    const c = claim({ idleSeconds: 120 });
    expect(isStaleClaim(c, 60)).toBe(true);
    expect(isStaleClaim(c)).toBe(false);
  });
});

describe("what the badge says", () => {
  it("names the holder and both durations", () => {
    expect(staleClaimSummary(claim({ heldSeconds: 7200, idleSeconds: 2700 }))).toBe(
      "held by opus-x · 2h · silent 45m",
    );
  });

  it("keeps held and silent distinguishable, which is the entire diagnosis", () => {
    const healthyShape = staleClaimSummary(claim({ heldSeconds: 7200, idleSeconds: 30 }));
    const abandoned = staleClaimSummary(claim({ heldSeconds: 7200, idleSeconds: 7200 }));
    // Same holder, same age, opposite meaning. If a refactor ever prints one duration,
    // these two collapse into the same sentence and the badge stops being evidence.
    expect(healthyShape).not.toBe(abandoned);
    expect(abandoned).toBe("held by opus-x · 2h · silent 2h");
  });

  it("adds the timestamp the silence was derived from, in the detail variant", () => {
    // The panel has the room, and lastActivityAt is the auditable fact a human can check
    // against the event log before taking someone's work away.
    expect(staleClaimDetail(claim())).toBe(
      "held by opus-x · 2h · silent 45m · last activity 2026-09-01T11:15:00Z",
    );
  });
});

describe("formatAgo mirrors the store's prose", () => {
  it("uses one floored unit, the way the refusal sentences do", () => {
    // These are the exact renderings inside claimGuardMessage() in src/core/types.ts. A
    // badge saying "silent 45m" next to a refusal saying "active 2700s ago" would read
    // as two systems describing two different claims.
    expect(formatAgo(0)).toBe("0s");
    expect(formatAgo(59)).toBe("59s");
    expect(formatAgo(60)).toBe("1m");
    expect(formatAgo(3599)).toBe("59m");
    expect(formatAgo(3600)).toBe("1h");
    expect(formatAgo(86399)).toBe("23h");
    expect(formatAgo(86400)).toBe("1d");
    expect(formatAgo(86400 * 5)).toBe("5d");
  });

  it("never renders a negative age from a clock that disagrees with itself", () => {
    // The server computes these; a machine whose clock stepped backwards mid-request
    // should produce a boring "0s", not "-3s ago".
    expect(formatAgo(-90)).toBe("0s");
  });
});
