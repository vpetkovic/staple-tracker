import React from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SessionContext } from "../src/ui/app/src/lib/session.js";
import { fakeSession } from "../src/ui/app/src/views/fake-session.js";
import { NavRail } from "../src/ui/app/src/components/nav/NavRail.js";
import { MoreSheetRows, ViewTabBar } from "../src/ui/app/src/components/nav/ViewTabBar.js";
import { AttentionContext } from "../src/ui/app/src/lib/attention.js";
import { FilterMenuBody } from "../src/ui/app/src/components/filters/FilterMenu.js";
import { buildCommands } from "../src/ui/app/src/components/command-palette/commands.js";
import { PlanView } from "../src/ui/app/src/views/plan/PlanView.js";
import { groupByOptions } from "../src/ui/app/src/lib/view-prefs.js";
import { emptyFilters } from "../src/ui/app/src/lib/filters.js";
import { SETTING_CATEGORIES, SETTING_DEFINITIONS } from "../src/core/settings-registry.js";

it("OFF removes Plan navigation and its lenses; ON restores navigation", () => {
  for (const planningEnabled of [false, true]) {
    const attention = { data: { rows: [], workspaces: [], failed: [], now: "2026-11-26T12:00:00.000Z" }, error: undefined, loading: false, reload: () => {} };
    const markup = renderToStaticMarkup(<SessionContext.Provider value={fakeSession({ planningEnabled })}><AttentionContext value={attention}><ViewTabBar /><NavRail mode="full" /><MoreSheetRows view="tree" planningEnabled={planningEnabled} onChoose={() => {}} /></AttentionContext></SessionContext.Provider>);
    // The phone reaches Plan through the tab bar's More sheet; the bar itself holds four views and More.
    expect(markup.includes('data-view-tab="plan"')).toBe(false);
    expect(markup.includes('data-more-view="plan"')).toBe(planningEnabled);
    expect(markup.includes('data-nav-item="view:plan"')).toBe(planningEnabled);
  }
  const off = renderToStaticMarkup(<SessionContext.Provider value={fakeSession({ planningEnabled: false, mode: "hub", ws: "", workspaces: [{ slug: "larkspur", prefix: "LAR" }, { slug: "larkspur-sandbox", prefix: "SAN" }] })}><PlanView onAuthError={() => {}} /></SessionContext.Provider>);
  expect(off).not.toMatch(/data-plan-|Ideas|Horizons|Timeline|Enable planning/);
});

it("OFF removes palette navigation and lifecycle writes even with a stale selected plan record", () => {
  for (const planningEnabled of [false, true]) {
    const commands = buildCommands({ planningEnabled, selection: { workspace: "larkspur", ref: "idea" }, planRecord: { id: "idea", title: "Larkspur idea", promoted: false, actions: [{ id: "promote", label: "Promote", who: "anyone", disabledReason: null }] }, view: "tree", ws: "larkspur", assignee: "", workspaces: [{ slug: "larkspur", prefix: "LAR" }], hub: false });
    expect(commands.some(c => c.id === "view:plan")).toBe(planningEnabled);
    expect(commands.some(c => c.action.type === "plan")).toBe(planningEnabled);
  }
});

it("OFF removes the Horizon filter even when old row data survives; ON restores it", () => {
  for (const planningEnabled of [false, true]) {
    const markup = renderToStaticMarkup(<SessionContext.Provider value={fakeSession({ planningEnabled })}><FilterMenuBody rows={[]} state={emptyFilters()} page={null} onPage={() => {}} onChange={() => {}} /></SessionContext.Provider>);
    expect(markup.includes('data-filter-dimension="horizon"')).toBe(planningEnabled);
  }
});

it("Settings shows the person-controlled planning toggle under Features, labelled nowhere experimental", () => {
  expect(SETTING_CATEGORIES.find(c => c.id === "features")?.label).toBe("Features");
  expect(SETTING_CATEGORIES.some(c => /experimental/i.test(`${c.label} ${c.description}`))).toBe(false);
  // The default stays off for a workspace that never stored the key; a new one stores it on at init.
  expect(SETTING_DEFINITIONS.find(d => d.key === "features.planning")).toMatchObject({ default: false, scope: "workspace", ui: { control: "toggle", label: "Planning", resettable: false } });
  expect(SETTING_DEFINITIONS.filter(d => /experimental/i.test(`${d.ui?.label ?? ""} ${d.ui?.description ?? ""}`)).map(d => d.key)).toEqual([]);
});

it("OFF removes the Horizon grouping axis and ON restores it", () => {
  expect(groupByOptions(false).some(o => o.id === "horizon")).toBe(false);
  expect(groupByOptions(true).some(o => o.id === "horizon")).toBe(true);
});

it("the hidden Plan URL rewrites to the Tasks view actually shown and drops its lens", async () => {
  const { withShellState } = await import("../src/ui/app/src/lib/session-url.js");
  const state = { ws: "larkspur", view: "plan" as const, filters: emptyFilters(), focus: null };
  const off = new URL(withShellState("http://larkspur.test/?view=plan&plan-lens=timeline", state, { planningEnabled: false }));
  expect(off.searchParams.get("view")).toBe("tasks"); expect(off.searchParams.has("plan-lens")).toBe(false);
  const on = new URL(withShellState("http://larkspur.test/?view=plan&plan-lens=timeline", state, { planningEnabled: true }));
  expect(on.searchParams.get("view")).toBe("plan"); expect(on.searchParams.get("plan-lens")).toBe("timeline");
});
