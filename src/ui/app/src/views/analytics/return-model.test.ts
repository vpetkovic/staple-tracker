/**
 * The adapter from `RoiResponse` to what the Return lens draws: it prices nothing, so every
 * figure out is a figure in, placed where the page reads it.
 */
import { describe, expect, it } from "vitest";
import type { CostModelValue, RoiLens, RoiResponse, RoiRoleValue } from "@/lib/analytics-api";
import { readCostModel } from "../../../../../core/analytics/home.ts";
import { aiDetail, assumedFigures, assumedWords, currencySymbol, entryDates, peopleWords, returnView, sharePercent, shareWords } from "./return-model";

const MODEL = readCostModel([], null, "/nonexistent-staple-home");

function role(roleId: string, title: string, patch: Partial<RoiRoleValue> = {}): RoiRoleValue {
  return { roleId, title, hourlyRate: 100, hours: 0, value: 0, types: [], tickets: 0, estimatedTickets: null, present: true, share: 1, aiCost: 0, aiEntries: [], ...patch };
}
function lens(name: "measured" | "planned", patch: Partial<RoiLens>): RoiLens {
  return {
    lens: name,
    valueHours: 0,
    value: 0,
    byRole: [],
    aiCost: 0,
    sharedAiCost: 0,
    sharedAiEntries: [],
    director: { hours: 0, hourlyRate: 100, cost: 0 },
    totalCost: 0,
    net: 0,
    returnOnTotalCost: null,
    returnOnAiSpend: null,
    breakEvenRate: null,
    outputMultiplier: null,
    ...patch,
  };
}

/** One workspace, 28 days: engineering did the work, design was found, the writer did nothing but holds an API bill. */
function answer(patch: Partial<RoiResponse> = {}): RoiResponse {
  const writerBill = { id: "docs-api", label: "Docs API", kind: "api" as const, monthlyAmount: 30, quantity: null, cost: 0 };
  return {
    asOf: "2026-11-26T12:00:00.000Z",
    period: { from: "2026-10-30", to: "2026-11-26", tz: "UTC", days: 28, bucket: "day", explicit: true, firstActivity: "2026-09-01", lastActivity: "2026-11-26" },
    scope: { kind: "workspace", workspaces: [{ slug: "staple", prefix: "STA", available: true }] },
    model: MODEL,
    measured: lens("measured", {
      valueHours: 50,
      value: 4950,
      byRole: [
        role("software-engineer", "Software Engineer", { hours: 40, value: 4000, tickets: 12, share: 0.5, types: ["engineering"], aiCost: 46.67, aiEntries: [{ id: "seat", label: "Copilot", kind: "subscription", monthlyAmount: 50, quantity: 2, cost: 46.67 }] }),
        role("design-engineer", "Design Engineer", { hourlyRate: 95, hours: 10, value: 950, tickets: 3, share: 0.25, types: ["design"] }),
        role("technical-writer", "Technical Writer", { hourlyRate: 70, present: false, share: 0, aiEntries: [writerBill] }),
      ],
      aiCost: 109.33,
      sharedAiCost: 62.66,
      sharedAiEntries: [{ id: "ai-plan", label: "AI subscription", kind: "subscription", monthlyAmount: 200, quantity: 1, cost: 62.66 }],
      director: { hours: 96, hourlyRate: 100, cost: 9600 },
      totalCost: 9709.33,
      net: -4759.33,
      returnOnTotalCost: 0.51,
      breakEvenRate: 194.19,
      outputMultiplier: 0.52,
    }),
    planned: lens("planned", {
      valueHours: 70,
      value: 6900,
      // Planned lists its roles in its own order; the adapter joins by id.
      byRole: [role("design-engineer", "Design Engineer", { hourlyRate: 95, hours: 20, value: 1900, tickets: 3, estimatedTickets: 2 }), role("software-engineer", "Software Engineer", { hours: 50, value: 5000, tickets: 12, estimatedTickets: 9 })],
      totalCost: 9709.33,
      net: -2809.33,
      returnOnTotalCost: 0.71,
      outputMultiplier: 0.73,
    }),
    basis: { aiSpendHub: 400, directorHoursHub: 288, activeDaysHub: 36, hoursPerActiveDay: 8, share: 0.333, scopeAgentHours: 50, hubAgentHours: 150 },
    agentTypes: [],
    fallbacks: [],
    caveats: [{ code: "estimates_partial", count: 4, of: 15 }, { code: "default_cost_model", count: 5, of: 5 }],
    ...patch,
  };
}

