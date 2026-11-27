/**
 * The ROI read (`readRoi`) across two workspaces with roles billed two ways: each bill follows
 * the work billed that way, a single workspace carries only its share of each, and the
 * missing-API-bill caveat looks at the months API-billed work actually ran.
 *
 * Histories are written through real stores at controlled instants; the cost model is saved
 * and read through `home.ts`, as the server does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCostModel, writeCostModel, type HomeCandidate } from "../src/core/analytics/home.js";
import { readRoi, type AnalyticsScope } from "../src/core/analytics/service.js";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";

let home: string;
let alpha: HomeCandidate;
let beta: HomeCandidate;
const previousHome = process.env.STAPLE_HOME;

function candidate(slug: string): HomeCandidate {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  const prefix = slug.slice(0, 3).toUpperCase();
  return { slug, prefix, store: new WorkspaceStore(db, slug, prefix) };
}

/** One ticket worked for an hour starting at `startIso`. */
function worked(on: HomeCandidate, title: string, startIso: string): void {
  const start = Date.parse(startIso);
  vi.setSystemTime(start);
  const id = on.store.createIssue({ title }).id;
  on.store.checkoutIssue(id, `${on.slug}-agent`);
  vi.setSystemTime(start + 3_600_000);
  on.store.updateIssue(id, { status: "done" }, `${on.slug}-agent`);
}

const scopeOf = (...candidates: HomeCandidate[]): AnalyticsScope => ({
  kind: candidates.length > 1 ? "hub" : "workspace",
  sources: candidates.map((c) => ({ slug: c.slug, prefix: c.prefix, db: c.store.db })),
  refs: candidates.map((c) => ({ slug: c.slug, prefix: c.prefix, available: true })),
});

