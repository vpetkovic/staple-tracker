/**
 * Every edit the Cost setup dialog and the role page make, to the exact `CostModelWrite` it
 * sends. The model edited is the one the server reads with nothing saved (core
 * `readCostModel` over no workspace), so each write starts from a real read, not a guess.
 */
import { describe, expect, it } from "vitest";
import type { CostModelValue } from "@/lib/analytics-api";
import { readCostModel } from "../../../../../core/analytics/home.ts";
import { costModelPartProblem } from "../../../../../core/analytics/cost-model.ts";
import { agentWords, costEdits, moveHome, refusalSentence, resetProfiles, withHome, type CostEdit } from "./cost-edits";

const read = (): CostModelValue => readCostModel([], null, "/nonexistent-staple-home").model;
const SOLO_ASSUMED = [
  "director.hourlyRate",
  "director.hoursPerActiveDay",
  "roles.software-engineer.hourlyRate",
  "roles.design-engineer.hourlyRate",
  "roles.technical-writer.hourlyRate",
  "entries.ai-plan.monthlyAmount",
];
const SOLO_ENTRY = { id: "ai-plan", label: "AI subscription", kind: "subscription", monthlyAmount: 200, quantity: 1, roleId: null, from: "2000-01", to: null };
const RATES = { "software-engineer": 100, "design-engineer": 95, "technical-writer": 70 };
const TYPES = { engineering: "software-engineer", design: "design-engineer", documentation: "technical-writer", research: "software-engineer", orchestration: "software-engineer" };
const ROLES = [
  { id: "software-engineer", title: "Software Engineer" },
  { id: "design-engineer", title: "Design Engineer" },
  { id: "technical-writer", title: "Technical Writer" },
];

/** The write is valid by the server's own validator for every part it names, stamped as the server stores it. */
function valid(edit: CostEdit | null): CostEdit {
  expect(edit).not.toBeNull();
  for (const part of ["roles", "roleMapping", "scenario", "solo", "company"] as const) {
    const value = edit!.write[part];
    if (value !== undefined) expect(costModelPartProblem(part, { ...value, savedAt: "2026-11-26T12:00:00.000Z" }), part).toBeNull();
  }
  return edit!;
}

function withRules(model: CostModelValue, rules: CostModelValue["roleMapping"]["rules"]): CostModelValue {
  return { ...model, roleMapping: { ...model.roleMapping, rules } };
}

