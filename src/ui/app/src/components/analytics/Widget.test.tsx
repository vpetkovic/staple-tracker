/**
 * The widget frame and the four states it owns. A state replaces the body and keeps the frame
 * (title, the section's name, the held height), so a page never jumps when data arrives.
 *
 * Markup only, as everywhere in this suite (no jsdom). Pressing the Table switch is checked in a
 * real browser in `widgets-browser.test.tsx`; here is what each state draws.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoverageNote, Widget, type WidgetState } from "./Widget";

const table = { columns: ["Day", "Hours"], rows: [["Nov 4", 12.25]] } as const;
const render = (state?: WidgetState, extra: Partial<Parameters<typeof Widget>[0]> = {}) =>
  renderToStaticMarkup(
    <Widget title="Agent time" sentence="Agents worked 633 hours." state={state} help="How it is counted." coverage={{ covered: 248, total: 346, noun: "finished tickets", have: "have an estimate" }} table={table} minBodyHeight={150} {...extra}>
      <div data-body>the chart</div>
    </Widget>,
  );

describe("each state draws its own body inside the same frame", () => {
  it("ready: the sentence, the body, the coverage note, the help and the Table switch", () => {
    const html = render();
    expect(html).toContain('aria-label="Agent time"');
    expect(html).toContain('data-state="ready"');
    expect(html).toContain("Agents worked 633 hours.");
    expect(html).toContain("data-body");
    expect(html).toContain("data-coverage");
    expect(html).toContain("What does this mean?");
    expect(html).toContain('aria-label="Show Agent time as a table"');
    expect(html).not.toContain("min-height:150px");
  });

  it("loading: a polite status that names the widget, no body, and the held height", () => {
    const html = render({ kind: "loading" });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading Agent time");
    // Held twice: on the body, and on the state's own box so its full-height layout resolves.
    expect(html.match(/min-height:150px/g)).toHaveLength(2);
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(2);
    expect(html.match(/motion-reduce:animate-none/g)).toHaveLength(2);
    expect(html).not.toContain("data-body");
  });

  it("empty: its own words and hint instead of the body", () => {
    const html = render({ kind: "empty", title: "No finished tickets yet", hint: "Close a ticket to see it here." });
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("No finished tickets yet");
    expect(html).toContain("Close a ticket to see it here.");
    expect(html.match(/min-height:150px/g)).toHaveLength(2);
    expect(html).not.toContain("data-body");
  });

  it("error: an alert with the message, and Try again only when there is a retry", () => {
    const withRetry = render({ kind: "error", message: "The server said 500.", onRetry: () => {} });
    expect(withRetry).toContain('data-state="error"');
    expect(withRetry).toContain('role="alert"');
    expect(withRetry).toContain("This could not be loaded");
    expect(withRetry).toContain("The server said 500.");
    expect(withRetry).toContain("Try again");
    expect(withRetry.match(/min-height:150px/g)).toHaveLength(2);
    expect(withRetry).not.toContain("data-body");
    expect(render({ kind: "error", message: "The server said 500." })).not.toContain("Try again");
  });

  it("every state that is not ready drops the sentence, the Table switch, the coverage and the help", () => {
    for (const state of [{ kind: "loading" }, { kind: "empty", title: "Nothing" }, { kind: "error", message: "No" }] as const) {
      const html = render(state);
      expect(html, state.kind).toContain("<h3");
      expect(html, state.kind).toContain("Agent time");
      expect(html, state.kind).not.toContain("Agents worked 633 hours.");
      expect(html, state.kind).not.toContain("as a table");
      expect(html, state.kind).not.toContain("data-coverage");
      expect(html, state.kind).not.toContain("What does this mean?");
    }
  });
});

describe("the Table switch", () => {
  it("appears only when the widget has a table twin", () => {
    expect(render(undefined, { table: undefined })).not.toContain("as a table");
  });

  it("is a toggle button with a name, a focus ring and a 32px tap area at its desk size", () => {
    const button = /<button[^>]*aria-pressed[^>]*>/.exec(render())?.[0] ?? "";
    expect(button).toContain('aria-pressed="false"');
    expect(button).toContain("focus-ring");
    // 24px drawn (size-6) and a 4px invisible ring on every side (before:-inset-1): 32px.
    expect(button).toContain("size-6");
    expect(button).toContain("min-h-0");
    expect(button).toContain("before:-inset-1");
  });
});

describe("the coverage note", () => {
  it("says the share in words and as a figure when part of the data is covered", () => {
    const html = renderToStaticMarkup(<CoverageNote coverage={{ covered: 248, total: 346, noun: "finished tickets", have: "have an estimate" }} />);
    expect(html).toContain("Partial: 248 of 346 finished tickets have an estimate (72%)");
  });

  it("is absent when everything is covered, and when there is nothing to cover", () => {
    expect(renderToStaticMarkup(<CoverageNote coverage={{ covered: 346, total: 346, noun: "tickets", have: "have one" }} />)).toBe("");
    expect(renderToStaticMarkup(<CoverageNote coverage={{ covered: 0, total: 0, noun: "tickets", have: "have one" }} />)).toBe("");
    expect(render(undefined, { coverage: { covered: 5, total: 5, noun: "tickets", have: "have one" } })).not.toContain("data-coverage");
  });

  it("is present at one short of the total", () => {
    expect(renderToStaticMarkup(<CoverageNote coverage={{ covered: 345, total: 346, noun: "tickets", have: "have one" }} />)).toContain("345 of 346");
  });
});
