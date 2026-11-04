/**
 * Milestone membership on the UI's own routes.
 *
 * Membership is a relation, not a parent link, so neither `ancestors` nor `parentId` carries
 * it. The list nests a parentless member under its milestone from `/api/issues`' direct
 * `milestoneId`; a detail names the milestone an issue counts toward (`milestone`, with the
 * ancestor it comes through as `via`); a milestone's own detail carries its plan.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
const ids: Record<string, { id: string; identifier: string }> = {};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-milestone-relationships-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const ws = initWorkspace({ global: true, slug: "plans" });
  ws.store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
  const milestone = ws.store.createIssue({ title: "October cut", kind: MILESTONE_KIND });
  const epic = ws.store.createIssue({ title: "Autopilot", kind: "epic" });
  const task = ws.store.createIssue({ title: "Scoped pickup", parent: epic.identifier });
  const loose = ws.store.createIssue({ title: "Not planned" });
  ws.store.milestones().update(milestone.identifier, { targetDate: "2026-10-11" }, "vp");
  ws.store.milestones().addMember(milestone.identifier, epic.identifier, {}, "vp");
  Object.assign(ids, { milestone, epic, task, loose });
  const db = ws.dbPath;
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  token = ui.token;
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("/api/issues", () => {
  it("sends each row's direct milestone, and null for everything else", async () => {
    const rows = await get<Array<{ issue: { identifier: string }; milestoneId: string | null }>>("/api/issues");
    const of = (identifier: string) => rows.find((row) => row.issue.identifier === identifier)!.milestoneId;
    expect(of(ids.epic!.identifier)).toBe(ids.milestone!.id);
    // Inherited membership is the tree's to draw: the task nests under its epic.
    expect(of(ids.task!.identifier)).toBeNull();
    expect(of(ids.loose!.identifier)).toBeNull();
    expect(of(ids.milestone!.identifier)).toBeNull();
  });
});

describe("/api/issue", () => {
  it("names a direct member's milestone, with no via", async () => {
    const detail = await get<{ milestone: unknown }>(`/api/issue?ref=${ids.epic!.identifier}`);
    expect(detail.milestone).toEqual({
      id: ids.milestone!.id,
      identifier: ids.milestone!.identifier,
      title: "October cut",
      status: "backlog",
      targetDate: "2026-10-11",
      via: null,
    });
  });

  it("names an inherited milestone and the ancestor it comes through", async () => {
    const detail = await get<{ milestone: { identifier: string; via: unknown } }>(`/api/issue?ref=${ids.task!.identifier}`);
    expect(detail.milestone.identifier).toBe(ids.milestone!.identifier);
    expect(detail.milestone.via).toEqual({ identifier: ids.epic!.identifier, title: "Autopilot" });
  });

  it("says null for work in no milestone", async () => {
    const detail = await get<{ milestone: unknown; milestonePlan: unknown }>(`/api/issue?ref=${ids.loose!.identifier}`);
    expect(detail.milestone).toBeNull();
    expect(detail.milestonePlan).toBeNull();
  });

  it("carries a milestone's own plan on its detail", async () => {
    const detail = await get<{
      milestone: unknown;
      milestonePlan: { milestone: { targetDate: string }; progress: { countable: number }; members: Array<{ identifier: string }> };
    }>(`/api/issue?ref=${ids.milestone!.identifier}`);
    expect(detail.milestone).toBeNull();
    expect(detail.milestonePlan.milestone.targetDate).toBe("2026-10-11");
    expect(detail.milestonePlan.members.map((member) => member.identifier)).toEqual([ids.epic!.identifier]);
    expect(detail.milestonePlan.progress.countable).toBe(1);
  });
});