describe("returnView", () => {
  it("lists the roles that did work in the server's order, and names the rest from the role list", () => {
    const view = returnView(answer());
    expect(view.roles.map((row) => row.roleId)).toEqual(["software-engineer", "design-engineer"]);
    expect(view.absent.map((row) => row.roleId)).toEqual(["technical-writer"]);
    expect(view.all.map((row) => row.roleId)).toEqual(["software-engineer", "design-engineer", "technical-writer"]);
  });

  it("joins the two lenses by role and carries each role's figures as the server gave them", () => {
    const [engineer, designer] = returnView(answer()).roles;
    expect(engineer).toMatchObject({ rate: 100, measuredHours: 40, plannedHours: 50, measuredValue: 4000, plannedValue: 5000, tickets: 12, estimatedTickets: 9, share: 0.5, aiCost: 46.67, present: true, types: ["engineering"] });
    expect(engineer?.aiLines).toEqual([{ id: "seat", label: "Copilot", kind: "subscription", perMonth: 50, quantity: 2, cost: 46.67 }]);
    expect(designer).toMatchObject({ rate: 95, measuredHours: 10, plannedHours: 20, plannedValue: 1900, estimatedTickets: 2, share: 0.25 });
  });

  it("keeps an absent role's lines, at the cost the server gave (nothing)", () => {
    const writer = returnView(answer()).absent[0];
    expect(writer).toMatchObject({ present: false, aiCost: 0, rate: 70, tickets: 0 });
    expect(writer?.aiLines).toEqual([{ id: "docs-api", label: "Docs API", kind: "api", perMonth: 30, quantity: null, cost: 0 }]);
  });

  it("prints the headline figures from the lenses, the cost from the measured lens, and the scope's share", () => {
    const view = returnView(answer());
    expect(view.measured).toEqual({ hours: 50, value: 4950, multiple: 0.51, net: -4759.33, leverage: 0.52, fte: 50 / (4 * 40) });
    expect(view.planned).toEqual({ hours: 70, value: 6900, multiple: 0.71, net: -2809.33, leverage: 0.73, fte: 70 / (4 * 40) });
    expect(view).toMatchObject({ cost: 9709.33, aiSpend: 109.33, breakEvenRate: 194.19, share: 0.333, hub: false, scope: "staple", sign: "$", currency: "USD", mode: "solo" });
    expect(view.director).toEqual({ hours: 96, rate: 100, cost: 9600, activeDays: 36, hoursPerActiveDay: 8 });
    expect(view.shared).toEqual({ cost: 62.66, lines: [{ id: "ai-plan", label: "AI subscription", kind: "subscription", perMonth: 200, quantity: 1, cost: 62.66 }] });
  });

  it("has no planned side when no finished ticket carries an estimate", () => {
    expect(returnView(answer({ planned: lens("planned", { valueHours: 0 }) })).planned).toBeNull();
  });

  it("counts the estimates from the caveat, and from the rows when there is none", () => {
    expect(returnView(answer()).estimates).toEqual({ covered: 11, total: 15 });
    expect(returnView(answer({ caveats: [] })).estimates).toEqual({ covered: 11, total: 15 });
  });

  it("keys the caveats by code", () => {
    const view = returnView(answer({ caveats: [{ code: "no_ai_spend", count: 1, of: null }] }));
    expect(view.caveats.no_ai_spend).toEqual({ code: "no_ai_spend", count: 1, of: null });
    expect(view.caveats.estimates_partial).toBeUndefined();
  });

  it("shows a renamed role at once, but prices and words the figures with the profile the server read", () => {
    const edited: CostModelValue = {
      ...MODEL.model,
      roles: { ...MODEL.model.roles, roles: MODEL.model.roles.roles.map((row) => (row.id === "design-engineer" ? { ...row, title: "Designer" } : row)) },
      scenario: { ...MODEL.model.scenario, mode: "company", currency: "EUR" },
    };
    const view = returnView(answer(), edited);
    expect(view.roles[1]?.title).toBe("Designer");
    expect(view).toMatchObject({ mode: "solo", currency: "USD", sign: "$" });
  });

  it("names the role a missing role's hours are priced at", () => {
    const view = returnView(answer({ fallbacks: [{ type: "design", rule: null, missingRoleId: "gone", usedRoleId: "software-engineer" }, { type: null, rule: 2, missingRoleId: "gone", usedRoleId: "software-engineer" }] }));
    expect(view.fallbacks).toEqual([
      { missingRoleId: "gone", usedTitle: "Software Engineer", type: "design", rule: null },
      { missingRoleId: "gone", usedTitle: "Software Engineer", type: null, rule: 2 },
    ]);
  });

  it("names the hub all workspaces", () => {
    expect(returnView(answer({ scope: { kind: "hub", workspaces: [] } }))).toMatchObject({ hub: true, scope: "all workspaces" });
  });
});

