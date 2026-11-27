/**
 * The cost model's storage (`src/core/analytics/home.ts`, option B on the Analytics epic):
 * four registered workspace settings in one home workspace, found from the data, written
 * atomically per workspace, moved whole, and synced to another device as ordinary `setting`
 * operations, with field-level conflicts per part.
 *
 * The first block runs on in-memory workspaces. The second runs two devices against the fake
 * sync service (`test/fixtures/sync-machines.ts`), the same harness every cloud test uses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCostModel, writeCostModel, type HomeCandidate } from "../src/core/analytics/home.js";
import { DEFAULT_COST_MODEL } from "../src/core/analytics/cost-model.js";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { settingRegistryView } from "../src/core/settings-registry.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const ROLES = { roles: [{ id: "engineer", title: "Engineer" }] };
const SCENARIO = { mode: "company" as const, currency: "USD" };
/** A company profile pricing the engineer at `rate`. */
const company = (rate = 70, over: Record<string, unknown> = {}) => ({
  director: { title: "Employee", hourlyRate: 85, hoursPerActiveDay: 6 },
  rates: { engineer: rate },
  entries: [],
  assumed: ["director.hoursPerActiveDay"],
  ...over,
});
const SPEND = (monthlyAmount: number, id = "api") => [{ id, label: "API", kind: "api" as const, monthlyAmount, from: "2026-09", to: null }];
const DEFAULT_SOURCE = { roles: "default", roleMapping: "default", scenario: "default", solo: "default", company: "default" };

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("on one machine", () => {
  let home: string;
  let candidates: HomeCandidate[];
  const previousHome = process.env.STAPLE_HOME;
  const at = (minute: number): string => new Date(Date.UTC(2026, 10, 27, 9, minute)).toISOString();
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "staple-cost-model-"));
    process.env.STAPLE_HOME = home;
    candidates = ["alpha", "beta"].map((slug) => {
      const db = openDb(":memory:");
      migrateWorkspace(db);
      return { slug, prefix: slug.slice(0, 3).toUpperCase(), store: new WorkspaceStore(db, slug, slug.slice(0, 3).toUpperCase()) };
    });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previousHome;
  });

  it("reads every part as an assumption before anything is saved, and suggests the page's workspace", () => {
    const response = readCostModel(candidates, "beta", home);
    expect(response.source).toEqual(DEFAULT_SOURCE);
    expect(response.model.scenario).toEqual({ ...DEFAULT_COST_MODEL.scenario });
    expect(response.model.solo.entries).toEqual(DEFAULT_COST_MODEL.solo.entries);
    expect(response.home).toEqual({ slug: null, prefix: null, synced: false, others: [], suggested: "beta" });
    expect(readCostModel(candidates, null, home).home.suggested).toBe("alpha");
  });

  it("refuses a first save that names no home, then saves where it is told and stamps savedAt", () => {
    expect(refusal(() => writeCostModel(candidates, { roles: ROLES }, { scopeSlug: null, actor: "ui", now: at(0), home })).message).toMatch(/name the workspace/);
    const { response, written } = writeCostModel(candidates, { home: "beta", roles: ROLES, scenario: SCENARIO, company: company() }, { scopeSlug: null, actor: "ui", now: at(1), home });
    expect(written).toEqual(["beta"]);
    expect(response.home).toMatchObject({ slug: "beta", others: [] });
    expect(response.source).toEqual({ ...DEFAULT_SOURCE, roles: "saved", scenario: "saved", company: "saved" });
    expect(response.model.roles).toEqual({ ...ROLES, assumed: [], savedAt: at(1) });
    expect(response.model.company).toMatchObject({ rates: { engineer: 70 }, assumed: ["director.hoursPerActiveDay"], savedAt: at(1) });
    // A later read on any scope finds the same home.
    expect(readCostModel(candidates, "alpha", home).home.slug).toBe("beta");
    // And the setting is an ordinary workspace setting there.
    expect(candidates[1]!.store.settingValue("analytics.roles")).toMatchObject({ source: "workspace", value: { roles: ROLES.roles } });
  });

  it("writes nothing when one part of a save is invalid", () => {
    writeCostModel(candidates, { home: "alpha", roles: ROLES, company: company(70) }, { scopeSlug: null, actor: "ui", now: at(0), home });
    const bad = company(70, { director: { title: "Employee", hourlyRate: 85, hoursPerActiveDay: 30 } });
    const error = refusal(() =>
      writeCostModel(candidates, { roles: { roles: [{ id: "engineer", title: "Renamed" }] }, company: bad }, { scopeSlug: null, actor: "ui", now: at(1), home }),
    );
    expect(error.code).toBe("validation");
    expect(error.message).toMatch(/hoursPerActiveDay/);
    expect(readCostModel(candidates, null, home).model.roles.roles[0]!.title).toBe("Engineer");
  });

  it("refuses a client-stamped savedAt and a reset of something that is not a part", () => {
    expect(refusal(() => writeCostModel(candidates, { home: "alpha", roles: { ...ROLES, savedAt: "x" } as never }, { scopeSlug: null, actor: "ui", now: at(0), home })).message).toMatch(/stamped by the server/);
    expect(refusal(() => writeCostModel(candidates, { home: "alpha", reset: ["rates" as never] }, { scopeSlug: null, actor: "ui", now: at(0), home })).message).toMatch(/not a part/);
    expect(refusal(() => writeCostModel(candidates, { home: "gamma", roles: ROLES }, { scopeSlug: null, actor: "ui", now: at(0), home })).code).toBe("not_found");
  });

  it("resets a part to its default", () => {
    writeCostModel(candidates, { home: "alpha", roles: ROLES, company: company() }, { scopeSlug: null, actor: "ui", now: at(0), home });
    const { response } = writeCostModel(candidates, { reset: ["company"] }, { scopeSlug: null, actor: "ui", now: at(1), home });
    expect(response.source.company).toBe("default");
    expect(response.model.company.director.hourlyRate).toBe(100);
    expect(response.source.roles).toBe("saved");
  });

  it("reads the newest save when two workspaces hold one, and names the other", () => {
    writeCostModel(candidates, { home: "alpha", roles: ROLES }, { scopeSlug: null, actor: "ui", now: at(0), home });
    candidates[1]!.store.setSetting("analytics.scenario", { ...SCENARIO, savedAt: at(5) }, "other-device");
    const response = readCostModel(candidates, null, home);
    expect(response.home).toMatchObject({ slug: "beta", others: [{ slug: "alpha", prefix: "ALP", savedAt: at(0) }] });
    // Each part is read from its own newest save, wherever it is: nothing alpha saved is hidden.
    expect(response.source).toEqual({ ...DEFAULT_SOURCE, roles: "saved", scenario: "saved" });
    expect(response.model.roles.roles).toEqual(ROLES.roles);
  });

  it("moves the whole model to another workspace and clears the old home", () => {
    writeCostModel(candidates, { home: "alpha", roles: ROLES, scenario: SCENARIO }, { scopeSlug: null, actor: "ui", now: at(0), home });
    const { response, written } = writeCostModel(candidates, { home: "beta", company: company(70, { entries: SPEND(900) }) }, { scopeSlug: null, actor: "ui", now: at(1), home });
    expect(written).toEqual(["beta", "alpha"]);
    expect(response.home).toMatchObject({ slug: "beta", others: [] });
    expect(response.source).toEqual({ ...DEFAULT_SOURCE, roles: "saved", scenario: "saved", company: "saved" });
    expect(response.model.roles.roles).toEqual(ROLES.roles);
    for (const key of ["analytics.roles", "analytics.scenario", "analytics.company"]) expect(candidates[0]!.store.settingValue(key).source).toBe("default");
  });

  it("resets a part everywhere, gathering every other part's newest save into the home", () => {
    writeCostModel(candidates, { home: "alpha", roles: ROLES }, { scopeSlug: null, actor: "ui", now: at(5), home });
    // An older save arrives by sync in another workspace: alpha stays the home.
    candidates[1]!.store.setSetting("analytics.solo", { ...DEFAULT_COST_MODEL.solo, entries: [{ id: "old", label: "Old", monthlyAmount: 9999, from: "2026-01", to: null }], savedAt: at(0) }, "sync");
    expect(readCostModel(candidates, null, home).home).toMatchObject({ slug: "alpha", others: [{ slug: "beta" }] });
    const { response, written } = writeCostModel(candidates, { reset: ["roles"] }, { scopeSlug: null, actor: "ui", now: at(6), home });
    expect(written).toEqual(["alpha", "beta"]);
    expect(response.source).toEqual({ ...DEFAULT_SOURCE, solo: "saved" });
    expect(response.model.roles.roles.map((role) => role.id)).toEqual(["software-engineer", "design-engineer", "technical-writer"]);
    // Beta held the only solo save: it moved into the home, and beta holds nothing any more.
    expect(response.model.solo.entries[0]!.monthlyAmount).toBe(9999);
    expect(response.home).toMatchObject({ slug: "alpha", others: [] });
    expect(candidates[1]!.store.settingValue("analytics.solo").source).toBe("default");
    // A second reset of that part leaves no older copy anywhere to come back.
    expect(writeCostModel(candidates, { reset: ["solo"] }, { scopeSlug: null, actor: "ui", now: at(7), home }).response.source).toEqual(DEFAULT_SOURCE);
  });

  it("moves the whole model into a workspace that holds a part of its own, keeping each part's newest save", () => {
    writeCostModel(candidates, { home: "alpha", roles: ROLES }, { scopeSlug: null, actor: "ui", now: at(5), home });
    candidates[1]!.store.setSetting("analytics.company", { ...company(999), director: { title: "Employee", hourlyRate: 999, hoursPerActiveDay: 6 }, savedAt: at(0) }, "sync");
    const { response } = writeCostModel(candidates, { home: "beta" }, { scopeSlug: null, actor: "ui", now: at(6), home });
    expect(response.home).toMatchObject({ slug: "beta", others: [] });
    // Beta's company profile is the only company save, so it stays; alpha's roles came along.
    expect(response.model.company.director.hourlyRate).toBe(999);
    expect(response.source).toEqual({ ...DEFAULT_SOURCE, roles: "saved", company: "saved" });
    expect(candidates[0]!.store.settingValue("analytics.roles").source).toBe("default");
  });

  it("ranks saves by the instant they name, and keeps a save with no stamp as the oldest home", () => {
    // 10:00+05:00 is 05:00Z, older than 07:00Z.
    candidates[0]!.store.setSetting("analytics.roles", { ...ROLES, savedAt: "2026-11-27T10:00:00+05:00" }, "cli");
    candidates[1]!.store.setSetting("analytics.roles", { ...ROLES, savedAt: "2026-11-27T07:00:00.000Z" }, "cli");
    expect(readCostModel(candidates, null, home).home.slug).toBe("beta");
    candidates[1]!.store.resetSetting("analytics.roles");
    candidates[1]!.store.setSetting("analytics.roles", { ...ROLES, savedAt: null }, "cli");
    candidates[0]!.store.resetSetting("analytics.roles");
    expect(readCostModel(candidates, null, home).home).toMatchObject({ slug: "beta", others: [] });
  });

  it("answers a read that is a valid write after roles are removed, and prices a role named like a built-in only by its own rate", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ id: `role-${index}`, title: `Role ${index}` }));
    writeCostModel(
      candidates,
      { home: "alpha", roles: { roles: many }, solo: { ...company(), rates: Object.fromEntries(many.map((role) => [role.id, 50])) } },
      { scopeSlug: null, actor: "ui", now: at(0), home },
    );
    // One role replaced: the read lists rates for exactly the 30 roles there are now.
    writeCostModel(candidates, { roles: { roles: [...many.slice(1), { id: "constructor", title: "Builder" }] } }, { scopeSlug: null, actor: "ui", now: at(1), home });
    const read = readCostModel(candidates, null, home);
    expect(Object.keys(read.model.solo.rates)).toHaveLength(30);
    expect(read.model.solo.rates.constructor).toBe(100);
    expect(read.model.solo.assumed).toContain("roles.constructor.hourlyRate");
    // Echoed back as it was read, it saves.
    const { savedAt: _savedAt, ...echo } = read.model.solo;
    expect(() => writeCostModel(candidates, { solo: echo as never }, { scopeSlug: null, actor: "ui", now: at(2), home })).not.toThrow();
  });

  it("refuses a malformed write by name rather than failing on it", () => {
    for (const body of [null, [], { reset: 5 }, { reset: "roles" }, { reset: [{}] }, { home: 7 }]) {
      expect(refusal(() => writeCostModel(candidates, body as never, { scopeSlug: null, actor: "ui", now: at(0), home })).code, JSON.stringify(body)).toBe("validation");
    }
  });

  it("keeps the workspace working when a synced part cannot be read, refusing only that part", () => {
    // A newer build's value: a field this build does not know.
    candidates[0]!.store.db
      .prepare("INSERT INTO meta (key, value) VALUES ('setting:analytics.roles', ?)")
      .run(JSON.stringify({ v: 1, value: { roles: [{ id: "a", title: "A", currency: "EUR" }], savedAt: at(0) } }));
    candidates[0]!.store.db.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'settings_revision'").run();
    const store = candidates[0]!.store;
    expect(store.getSetting("queue.policy")).toBe("advisory");
    expect(store.createIssue({ title: "Still works" }).title).toBe("Still works");
    expect(refusal(() => store.settingValue("analytics.roles")).message).toMatch(/unknown field "currency"/);
    // The listing (and the Settings screen it feeds) still works, and says which row it could not read.
    expect(store.settingValues().map((value) => value.key)).not.toContain("analytics.roles");
    expect(store.unknownSettingKeys()).toEqual(["analytics.roles"]);
    // Only alpha holds anything, so it is the home and the model cannot be read whole: refused, not mixed with a default.
    expect(refusal(() => readCostModel(candidates, null, home)).code).toBe("validation");
    // Elsewhere, a newer save takes over and the unreadable row in alpha is neither read nor reset.
    writeCostModel(candidates, { home: "beta", roles: ROLES }, { scopeSlug: null, actor: "ui", now: at(9), home });
    // Alpha still holds an older save this build cannot read: named, never reset.
    expect(readCostModel(candidates, null, home).home).toMatchObject({ slug: "beta", others: [{ slug: "alpha", savedAt: at(0) }] });
    expect(store.unknownSettingKeys()).toEqual(["analytics.roles"]);
    // Resetting the row is the repair.
    store.resetSetting("analytics.roles");
    expect(store.settingValue("analytics.roles").source).toBe("default");
    expect(store.unknownSettingKeys()).toEqual([]);
  });

  it("keeps the cost model out of the Settings screen's registry, but in the workspace's settings", () => {
    const view = settingRegistryView();
    expect(view.categories.map((category) => category.id)).not.toContain("analytics");
    expect(view.definitions.map((definition) => definition.key).filter((key) => key.startsWith("analytics."))).toEqual([]);
    expect(candidates[0]!.store.settingValues().map((value) => value.key)).toEqual(
      expect.arrayContaining(["analytics.roles", "analytics.roleMapping", "analytics.scenario", "analytics.solo", "analytics.company"]),
    );
  });
});

