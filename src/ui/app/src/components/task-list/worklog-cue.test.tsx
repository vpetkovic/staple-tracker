/**
 * W4 (STA-116) — the worklog freshness cue, state by state.
 *
 * Rendered to a string with `react-dom/server`, like every other test in this folder:
 * the claims below are all about which elements exist and what their accessible names
 * say, which is exactly what a string can answer.
 *
 * The four properties worth a test, in order of how quietly they would break:
 *
 *   1. THE CUE IS NOT A SECOND LIVENESS BADGE. §4 of the STA-108 spec is entirely about
 *      this: a live claim with a stale worklog must render BOTH facts without either
 *      contradicting the other, and the cue's own words must never mean "silent". Two
 *      badges that both say "silent" is precisely the noise the epic exists to remove.
 *   2. It never re-derives the judgement. `worklogStaleness` in lib/worklog.ts owns it,
 *      and the margin is one hour, not `STALE_CLAIM_SECONDS`. Borrowing the claim
 *      threshold would look identical on screen and be a different assertion about the
 *      world — so the test drives the boundary rather than a convenient interior point.
 *   3. It spends no colour. The row already spends its only hue on the working dot. This
 *      is asserted against the STYLESHEET, not only against the markup, because the
 *      markup is `currentColor` throughout and a hue could only ever be smuggled in
 *      through CSS.
 *   4. The empty variant appears only where somebody is holding the ticket. On an unheld
 *      row a missing worklog is not a finding, it is the normal state of a backlog.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { STALE_CLAIM_SECONDS } from "@/lib/claim";
import { WORKLOG_STALE_MARGIN_SECONDS } from "@/lib/worklog";
import type { ClaimActivity, WorklogSummary } from "@/lib/types";
import { WorklogCue } from "./WorklogCue";
import { claim, worklog } from "./fixtures";

const NOW = new Date("2026-09-02T12:00:00.000Z");

/** `n` seconds before NOW, as the ISO string the server would have sent. */
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

function render(input: {
  worklog?: WorklogSummary | null;
  claim?: ClaimActivity | null;
  checkoutAgent?: string | null;
}): string {
  return renderToStaticMarkup(
    <WorklogCue
      worklog={input.worklog}
      claim={input.claim ?? null}
      checkoutAgent={input.checkoutAgent ?? null}
      now={NOW}
    />,
  );
}

describe("the four states", () => {
  it("draws a FRESH cue with its revision count and its age", () => {
    const markup = render({
      worklog: worklog({ revisions: 3, updatedAt: ago(41 * 60) }),
      claim: claim({ lastActivityAt: ago(30), idleSeconds: 30 }),
      checkoutAgent: "opus-x",
    });

    expect(markup).toContain('data-testid="worklog-cue"');
    expect(markup).toContain('data-state="fresh"');
    expect(markup).toContain("r3 · 41m");
    // The count and the age are the two facts, and the label says both in words.
    expect(markup).toContain('aria-label="worklog, 3 checkpoints, last written 41m ago"');
  });

  it("draws a STALE cue when the holder has worked on past the last checkpoint", () => {
    const markup = render({
      worklog: worklog({ revisions: 3, updatedAt: ago(4 * 3600) }),
      claim: claim({ lastActivityAt: ago(60), idleSeconds: 60 }),
      checkoutAgent: "opus-x",
    });

    expect(markup).toContain('data-state="stale"');
    expect(markup).toContain("r3 · 4h");
    // "behind the work" — a statement about the HANDOFF, never about the holder being
    // quiet. The claim slot owns quiet, and it is two elements to the right.
    expect(markup).toContain(
      'aria-label="worklog behind the work, 3 checkpoints, last written 4h ago"',
    );
    expect(markup).not.toMatch(/silent|idle|working|stale claim/i);
  });

  it("draws the EMPTY cue on a held row with nothing checkpointed", () => {
    const markup = render({
      worklog: null,
      claim: claim({ lastActivityAt: ago(60), idleSeconds: 60 }),
      checkoutAgent: "opus-x",
    });

    expect(markup).toContain('data-state="empty"');
    expect(markup).toContain('aria-label="no worklog yet"');
    // An em dash, not a zero and not a blank: "there is nothing here" reads differently
    // from "there are none of them", and a blank slot reads as a bug.
    expect(markup).toContain("—");
    expect(markup).not.toContain("r0");
  });

  it("draws NOTHING on an unheld row with no worklog", () => {
    // Absent, not empty. Most of a backlog is in this state and a column of dashes down
    // 114 rows would be the noise the row spec forbids, not a signal.
    expect(render({ worklog: null, claim: null, checkoutAgent: null })).toBe("");
    expect(render({ claim: null, checkoutAgent: null })).toBe("");
  });

  it("treats an undefined summary exactly like a null one", () => {
    // `IssueRow.worklog` is optional so that a fixture or a synthesised row is FORCED to
    // be checked rather than assumed. The two spellings must not diverge here.
    const held = { claim: claim(), checkoutAgent: "opus-x" };
    expect(render({ ...held, worklog: undefined })).toBe(render({ ...held, worklog: null }));
  });

  it("still draws the empty cue when only `checkoutAgent` says the ticket is held", () => {
    // The claim slot's third state: a claim exists, but this endpoint carried no liveness
    // reading. Somebody has it and has written nothing down, which is the finding.
    const markup = render({ worklog: null, claim: null, checkoutAgent: "opus-x" });
    expect(markup).toContain('data-state="empty"');
  });
});

