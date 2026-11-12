import React from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SessionContext } from "../src/ui/app/src/lib/session.js";
import { fakeSession } from "../src/ui/app/src/views/fake-session.js";
import { NavRail } from "../src/ui/app/src/components/nav/NavRail.js";
import { ViewTabBar } from "../src/ui/app/src/components/nav/ViewTabBar.js";
import { FilterMenuBody } from "../src/ui/app/src/components/filters/FilterMenu.js";
import { buildCommands } from "../src/ui/app/src/components/command-palette/commands.js";
import { PlanView } from "../src/ui/app/src/views/plan/PlanView.js";
import { groupByOptions } from "../src/ui/app/src/lib/view-prefs.js";
import { emptyFilters } from "../src/ui/app/src/lib/filters.js";
import { SETTING_CATEGORIES, SETTING_DEFINITIONS } from "../src/core/settings-registry.js";

it("OFF removes Plan navigation and its lenses; ON restores navigation", () => {
  for (const planningEnabled of [false, true]) {
    const markup = renderToStaticMarkup(<SessionContext.Provider value={fakeSession({ planningEnabled })}><ViewTabBar /><NavRail onHide={() => {}} /></SessionContext.Provider>);
    expect(markup.includes('data-view-tab="plan"')).toBe(planningEnabled);
    expect(markup.includes('data-nav-view="plan"')).toBe(planningEnabled);
  }
  const off = renderToStaticMarkup(<SessionContext.Provider value={fakeSession({ planningEnabled: false })}><PlanView onAuthError={() => {}} /></SessionContext.Provider>);
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

it("Settings labels the person-controlled planning toggle experimental", () => {
  expect(SETTING_CATEGORIES.find(c => c.id === "features")?.label).toBe("Experimental");
  expect(SETTING_DEFINITIONS.find(d => d.key === "features.planning")).toMatchObject({ default: false, scope: "workspace", ui: { control: "toggle", label: "Planning (experimental)" } });
});

it("OFF removes the Horizon grouping axis and ON restores it", () => {
  expect(groupByOptions(false).some(o => o.id === "horizon")).toBe(false);
  expect(groupByOptions(true).some(o => o.id === "horizon")).toBe(true);
});
