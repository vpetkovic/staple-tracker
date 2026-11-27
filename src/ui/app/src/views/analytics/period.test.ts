/**
 * The page's period as the query every Analytics read takes: presets become calendar days ending
 * today, a custom range passes through, and "all time" names no start.
 */
import { describe, expect, it } from "vitest";
import { daysBefore, toQuery, todayKey } from "./period";

const TODAY = "2026-11-26";

describe("a period preset as days", () => {
  it("counts the last 7, 30 and 90 days back from today, today included", () => {
    expect(toQuery({ preset: "7d" }, "", TODAY)).toEqual({ scope: "hub", from: "2026-11-20", to: TODAY });
    expect(toQuery({ preset: "30d" }, "", TODAY)).toEqual({ scope: "hub", from: "2026-10-28", to: TODAY });
    expect(toQuery({ preset: "90d" }, "", TODAY)).toEqual({ scope: "hub", from: "2026-08-29", to: TODAY });
  });

  it("starts this year on January 1st", () => {
    expect(toQuery({ preset: "ytd" }, "", TODAY)).toEqual({ scope: "hub", from: "2026-01-01", to: TODAY });
    expect(toQuery({ preset: "ytd" }, "", "2027-01-01")).toEqual({ scope: "hub", from: "2027-01-01", to: "2027-01-01" });
  });

  it("crosses a year boundary, and a leap day, on the calendar", () => {
    expect(toQuery({ preset: "7d" }, "", "2027-01-03")).toEqual({ scope: "hub", from: "2026-12-28", to: "2027-01-03" });
    expect(toQuery({ preset: "30d" }, "", "2028-03-01").from).toBe("2028-02-01");
    expect(toQuery({ preset: "30d" }, "", "2026-03-01").from).toBe("2026-01-31");
    expect(daysBefore("2028-03-01", 1)).toBe("2028-02-29");
    expect(daysBefore("2026-03-01", 1)).toBe("2026-02-28");
  });

  it("sends no start for all time, so the server begins at the first activity", () => {
    const query = toQuery({ preset: "all" }, "", TODAY);
    expect(query).toEqual({ scope: "hub", to: TODAY });
    expect("from" in query).toBe(false);
  });
});

describe("a custom range and the workspace", () => {
  it("passes a custom range through as it was chosen", () => {
    expect(toQuery({ preset: "custom", from: "2026-09-21", to: "2026-10-05" }, "", TODAY)).toEqual({ scope: "hub", from: "2026-09-21", to: "2026-10-05" });
  });

  it("falls back to the last 30 days when a custom range is missing an end", () => {
    expect(toQuery({ preset: "custom", from: "2026-09-21" }, "", TODAY)).toEqual({ scope: "hub", from: "2026-10-28", to: TODAY });
  });

  it("asks for one workspace by its slug, and for the hub with none chosen", () => {
    expect(toQuery({ preset: "30d" }, "staple", TODAY).scope).toBe("staple");
    expect(toQuery({ preset: "30d" }, "", TODAY).scope).toBe("hub");
  });

  it("reads today as the browser's own calendar day", () => {
    expect(todayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(todayKey(new Date(2026, 11, 31, 0, 1))).toBe("2026-12-31");
  });
});
