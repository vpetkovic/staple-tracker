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
  aiSpendFor,
  costModelPartProblem,
  costModelSavedAt,
  resolveRoles,
  roi,
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
  it("accepts every default", () => {
    for (const part of ["roles", "roleMapping", "scenario", "aiSpend"] as const) expect(costModelPartProblem(part, DEFAULT_COST_MODEL[part])).toBeNull();
  });

  it("refuses malformed roles by name", () => {
    expect(costModelPartProblem("roles", { roles: [], savedAt: null })).toMatch(/1 to 30/);
    expect(costModelPartProblem("roles", { roles: [{ id: "a", title: "A", hourlyRate: 1 }, { id: "a", title: "B", hourlyRate: 2 }], savedAt: null })).toMatch(/twice/);
    expect(costModelPartProblem("roles", { roles: [{ id: "Bad Id", title: "A", hourlyRate: 1 }], savedAt: null })).toMatch(/lowercase/);
    expect(costModelPartProblem("roles", { roles: [{ id: "a", title: "A", hourlyRate: -1 }], savedAt: null })).toMatch(/hourlyRate/);
    expect(costModelPartProblem("roles", { roles: [{ id: "a", title: "A", hourlyRate: 1, salary: 2 }], savedAt: null })).toMatch(/unknown field "salary"/);
    expect(costModelPartProblem("roles", { roles: [{ id: "a", title: "A", hourlyRate: 1 }], savedAt: "yesterday" })).toMatch(/savedAt/);
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

  it("refuses a bad scenario and bad spend entries", () => {
    expect(costModelPartProblem("scenario", { ...DEFAULT_COST_MODEL.scenario, mode: "agency" })).toMatch(/mode/);
    expect(costModelPartProblem("scenario", { ...DEFAULT_COST_MODEL.scenario, currency: "usd" })).toMatch(/currency/);
    expect(costModelPartProblem("scenario", { ...DEFAULT_COST_MODEL.scenario, director: { title: "Me", hourlyRate: 1, hoursPerActiveDay: 30 } })).toMatch(/hoursPerActiveDay/);
    const entry = { id: "plan", label: "Plan", monthlyAmount: 100, from: "2026-09", to: null };
    expect(costModelPartProblem("aiSpend", { entries: [{ ...entry, from: "2026-13" }], savedAt: null })).toMatch(/from/);
    expect(costModelPartProblem("aiSpend", { entries: [{ ...entry, to: "2026-08" }], savedAt: null })).toMatch(/before it starts/);
    expect(costModelPartProblem("aiSpend", { entries: [entry, entry], savedAt: null })).toMatch(/twice/);
  });

  it("ships three roles, prices orchestration as engineering, and lists every default figure as assumed", () => {
    expect(DEFAULT_COST_MODEL.roles.roles.map((role) => role.id)).toEqual(["software-engineer", "design-engineer", "technical-writer"]);
    expect(DEFAULT_COST_MODEL.roleMapping.types.orchestration).toBe("software-engineer");
    expect(DEFAULT_COST_MODEL.scenario.assumed).toEqual(["director.hourlyRate", "director.hoursPerActiveDay"]);
    expect(DEFAULT_COST_MODEL.aiSpend.assumed).toEqual(["entries.ai-plan.monthlyAmount"]);
    expect(costModelPartProblem("scenario", { ...DEFAULT_COST_MODEL.scenario, assumed: [7] })).toMatch(/assumed/);
  });

  it("reads the newest save across the parts, and null for all defaults", () => {
    expect(costModelSavedAt(DEFAULT_COST_MODEL)).toBeNull();
    const model: CostModel = {
      ...DEFAULT_COST_MODEL,
      roles: { ...DEFAULT_COST_MODEL.roles, savedAt: "2026-11-01T00:00:00.000Z" },
      aiSpend: { ...DEFAULT_COST_MODEL.aiSpend, savedAt: "2026-11-20T00:00:00.000Z" },
    };
    expect(costModelSavedAt(model)).toBe("2026-11-20T00:00:00.000Z");
  });
});

describe("AI spend over a period", () => {
  const spend = {
    entries: [
      { id: "max", label: "Max plan", monthlyAmount: 300, from: "2026-09", to: "2026-09" },
      { id: "api", label: "API", monthlyAmount: 3100, from: "2026-10", to: null },
    ],
    savedAt: null,
  };

  it("prorates each day at its own month's amount and days", () => {
    expect(aiSpendFor(spend, eachDate("2026-09-01", "2026-09-30"))).toBeCloseTo(300);
    expect(aiSpendFor(spend, eachDate("2026-09-16", "2026-09-30"))).toBeCloseTo(150);
    // Sep 30 at 300/30, Oct 1 at 3100/31.
    expect(aiSpendFor(spend, ["2026-09-30", "2026-10-01"])).toBeCloseTo(10 + 100);
    expect(aiSpendFor(spend, ["2026-08-31"])).toBe(0);
  });
});

