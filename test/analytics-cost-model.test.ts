/**
 * The cost model's pure parts: the agent-type derivation on real-shaped attempt data, the
 * validation every part goes through, the day-prorated AI spend, the ROI arithmetic, and the
 * calendar arithmetic the analytics read rests on.
 *
 * Agent names below are spellings found on the maintainers' hub (2026-11-26 snapshot):
 * `autopilot`, `fable-r1a` (shipped a schema change), `sta222-writer` (wrote a spike's spec),
 * `d4-docs`, `claude-design-skill`, `fxi-orchestrator` (a worker-lane identity), `PlanBuilder`.
 */
import { describe, expect, it } from "vitest";
import { deriveAgentType, globMatches, type AgentTypeInput } from "../src/core/analytics/agent-type.js";
import {
  DEFAULT_COST_MODEL,
  activeProfile,
  aiSpendFor,
  costModelPartProblem,
  monthlyCostOf,
  resolveRoles,
  roi,
  spendCovers,
  type AiSpendEntry,
  type CostModel,
} from "../src/core/analytics/cost-model.js";
import { Zone, eachDate } from "../src/core/analytics/local-time.js";

const input = (over: Partial<AgentTypeInput>): AgentTypeInput => ({
  agent: "autopilot",
  role: "worker",
  workspace: "STA",
  kind: "task",
  labels: [],
  title: "fix(ui): Enter on a control acts only on that control",
  ...over,
});

