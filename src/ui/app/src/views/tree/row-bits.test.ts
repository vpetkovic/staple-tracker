/**
 * V5 (STA-97) — the three pure helpers on the row, and the property each one has to keep.
 *
 * None of these is complicated. Each has exactly one way of failing that a reader would
 * never notice until it had been wrong for weeks:
 *
 *   - `labelHue` returning a different hue on a different machine or after a reload. The
 *     colour is a scanning aid: "the green one" has to mean the same label tomorrow. There
 *     is no label table to hang a colour off, so stability is a property of the FUNCTION.
 *   - `initials` producing three characters, or one, and quietly breaking an 18px circle.
 *   - `formatRowDate` printing a bare "Oct 9" for something from last year, which reads as
 *     six weeks old when it is fourteen months old.
 */
import { describe, expect, it } from "vitest";
import { LABEL_HUE_COUNT, labelHue, splitLabels } from "./label-hue";
import { initials } from "./avatar";
import { formatRowDate } from "./row-date";

describe("labelHue", () => {
  it("gives curated labels the colour people already expect", () => {
    expect(labelHue("bug")).toBe(1); // red
    expect(labelHue("regression")).toBe(1);
    expect(labelHue("security")).toBe(1);
    expect(labelHue("performance")).toBe(3); // green
    expect(labelHue("perf")).toBe(3);
    expect(labelHue("design")).toBe(6); // violet
    expect(labelHue("docs")).toBe(8); // slate
    expect(labelHue("feature")).toBe(5); // blue
  });

  it("is stable, case-insensitive and whitespace-insensitive", () => {
    expect(labelHue("Bug")).toBe(labelHue("bug"));
    expect(labelHue("  ux-polish  ")).toBe(labelHue("ux-polish"));
    // The whole point: a pure function of the string means every machine and every reload
    // agree without a registry, a migration, or a server round trip.
    expect(labelHue("ux-polish")).toBe(labelHue("ux-polish"));
  });

  it("always lands inside the eight-hue palette", () => {
    const samples = ["a", "zzz", "wave-2", "STA", "", "🙂", "a".repeat(200)];
    for (const s of samples) {
      const hue = labelHue(s);
      expect(hue).toBeGreaterThanOrEqual(1);
      expect(hue).toBeLessThanOrEqual(LABEL_HUE_COUNT);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  it("spreads uncurated labels over more than one hue", () => {
    const hues = new Set(
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].map(labelHue),
    );
    expect(hues.size).toBeGreaterThan(2);
  });
});

describe("splitLabels", () => {
  it("keeps source order — the author's ordering is information", () => {
    expect(splitLabels(["zeta", "alpha"], 2)).toEqual({ shown: ["zeta", "alpha"], hidden: [] });
  });

  it("caps at max and puts the remainder in the overflow", () => {
    expect(splitLabels(["a", "b", "c", "d"], 2)).toEqual({ shown: ["a", "b"], hidden: ["c", "d"] });
  });

  it("hides everything when max is zero, so the caller can render bare dots instead", () => {
    expect(splitLabels(["a", "b"], 0)).toEqual({ shown: [], hidden: ["a", "b"] });
  });
});

describe("initials", () => {
  it("renders the spec's four worked examples", () => {
    expect(initials("opus-x")).toBe("OX");
    expect(initials("v5-designer")).toBe("VD");
    expect(initials("VP")).toBe("VP");
    expect(initials("claude")).toBe("CL");
  });

  it("never overflows the circle — hard cap of two characters", () => {
    // A single-character name legitimately yields one initial; what must never happen is
    // three, which is what an unbounded "first letter of every token" would produce for
    // `some-long-agent-name` and what would burst an 18px circle.
    for (const name of ["a", "a-b-c-d", "  spaced  out  ", "x_y", "3", "ünicode"]) {
      const out = initials(name);
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out.length).toBeLessThanOrEqual(2);
      expect(out).toBe(out.toUpperCase());
    }
    expect(initials("a-b-c-d")).toBe("AB");
  });

  it("falls back rather than rendering an empty circle", () => {
    expect(initials("")).toBe("??");
    expect(initials("   ")).toBe("??");
  });
});

describe("formatRowDate", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");

  it("uses the same duration vocabulary as the stale badge under a day", () => {
    expect(formatRowDate("2026-09-02T11:48:00.000Z", now)).toBe("12m");
    expect(formatRowDate("2026-09-02T09:00:00.000Z", now)).toBe("3h");
  });

  it("drops the year for an older date in the same calendar year", () => {
    expect(formatRowDate("2026-06-09T09:00:00.000Z", now)).toBe("Jun 9");
  });

  it("keeps the year once the calendar year differs — 'Oct 9' must not mean 14 months ago", () => {
    expect(formatRowDate("2025-10-09T09:00:00.000Z", now)).toBe("Oct 9, 2025");
  });
});
