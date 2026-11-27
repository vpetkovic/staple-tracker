/**
 * WHAT THE QUEUE PAGE READS, over HTTP against the real server.
 *
 *   - Every queue answer, read or write, carries the workspace's `queue.policy`.
 *   - `pickup=1` applies the member rung `queue next` applies: in a shared workspace another
 *     member's ticket reads `assigned_to_other_member` with the store's reason, instead of
 *     `eligible` on a list whose next pick silently skips it. A write asked the same way
 *     answers the same way.
 *   - `GET /api/queues` is every workspace's plan, one section each, in hub mode; each section
 *     is exactly that workspace's `/api/queue` answer, so nothing is merged.
 *
 * The member list is the cache file `writeMembersCache` writes, as in member-pickup.test.ts.
 * Everything is scratch: STAPLE_HOME is a temp dir and the server is in-process on port 0.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERS_CACHE_VERSION, writeMembersCache } from "../src/core/cloud/members-cache.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let markos: string;
let free: string;
let other: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-queue-reads-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const shared = initWorkspace({ global: true, slug: "shared" });
  markos = shared.store.createIssue({ title: "Fix webhook retry", assignee: "marko" }).identifier;
  free = shared.store.createIssue({ title: "Supabase RLS for inbox" }).identifier;
  for (const ref of [markos, free]) shared.store.queue().enqueue(ref, {}, "vp");
  shared.store.setSetting("queue.policy", "strict", "vp");
  const { repository_id: repositoryId } = shared.store.db
    .prepare("SELECT repository_id FROM sync_state WHERE id = 1")
    .get() as { repository_id: string };
  shared.store.db.close();
  writeMembersCache(home, {
    version: MEMBERS_CACHE_VERSION,
    repositoryId,
    fetchedAt: "2026-11-06T12:00:00.000Z",
    self: { memberId: "mem-vp", deviceId: "this-machine" },
    members: [
      { memberId: "mem-vp", name: "VP", isOwner: true, removed: false, devices: [] },
      { memberId: "mem-marko", name: "marko", isOwner: false, removed: false, devices: [] },
    ],
  });

  const solo = initWorkspace({ global: true, slug: "solo" });
  other = solo.store.createIssue({ title: "Write the release notes" }).identifier;
  solo.store.queue().enqueue(other, {}, "vp");
  solo.store.db.close();

  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

async function get<T = any>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

async function post<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "x-staple-token": ui.token, "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

const eligibilityOf = (view: { effective: Array<{ identifier: string; eligibility: string; reason: string | null }> }, ref: string) =>
  view.effective.find((row) => row.identifier === ref);

describe("one workspace's queue", () => {
  it("names the workspace's policy on a read", async () => {
    expect((await get("/api/queue?ws=shared")).policy).toBe("strict");
    expect((await get("/api/queue?ws=solo")).policy).toBe("advisory");
  });

  it("marks another member's ticket with the store's reason when the read asks for the member rung", async () => {
    const plain = await get("/api/queue?ws=shared&all=1");
    expect(eligibilityOf(plain, markos)?.eligibility).toBe("eligible");
    const pickup = await get("/api/queue?ws=shared&all=1&pickup=1");
    expect(eligibilityOf(pickup, markos)).toMatchObject({
      eligibility: "assigned_to_other_member",
      reason: `${markos} is assigned to marko, another member.`,
    });
    expect(eligibilityOf(pickup, free)?.eligibility).toBe("eligible");
    // The list now agrees with the pickup answer: its first eligible row is `queue next`'s.
    const next = await get("/api/queue/next?ws=shared");
    expect(next.next.identifier).toBe(free);
    expect(pickup.effective.find((row: { eligibility: string }) => row.eligibility === "eligible").identifier).toBe(free);
  });

  it("answers a write the way the write asked to be read, policy included", async () => {
    const { revision } = await get("/api/queue?ws=shared");
    const answer = await post("/api/queue/reorder", {
      ws: "shared",
      order: [free, markos],
      baseRevision: revision,
      all: true,
      pickup: true,
    });
    expect(answer.entries.map((entry: { identifier: string }) => entry.identifier)).toEqual([free, markos]);
    expect(eligibilityOf(answer, markos)?.eligibility).toBe("assigned_to_other_member");
    expect(answer.policy).toBe("strict");
  });
});

describe("every workspace's queue", () => {
  it("answers one section per workspace, each the same as that workspace's own read", async () => {
    const hub = await get("/api/queues?all=1&pickup=1");
    expect(hub.failed).toEqual([]);
    expect(hub.workspaces.map((section: { slug: string }) => section.slug).sort()).toEqual(["shared", "solo"]);
    for (const slug of ["shared", "solo"]) {
      const section = hub.workspaces.find((candidate: { slug: string }) => candidate.slug === slug);
      const own = await get(`/api/queue?ws=${slug}&all=1&pickup=1`);
      const { slug: _slug, prefix, ...rest } = section;
      // The identifier prefix, which is what a section's rows are numbered with.
      expect(own.entries[0].identifier.startsWith(`${prefix}-`)).toBe(true);
      expect(rest).toEqual(own);
    }
  });

  it("answers one workspace's section when a ws is named", async () => {
    const hub = await get("/api/queues?ws=solo");
    expect(hub.workspaces.map((section: { slug: string }) => section.slug)).toEqual(["solo"]);
    expect(hub.workspaces[0].entries.map((entry: { identifier: string }) => entry.identifier)).toEqual([other]);
  });
});
