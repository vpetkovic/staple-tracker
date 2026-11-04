import { describe, expect, it } from "vitest";
import type { EffectiveQueueRow } from "@/lib/types";
import { queueCaption } from "./QueueView";

const claimed = { eligibility: "claimed", reason: "STA-313 is held by dux-shell." } as EffectiveQueueRow;
const blocked = { eligibility: "blocked", reason: "STA-62 is blocked by STA-61." } as EffectiveQueueRow;
const desk = { desk: true, plan: { layout: "line" } };
const phone = { desk: true, plan: { layout: "compact" } };
const held = { claim: null, issue: { checkoutAgent: "dux-shell" } } as never;
const nobody = { claim: null, issue: { checkoutAgent: null } } as never;

describe("the queue row's caption says who holds it once", () => {
  it("leaves the holder to the who cue on the desk row", () => {
    expect(queueCaption(claimed, desk, held)).toBeUndefined();
  });
  it("keeps the store's sentence when the row cannot name the holder, and on the phone", () => {
    expect(queueCaption(claimed, desk, nobody)).toBe("STA-313 is held by dux-shell.");
    expect(queueCaption(claimed, phone, held)).toBe("STA-313 is held by dux-shell.");
  });
  it("leaves a blocker to the row's Blocked by cue, and keeps every other reason", () => {
    const blockedRow = { claim: null, issue: { checkoutAgent: null }, deps: { blockedBy: ["STA-61"], blocks: [] } } as never;
    expect(queueCaption(blocked, desk, blockedRow)).toBeUndefined();
    expect(queueCaption(blocked, desk, held)).toBe("STA-62 is blocked by STA-61.");
    expect(queueCaption(blocked, phone, blockedRow)).toBe("STA-62 is blocked by STA-61.");
  });
});
