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
