/**
 * The desktop row's who cue: each person once, one plain word, the full sentence kept.
 *
 * `idleSeconds` is computed by the server; what is under test here is only the cue's reading
 * of it at the stale threshold, so a claim shaped like `/api/issues` sends one is enough.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STALE_CLAIM_SECONDS } from "@/lib/claim";
import type { ClaimActivity } from "@/lib/types";
import { WhoCue, whoFacts } from "./WhoCue";

const claim = (idleSeconds: number, heldBy = "opus-a"): ClaimActivity =>
  ({
    heldBy,
    checkoutAt: "2026-09-04T10:00:00.000Z",
    lastActivityAt: "2026-09-04T11:00:00.000Z",
    heldSeconds: 7200,
    idleSeconds,
    scope: "local",
  }) as ClaimActivity;

describe("whoFacts", () => {
  it("says Working under the stale threshold and Quiet at it", () => {
    expect(whoFacts({ claim: claim(STALE_CLAIM_SECONDS - 1), checkoutAgent: "opus-a", assignee: null })?.word).toBe("Working");
    const quiet = whoFacts({ claim: claim(STALE_CLAIM_SECONDS), checkoutAgent: "opus-a", assignee: null })!;
    expect(quiet.state).toBe("quiet");
    expect(quiet.word).toBe("Quiet 30m");
    // The whole diagnosis is still said, for the tooltip and a screen reader.
    expect(quiet.sentence).toContain("silent 30m");
  });

  it("drops an assignee who is the holder, keeps one who is not", () => {
    expect(whoFacts({ claim: claim(10), checkoutAgent: "opus-a", assignee: "opus-a" })?.assignee).toBeNull();
    expect(whoFacts({ claim: claim(10), checkoutAgent: "opus-a", assignee: "vp" })?.assignee).toBe("vp");
  });

  it("says Picked up for a checkout with no activity reading, and nothing for an empty task", () => {
    expect(whoFacts({ claim: null, checkoutAgent: "opus-b", assignee: null })?.word).toBe("Picked up");
    expect(whoFacts({ claim: null, checkoutAgent: null, assignee: null })).toBeNull();
  });

  it("never uses an ellipsis in a word", () => {
    for (const idle of [5, STALE_CLAIM_SECONDS * 3]) {
      expect(whoFacts({ claim: claim(idle), checkoutAgent: "x", assignee: null })!.word).not.toContain("…");
    }
  });
});

describe("WhoCue", () => {
  it("keeps its slot when nobody is on the task, so the dates still form a column", () => {
    const html = renderToStaticMarkup(<WhoCue claim={null} checkoutAgent={null} assignee={null} />);
    expect(html).toContain('data-testid="who-slot"');
    expect(html).not.toContain("who-cue");
  });

  it("drops the word below 880px but keeps the avatar and the sentence", () => {
    const html = renderToStaticMarkup(<WhoCue claim={claim(10)} checkoutAgent="opus-a" assignee={null} showWord={false} />);
    expect(html).toContain('data-word="off"');
    expect(html).not.toContain("staple-who-word");
    expect(html).toContain("OA");
    expect(html).toContain("opus-a is working on this");
  });
});
