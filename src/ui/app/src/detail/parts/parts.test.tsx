/**
 * The shared detail primitives: the relative date formatter (pure, clock and zone injected)
 * and the markup contract of the small components both detail lanes build on.
 */
import { Inbox } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailCard, EmptyState, PersonChip, RelativeTime, SectionHeading, formatDuration, formatExact, formatRelative } from "./index";

const NOW = new Date("2026-09-27T15:00:00Z");
const at = (iso: string) => formatRelative(iso, { now: NOW, timeZone: "UTC" });

describe("formatRelative", () => {
  it("says the last minute as just now", () => {
    expect(at("2026-09-27T14:59:40Z")).toBe("Just now");
  });

  it("counts minutes, then hours, within the same day", () => {
    expect(at("2026-09-27T14:48:00Z")).toBe("12 min ago");
    expect(at("2026-09-27T14:00:30Z")).toBe("59 min ago");
    expect(at("2026-09-27T11:00:00Z")).toBe("4 hr ago");
    expect(at("2026-09-27T00:10:00Z")).toBe("14 hr ago");
  });

  it("uses calendar words past midnight, not a 24-hour window", () => {
    expect(at("2026-09-26T23:30:00Z")).toBe("Yesterday");
    expect(at("2026-09-26T01:00:00Z")).toBe("Yesterday");
    expect(at("2026-09-24T10:00:00Z")).toBe("Thursday");
  });

  it("drops to a short date after a week, with the year only when it is not this year", () => {
    expect(at("2026-09-12T10:00:00Z")).toBe("Sep 12");
    expect(at("2025-10-09T10:00:00Z")).toBe("Oct 9, 2025");
  });

  it("reads calendar days in the zone it is given", () => {
    // 01:00 UTC on the 27th is still the 26th in New York.
    expect(formatRelative("2026-09-27T01:00:00Z", { now: NOW, timeZone: "America/New_York" })).toBe("Yesterday");
    expect(formatRelative("2026-09-27T01:00:00Z", { now: NOW, timeZone: "UTC" })).toBe("14 hr ago");
  });

  it("speaks forwards for a future date", () => {
    expect(at("2026-09-27T15:05:00Z")).toBe("in 5 min");
    expect(at("2026-09-28T09:00:00Z")).toBe("Tomorrow");
  });

  it("drops the capital mid-sentence, but never from a weekday or a month", () => {
    const mid = (iso: string) => formatRelative(iso, { now: NOW, timeZone: "UTC", inSentence: true });
    expect(mid("2026-09-27T14:59:40Z")).toBe("just now");
    expect(mid("2026-09-26T23:30:00Z")).toBe("yesterday");
    expect(mid("2026-09-24T10:00:00Z")).toBe("Thursday");
    expect(mid("2026-09-12T10:00:00Z")).toBe("Sep 12");
  });

  it("returns null for a missing or unreadable value, never 'Invalid Date'", () => {
    expect(at("")).toBeNull();
    expect(formatRelative(null)).toBeNull();
    expect(formatRelative(undefined)).toBeNull();
    expect(at("not a date")).toBeNull();
  });
});

describe("formatExact and formatDuration", () => {
  it("gives the full local time for the tooltip", () => {
    expect(formatExact("2026-09-27T11:18:00Z", { timeZone: "UTC" })).toBe("Sun, Sep 27, 2026, 11:18 AM");
    expect(formatExact("nope")).toBeNull();
  });

  it("says a duration in words", () => {
    expect(formatDuration(20)).toBe("less than a minute");
    expect(formatDuration(8 * 60 + 5)).toBe("8 min");
    expect(formatDuration(3 * 3600)).toBe("3 hr");
    expect(formatDuration(86400)).toBe("1 day");
    expect(formatDuration(3 * 86400)).toBe("3 days");
    expect(formatDuration(Number.NaN)).toBe("less than a minute");
  });
});

describe("RelativeTime", () => {
  it("renders a <time> with the machine value and the exact time in its title", () => {
    const html = renderToStaticMarkup(<RelativeTime iso="2026-09-27T14:48:00Z" now={NOW} timeZone="UTC" />);
    expect(html).toContain('<time dateTime="2026-09-27T14:48:00Z"');
    expect(html).toContain('title="Sun, Sep 27, 2026, 2:48 PM"');
    expect(html).toContain(">12 min ago</time>");
  });

  it("renders the fallback when there is no date", () => {
    expect(renderToStaticMarkup(<RelativeTime iso={null} fallback="Not yet" />)).toBe("Not yet");
  });
});

describe("PersonChip", () => {
  it("shows the name in the normal font beside an initial disc", () => {
    const html = renderToStaticMarkup(<PersonChip name="dux-shell" kind="agent" />);
    expect(html).toContain(">dux-shell<");
    expect(html).toContain(">DS<");
    expect(html).not.toContain("font-mono");
    expect(html).not.toContain("@dux-shell");
  });

  it("draws an agent as a rounded square and a person as a circle", () => {
    expect(renderToStaticMarkup(<PersonChip name="dux-shell" kind="agent" />)).toContain('data-person-disc="agent"');
    const human = renderToStaticMarkup(<PersonChip name="VP" />);
    expect(human).toContain('data-person-disc="human"');
    expect(human).toContain("rounded-full");
  });
});

describe("SectionHeading, DetailCard and EmptyState", () => {
  it("heads a section in sentence case, never uppercase", () => {
    const html = renderToStaticMarkup(<SectionHeading>Acceptance criteria</SectionHeading>);
    expect(html).toContain(">Acceptance criteria</h3>");
    expect(html).not.toContain("uppercase");
    expect(html).toContain("text-text-secondary");
  });

  it("draws a card as a surface with a hairline and a 12px radius, no shadow", () => {
    const html = renderToStaticMarkup(<DetailCard>body</DetailCard>);
    expect(html).toContain("rounded-xl");
    expect(html).toContain("border");
    expect(html).not.toContain("shadow");
  });

  it("says what is empty in one sentence, with an optional action", () => {
    const html = renderToStaticMarkup(
      <EmptyState icon={Inbox} action={<button type="button">Add one</button>}>
        Nothing is connected to this task yet.
      </EmptyState>,
    );
    expect(html).toContain("Nothing is connected to this task yet.");
    expect(html).toContain(">Add one</button>");
    expect(html).toContain("<svg");
  });
});
