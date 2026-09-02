/**
 * The token estimate and the size breakdown behind the "what the agent sees" pane.
 *
 * The estimate is the whole reason the pane exists, so the arithmetic gets pinned:
 * measured on the COMPACT JSON (what mcp.ts actually puts on the wire), rounded up, and
 * broken down into shares that add up.
 */
import { describe, expect, it } from "vitest";
import {
  breakdown,
  CHARS_PER_TOKEN,
  estimateTokens,
  thousands,
  wireJson,
} from "../src/ui/app/src/detail/agentPayload.js";

describe("estimateTokens", () => {
  it("is chars over four, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });

  it("uses the divisor the pane tells the reader it uses", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    const text = "y".repeat(400);
    expect(estimateTokens(text)).toBe(text.length / CHARS_PER_TOKEN);
  });
});

describe("wireJson", () => {
  it("is compact — the indented form the pane displays is not what the agent is charged for", () => {
    const payload = { issue: { identifier: "STA-16", title: "a task" }, comments: [] };
    expect(wireJson(payload)).toBe(JSON.stringify(payload));
    expect(wireJson(payload).length).toBeLessThan(JSON.stringify(payload, null, 2).length);
  });

  it("makes the estimate materially smaller than an indented one would be", () => {
    const payload = {
      issue: { identifier: "STA-16", title: "a task", description: "x".repeat(200) },
      comments: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, body: "y".repeat(80) })),
    };
    const compact = estimateTokens(wireJson(payload));
    const indented = estimateTokens(JSON.stringify(payload, null, 2));
    expect(indented).toBeGreaterThan(compact * 1.15);
  });
});

describe("breakdown", () => {
  const payload = {
    issue: { identifier: "STA-16", description: "x".repeat(400) },
    comments: [{ body: "y".repeat(100) }, { body: "z".repeat(100) }],
    documents: [],
    crossBlockers: [],
  };

  it("sorts the biggest contributor first", () => {
    expect(breakdown(payload)[0]!.key).toBe("issue");
  });

  it("counts rows for arrays and nothing for objects", () => {
    const slices = Object.fromEntries(breakdown(payload).map((s) => [s.key, s]));
    expect(slices.comments!.count).toBe(2);
    expect(slices.documents!.count).toBe(0);
    expect(slices.issue!.count).toBeNull();
  });

  it("produces shares that add up to one", () => {
    const total = breakdown(payload).reduce((sum, slice) => sum + slice.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("agrees with estimateTokens on each key", () => {
    for (const slice of breakdown(payload)) {
      expect(slice.tokens).toBe(estimateTokens(wireJson(payload[slice.key as keyof typeof payload])));
      expect(slice.chars).toBe(wireJson(payload[slice.key as keyof typeof payload]).length);
    }
  });

  it("does not divide by zero on an empty payload", () => {
    expect(breakdown({})).toEqual([]);
  });

  it("shows document bodies dominating once they are inlined, which is the point", () => {
    const lean = breakdown({ ...payload, documents: [{ key: "plan", currentRevision: 3 }] });
    const full = breakdown({
      ...payload,
      documents: [{ key: "plan", currentRevision: 3, body: "p".repeat(8000) }],
    });
    const shareOf = (slices: ReturnType<typeof breakdown>, key: string) =>
      slices.find((s) => s.key === key)!.share;
    expect(shareOf(lean, "documents")).toBeLessThan(0.1);
    expect(shareOf(full, "documents")).toBeGreaterThan(0.9);
  });
});

describe("thousands", () => {
  it("groups digits without dragging in a locale", () => {
    expect(thousands(0)).toBe("0");
    expect(thousands(999)).toBe("999");
    expect(thousands(1000)).toBe("1,000");
    expect(thousands(1234567)).toBe("1,234,567");
    expect(thousands(-1234)).toBe("-1,234");
  });
});
