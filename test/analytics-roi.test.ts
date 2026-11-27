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
  roles: {
    roles: [
      { id: "engineer", title: "Engineer", hourlyRate: 100, billing: "subscription" as const },
      { id: "writer", title: "Writer", hourlyRate: 60, billing: "api" as const },
    ],
  },
  roleMapping: {
    types: { engineering: "engineer", design: "engineer", documentation: "writer", research: "engineer", orchestration: "engineer" },
    rules: [],
  },
};

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

describe("each bill follows the work billed that way", () => {
  beforeEach(() => {
    worked(alpha, "Build the importer", "2026-09-10T10:00:00.000Z");
    worked(beta, "Docs for the importer", "2026-09-11T10:00:00.000Z");
    writeCostModel(
      [alpha, beta],
      {
        ...MODEL,
        aiSpend: {
          entries: [
            { id: "plan", label: "Plan", monthlyAmount: 100, from: "2026-09", to: null },
            { id: "metered", label: "API", monthlyAmount: 500, from: "2026-09", to: null, kind: "api" },
          ],
        },
      },
      { scopeSlug: null, actor: "test", now: "2026-11-01T00:00:00.000Z", home },
    );
  });

  it("gives the hub every bill, each on the roles billed that way", () => {
    const roi = roiFor(scopeOf(alpha, beta), "2026-09-01", "2026-09-30");
    expect(roi.measured.aiCost).toBeCloseTo(600);
    expect(Object.fromEntries(roi.measured.byRole.map((role) => [role.roleId, [role.billing, Math.round(role.aiCost)]]))).toEqual({
      engineer: ["subscription", 100],
      writer: ["api", 500],
    });
  });

  it("charges a workspace only for the bills its own roles ran against", () => {
    const onAlpha = roiFor(scopeOf(alpha), "2026-09-01", "2026-09-30");
    const onBeta = roiFor(scopeOf(beta), "2026-09-01", "2026-09-30");
    expect(onAlpha.basis.shareByKind).toEqual({ subscription: 1, api: 0 });
    expect(onAlpha.measured.aiCost).toBeCloseTo(100);
    expect(onBeta.measured.aiCost).toBeCloseTo(500);
    // The two workspaces add up to the hub, and each one's rows add up to its own total.
    expect(onAlpha.measured.aiCost + onBeta.measured.aiCost).toBeCloseTo(600);
    for (const roi of [onAlpha, onBeta]) {
      expect(roi.measured.byRole.reduce((sum, role) => sum + role.aiCost, 0)).toBeCloseTo(roi.measured.aiCost);
    }
  });
});

describe("the missing API bill", () => {
  it("is raised for a month the API-billed work ran in that no API bill covers, or a bill of nothing", () => {
    worked(beta, "Docs for September", "2026-09-11T10:00:00.000Z");
    worked(beta, "Docs for October", "2026-10-11T10:00:00.000Z");
    const save = (entries: unknown[]) =>
      writeCostModel([alpha, beta], { ...MODEL, aiSpend: { entries: entries as never } }, { scopeSlug: null, actor: "test", now: "2026-11-01T00:00:00.000Z", home });
    const codes = () => roiFor(scopeOf(alpha, beta), "2026-09-01", "2026-10-31").caveats.map((caveat) => caveat.code);

    save([{ id: "metered", label: "API", monthlyAmount: 500, from: "2026-09", to: "2026-09", kind: "api" }]);
    expect(codes()).toContain("api_bill_missing");
    save([{ id: "metered", label: "API", monthlyAmount: 0, from: "2026-09", to: null, kind: "api" }]);
    expect(codes()).toContain("api_bill_missing");
    save([{ id: "metered", label: "API", monthlyAmount: 500, from: "2026-09", to: null, kind: "api" }]);
    expect(codes()).not.toContain("api_bill_missing");
  });
});

describe("moving the model", () => {
  it("carries spend entries as they were stored, without writing the default bill into them", () => {
    writeCostModel(
      [alpha, beta],
      { home: "alpha", aiSpend: { entries: [{ id: "plan", label: "Plan", monthlyAmount: 100, from: "2026-09", to: null }] } },
      { scopeSlug: null, actor: "test", now: "2026-11-01T00:00:00.000Z", home },
    );
    // Read with its bill...
    expect(readCostModel([alpha, beta], null, home).model.aiSpend.entries[0]!.kind).toBe("subscription");
    writeCostModel([alpha, beta], { home: "beta" }, { scopeSlug: null, actor: "test", now: "2026-11-01T00:01:00.000Z", home });
    // ...but stored as it was written, so a build that does not know `kind` still reads it.
    const stored = beta.store.db.prepare("SELECT value FROM meta WHERE key = 'setting:analytics.aiSpend'").get() as { value: string };
    expect(JSON.parse(stored.value).value.entries[0]).not.toHaveProperty("kind");
  });
});