describe("the freshness judgement is lib/worklog.ts's, not lib/claim.ts's", () => {
  it("flips at the WORKLOG margin and nowhere near the claim threshold", () => {
    // A worklog written just inside the margin behind the last activity is fresh; one
    // written just outside it is stale. Driving the boundary is what makes this a test of
    // the margin rather than of a comfortable interior point.
    const at = (gapSeconds: number) =>
      render({
        worklog: worklog({ revisions: 2, updatedAt: ago(gapSeconds + 60) }),
        claim: claim({ lastActivityAt: ago(60), idleSeconds: 60 }),
        checkoutAgent: "opus-x",
      });

    expect(at(WORKLOG_STALE_MARGIN_SECONDS - 60)).toContain('data-state="fresh"');
    expect(at(WORKLOG_STALE_MARGIN_SECONDS)).toContain('data-state="stale"');
    // The two constants are genuinely different numbers, which is the whole argument for
    // there being two of them. If someone "tidies" them into one, this fails first.
    expect(WORKLOG_STALE_MARGIN_SECONDS).not.toBe(STALE_CLAIM_SECONDS);
    // …and at the claim's threshold the worklog is still perfectly fresh.
    expect(at(STALE_CLAIM_SECONDS)).toContain('data-state="fresh"');
  });

  it("calls an unheld ticket's worklog fresh — nothing has happened that it fails to explain", () => {
    // `worklogStaleness` returns `unknown` with no claim activity to compare against. A
    // finished, well-documented ticket must not be flagged as a handoff risk six hours
    // later just because six hours passed.
    const markup = render({
      worklog: worklog({ revisions: 7, updatedAt: ago(6 * 3600) }),
      claim: null,
    });
    expect(markup).toContain('data-state="fresh"');
    expect(markup).toContain("r7 · 6h");
  });

  it("renders a live claim and a stale worklog as two facts, not as a contradiction", () => {
    // The row that this whole epic is about: the agent is busy and has stopped
    // checkpointing. The cue says the handoff is behind; it says nothing at all about
    // whether anyone is there, because RowClaimSlot is the only element allowed to.
    const markup = render({
      worklog: worklog({ revisions: 1, updatedAt: ago(5 * 3600) }),
      claim: claim({ lastActivityAt: ago(10), idleSeconds: 10 }),
      checkoutAgent: "opus-t98",
    });

    expect(markup).toContain('data-state="stale"');
    // It does not name the holder either — the pill beside it already does, and printing
    // the holder twice on a 36px row turns a signal into noise.
    expect(markup).not.toContain("opus-t98");
  });
});

describe("presentation", () => {
  /**
   * COMMENTS STRIPPED FIRST. This file's own prose says the words "hue", "priority" and
   * "transition" while forbidding them, and a test that grepped the comments would be
   * asserting that the stylesheet does not explain itself.
   */
  const CSS = readFileSync(
    fileURLToPath(new URL("./task-list.css", import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  /** Every rule whose selector mentions the cue. */
  const cueRules = CSS.split("}")
    .filter((block) => /\.staple-worklog-/.test(block.split("{")[0] ?? ""))
    .join("}");

  it("hides the glyph from assistive tech and puts the words on the wrapper", () => {
    const markup = render({ worklog: worklog(), claim: claim() });
    expect(markup).toContain('aria-hidden="true"');
    // The <svg> carries no name of its own; a decorative glyph announced twice is worse
    // than one announced once.
    expect(markup).not.toMatch(/<svg[^>]*aria-label/);
    // Pointer users get the same sentence, per §3C.
    expect(markup).toMatch(/title="[^"]+"/);
  });

  it("gives each state a DIFFERENT SHAPE, so none of the three depends on weight alone", () => {
    const shapes = (["fresh", "stale", "empty"] as const).map((state) => {
      const markup =
        state === "empty"
          ? render({ worklog: null, claim: claim() })
          : render({
              worklog: worklog({ updatedAt: state === "fresh" ? ago(60) : ago(9 * 3600) }),
              claim: claim({ lastActivityAt: ago(60) }),
            });
      return markup.slice(markup.indexOf("<svg"), markup.indexOf("</svg>"));
    });
    expect(new Set(shapes).size).toBe(3);
  });

  it("spends NO colour — not in the markup, and not in the stylesheet either", () => {
    for (const markup of [
      render({ worklog: worklog(), claim: claim() }),
      render({
        worklog: worklog({ updatedAt: ago(9 * 3600) }),
        claim: claim({ lastActivityAt: ago(60) }),
      }),
      render({ worklog: null, claim: claim() }),
    ]) {
      // The glyph is `currentColor` throughout, so there is no token in the markup at all.
      expect(markup).not.toContain("var(--");
      expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|hsl\(|rgb\(|oklch\(/i);
    }

    // The stylesheet is where a hue could actually be smuggled in. The cue may use the
    // neutral text tokens and nothing else — no label hue, no status hue, no priority
    // hue, no agent gradient. The working dot stays the only colour on the row.
    expect(cueRules).not.toMatch(/--label-hue|--status-|--priority-|--agent-|--accent/);
    expect(cueRules).not.toMatch(/#[0-9a-f]{3,8}\b|hsl\(|rgb\(|oklch\(/i);
    expect(cueRules).toContain("tabular-nums");
  });

  it("animates nothing on hover — the row spec's hardest rule", () => {
    // Not `transform`, not `width`, not `padding`. At 36px with a hairline separator a
    // 1px shift when the pointer crosses a row reads as the whole list twitching.
    expect(cueRules).not.toMatch(/transition|transform|animation/);
    expect(CSS).not.toMatch(/\.staple-row:hover[^{]*\.staple-worklog/);
  });
});
