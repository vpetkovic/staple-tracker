/**
 * How the analytics widgets say a number: every formatter on both sides of each threshold it
 * switches at, so a figure reads the same on a tile, an axis, a tooltip and a table.
 */
import { describe, expect, it } from "vitest";
import { changeRatio, formatCount, formatDay, formatDayRange, formatEffortHours, formatHours, formatMoney, formatMultiple, formatNumber, formatPercent, niceTicks } from "./format";

describe("formatCount", () => {
  it("says a count whole, with separators, under ten thousand", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1284)).toBe("1,284");
    expect(formatCount(9999)).toBe("9,999");
  });
  it("goes compact at ten thousand and at a million", () => {
    expect(formatCount(10_000)).toBe("10K");
    expect(formatCount(12_900)).toBe("12.9K");
    expect(formatCount(999_000)).toBe("999K");
    expect(formatCount(1_000_000)).toBe("1M");
    expect(formatCount(4_230_000)).toBe("4.2M");
  });
  it("keeps the sign and switches on the size, not the sign", () => {
    expect(formatCount(-12_900)).toBe("-12.9K");
    expect(formatCount(-950)).toBe("-950");
  });
});

describe("formatNumber", () => {
  it("prints one decimal under ten and none from ten", () => {
    expect(formatNumber(1.14)).toBe("1.1");
    expect(formatNumber(9.54)).toBe("9.5");
    expect(formatNumber(10.4)).toBe("10");
    expect(formatNumber(633)).toBe("633");
    expect(formatNumber(1619)).toBe("1,619");
  });
  it("drops a trailing zero and honours explicit digits", () => {
    expect(formatNumber(2)).toBe("2");
    expect(formatNumber(12.345, 2)).toBe("12.35");
    expect(formatNumber(3.7, 0)).toBe("4");
  });
});

describe("formatHours", () => {
  it("says under a minute below one minute", () => {
    expect(formatHours(0)).toBe("under a minute");
    expect(formatHours(0.5 / 60)).toBe("under a minute");
  });
  it("says minutes from one minute to the hour", () => {
    expect(formatHours(1 / 60)).toBe("1 min");
    expect(formatHours(22 / 60)).toBe("22 min");
    expect(formatHours(59 / 60)).toBe("59 min");
  });
  it("says the hour, never 60 min, when the minutes round up to it", () => {
    expect(formatHours(59.6 / 60)).toBe("1 h");
  });
  it("says hours from one hour to three days, then days", () => {
    expect(formatHours(1)).toBe("1 h");
    expect(formatHours(1.1)).toBe("1.1 h");
    expect(formatHours(71)).toBe("71 h");
    expect(formatHours(72)).toBe("3 days");
    expect(formatHours(60 * 24)).toBe("60 days");
  });
});

describe("formatEffortHours", () => {
  it("keeps one decimal under ten hours and whole hours from ten", () => {
    expect(formatEffortHours(0.25)).toBe("0.3 h");
    expect(formatEffortHours(9.94)).toBe("9.9 h");
    expect(formatEffortHours(10)).toBe("10 h");
    expect(formatEffortHours(633.4)).toBe("633 h");
  });
  it("never switches to days", () => {
    expect(formatEffortHours(1619)).toBe("1,619 h");
  });
});

describe("formatMoney", () => {
  it("says whole dollars under ten thousand", () => {
    expect(formatMoney(0)).toBe("$0");
    expect(formatMoney(949.6)).toBe("$950");
    expect(formatMoney(9999)).toBe("$9,999");
  });
  it("goes compact at ten thousand (one decimal) and a million (two)", () => {
    expect(formatMoney(10_000)).toBe("$10K");
    expect(formatMoney(26_600)).toBe("$26.6K");
    expect(formatMoney(1_000_000)).toBe("$1M");
    expect(formatMoney(1_234_567)).toBe("$1.23M");
  });
  it("puts a true minus before the currency and takes another currency sign", () => {
    expect(formatMoney(-950)).toBe("−$950");
    expect(formatMoney(-26_600)).toBe("−$26.6K");
    expect(formatMoney(950, "€")).toBe("€950");
  });
});

describe("formatMultiple", () => {
  it("prints two decimals under 1×, one under 10× and none from 10×", () => {
    expect(formatMultiple(0.734)).toBe("0.73×");
    expect(formatMultiple(1)).toBe("1×");
    expect(formatMultiple(2.44)).toBe("2.4×");
    expect(formatMultiple(9.94)).toBe("9.9×");
    expect(formatMultiple(10)).toBe("10×");
    expect(formatMultiple(12.4)).toBe("12×");
  });
});

describe("formatPercent", () => {
  it("prints a ratio as a whole percent unless told the digits", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.1234)).toBe("12%");
    expect(formatPercent(0.1234, 1)).toBe("12.3%");
    expect(formatPercent(1)).toBe("100%");
  });
});

describe("formatDay and formatDayRange", () => {
  it("says a calendar day as month and date, with no clock and no time zone", () => {
    expect(formatDay("2026-11-04")).toBe("Nov 4");
    expect(formatDay("2026-01-31")).toBe("Jan 31");
    expect(formatDay("2026-12-01")).toBe("Dec 1");
  });
  it("names the year only when the two ends differ in it", () => {
    expect(formatDayRange("2026-10-28", "2026-11-26")).toBe("Oct 28 – Nov 26");
    expect(formatDayRange("2025-12-20", "2026-01-04")).toBe("Dec 20, 2025 – Jan 4, 2026");
  });
});

describe("changeRatio", () => {
  it("is the signed share of the change against the base", () => {
    expect(changeRatio(132, 100)).toBeCloseTo(0.32);
    expect(changeRatio(92, 100)).toBeCloseTo(-0.08);
    expect(changeRatio(0, 50)).toBe(-1);
  });
  it("is null only when one side is missing, never NaN", () => {
    expect(changeRatio(10, null)).toBeNull();
    expect(changeRatio(null, 10)).toBeNull();
  });
  it("an earlier figure of zero is a real period: no change from 0 to 0, and a change from nothing has no percentage", () => {
    expect(changeRatio(0, 0)).toBe(0);
    expect(changeRatio(10, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(changeRatio(-3, 0)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("niceTicks", () => {
  it("steps from 0 in clean steps up to at least the max", () => {
    expect(niceTicks(8)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(101)).toEqual([0, 50, 100, 150]);
    expect(niceTicks(0.3)).toEqual([0, 0.1, 0.2, 0.3]);
  });
  it("draws 0 and 1 when there is nothing to scale", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(-5)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });
  it("takes a different target number of steps", () => {
    expect(niceTicks(10, 2)).toEqual([0, 5, 10]);
  });
  it("never steps by less than 1 on an axis that counts things", () => {
    expect(niceTicks(1, 4, true)).toEqual([0, 1]);
    expect(niceTicks(2, 4, true)).toEqual([0, 1, 2]);
    expect(niceTicks(3, 4, true)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(9, 4, true)).toEqual([0, 3, 6, 9]);
    // A larger count keeps its clean steps.
    expect(niceTicks(100, 4, true)).toEqual(niceTicks(100));
  });
});
