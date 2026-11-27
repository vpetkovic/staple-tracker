/**
 * The Analytics routes over HTTP, in hub mode: `/api/analytics` answers the same report the
 * core read gives for the same workspaces, scopes to one workspace by slug, names a registered
 * workspace it could not open, and refuses a bad query with the server's envelope.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAnalytics } from "../src/core/analytics/service.js";
import { setClock } from "../src/core/types.js";
import { initWorkspace, resolveWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let ghostPath: string;

async function http(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-staple-token": token, origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const QUERY = "from=2026-09-01&to=2026-09-07&tz=America/New_York";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-analytics-http-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  let clock = T0;
  setClock(() => clock);
  const at = (minutes: number): void => void (clock = T0 + minutes * 60_000);
  for (const slug of ["alpha", "beta"]) {
    const ws = initWorkspace({ global: true, slug });
    const store = ws.store;
    for (let n = 0; n < (slug === "alpha" ? 2 : 1); n += 1) {
      at(n * 100);
      const id = store.createIssue({ title: slug === "beta" ? "Docs for the API" : `Build ${n}`, estimatedSeconds: 7200 }).id;
      store.checkoutIssue(id, `${slug}-worker`, undefined, { attempt: { harness: "claude_code", model: "claude-opus-5-5" } });
      at(n * 100 + 60);
      store.updateIssue(id, { status: "done" }, `${slug}-worker`);
    }
    store.db.close();
  }
  const ghost = initWorkspace({ global: true, slug: "ghost" });
  ghostPath = ghost.dbPath;
  ghost.store.db.close();
  rmSync(ghostPath, { force: true });
  setClock(null);

  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (ui ? ui.server.close(() => resolve()) : resolve()));
  rmSync(home, { recursive: true, force: true });
});

const withoutAsOf = ({ asOf: _asOf, ...rest }: { asOf: string }): Record<string, unknown> => rest;

describe("GET /api/analytics", () => {
  it("answers the hub with the core read's report, and names the workspace it could not open", async () => {
    const { status, body } = await http(`/api/analytics?${QUERY}`);
    expect(status).toBe(200);
    expect(body.scope).toEqual({
      kind: "hub",
      workspaces: [
        { slug: "alpha", prefix: "ALP", available: true },
        { slug: "beta", prefix: "BET", available: true },
        { slug: "ghost", prefix: "GHO", available: false },
      ],
    });
    expect(body.headline).toMatchObject({ done: 3, agentHours: 3, plannedHours: 6 });
    expect(body.caveats).toContainEqual({ code: "workspace_unavailable", count: 1, of: 3 });
    expect(body.agentTypes.map((row: { type: string; attempts: number }) => [row.type, row.attempts])).toEqual([
      ["engineering", 2],
      ["documentation", 1],
    ]);

    const alpha = resolveWorkspace({ ws: "alpha" });
    const beta = resolveWorkspace({ ws: "beta" });
    try {
      const core = readAnalytics(
        {
          kind: "hub",
          sources: [
            { slug: "alpha", prefix: "ALP", db: alpha.store.db },
            { slug: "beta", prefix: "BET", db: beta.store.db },
          ],
          refs: body.scope.workspaces,
        },
        { from: "2026-09-01", to: "2026-09-07", tz: "America/New_York", now: body.asOf },
      );
      expect(withoutAsOf(body)).toEqual(withoutAsOf(JSON.parse(JSON.stringify(core))));
    } finally {
      alpha.store.db.close();
      beta.store.db.close();
    }
  });

  it("scopes to one workspace by slug", async () => {
    const { status, body } = await http(`/api/analytics?scope=beta&${QUERY}`);
    expect(status).toBe(200);
    expect(body.scope).toEqual({ kind: "workspace", workspaces: [{ slug: "beta", prefix: "BET", available: true }] });
    expect(body.headline.done).toBe(1);
  });

  it("refuses a bad query with the server's envelope, and an unknown workspace as not found", async () => {
    const zone = await http(`/api/analytics?tz=Mars/Olympus`);
    expect(zone.status).toBe(409);
    expect(zone.body).toMatchObject({ code: "validation", message: expect.stringMatching(/IANA/) });
    const inverted = await http(`/api/analytics?from=2026-09-05&to=2026-09-01`);
    expect(inverted.status).toBe(409);
    expect((await http(`/api/analytics?scope=nowhere`)).status).toBe(404);
  });

  it("is a read: a POST is refused", async () => {
    expect((await http(`/api/analytics`, {})).status).toBe(405);
  });
});

describe("the cost model over HTTP", () => {
  it("reads defaults, saves to the suggested home, and refuses a write from a foreign page", async () => {
    const before = await http(`/api/analytics/cost-model?scope=beta`);
    expect(before.status).toBe(200);
    expect(before.body.home).toMatchObject({ slug: null, suggested: "beta" });
    expect(before.body.model.roles.assumed).toEqual(["roles.software-engineer.hourlyRate", "roles.design-engineer.hourlyRate", "roles.technical-writer.hourlyRate"]);

    const foreign = await fetch(`${origin}/api/analytics/cost-model`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
      body: JSON.stringify({ home: "beta", roles: { roles: [{ id: "engineer", title: "Engineer", hourlyRate: 1 }] } }),
    });
    expect([401, 403]).toContain(foreign.status);

    const saved = await http(`/api/analytics/cost-model?scope=beta`, {
      home: "beta",
      roles: { roles: [{ id: "engineer", title: "Engineer", hourlyRate: 70 }, { id: "writer", title: "Writer", hourlyRate: 50 }] },
      roleMapping: { types: { engineering: "engineer", design: "engineer", documentation: "writer", research: "engineer", orchestration: "engineer" }, rules: [{ title: "build", roleId: "writer" }] },
      scenario: { mode: "solo", currency: "USD", director: { title: "You", hourlyRate: 100, hoursPerActiveDay: 8 }, assumed: ["director.hoursPerActiveDay"] },
      aiSpend: { entries: [{ id: "plan", label: "Plan", monthlyAmount: 300, from: "2026-09", to: null }] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.home).toMatchObject({ slug: "beta", synced: false });
    expect(saved.body.source).toEqual({ roles: "saved", roleMapping: "saved", scenario: "saved", aiSpend: "saved" });
    expect((await http(`/api/analytics/cost-model?scope=alpha`)).body.home.slug).toBe("beta");

    expect((await http(`/api/analytics/cost-model`, { reset: 5 })).status).toBe(409);
    expect((await http(`/api/analytics/cost-model`, null)).status).toBe(409);
    const bad = await http(`/api/analytics/cost-model`, { roles: { roles: [] } });
    expect(bad.status).toBe(409);
    expect(bad.body).toMatchObject({ code: "validation", message: expect.stringMatching(/1 to 30/) });
  });

  it("applies the saved rules to the metrics, prices the ROI against the hub's costs, and lists the tickets behind a role", async () => {
    // The rule `title: build → writer` now prices alpha's two "Build n" tickets at the writer role.
    const roi = await http(`/api/analytics/roi?scope=alpha&${QUERY}`);
    expect(roi.status).toBe(200);
    expect(roi.body.measured.byRole).toEqual([
      expect.objectContaining({ roleId: "writer", hours: 2, value: 100, tickets: 2, plannedTickets: null }),
    ]);
    expect(roi.body.planned.byRole).toEqual([expect.objectContaining({ roleId: "writer", hours: 4, tickets: 2, plannedTickets: 2 })]);
    // Alpha ran 2 of the hub's 3 agent-hours: it carries two thirds of a week of $300/month and of 2 active days × 8 h.
    expect(roi.body.basis).toMatchObject({ share: 2 / 3, scopeAgentHours: 2, hubAgentHours: 3, activeDaysHub: 1, hoursPerActiveDay: 8, directorHoursHub: 8 });
    expect(roi.body.basis.aiSpendHub).toBeCloseTo(70);
    expect(roi.body.measured.aiCost).toBeCloseTo(70 * (2 / 3));
    expect(roi.body.measured.director).toMatchObject({ hours: 8 * (2 / 3), hourlyRate: 100 });
    expect(roi.body.caveats.map((caveat: { code: string }) => caveat.code)).toContain("home_not_synced");

    const hub = await http(`/api/analytics/roi?${QUERY}`);
    expect(hub.body.basis.share).toBe(1);
    expect(hub.body.measured.aiCost).toBeCloseTo(70);

    const tickets = await http(`/api/analytics/roi/tickets?scope=alpha&roleId=writer&${QUERY}`);
    expect(tickets.status).toBe(200);
    expect(tickets.body).toMatchObject({ roleId: "writer", total: 2, limit: 200, otherAgentHours: 0 });
    expect(tickets.body.tickets.map((t: { title: string; reason: { code: string } }) => [t.title, t.reason.code])).toEqual([
      ["Build 0", "rule"],
      ["Build 1", "rule"],
    ]);
    expect((await http(`/api/analytics/roi/tickets?scope=alpha&${QUERY}`)).status).toBe(409);
    expect((await http(`/api/analytics/roi/tickets?scope=alpha&roleId=writer&limit=abc&${QUERY}`)).status).toBe(409);
    expect((await http(`/api/analytics/roi/tickets?scope=alpha&roleId=writer&limit=1&${QUERY}`)).body.tickets).toHaveLength(1);

    const metrics = await http(`/api/analytics?scope=alpha&${QUERY}`);
    expect(metrics.body.agents[0].reason).toEqual({ code: "rule", detail: "0" });
  });
});
