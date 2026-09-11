/**
 * The page writes by issue id, so the renumber guard never has to stop it.
 *
 * A write through a number an issue has left is refused for a day (`docs/sync.md`, "A
 * number that moved under a caller"), and the page has no way to acknowledge that. It does
 * not need one: every row it shows carries its id, and every write it makes names the id of
 * the row the reader acted on (`src/ui/app/src/lib/write-ref.ts`). Here, inside the window,
 * each write the page makes goes through and lands on the issue meant — built by the page's
 * own helpers from the rows the server gave it — where the same write by number is refused.
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { idsOf, pinnedRef } from "../src/ui/app/src/lib/write-ref.js";
import type { IssueRow } from "../src/ui/app/src/lib/types.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000187";

let fleet: Fleet | null = null;
let ui: UiHandle | null = null;
const previousDevice = process.env.STAPLE_DEVICE_ID;
afterEach(async () => {
  ui?.close();
  ui = null;
  fleet?.close();
  fleet = null;
  if (previousDevice === undefined) delete process.env.STAPLE_DEVICE_ID;
  else process.env.STAPLE_DEVICE_ID = previousDevice;
});

describe("the page's writes, inside the renumber window", () => {
  it("name the issue by id, go through, and land on the issue the reader acted on", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "The shared base" });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    const theirs = a.store.createIssue({ title: "A's second" });
    b.use();
    b.store.addKind({ id: "milestone", label: "Milestone" }, "vp");
    const mine = b.store.createIssue({ title: "B's second" });
    expect(mine.identifier).toBe("TRA-2");
    const milestone = b.store.getIssue(
      (b.store.milestones().create({ title: "M" }, "vp") as { milestone: { identifier: string } }).milestone.identifier,
    ).id;
    b.store.milestones().addMember(milestone, mine.id, {}, "vp");
    b.store.queue().enqueue(mine.id, {}, "vp");
    await a.sync();
    // B's issue moves off TRA-2, which is A's now.
    await b.sync();
    await a.sync();
    await b.sync();
    const moved = b.store.getIssue(mine.id).identifier;
    expect(moved).not.toBe("TRA-2");

    process.env.STAPLE_DEVICE_ID = b.deviceId;
    b.use();
    ui = startUiServer({ port: 0, hub: false, ws: "tracker" });
    await once(ui.server, "listening");
    const origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
    const headers = { "content-type": "application/json", "x-staple-token": ui.token, origin };
    const get = async <T>(path: string): Promise<T> => (await (await fetch(`${origin}${path}`, { headers })).json()) as T;
    const post = (path: string, body: Record<string, unknown>) =>
      fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify({ actor: "ui", ...body }) });

    // What the page holds.
    const rows = await get<IssueRow[]>("/api/issues");
    const queue = await get<{ revision: number; entries: Array<{ identifier: string; issueId: string }> }>("/api/queue");
    const view = await get<{ milestone: { id: string }; revision: number; members: Array<{ identifier: string; issueId: string }> }>(
      `/api/milestone?ref=${milestone}`,
    );

    // By number, the guard refuses — which the page must never meet.
    expect((await post("/api/action", { ref: "TRA-2", type: "comment", body: "by number" })).status).toBe(409);

    // By id, each goes through and lands on B's issue.
    const pinned = pinnedRef(rows, "tracker", moved);
    expect(pinned).toBe(mine.id);
    expect((await post("/api/action", { ref: pinned, type: "comment", body: "by id" })).status).toBe(200);
    expect(b.store.listComments(mine.id).map((comment) => comment.body)).toContain("by id");
    const entries = queue.entries.map((entry) => ({ identifier: entry.identifier, id: entry.issueId }));
    expect((await post("/api/queue/remove", { ref: idsOf(entries, [moved])[0], baseRevision: queue.revision })).status).toBe(200);
    expect(b.store.queue().entries().map((entry) => entry.identifier)).not.toContain(moved);
    const members = view.members.map((member) => ({ identifier: member.identifier, id: member.issueId }));
    expect(
      (await post("/api/milestone/remove", { milestone: view.milestone.id, ref: idsOf(members, [moved])[0], baseRevision: view.revision })).status,
    ).toBe(200);
    expect(b.store.milestones().milestoneOf(mine.id)).toBeNull();
    // A create whose parent and blocker the reader picked, by id.
    const created = await post("/api/action", {
      type: "create",
      title: "A child of B's second",
      parent: pinnedRef(rows, "tracker", moved),
      blockedBy: [pinnedRef(rows, "tracker", "TRA-2")],
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const child = (await created.json()) as { id: string; parentId: string };
    expect(child.parentId).toBe(mine.id);
    expect(b.store.blockersOf(child.id).map((row) => row.id)).toEqual([theirs.id]);
    // Its own workspace named as `<slug>:<id>` too, as a pick from another workspace's view would.
    const pinnedLocally = await post("/api/action", { type: "create", title: "Pinned by slug", parent: `tracker:${mine.id}` });
    expect(pinnedLocally.status, await pinnedLocally.clone().text()).toBe(200);
    expect(((await pinnedLocally.json()) as { parentId: string }).parentId).toBe(mine.id);
  }, 60_000);
});
