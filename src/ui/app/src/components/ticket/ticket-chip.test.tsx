/**
 * The ticket chip and RefText, rendered to markup: what is a button and what is not, the
 * accessible name, the deleted fallback, and which references in a sentence become chips.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { statusLabel } from "@/lib/settings";
import type { RunIssue } from "@/lib/types";
import { issueOf, RefText, TicketChip } from "./TicketChip";

const issue = (over: Partial<RunIssue> = {}): RunIssue => ({
  issueId: "i-1",
  identifier: "STA-1",
  title: "Fix the thing",
  status: "in_progress",
  category: "active",
  kind: "task",
  ...over,
});

const open = () => {};

describe("TicketChip", () => {
  it("is one button named by its identifier, title and status, with the full title on hover", () => {
    const html = renderToStaticMarkup(<TicketChip issue={issue()} fallbackRef="STA-1" onOpen={open} />);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(`aria-label="STA-1: Fix the thing, ${statusLabel("in_progress")}"`);
    expect(html).toContain('title="Fix the thing"');
    expect(html).toContain(">Fix the thing</span>");
  });

  it("is not a button without onOpen", () => {
    const html = renderToStaticMarkup(<TicketChip issue={issue()} fallbackRef="STA-1" />);
    expect(html).not.toContain("<button");
    expect(html).toContain("STA-1");
  });

  it("prints a deleted issue's reference with 'deleted' and offers nothing to open", () => {
    const html = renderToStaticMarkup(<TicketChip issue={null} fallbackRef="STA-9" onOpen={open} />);
    expect(html).not.toContain("<button");
    expect(html).toContain("STA-9");
    expect(html).toContain("deleted");
  });

  it("inline prints the glyph and identifier only", () => {
    const html = renderToStaticMarkup(<TicketChip issue={issue()} fallbackRef="STA-1" onOpen={open} variant="inline" />);
    expect(html).not.toContain(">Fix the thing</span>");
    expect(html).toContain("STA-1");
    expect(html).toContain('data-variant="inline"');
  });
});

describe("RefText", () => {
  const issues = [issue(), issue({ issueId: "i-2", identifier: "AB2-40", title: "Other" })];

  it("turns every reference to a known issue into an inline chip and leaves the rest as text", () => {
    const html = renderToStaticMarkup(<RefText text="STA-1 and AB2-40 failed, STA-7 did not" issues={issues} onOpen={open} />);
    expect(html.match(/data-ticket-chip=/g)).toHaveLength(2);
    expect(html).toContain('data-ticket-chip="STA-1"');
    expect(html).toContain('data-ticket-chip="AB2-40"');
    expect(html).toContain("STA-7 did not");
  });

  it("matches whole identifiers only", () => {
    const html = renderToStaticMarkup(<RefText text="XSTA-1 and STA-12 and STA-1x" issues={issues} onOpen={open} />);
    expect(html).not.toContain("data-ticket-chip");
  });
});

describe("issueOf", () => {
  it("finds an issue by id and tolerates an entry without issues", () => {
    expect(issueOf({ issues: [issue()] }, "i-1")?.identifier).toBe("STA-1");
    expect(issueOf({ issues: [issue()] }, "nope")).toBeNull();
    expect(issueOf({} as { issues?: RunIssue[] }, "i-1")).toBeNull();
  });
});
