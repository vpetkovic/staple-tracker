/**
 * `GET /api/run` on a hub: a link to a run names only the run, and the server finds the
 * workspace it lives in. The stopped run an Attention row names on All workspaces opens the
 * same run.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let runId: string;

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-run-hub-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  // Registered first, and unreadable: its runs table is gone (fixture).
  const broken = initWorkspace({ global: true, slug: "broken" }).store;
  broken.db.exec("DROP TABLE run_tickets; DROP TABLE runs;");
  broken.db.close();
  initWorkspace({ global: true, slug: "app" }).store.db.close();
  const web = initWorkspace({ global: true, slug: "web" }).store;
  try {
    const epic = web.createIssue({ title: "Checkout flow", kind: "epic" });
    web.createIssue({ title: "Card form", parent: epic.identifier, status: "todo" });
    const runs = web.runs();
    runId = runs.start({ actor: "bot", scope: epic.identifier }).id;
    runs.continue({ actor: "bot" });
    runs.continue({ actor: "bot", outcome: "failed", reason: "one" });
    runs.continue({ actor: "bot", outcome: "failed", reason: "two" });
  } finally {
    web.db.close();
  }
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => (ui ? ui.server.close(() => resolve()) : resolve()));
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/run on a hub", () => {
  it("finds the run in whichever workspace holds it when no workspace is named, past one it cannot read", async () => {
    const { status, body } = await get(`/api/run?id=${runId}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ workspace: "web", title: "Checkout flow", run: { id: runId, state: "stopped", stop: { reason: "failure_streak" } } });
  });

  it("opens the run a stopped-run Attention row names", async () => {
    const attention = await get("/api/attention");
    const row = attention.body.rows.find((candidate: { kind: string }) => candidate.kind === "run_stopped");
    expect(row).toMatchObject({ workspace: "web", runId });
    expect((await get(`/api/run?id=${row.runId}&ws=${row.workspace}`)).body.run.id).toBe(runId);
  });

  it("looks only in a named workspace", async () => {
    expect((await get(`/api/run?id=${runId}&ws=web`)).status).toBe(200);
    const elsewhere = await get(`/api/run?id=${runId}&ws=app`);
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.body.message).toContain("in app");
    // Named, the unreadable workspace says why rather than "not found".
    const unreadable = await get(`/api/run?id=${runId}&ws=broken`);
    expect([404, 200]).not.toContain(unreadable.status);
    expect(unreadable.body.message).not.toContain("No autopilot run");
  });
});
