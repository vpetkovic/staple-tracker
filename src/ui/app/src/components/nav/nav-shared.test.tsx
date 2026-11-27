/**
 * What the rail and the More sheet share: the corner badge's two states, the marks' one
 * register, and that every view row goes through `navigateTo`. Pure
 * helpers and presentational marks, so no session and no DOM.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AttentionMark, MARK_CLASS, PendingMark, countBadgeClass, pendingWords, railFocusSelector } from "./nav-shared";

describe("the corner badge", () => {
  it("is quiet by default: the selected tint laid on the surface it sits on, foreground text", () => {
    const rail = countBadgeClass(false, "sidebar");
    expect(rail).toContain("bg-sidebar");
    expect(rail).toContain("ring-sidebar");
    expect(rail).toContain("from-surface-selected");
    expect(rail).toContain("text-foreground");
    expect(rail).not.toContain("--badge-fresh");
    expect(countBadgeClass(false, "card")).toContain("ring-card");
  });

  it("takes the accent, with the page colour as its text, only when something in it is new", () => {
    const fresh = countBadgeClass(true, "sidebar");
    expect(fresh).toContain("bg-[var(--badge-fresh)]");
    expect(fresh).toContain("text-background");
    expect(fresh).not.toContain("from-surface-selected");
    // The solid accent replaces the surface: the two never fight over the background colour.
    expect(fresh).not.toContain("bg-sidebar");
  });
});

describe("the marks' register", () => {
  it("is right-aligned, label size, tabular and tertiary", () => {
    for (const cls of ["ml-auto", "text-label", "tabular-nums", "text-text-tertiary"]) expect(MARK_CLASS).toContain(cls);
  });

  it("says Settings' waiting join requests as the accent dot and the number, named in words", () => {
    const two = renderToStaticMarkup(<PendingMark pending={2} />);
    expect(two).toContain('data-settings-badge="2"');
    expect(two).toContain('aria-label="2 join requests waiting"');
    expect(two).toMatch(/bg-\[var\(--status-task-in_progress\)\][^>]*><\/span><span aria-hidden="true">2<\/span>/);
    expect(renderToStaticMarkup(<PendingMark pending={1} />)).toContain('aria-label="1 join request waiting"');
    expect(renderToStaticMarkup(<PendingMark pending={0} />)).toBe("");
    expect(pendingWords(0)).toBeNull();
  });

  it("marks Settings' count and the Integrations dot as marks, so they dim with the rest while reconnecting", () => {
    expect(renderToStaticMarkup(<PendingMark pending={2} />)).toMatch(/^<span[^>]* data-nav-mark="true"/);
    expect(renderToStaticMarkup(<AttentionMark />)).toMatch(/^<span[^>]* data-nav-mark="true"/);
  });
});

describe("where the focus goes when the rail changes width", () => {
  /** An element whose `closest` answers from the attributes it and its ancestors carry. */
  const at = (attributes: Record<string, string>) => ({
    closest: (selector: string) => {
      const names = [...selector.matchAll(/\[([a-z-]+)/g)].map((match) => match[1]!);
      const hit = names.find((name) => name in attributes);
      return hit ? ({ getAttribute: (name: string) => attributes[name] ?? null } as unknown as Element) : null;
    },
  });

  it("goes to the same row, the head, Settings, Integrations or the theme in the other shape", () => {
    expect(railFocusSelector(at({ "data-nav-item": "view:graph" }))).toBe('[data-nav-item="view:graph"]');
    expect(railFocusSelector(at({ "data-workspace-switcher": "head" }))).toBe('[data-workspace-switcher="head"]');
    expect(railFocusSelector(at({ "data-nav-settings": "true" }))).toBe("[data-nav-settings]");
    expect(railFocusSelector(at({ "data-nav-integrations": "true" }))).toBe("[data-nav-integrations]");
    expect(railFocusSelector(at({ "data-nav-theme": "" }))).toBe("[data-nav-theme]");
  });

  it("takes a sub-row or a row's action to its parent row, and anything else to the fallback", () => {
    for (const hook of ["data-nav-project", "data-nav-project-settings", "data-nav-action"]) {
      expect(railFocusSelector(at({ [hook]: "p-1" }))).toBe('[data-nav-item="view:tree"]');
    }
    for (const hook of ["data-nav-run", "data-nav-run-more"]) {
      expect(railFocusSelector(at({ [hook]: "r-1" }))).toBe('[data-nav-item="view:autopilot"]');
    }
    expect(railFocusSelector(at({}))).toBe("");
  });
});

describe("where a navigation row goes", () => {
  it("is navigateTo on every row of the full rail, the narrow rail, the tab bar and the More sheet", () => {
    // The clicks cannot run without a DOM; what is pinned is that no row goes around the one way to a view.
    const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    const rail = source("./NavRail.tsx");
    // The full rail's records and foot, the narrow rail's rows, its Inbox and Autopilot, and the top rows.
    expect(rail.match(/navigateTo\(session, entry\.view\)/g)).toHaveLength(2);
    expect(rail).toContain("navigateTo(session, inbox.view)");
    expect(rail).toContain("navigateTo(session, autopilot.view)");
    expect(rail).toContain("onSelect={(view) => navigateTo(session, view)}");
    const sheet = source("./ViewTabBar.tsx");
    expect(sheet).toContain("onSelect={(view) => navigateTo(session, view)}");
    expect(sheet.match(/navigateTo\(session, view\)/g)).toHaveLength(2);
    for (const text of [rail, sheet]) {
      expect(text).not.toMatch(/session\.setView\(/);
      expect(text).not.toMatch(/session\.showAllTasks\(/);
    }
  });
});
