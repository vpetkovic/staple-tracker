/**
 * A blocker in another workspace carries its title on the web UI's detail, and nowhere else.
 *
 * The Connections tab names every related task by title. For a blocker in another workspace
 * the payload used to carry only the id, so the row read "ALP-1". `/api/issue` now asks the hub
 * for the titled rows; `crossBlockersOf`, which feeds MCP `get_task` and `/api/agent-context`
 * (pinned byte for byte to each other), is unchanged, and this file proves both halves.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let gateRef: string;
let consumerRef: string;
let missingRef: string;

function get(path: string) {
  return fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-cross-title-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const alpha = initWorkspace({ global: true, slug: "alpha" });
  const beta = initWorkspace({ global: true, slug: "beta" });
  const gamma = initWorkspace({ global: true, slug: "gamma" });
  const gate = alpha.store.createIssue({ title: "Publish the API contract", assignee: "opus-api" });
  const consumer = beta.store.createIssue({ title: "Use the API" });
  const gone = gamma.store.createIssue({ title: "Lives on another laptop" });
  gateRef = gate.identifier;
  consumerRef = consumer.identifier;
  missingRef = gone.identifier;
  alpha.store.updateIssue(gate.id, { status: "in_progress" });

  const hub = Hub.open();
  hub.addCrossLink(gateRef, consumerRef);
  hub.addCrossLink(missingRef, consumerRef);
  hub.close();
  alpha.store.db.close();
  beta.store.db.close();
  gamma.store.db.close();
  // The gamma file goes missing: its blocker is unresolvable, and has no title to give.
  rmSync(join(home, "workspaces", "gamma.db"));
  rmSync(join(home, "workspaces", "gamma.db-wal"), { force: true });
  rmSync(join(home, "workspaces", "gamma.db-shm"), { force: true });

  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("cross-workspace blocker titles", () => {
  it("/api/issue names the blocker by title and status, and a missing one as null", async () => {
    const res = await get(`/api/issue?ws=beta&ref=${consumerRef}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { crossBlockers: Array<Record<string, unknown>> };
    const byId = new Map(body.crossBlockers.map((row) => [row.identifier, row]));
    expect(byId.get(gateRef)).toEqual({
      identifier: gateRef,
      workspace: "alpha",
      status: "in_progress",
      resolved: false,
      unresolvable: false,
      title: "Publish the API contract",
    });
    expect(byId.get(missingRef)).toMatchObject({ status: null, unresolvable: true, title: null });
  });

  it("leaves the agent's payload exactly as it was: no title key", async () => {
    const res = await get(`/api/agent-context?ws=beta&ref=${consumerRef}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { crossBlockers: Array<Record<string, unknown>> };
    expect(body.crossBlockers).toHaveLength(2);
    for (const row of body.crossBlockers) {
      expect(Object.keys(row).sort()).toEqual(["identifier", "resolved", "status", "unresolvable", "workspace"]);
    }
  });

  it("keeps crossBlockersOf untitled and gives the same rows, titled, on request", () => {
    const hub = Hub.open();
    try {
      const plain = hub.crossBlockersOf(consumerRef);
      const titled = hub.crossBlockersWithTitles(consumerRef);
      expect(plain.every((row) => !("title" in row))).toBe(true);
      expect(titled.map(({ title: _title, ...rest }) => rest)).toEqual(plain);
    } finally {
      hub.close();
    }
  });
});