describe("the ROI", () => {
  const model: CostModel = {
    ...DEFAULT_COST_MODEL,
    roles: { roles: [{ id: "eng", title: "Engineer", hourlyRate: 70 }, { id: "writer", title: "Writer", hourlyRate: 50 }], savedAt: null },
    roleMapping: { types: { engineering: "eng", design: "eng", documentation: "writer", research: "eng", orchestration: "eng" }, rules: [], savedAt: null },
    scenario: { mode: "solo", currency: "USD", director: { title: "You", hourlyRate: 70, hoursPerActiveDay: 8 }, savedAt: null },
  };
  type Hours = Partial<Record<"engineering" | "design" | "documentation" | "research" | "orchestration", number>>;
  /** Hours by type, each type priced at its mapped role, as the metrics read tallies them. */
  const byRole = (hoursByType: Hours, tickets: Record<string, number> = {}) => {
    const out = new Map<string, { hours: number; types: Set<any>; tickets: number; plannedTickets: number | null }>();
    for (const [type, value] of Object.entries(hoursByType)) {
      const id = model.roleMapping.types[type as keyof Hours];
      const held = out.get(id) ?? { hours: 0, types: new Set(), tickets: tickets[id] ?? 0, plannedTickets: null };
      held.hours += value!;
      held.types.add(type);
      out.set(id, held);
    }
    return out;
  };

  it("reproduces the shaping discussion's measured-lens figures (0.73×)", () => {
    // VP's numbers: $70/h, $17,000/month for 2.5 months, 256 h directing, 633 measured agent-hours.
    const result = roi({ lens: "measured", byRole: byRole({ engineering: 633 }), aiCost: 17_000 * 2.5, directorHours: 256, model });
    expect(result.value).toBeCloseTo(44_310);
    expect(result.totalCost).toBeCloseTo(42_500 + 17_920);
    expect(result.returnOnTotalCost).toBeCloseTo(44_310 / 60_420, 6);
    expect(result.breakEvenRate).toBeCloseTo(60_420 / 633);
    expect(result.outputMultiplier).toBeCloseTo(633 / 256);
  });

  it("prices each agent type at its role and folds types that share a role", () => {
    const result = roi({ lens: "planned", byRole: byRole({ engineering: 10, design: 5, documentation: 4 }, { eng: 3, writer: 1 }), aiCost: 100, directorHours: 0, model });
    expect(result.byRole).toEqual([
      { roleId: "eng", title: "Engineer", hourlyRate: 70, hours: 15, value: 1050, types: ["engineering", "design"], tickets: 3, plannedTickets: 0 },
      { roleId: "writer", title: "Writer", hourlyRate: 50, hours: 4, value: 200, types: ["documentation"], tickets: 1, plannedTickets: 0 },
    ]);
    expect(result).toMatchObject({ valueHours: 19, value: 1250, totalCost: 100, net: 1150, returnOnTotalCost: 12.5, returnOnAiSpend: 12.5, outputMultiplier: null });
  });

  it("answers null, not infinity, when there is no cost or no hours", () => {
    const result = roi({ lens: "measured", byRole: new Map(), aiCost: 0, directorHours: 0, model });
    expect(result).toMatchObject({ value: 0, totalCost: 0, returnOnTotalCost: null, returnOnAiSpend: null, breakEvenRate: null });
  });

  it("prices a type whose role was removed at the first role, and says so", () => {
    const orphaned: CostModel = { ...model, roleMapping: { ...model.roleMapping, types: { ...model.roleMapping.types, documentation: "gone" } } };
    expect(resolveRoles(orphaned).fallbacks).toEqual([{ type: "documentation", rule: null, missingRoleId: "gone", usedRoleId: "eng" }]);
    const ruled: CostModel = { ...model, roleMapping: { ...model.roleMapping, rules: [{ title: "qa", roleId: "qa" }] } };
    expect(resolveRoles(ruled).fallbacks).toEqual([{ type: null, rule: 0, missingRoleId: "qa", usedRoleId: "eng" }]);
    const tally = new Map([["gone", { hours: 2, types: new Set(["documentation" as const]), tickets: 1, plannedTickets: null }]]);
    expect(roi({ lens: "measured", byRole: tally, aiCost: 0, directorHours: 0, model: orphaned }).value).toBe(140);
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
