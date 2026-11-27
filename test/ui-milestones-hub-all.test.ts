/**
 * GET /api/milestones in hub mode with no `ws` reads every workspace, the way /api/issues and
 * /api/projects do, instead of falling back to whichever workspace sorts first. A workspace that
 * never ran `kinds add milestone` has no milestones to contribute: zero rows, not a refusal that
 * breaks the whole hub. Naming a workspace, or serving a single one, answers as before.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync } from "./fixtures/contract-support.js";

/** Sorts first in the hub (ORDER BY slug) and has no milestone kind. */
const BARE = "aaa-bare";
const BETA = "beta";
const GAMMA = "gamma";

let home: string;
const servers: UiHandle[] = [];

async function cli(...args: string[]): Promise<void> {
  const result = await runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
  expect(result.status, result.stderr).toBe(0);
}

async function serve(options: { hub: boolean; ws?: string }) {
  const ui = startUiServer({ port: 0, ...options });
  servers.push(ui);
  await once(ui.server, "listening");
  const origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  return async (path: string) => {
    const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
    return { status: response.status, body: (await response.json()) as unknown };
  };
}

type Row = { workspace?: string; milestone: { identifier: string } };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-ms-hub-all-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  await cli("init", "--no-planning", "--global", BARE);
  for (const ws of [BETA, GAMMA]) {
    await cli("init", "--no-planning", "--global", ws);
    await cli("kinds", "add", "milestone", "--label", "Milestone", "--ws", ws);
    await cli("milestone", "new", `${ws} cut`, "--ws", ws);
  }
}, 60_000);

afterAll(() => {
  for (const ui of servers) ui.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the milestones list in hub mode with no workspace named", () => {
  it("answers 200 with every workspace's milestones, each tagged, when the first workspace has no milestone kind", async () => {
    const get = await serve({ hub: true });
    const { status, body } = await get("/api/milestones");
    expect(status, JSON.stringify(body)).toBe(200);
    const rows = body as Row[];
    expect(rows.map((row) => [row.workspace, row.milestone.identifier])).toEqual([
      [BETA, "BET-1"],
      [GAMMA, "GAM-1"],
    ]);
    // `all=1` still reaches every store.
    expect(((await get("/api/milestones?all=1")).body as Row[]).map((row) => row.workspace)).toEqual([BETA, GAMMA]);
  });

  it("still refuses a named workspace without the kind, and answers a named one untagged as before", async () => {
    const get = await serve({ hub: true });
    expect((await get(`/api/milestones?ws=${BARE}`)).status).toBe(409);
    const named = await get(`/api/milestones?ws=${BETA}`);
    expect(named.status).toBe(200);
    expect((named.body as Row[]).map((row) => [row.workspace, row.milestone.identifier])).toEqual([[undefined, "BET-1"]]);
  });
});

describe("the milestones list when one workspace is served", () => {
  it("answers that workspace's milestones, untagged", async () => {
    const get = await serve({ hub: false, ws: GAMMA });
    const { status, body } = await get("/api/milestones");
    expect(status).toBe(200);
    expect((body as Row[]).map((row) => [row.workspace, row.milestone.identifier])).toEqual([[undefined, "GAM-1"]]);
  });

  it("refuses a served workspace without the kind, as before", async () => {
    const get = await serve({ hub: false, ws: BARE });
    expect((await get("/api/milestones")).status).toBe(409);
  });
});