const MODEL = {
  home: "alpha",
  roles: { roles: [{ id: "engineer", title: "Engineer" }, { id: "writer", title: "Writer" }] },
  roleMapping: {
    types: { engineering: "engineer", design: "engineer", documentation: "writer", research: "engineer", orchestration: "engineer" },
    rules: [],
  },
};
const PROFILE = { director: { title: "You", hourlyRate: 100, hoursPerActiveDay: 8 }, rates: { engineer: 100, writer: 60 } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  home = mkdtempSync(join(tmpdir(), "staple-analytics-roi-"));
  process.env.STAPLE_HOME = home;
  alpha = candidate("alpha");
  beta = candidate("beta");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

function roiFor(scope: AnalyticsScope, from: string, to: string) {
  const hub = scopeOf(alpha, beta);
  return readRoi({
    scope: scope.kind === "hub" ? hub : scope,
    hub,
    query: { from, to, tz: "UTC", now: "2026-11-01T00:00:00.000Z" },
    model: readCostModel([alpha, beta], null, home),
  });
}

const save = (write: Record<string, unknown>) =>
  writeCostModel([alpha, beta], { ...MODEL, ...write } as never, { scopeSlug: null, actor: "test", now: "2026-11-01T00:00:00.000Z", home });

describe("each spend line lands whole where it is assigned", () => {
  beforeEach(() => {
    worked(alpha, "Build the importer", "2026-09-10T10:00:00.000Z");
    worked(beta, "Docs for the importer", "2026-09-11T10:00:00.000Z");
    save({
      solo: {
        ...PROFILE,
        entries: [
          { id: "writer-seats", label: "Writer seats", monthlyAmount: 100, quantity: 3, roleId: "writer", from: "2026-09", to: null },
          { id: "team-api", label: "Team API", kind: "api", monthlyAmount: 150, from: "2026-09", to: null },
        ],
      },
    });
  });

  it("puts a role's own lines on its row with the arithmetic, and the rest on the shared row", () => {
    const roi = roiFor(scopeOf(alpha, beta), "2026-09-01", "2026-09-30");
    expect(roi.measured.aiCost).toBeCloseTo(450);
    expect(roi.measured.sharedAiCost).toBeCloseTo(150);
    const writer = roi.measured.byRole.find((role) => role.roleId === "writer")!;
    expect(writer.aiEntries).toEqual([{ id: "writer-seats", label: "Writer seats", kind: "subscription", monthlyAmount: 100, quantity: 3, cost: expect.closeTo(300, 6) }]);
    expect(writer.aiCost).toBeCloseTo(300);
    expect(roi.measured.byRole.find((role) => role.roleId === "engineer")!.aiCost).toBe(0);
    expect(roi.measured.sharedAiEntries).toEqual([{ id: "team-api", label: "Team API", kind: "api", monthlyAmount: 150, quantity: null, cost: expect.closeTo(150, 6) }]);
    // The planned lens carries the same lines, and counts estimated tickets beside tickets.
    expect(roi.planned.byRole.find((role) => role.roleId === "writer")).toMatchObject({ tickets: 1, estimatedTickets: 0, aiCost: expect.closeTo(300, 6) });
  });

  it("charges a single workspace its share of every line, so workspaces add up to the hub", () => {
    const onAlpha = roiFor(scopeOf(alpha), "2026-09-01", "2026-09-30");
    const onBeta = roiFor(scopeOf(beta), "2026-09-01", "2026-09-30");
    expect(onAlpha.basis.share).toBeCloseTo(0.5);
    expect(onAlpha.measured.aiCost + onBeta.measured.aiCost).toBeCloseTo(450);
    // Alpha's writer did not run there, yet carries half the writer's seats: assigned spend is the role's, wherever it worked.
    expect(onAlpha.measured.byRole.find((role) => role.roleId === "writer")!.aiCost).toBeCloseTo(150);
    for (const roi of [onAlpha, onBeta]) {
      expect(roi.measured.byRole.reduce((sum, role) => sum + role.aiCost, 0) + roi.measured.sharedAiCost).toBeCloseTo(roi.measured.aiCost);
    }
  });
});

describe("no AI spend", () => {
  it("is said when the profile in use has nothing that costs anything in the period, as for a fresh company", () => {
    worked(alpha, "Build the importer", "2026-09-10T10:00:00.000Z");
    const codes = () => roiFor(scopeOf(alpha, beta), "2026-09-01", "2026-09-30").caveats.map((caveat) => caveat.code);
    // The shipped solo profile has one $200 subscription; a fresh company profile has none.
    expect(codes()).not.toContain("no_ai_spend");
    save({ scenario: { mode: "company", currency: "USD" } });
    expect(codes()).toContain("no_ai_spend");
    save({ company: { ...PROFILE, entries: [{ id: "seats", label: "Seats", monthlyAmount: 30, quantity: 0, from: "2026-09", to: null }] } });
    expect(codes()).toContain("no_ai_spend");
    save({ company: { ...PROFILE, entries: [{ id: "bill", label: "API bill", kind: "api", monthlyAmount: 500, from: "2026-09", to: null }] } });
    expect(codes()).not.toContain("no_ai_spend");
  });
});

describe("moving the model", () => {
  it("carries spend entries as they were stored, without writing the read-time defaults into them", () => {
    writeCostModel(
      [alpha, beta],
      { home: "alpha", solo: { ...PROFILE, entries: [{ id: "plan", label: "Plan", monthlyAmount: 100, from: "2026-09", to: null }] } },
      { scopeSlug: null, actor: "test", now: "2026-11-01T00:00:00.000Z", home },
    );
    // Read with its kind, quantity and role...
    expect(readCostModel([alpha, beta], null, home).model.solo.entries[0]).toMatchObject({ kind: "subscription", quantity: 1, roleId: null });
    writeCostModel([alpha, beta], { home: "beta" }, { scopeSlug: null, actor: "test", now: "2026-11-01T00:01:00.000Z", home });
    // ...but stored as it was written.
    const stored = beta.store.db.prepare("SELECT value FROM meta WHERE key = 'setting:analytics.solo'").get() as { value: string };
    const entry = JSON.parse(stored.value).value.entries[0];
    for (const field of ["kind", "quantity", "roleId"]) expect(entry).not.toHaveProperty(field);
  });
});