describe("across devices", () => {
  const REPO = "5eed0000-0000-4000-8000-000000000575";
  let fleet: Fleet | null = null;
  afterEach(() => {
    fleet?.close();
    fleet = null;
  });
  const only = (machine: { store: WorkspaceStore }): HomeCandidate[] => [{ slug: "tracker", prefix: "TRA", store: machine.store }];
  const save = (machine: { store: WorkspaceStore; home: string; use(): void }, write: Parameters<typeof writeCostModel>[1], now: string) => {
    machine.use();
    return writeCostModel(only(machine), { home: "tracker", ...write }, { scopeSlug: null, actor: "ui", now, home: machine.home }).response;
  };

  it("reaches a second device through cloud sync, and says the home syncs", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    const saved = save(a, { roles: ROLES, scenario: SCENARIO, company: company() }, "2026-11-27T09:00:00.000Z");
    expect(saved.home.synced).toBe(true);
    await a.sync();
    await b.sync();
    b.use();
    const onB = readCostModel(only(b), null, b.home);
    expect(onB.source).toEqual({ ...DEFAULT_SOURCE, roles: "saved", scenario: "saved", company: "saved" });
    expect(onB.model).toEqual(saved.model);
    // A device that hydrates afterwards holds the same model.
    const c = fleet.machine("c");
    await c.sync();
    c.use();
    expect(readCostModel(only(c), null, c.home).model).toEqual(saved.model);
  });

  it("keeps the two profiles apart: editing the company on one device and just me on another merges, and neither changes the other", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    save(a, { roles: ROLES }, "2026-11-27T09:00:00.000Z");
    await a.sync();
    await b.sync();
    save(a, { company: company(120) }, "2026-11-27T09:05:00.000Z");
    save(b, { solo: { ...company(40), director: { title: "You", hourlyRate: 100, hoursPerActiveDay: 8 }, entries: SPEND(900) } }, "2026-11-27T09:06:00.000Z");
    await a.sync();
    await b.sync();
    await a.sync();
    for (const machine of [a, b]) {
      machine.use();
      const model = readCostModel(only(machine), null, machine.home);
      expect(model.model.company.rates.engineer, machine.label).toBe(120);
      expect(model.model.company.entries, machine.label).toEqual([]);
      expect(model.model.solo.rates.engineer, machine.label).toBe(40);
      expect(model.model.solo.entries[0]!.monthlyAmount, machine.label).toBe(900);
      expect(listConflicts(machine.db).filter((conflict) => conflict.entity === "setting"), machine.label).toEqual([]);
    }
  });

  it("keeps both values when two devices change the same part, refuses a save over it, and converges on the one chosen", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    save(a, { roles: ROLES }, "2026-11-27T09:00:00.000Z");
    await a.sync();
    await b.sync();
    save(a, { company: company(120) }, "2026-11-27T09:05:00.000Z");
    save(b, { company: company(60) }, "2026-11-27T09:06:00.000Z");
    await a.sync();
    await b.sync();
    await a.sync();
    a.use();
    const open = listConflicts(a.db).filter((conflict) => conflict.entity === "setting" && conflict.entityId === "analytics.company");
    expect(open).toHaveLength(1);
    // Neither value was silently dropped: A still holds its own, and the record holds B's.
    expect(readCostModel(only(a), null, a.home).model.company.rates.engineer).toBe(120);
    expect((open[0]!.remoteValue as { rates: Record<string, number> }).rates.engineer).toBe(60);
    // A save over the open conflict is refused; an unrelated part still saves.
    const error = refusal(() => save(a, { company: company(70) }, "2026-11-27T09:10:00.000Z"));
    expect(error.code).toBe("conflict");
    expect(save(a, { scenario: SCENARIO }, "2026-11-27T09:10:00.000Z").source.scenario).toBe("saved");

    resolveConflict(a.db, { id: open[0]!.id, choice: "remote", actor: "VP" });
    await a.sync();
    await b.sync();
    for (const machine of [a, b]) {
      machine.use();
      expect(readCostModel(only(machine), null, machine.home).model.company.rates.engineer, machine.label).toBe(60);
    }
  });

  it("refuses to move the model away from a home with an open conflict", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    save(a, { roles: ROLES }, "2026-11-27T09:00:00.000Z");
    await a.sync();
    await b.sync();
    save(a, { company: company(120) }, "2026-11-27T09:05:00.000Z");
    save(b, { company: company(60) }, "2026-11-27T09:06:00.000Z");
    await a.sync();
    await b.sync();
    await a.sync();
    a.use();
    expect(listConflicts(a.db).filter((conflict) => conflict.entityId === "analytics.company")).toHaveLength(1);
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const local: HomeCandidate = { slug: "local", prefix: "LOC", store: new WorkspaceStore(db, "local", "LOC") };
    const error = refusal(() => writeCostModel([...only(a), local], { home: "local" }, { scopeSlug: null, actor: "ui", now: "2026-11-27T09:10:00.000Z", home: a.home }));
    expect(error.code).toBe("conflict");
    expect(local.store.settingValue("analytics.company").source).toBe("default");
    expect(a.store.settingValue("analytics.company").source).toBe("workspace");
  });

  it("keeps a moved model whole when another device saves one profile in the old home meanwhile", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    save(a, { roles: ROLES, solo: { ...company(40), director: { title: "You", hourlyRate: 100, hoursPerActiveDay: 8 } } }, "2026-11-27T09:00:00.000Z");
    await a.sync();
    await b.sync();
    // A moves the whole model to a workspace only it has; B, not knowing, saves the company profile in the old home.
    a.use();
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const local: HomeCandidate = { slug: "local", prefix: "LOC", store: new WorkspaceStore(db, "local", "LOC") };
    writeCostModel([...only(a), local], { home: "local" }, { scopeSlug: null, actor: "ui", now: "2026-11-27T09:05:00.000Z", home: a.home });
    save(b, { company: company(120) }, "2026-11-27T09:06:00.000Z");
    await a.sync();
    await b.sync();
    await a.sync();
    a.use();
    const onA = readCostModel([...only(a), local], null, a.home);
    // B's company edit is there, and so is everything A moved: nothing blanked, the solo profile untouched.
    expect(onA.model.company.rates.engineer).toBe(120);
    expect(onA.model.roles.roles).toEqual(ROLES.roles);
    expect(onA.model.solo.rates.engineer).toBe(40);
    expect(onA.source).toEqual({ ...DEFAULT_SOURCE, roles: "saved", solo: "saved", company: "saved" });
  });

  it("carries a reset to the other device, and a later save after it", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    save(a, { scenario: SCENARIO }, "2026-11-27T09:00:00.000Z");
    await a.sync();
    await b.sync();
    a.use();
    writeCostModel(only(a), { reset: ["scenario"] }, { scopeSlug: null, actor: "ui", now: "2026-11-27T09:01:00.000Z", home: a.home });
    await a.sync();
    await b.sync();
    b.use();
    expect(readCostModel(only(b), null, b.home).source.scenario).toBe("default");
    save(b, { scenario: { ...SCENARIO, mode: "solo" } }, "2026-11-27T09:02:00.000Z");
    await b.sync();
    await a.sync();
    a.use();
    expect(readCostModel(only(a), null, a.home).model.scenario.mode).toBe("solo");
  });
});