describe("agent type derivation", () => {
  it("reads free-form names and titles the way their work was", () => {
    expect(deriveAgentType(input({ agent: "autopilot" }))).toEqual({ type: "engineering", roleId: null, reason: { code: "default", detail: null } });
    expect(deriveAgentType(input({ agent: "fable-r1a", title: "R1a: ship and install a schema-6 runtime" })).type).toBe("engineering");
    expect(deriveAgentType(input({ agent: "sta222-writer", kind: "spike", title: "S1.1: define active wall review blocked and orchestration time" }))).toEqual({
      type: "research",
      roleId: null,
      reason: { code: "kind", detail: "spike" },
    });
    expect(deriveAgentType(input({ agent: "d4-docs", title: "D4: tell the npx story" }))).toEqual({ type: "documentation", roleId: null, reason: { code: "agent_name", detail: "docs" } });
    expect(deriveAgentType(input({ agent: "claude-design-skill" }))).toEqual({ type: "design", roleId: null, reason: { code: "agent_name", detail: "design" } });
    expect(deriveAgentType(input({ agent: "PlanBuilder", title: "Redesign the Plan view and idea drawer" }))).toEqual({ type: "design", roleId: null, reason: { code: "title", detail: "redesign" } });
    expect(deriveAgentType(input({ title: "Docs, README and website refresh" }))).toEqual({ type: "documentation", roleId: null, reason: { code: "title", detail: "docs" } });
  });

  it("decides orchestration by the lane, never by a name", () => {
    expect(deriveAgentType(input({ agent: "fxi-orchestrator" })).type).toBe("engineering");
    expect(deriveAgentType(input({ agent: "anyone", role: "orchestrator" }))).toEqual({ type: "orchestration", roleId: null, reason: { code: "orchestrator_lane", detail: null } });
  });

  it("reads a label before the agent name and the title", () => {
    expect(deriveAgentType(input({ agent: "d4-docs", labels: ["clickup-mirrored", "area:design"] }))).toEqual({ type: "design", roleId: null, reason: { code: "label", detail: "area:design" } });
    // `frontend` names no kind of work: frontend engineering is engineering.
    expect(deriveAgentType(input({ labels: ["frontend", "p2"] })).type).toBe("engineering");
  });

  it("lets the person's rules win, in order, on every field they give", () => {
    const rules = [
      { agent: "fable-*", workspace: "sta", type: "design" as const },
      { kind: "chore", type: "documentation" as const },
    ];
    expect(deriveAgentType(input({ agent: "Fable-R7B", labels: ["docs"] }), rules)).toEqual({ type: "design", roleId: null, reason: { code: "rule", detail: "0" } });
    expect(deriveAgentType(input({ agent: "fable-r7b", workspace: "EXE" }), rules).type).toBe("engineering");
    expect(deriveAgentType(input({ kind: "chore" }), rules)).toEqual({ type: "documentation", roleId: null, reason: { code: "rule", detail: "1" } });
    expect(deriveAgentType(input({ agent: "x", role: "orchestrator" }), rules).type).toBe("orchestration");
  });

  it("matches a title word or phrase, and can name a role while the type stays derived", () => {
    const rules = [
      { title: "release notes", roleId: "release-manager" },
      { title: "qa", roleId: "qa-engineer" },
      { title: "landing", type: "design" as const },
    ];
    expect(deriveAgentType(input({ title: "Write the Release Notes for 0.3" }), rules)).toEqual({ type: "engineering", roleId: "release-manager", reason: { code: "rule", detail: "0" } });
    expect(deriveAgentType(input({ title: "Docs: notes on the release" }), rules)).toEqual({ type: "documentation", roleId: null, reason: { code: "title", detail: "docs" } });
    expect(deriveAgentType(input({ title: "QA pass over the import" }), rules).roleId).toBe("qa-engineer");
    // A whole word only: "quality" does not contain the word "qa", "landings" is not "landing".
    expect(deriveAgentType(input({ title: "quality pass over landings" }), rules)).toEqual({ type: "engineering", roleId: null, reason: { code: "default", detail: null } });
  });

  it("matches a glob on the whole name, case-insensitively, with regex characters literal", () => {
    expect(globMatches("sta*-writer", "STA222-writer")).toBe(true);
    expect(globMatches("sta*", "the-sta")).toBe(false);
    expect(globMatches("a.b", "axb")).toBe(false);
    expect(globMatches("a.b", "a.b")).toBe(true);
  });

  it("matches a pathological glob in linear time", () => {
    const started = performance.now();
    expect(globMatches("*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(40))).toBe(false);
    expect(globMatches("*a*a*a*a*a*a*a*a*a*a*a*a*b", `${"a".repeat(40)}b`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
    expect(globMatches("*", "")).toBe(true);
    expect(globMatches("a*", "")).toBe(false);
  });

  it("is deterministic: the same attempt types the same way every time", () => {
    const one = input({ agent: "claude-relay-builder", title: "A visual pass over the relay" });
    expect(deriveAgentType(one)).toEqual(deriveAgentType({ ...one }));
  });
});

describe("cost model validation", () => {
  const profile = DEFAULT_COST_MODEL.solo;
  const entry = { id: "plan", label: "Plan", monthlyAmount: 100, from: "2026-09", to: null };

  it("accepts every default", () => {
    for (const part of ["roles", "roleMapping", "scenario", "solo", "company"] as const) expect(costModelPartProblem(part, DEFAULT_COST_MODEL[part]), part).toBeNull();
  });

  it("refuses malformed roles by name, rates now living in the profiles", () => {
    expect(costModelPartProblem("roles", { roles: [], savedAt: null })).toMatch(/1 to 30/);
    expect(costModelPartProblem("roles", { roles: [{ id: "a", title: "A" }, { id: "a", title: "B" }], savedAt: null })).toMatch(/twice/);
    expect(costModelPartProblem("roles", { roles: [{ id: "Bad Id", title: "A" }], savedAt: null })).toMatch(/lowercase/);
    expect(costModelPartProblem("roles", { roles: [{ id: "a", title: "A", hourlyRate: 1 }], savedAt: null })).toMatch(/unknown field "hourlyRate"/);
    expect(costModelPartProblem("roles", { roles: [{ id: "a", title: "A" }], savedAt: "yesterday" })).toMatch(/savedAt/);
  });

  it("refuses a mapping that misses an agent type, names a stranger, or has an empty rule", () => {
    const types = { ...DEFAULT_COST_MODEL.roleMapping.types };
    expect(costModelPartProblem("roleMapping", { types: { ...types, design: undefined }, rules: [], savedAt: null })).toMatch(/types.design/);
    expect(costModelPartProblem("roleMapping", { types: { ...types, qa: "x" }, rules: [], savedAt: null })).toMatch(/not an agent type/);
    expect(costModelPartProblem("roleMapping", { types, rules: [{ type: "design" }], savedAt: null })).toMatch(/at least one/);
    expect(costModelPartProblem("roleMapping", { types, rules: [{ agent: "x", type: "qa" }], savedAt: null })).toMatch(/type must be one of/);
    expect(costModelPartProblem("roleMapping", { types, rules: [{ agent: "x", type: "design", roleId: "qa" }], savedAt: null })).toMatch(/exactly one/);
    expect(costModelPartProblem("roleMapping", { types, rules: [{ title: "qa", roleId: "Q A" }], savedAt: null })).toMatch(/roleId/);
    expect(costModelPartProblem("roleMapping", { types, rules: [{ title: "qa", roleId: "qa" }], savedAt: null })).toBeNull();
  });

  it("refuses a bad scenario, and a scenario that still carries a director", () => {
    expect(costModelPartProblem("scenario", { ...DEFAULT_COST_MODEL.scenario, mode: "agency" })).toMatch(/mode/);
    expect(costModelPartProblem("scenario", { ...DEFAULT_COST_MODEL.scenario, currency: "usd" })).toMatch(/currency/);
    expect(costModelPartProblem("scenario", { ...DEFAULT_COST_MODEL.scenario, director: {} })).toMatch(/unknown field "director"/);
  });

  it("refuses a bad profile: its director, its rates and its spend lines", () => {
    expect(costModelPartProblem("solo", { ...profile, director: { title: "Me", hourlyRate: 1, hoursPerActiveDay: 30 } })).toMatch(/hoursPerActiveDay/);
    expect(costModelPartProblem("company", { ...profile, rates: { "Not An Id": 5 } })).toMatch(/not a role id/);
    expect(costModelPartProblem("company", { ...profile, rates: { engineer: -1 } })).toMatch(/rates.engineer/);
    expect(costModelPartProblem("solo", { ...profile, billing: {} })).toMatch(/unknown field "billing"/);
    const bad = (line: Record<string, unknown>) => costModelPartProblem("solo", { ...profile, entries: [{ ...entry, ...line }] });
    expect(bad({ from: "2026-13" })).toMatch(/from/);
    expect(bad({ to: "2026-08" })).toMatch(/before it starts/);
    expect(bad({ kind: "metered" })).toMatch(/kind must be one of subscription, api/);
    expect(bad({ kind: "api", quantity: 2 })).toMatch(/API bill, which has no quantity/);
    expect(bad({ quantity: 1.5 })).toMatch(/quantity must be a whole number/);
    expect(bad({ roleId: "Bad Role" })).toMatch(/roleId must name a role id/);
    expect(costModelPartProblem("solo", { ...profile, entries: [entry, entry] })).toMatch(/twice/);
    // A read's own shape is a valid write: an API bill with quantity null, shared spend with roleId null.
    expect(bad({ kind: "api", quantity: null, roleId: null })).toBeNull();
    expect(bad({ kind: "subscription", quantity: 10, roleId: "software-engineer" })).toBeNull();
  });

  it("ships three roles; one shared $200 subscription for just me and nothing for a company; every default figure assumed", () => {
    expect(DEFAULT_COST_MODEL.roles.roles.map((role) => role.id)).toEqual(["software-engineer", "design-engineer", "technical-writer"]);
    expect(DEFAULT_COST_MODEL.roleMapping.types.orchestration).toBe("software-engineer");
    expect(DEFAULT_COST_MODEL.scenario.mode).toBe("solo");
    expect(DEFAULT_COST_MODEL.solo.entries).toEqual([{ id: "ai-plan", label: "AI subscription", monthlyAmount: 200, from: "2000-01", to: null, kind: "subscription", quantity: 1, roleId: null }]);
    expect(DEFAULT_COST_MODEL.company.entries).toEqual([]);
    expect(DEFAULT_COST_MODEL.solo.assumed).toEqual(expect.arrayContaining(["director.hourlyRate", "director.hoursPerActiveDay", "roles.software-engineer.hourlyRate", "entries.ai-plan.monthlyAmount"]));
    expect(DEFAULT_COST_MODEL.company.assumed).toEqual(expect.arrayContaining(["director.hourlyRate", "roles.technical-writer.hourlyRate"]));
    expect(costModelPartProblem("solo", { ...profile, assumed: [7] })).toMatch(/assumed/);
  });
});

describe("AI spend over a period", () => {
  const entries: AiSpendEntry[] = [
    { id: "max", label: "Max plan", monthlyAmount: 300, from: "2026-09", to: "2026-09" },
    { id: "api", label: "API", monthlyAmount: 3100, from: "2026-10", to: null, kind: "api" },
  ];

  it("prorates each day at its own month's amount and days", () => {
    expect(aiSpendFor(entries, eachDate("2026-09-01", "2026-09-30"))).toBeCloseTo(300);
    expect(aiSpendFor(entries, eachDate("2026-09-16", "2026-09-30"))).toBeCloseTo(150);
    // Sep 30 at 300/30, Oct 1 at 3100/31.
    expect(aiSpendFor(entries, ["2026-09-30", "2026-10-01"])).toBeCloseTo(10 + 100);
    expect(aiSpendFor(entries, ["2026-08-31"])).toBe(0);
  });

  it("multiplies a subscription by its quantity and leaves an API bill as entered", () => {
    expect(monthlyCostOf({ id: "a", label: "A", monthlyAmount: 200, from: "2026-09", to: null, quantity: 10 })).toBe(2000);
    expect(monthlyCostOf({ id: "a", label: "A", monthlyAmount: 200, from: "2026-09", to: null })).toBe(200);
    expect(monthlyCostOf({ id: "a", label: "A", monthlyAmount: 200, from: "2026-09", to: null, quantity: 0 })).toBe(0);
    expect(monthlyCostOf({ id: "b", label: "B", monthlyAmount: 900, from: "2026-09", to: null, kind: "api", quantity: null })).toBe(900);
    expect(aiSpendFor([{ id: "two", label: "Two plans", monthlyAmount: 100, from: "2026-09", to: null, quantity: 2 }], eachDate("2026-09-01", "2026-09-30"))).toBeCloseTo(200);
  });

  it("says whether any spend that costs something covers the period", () => {
    expect(spendCovers(entries, eachDate("2026-09-01", "2026-09-30"))).toBe(true);
    expect(spendCovers(entries, ["2026-08-31"])).toBe(false);
    expect(spendCovers([{ id: "zero", label: "Zero", monthlyAmount: 0, from: "2026-09", to: null }], ["2026-09-01"])).toBe(false);
    expect(spendCovers([], ["2026-09-01"])).toBe(false);
  });
});

describe("the ROI", () => {
  const model: CostModel = {
    ...DEFAULT_COST_MODEL,
    roles: { roles: [{ id: "eng", title: "Engineer" }, { id: "writer", title: "Writer" }], savedAt: null },
    roleMapping: { types: { engineering: "eng", design: "eng", documentation: "writer", research: "eng", orchestration: "eng" }, rules: [], savedAt: null },
    scenario: { mode: "solo", currency: "USD", savedAt: null },
    solo: { director: { title: "You", hourlyRate: 70, hoursPerActiveDay: 8 }, rates: { eng: 70, writer: 50 }, entries: [], savedAt: null },
    company: { director: { title: "Employee", hourlyRate: 90, hoursPerActiveDay: 8 }, rates: { eng: 150, writer: 80 }, entries: [], savedAt: null },
  };
  type Hours = Partial<Record<"engineering" | "design" | "documentation" | "research" | "orchestration", number>>;
  /** Hours by type, each type priced at its mapped role, as the metrics read tallies them. */
  const byRole = (hoursByType: Hours, tickets: Record<string, number> = {}) => {
    const out = new Map<string, { hours: number; types: Set<any>; tickets: number; estimatedTickets: number | null }>();
    for (const [type, value] of Object.entries(hoursByType)) {
      const id = model.roleMapping.types[type as keyof Hours];
      const held = out.get(id) ?? { hours: 0, types: new Set(), tickets: tickets[id] ?? 0, estimatedTickets: null };
      held.hours += value!;
      held.types.add(type);
      out.set(id, held);
    }
    return out;
  };
  const line = (id: string, cost: number, over: Partial<AiSpendEntry> = {}) => ({
    entry: { id, label: id, monthlyAmount: cost, from: "2026-09", to: null, ...over } as AiSpendEntry,
    cost,
  });

  it("reproduces the shaping discussion's measured-lens figures (0.73×)", () => {
    // VP's numbers: $70/h, $17,000/month for 2.5 months, 256 h directing, 633 measured agent-hours.
    const result = roi({ lens: "measured", byRole: byRole({ engineering: 633 }), aiEntries: [line("api", 42_500, { kind: "api" })], directorHours: 256, model });
    expect(result.value).toBeCloseTo(44_310);
    expect(result.totalCost).toBeCloseTo(42_500 + 17_920);
    expect(result.returnOnTotalCost).toBeCloseTo(44_310 / 60_420, 6);
    expect(result.breakEvenRate).toBeCloseTo(60_420 / 633);
    expect(result.outputMultiplier).toBeCloseTo(633 / 256);
  });

  it("puts each spend line whole on the role it names, the rest on the shared row, and splits nothing", () => {
    const result = roi({
      lens: "planned",
      byRole: byRole({ engineering: 10, design: 5, documentation: 4 }, { eng: 3, writer: 1 }),
      aiEntries: [line("eng-seats", 300, { quantity: 3, roleId: "eng" }), line("writer-api", 40, { kind: "api", roleId: "writer" }), line("team", 60), line("gone", 10, { roleId: "nobody" })],
      directorHours: 0,
      model,
    });
    expect(result.byRole).toEqual([
      {
        roleId: "eng",
        title: "Engineer",
        hourlyRate: 70,
        hours: 15,
        value: 1050,
        types: ["engineering", "design"],
        tickets: 3,
        estimatedTickets: 0,
        aiCost: 300,
        aiEntries: [{ id: "eng-seats", label: "eng-seats", kind: "subscription", monthlyAmount: 300, quantity: 3, cost: 300 }],
      },
      {
        roleId: "writer",
        title: "Writer",
        hourlyRate: 50,
        hours: 4,
        value: 200,
        types: ["documentation"],
        tickets: 1,
        estimatedTickets: 0,
        aiCost: 40,
        aiEntries: [{ id: "writer-api", label: "writer-api", kind: "api", monthlyAmount: 40, quantity: null, cost: 40 }],
      },
    ]);
    // A line for a role no longer in the list counts as shared.
    expect(result.sharedAiEntries.map((entry) => entry.id)).toEqual(["team", "gone"]);
    expect(result).toMatchObject({ valueHours: 19, value: 1250, aiCost: 410, sharedAiCost: 70, totalCost: 410 });
  });

  it("gives a role a row for the spend assigned to it even when it did not run", () => {
    const result = roi({ lens: "measured", byRole: byRole({ engineering: 2 }), aiEntries: [line("writer-seat", 25, { roleId: "writer" })], directorHours: 0, model });
    expect(result.byRole.map((role) => [role.roleId, role.hours, role.aiCost])).toEqual([
      ["eng", 2, 0],
      ["writer", 0, 25],
    ]);
  });

  it("prices with the profile in use and nothing from the other", () => {
    const company: CostModel = { ...model, scenario: { ...model.scenario, mode: "company" } };
    expect(activeProfile(company)).toBe(company.company);
    const result = roi({ lens: "measured", byRole: byRole({ engineering: 10 }), aiEntries: [], directorHours: 5, model: company });
    expect(result.value).toBe(1500);
    expect(result.director).toEqual({ hours: 5, hourlyRate: 90, cost: 450 });
    // A role the profile sets no rate for is priced at the default rate.
    const unset: CostModel = { ...company, company: { ...company.company, rates: {} } };
    expect(roi({ lens: "measured", byRole: byRole({ engineering: 1 }), aiEntries: [], directorHours: 0, model: unset }).byRole[0]!.hourlyRate).toBe(100);
  });

  it("answers null, not infinity, when there is no cost or no hours", () => {
    const result = roi({ lens: "measured", byRole: new Map(), aiEntries: [], directorHours: 0, model });
    expect(result).toMatchObject({ value: 0, totalCost: 0, sharedAiCost: 0, returnOnTotalCost: null, returnOnAiSpend: null, breakEvenRate: null });
  });

  it("prices a type whose role was removed at the first role, and says so", () => {
    const orphaned: CostModel = { ...model, roleMapping: { ...model.roleMapping, types: { ...model.roleMapping.types, documentation: "gone" } } };
    expect(resolveRoles(orphaned).fallbacks).toEqual([{ type: "documentation", rule: null, missingRoleId: "gone", usedRoleId: "eng" }]);
    const ruled: CostModel = { ...model, roleMapping: { ...model.roleMapping, rules: [{ title: "qa", roleId: "qa" }] } };
    expect(resolveRoles(ruled).fallbacks).toEqual([{ type: null, rule: 0, missingRoleId: "qa", usedRoleId: "eng" }]);
    const tally = new Map([["gone", { hours: 2, types: new Set(["documentation" as const]), tickets: 1, estimatedTickets: null }]]);
    expect(roi({ lens: "measured", byRole: tally, aiEntries: [], directorHours: 0, model: orphaned }).value).toBe(140);
  });
});

describe("calendar days in a zone", () => {
  it("cuts each day at its own local midnight across a daylight-saving change", () => {
    const ny = Zone.of("America/New_York");
    // 2026-03-08 is the spring-forward day in New York: 23 hours long.
    expect(ny.startOf("2026-03-09") - ny.startOf("2026-03-08")).toBe(23 * 3_600_000);
    expect(new Date(ny.startOf("2026-03-08")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(ny.startOf("2026-11-02")).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(ny.dateOf("2026-09-02T03:59:59.000Z")).toBe("2026-09-01");
    expect(ny.dateOf("2026-09-02T04:00:00.000Z")).toBe("2026-09-02");
  });

  it("defaults to UTC and refuses an unknown zone", () => {
    expect(Zone.of(undefined).name).toBe("UTC");
    expect(() => Zone.of("Nowhere/Special")).toThrow(/IANA/);
  });
});