describe("the words around the figures", () => {
  it("an AI line's arithmetic carries the share only on one workspace", () => {
    const lines = returnView(answer()).roles[0]!.aiLines;
    expect(aiDetail(lines, "$", 0.5, "its agent time")).toBe("Copilot $50 × 2 a month × 50% of its agent time");
    expect(aiDetail(lines, "$", null, "its agent time")).toBe("Copilot $50 × 2 a month");
    expect(aiDetail([{ id: "b", label: "API", kind: "api", perMonth: 230, quantity: null, cost: 1 }], "$", 1, "x")).toBe("API $230 a month");
  });

  it("assumed figures are the profile's own list, for roles and entries that still exist", () => {
    const model = MODEL.model;
    expect(assumedFigures(model)).toEqual(model.solo.assumed);
    const trimmed: CostModelValue = { ...model, roles: { ...model.roles, roles: model.roles.roles.slice(0, 1) }, solo: { ...model.solo, entries: [] } };
    expect(assumedFigures(trimmed)).toEqual(["director.hourlyRate", "director.hoursPerActiveDay", "roles.software-engineer.hourlyRate"]);
    expect(assumedWords(assumedFigures(model), "your")).toEqual(["your hourly rate", "your hours a day", "AI spend", "role rates"]);
    expect(assumedWords(["roles.x.hourlyRate"], "your")).toEqual(["role rates"]);
  });

  it("an entry's months, when it does not cover every month", () => {
    expect(entryDates({ from: "2000-01", to: null })).toBeNull();
    expect(entryDates({ from: "2026-03", to: null })).toBe("from Mar 2026");
    expect(entryDates({ from: "2026-03", to: "2026-06" })).toBe("Mar 2026 to Jun 2026");
    expect(entryDates({ from: "2000-01", to: "2026-06" })).toBe("until Jun 2026");
    expect(entryDates({ from: "2026-03", to: "2026-03" })).toBe("Mar 2026");
  });

  it("writes a currency with its sign", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("XQZ")).toBe("XQZ");
  });
});

describe("small figures are not said as nothing", () => {
  it("a share under 10% keeps a decimal, and a trace is said as under 0.1%", () => {
    expect(sharePercent(0.34)).toBe("34%");
    expect(sharePercent(0.0054)).toBe("0.5%");
    expect(sharePercent(0.0001)).toBe("under 0.1%");
    expect(sharePercent(0)).toBe("0%");
    expect(shareWords(0.0054, "agent time")).toBe(" × 0.5% of agent time");
  });

  it("a team smaller than a twentieth of a person is said as under 0.1, never as 0", () => {
    expect(peopleWords(2.74)).toBe("2.7");
    expect(peopleWords(0.026)).toBe("under 0.1");
    expect(peopleWords(0)).toBe("0");
  });
});