describe("profile edits write the profile in use, whole, less the figure the person set", () => {
  it("the director's rate", () => {
    const edit = valid(costEdits.directorRate(read(), 150));
    expect(edit.write).toEqual({
      solo: { director: { title: "You", hourlyRate: 150, hoursPerActiveDay: 8 }, rates: RATES, entries: [SOLO_ENTRY], assumed: SOLO_ASSUMED.filter((id) => id !== "director.hourlyRate") },
    });
    expect(edit.next.solo.director.hourlyRate).toBe(150);
    expect(edit.field).toBe("director.hourlyRate");
  });

  it("the director's hours a day", () => {
    expect(valid(costEdits.directorHours(read(), 3)).write).toEqual({
      solo: { director: { title: "You", hourlyRate: 100, hoursPerActiveDay: 3 }, rates: RATES, entries: [SOLO_ENTRY], assumed: SOLO_ASSUMED.filter((id) => id !== "director.hoursPerActiveDay") },
    });
  });

  it("a role's rate", () => {
    expect(valid(costEdits.roleRate(read(), "design-engineer", 120)).write).toEqual({
      solo: { director: { title: "You", hourlyRate: 100, hoursPerActiveDay: 8 }, rates: { ...RATES, "design-engineer": 120 }, entries: [SOLO_ENTRY], assumed: SOLO_ASSUMED.filter((id) => id !== "roles.design-engineer.hourlyRate") },
    });
  });

  it("an entry's price settles it; its label and quantity do not", () => {
    const base = { director: { title: "You", hourlyRate: 100, hoursPerActiveDay: 8 }, rates: RATES };
    expect(valid(costEdits.entry(read(), "ai-plan", { monthlyAmount: 20 })).write).toEqual({
      solo: { ...base, entries: [{ ...SOLO_ENTRY, monthlyAmount: 20 }], assumed: SOLO_ASSUMED.filter((id) => id !== "entries.ai-plan.monthlyAmount") },
    });
    expect(valid(costEdits.entry(read(), "ai-plan", { label: "Claude Max" })).write).toEqual({ solo: { ...base, entries: [{ ...SOLO_ENTRY, label: "Claude Max" }], assumed: SOLO_ASSUMED } });
    const seats = valid(costEdits.entry(read(), "ai-plan", { quantity: 3 }));
    expect(seats.write).toEqual({ solo: { ...base, entries: [{ ...SOLO_ENTRY, quantity: 3 }], assumed: SOLO_ASSUMED } });
    expect(seats.field).toBe("entries.ai-plan.quantity");
  });

  it("a new entry covers every month; an API bill carries no quantity", () => {
    const api = valid(costEdits.entryAdd(read(), "design-engineer", "api", "entry-1"));
    expect(api.write.solo?.entries).toEqual([SOLO_ENTRY, { id: "entry-1", label: "API bill", kind: "api", monthlyAmount: 0, roleId: "design-engineer", from: "2000-01", to: null }]);
    expect(api.write.solo?.assumed).toEqual(SOLO_ASSUMED);
    const seat = valid(costEdits.entryAdd(read(), null, "subscription", "entry-2"));
    expect(seat.write.solo?.entries?.[1]).toEqual({ id: "entry-2", label: "Subscription", kind: "subscription", monthlyAmount: 0, quantity: 1, roleId: null, from: "2000-01", to: null });
  });

  it("removing an entry drops it and its assumed price", () => {
    expect(valid(costEdits.entryRemove(read(), "ai-plan")).write).toEqual({
      solo: { director: { title: "You", hourlyRate: 100, hoursPerActiveDay: 8 }, rates: RATES, entries: [], assumed: SOLO_ASSUMED.filter((id) => id !== "entries.ai-plan.monthlyAmount") },
    });
  });

  it("an existing entry with dates keeps them", () => {
    const model = read();
    const dated: CostModelValue = { ...model, solo: { ...model.solo, entries: [{ ...SOLO_ENTRY, kind: "subscription", from: "2026-03", to: "2026-06" }] } };
    expect(valid(costEdits.entry(dated, "ai-plan", { monthlyAmount: 30 })).write.solo?.entries).toEqual([{ ...SOLO_ENTRY, monthlyAmount: 30, from: "2026-03", to: "2026-06" }]);
  });

  it("with A company in use, the company profile is written and Just me is left alone", () => {
    const model = costEdits.scenario(read(), "company").next;
    expect(valid(costEdits.directorRate(model, 80)).write).toEqual({
      company: {
        director: { title: "Employee", hourlyRate: 80, hoursPerActiveDay: 8 },
        rates: RATES,
        entries: [],
        assumed: ["director.hoursPerActiveDay", "roles.software-engineer.hourlyRate", "roles.design-engineer.hourlyRate", "roles.technical-writer.hourlyRate"],
      },
    });
  });
});

describe("the shared parts", () => {
  it("switching profile writes only the scenario", () => {
    expect(valid(costEdits.scenario(read(), "company")).write).toEqual({ scenario: { mode: "company", currency: "USD", assumed: [] } });
  });

  it("renaming and adding a role write the role list", () => {
    expect(valid(costEdits.roleTitle(read(), "technical-writer", "Docs writer")).write).toEqual({ roles: { roles: ROLES.map((role) => (role.id === "technical-writer" ? { ...role, title: "Docs writer" } : role)), assumed: [] } });
    expect(valid(costEdits.roleAdd(read(), "role-qa")).write).toEqual({ roles: { roles: [...ROLES, { id: "role-qa", title: "New role" }], assumed: [] } });
  });

  it("removing a role moves its kinds of work to the engineering role and drops its rules, in one write", () => {
    const model = withRules(read(), [
      { label: "ui", roleId: "design-engineer" },
      { label: "ci", roleId: "technical-writer" },
      { agent: "fable-*", kind: "task", roleId: "design-engineer" },
      { title: "mockup", type: "design" },
    ]);
    const edit = valid(costEdits.roleRemove(model, "design-engineer"));
    expect(edit.write).toEqual({
      roles: { roles: ROLES.filter((role) => role.id !== "design-engineer"), assumed: [] },
      roleMapping: {
        types: { ...TYPES, design: "software-engineer" },
        rules: [{ label: "ci", roleId: "technical-writer" }, { title: "mockup", type: "design" }],
        assumed: [],
      },
    });
    expect(edit.field).toBe("roles.design-engineer");
  });

  it("the role that holds engineering cannot be removed", () => {
    expect(costEdits.roleRemove(read(), "software-engineer")).toBeNull();
    const moved = costEdits.typeTo(read(), "engineering", "technical-writer").next;
    expect(costEdits.roleRemove(moved, "technical-writer")).toBeNull();
    expect(costEdits.roleRemove(moved, "software-engineer")?.write.roleMapping?.types).toEqual({ ...TYPES, engineering: "technical-writer", research: "technical-writer", orchestration: "technical-writer" });
  });
});

describe("how a role is recognized", () => {
  it("giving a kind of work to a role takes it off the role that had it", () => {
    expect(valid(costEdits.typeTo(read(), "documentation", "design-engineer")).write).toEqual({ roleMapping: { types: { ...TYPES, documentation: "design-engineer" }, rules: [], assumed: [] } });
  });

  it("taking a kind off sends it to the engineering role; engineering itself and the engineering role's kinds stay", () => {
    expect(valid(costEdits.typeOff(read(), "design")).write).toEqual({ roleMapping: { types: { ...TYPES, design: "software-engineer" }, rules: [], assumed: [] } });
    expect(costEdits.typeOff(read(), "engineering")).toBeNull();
    expect(costEdits.typeOff(read(), "research")).toBeNull();
  });

  it("a chip is one single-field rule naming the role, added after the others", () => {
    const model = withRules(read(), [{ title: "mockup", type: "design" }]);
    expect(valid(costEdits.chipAdd(model, "design-engineer", "label", "ci")).write).toEqual({
      roleMapping: { types: TYPES, rules: [{ title: "mockup", type: "design" }, { label: "ci", roleId: "design-engineer" }], assumed: [] },
    });
    expect(valid(costEdits.chipAdd(model, "design-engineer", "title", "dark mode")).write.roleMapping?.rules[1]).toEqual({ title: "dark mode", roleId: "design-engineer" });
    expect(valid(costEdits.chipAdd(model, "design-engineer", "kind", "spike")).write.roleMapping?.rules[1]).toEqual({ kind: "spike", roleId: "design-engineer" });
  });

  it("an agent name is matched where it appears in the name; a workspace by its prefix", () => {
    const agent = valid(costEdits.chipAdd(read(), "design-engineer", "agent", "design"));
    expect(agent.write.roleMapping?.rules).toEqual([{ agent: "*design*", roleId: "design-engineer" }]);
    expect(agentWords("*design*")).toBe("design");
    expect(valid(costEdits.chipAdd(read(), "design-engineer", "agent", "fable-*")).write.roleMapping?.rules).toEqual([{ agent: "fable-*", roleId: "design-engineer" }]);
    expect(agentWords("fable-*")).toBe("fable-*");
    expect(valid(costEdits.chipAdd(read(), "technical-writer", "workspace", "fds")).write.roleMapping?.rules).toEqual([{ workspace: "FDS", roleId: "technical-writer" }]);
  });

  it("a chip already there is not added twice, and removing one removes only that rule", () => {
    const model = withRules(read(), [
      { label: "ci", roleId: "design-engineer" },
      { label: "ci", roleId: "technical-writer" },
      { label: "ci", agent: "x", roleId: "design-engineer" },
    ]);
    expect(costEdits.chipAdd(model, "design-engineer", "label", "ci")).toBeNull();
    expect(costEdits.chipAdd(model, "design-engineer", "label", "  ")).toBeNull();
    expect(valid(costEdits.chipRemove(model, "design-engineer", "label", "ci")).write).toEqual({
      roleMapping: { types: TYPES, rules: [{ label: "ci", roleId: "technical-writer" }, { label: "ci", agent: "x", roleId: "design-engineer" }], assumed: [] },
    });
  });
});

describe("where the write goes", () => {
  it("with nothing saved, the first save goes to the suggested workspace without asking", () => {
    const write = costEdits.scenario(read(), "company").write;
    expect(withHome(write, { slug: null, suggested: "staple" })).toEqual({ home: "staple", ...write });
    expect(withHome(write, { slug: "fds", suggested: "fds" })).toBe(write);
    expect(withHome(moveHome("exe"), { slug: null, suggested: "staple" })).toEqual({ home: "exe" });
  });

  it("resetting returns both profiles to their shipped figures", () => {
    expect(resetProfiles()).toEqual({ reset: ["solo", "company"] });
    expect(moveHome("workshop")).toEqual({ home: "workshop" });
  });
});

describe("a refusal, as the field says it", () => {
  it("keeps the server's sentence and drops the setting name and the echoed value", () => {
    expect(refusalSentence(`workspace alpha: "analytics.solo" must be rates.design-engineer must be a number from 0 to 100000, got {"director":{"title":"You"}}`)).toBe("Rates.design-engineer must be a number from 0 to 100000.");
    expect(refusalSentence("Nothing is saved yet: name the workspace to save the cost model in (home). Suggested: none.")).toBe("Nothing is saved yet: name the workspace to save the cost model in (home). Suggested: none.");
  });
});
