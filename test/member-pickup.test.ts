/**
 * Who owns what and who did what, in a shared workspace: `ls --mine`, `inbox --mine`,
 * the member pickup rule on `queue next` / MCP `next_task` / the strict guard / runs, and
 * the member on an event.
 *
 * The member list is a fixture written with `writeMembersCache`, exactly the file the
 * CLI writes after `cloud members` or a sync, in an isolated staple home. No service is
 * involved: everything here reads the cache, and nothing may make a network call.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERS_CACHE_VERSION, writeMembersCache, type MembersCache } from "../src/core/cloud/members-cache.js";
import { resolveWorkspace } from "../src/core/workspace.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "mem";
const VP_MEMBER = "mem-vp";
const MARKO_MEMBER = "mem-marko";
const MARKO_DEVICE = "marko-thinkpad";

let home: string;
let emptyDir: string;
let repositoryId: string;
let localDevice: string;
let mcp: McpHarness;

async function cli(...args: string[]) {
  return await runCliAsync([...args, "--ws", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function cliJson<T = any>(...args: string[]): Promise<T> {
  const result = await cli(...args, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

function withDb<T>(fn: (db: ReturnType<typeof resolveWorkspace>["store"]) => T): T {
  const previous = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = home;
  const opened = resolveWorkspace({ ws: WS });
  try {
    return fn(opened.store);
  } finally {
    opened.store.db.close();
    if (previous === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previous;
  }
}

function cache(): MembersCache {
  return {
    version: MEMBERS_CACHE_VERSION,
    repositoryId,
    fetchedAt: "2026-11-06T12:00:00.000Z",
    self: { memberId: VP_MEMBER, deviceId: localDevice },
    members: [
      {
        memberId: VP_MEMBER,
        name: "VP",
        isOwner: true,
        removed: false,
        devices: [{ deviceId: localDevice, label: "mbp-16", lastSeenAt: 1, revoked: false }],
      },
      {
        memberId: MARKO_MEMBER,
        name: "marko",
        isOwner: false,
        removed: false,
        devices: [{ deviceId: MARKO_DEVICE, label: "thinkpad", lastSeenAt: 1, revoked: false }],
      },
    ],
  };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-member-pickup-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-member-pickup-cwd-"));
  expect((await runCliAsync(["init", "--global", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  // MEM-1 marko's · MEM-2 unassigned · MEM-3 VP's (in another case) · MEM-4 an agent's.
  expect((await cli("new", "Fix webhook retry", "--assignee", "marko")).status).toBe(0);
  expect((await cli("new", "Supabase RLS for inbox")).status).toBe(0);
  expect((await cli("new", "Retry backoff config", "--assignee", "vp")).status).toBe(0);
  expect((await cli("new", "Label suggestions", "--assignee", "claude-ab12")).status).toBe(0);

  withDb((store) => {
    const row = store.db.prepare("SELECT repository_id FROM sync_state WHERE id = 1").get() as { repository_id: string | null };
    repositoryId = row.repository_id ?? "";
    // A change marko's device made, as a sync would have applied it.
    store.db
      .prepare(
        `INSERT INTO events (kind, issue_id, actor, payload, dedup_key, created_at, origin_device, origin_seq)
         SELECT 'comment_added', id, 'codex-77', '{}', 'remote-1', '2026-11-06T11:00:00.000Z', ?, 1 FROM issues WHERE identifier = 'MEM-2'`,
      )
      .run(MARKO_DEVICE);
    const local = store.db.prepare("SELECT origin_device FROM events WHERE origin_device IS NOT ? LIMIT 1").get(MARKO_DEVICE) as
      | { origin_device: string | null }
      | undefined;
    localDevice = local?.origin_device ?? "this-machine";
  });
  expect(repositoryId).not.toBe("");

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("without a member list", () => {
  it("refuses --mine and the MCP mine parameter, naming how to get one", async () => {
    for (const command of [["ls", "--mine"], ["inbox", "--mine"]]) {
      const result = await cli(...command);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("staple cloud join");
    }
    const listed = await mcp.call("list_tasks", { ws: WS, mine: true });
    expect(listed.isError).toBe(true);
    expect(JSON.stringify(listed.content)).toContain("staple cloud join");
  });

  it("does not skip another member's ticket: no member list, no rule", async () => {
    expect((await cliJson("queue", "next")).next.identifier).toBe("MEM-1");
  });
});

describe("with a member list on this machine", () => {
  beforeAll(() => {
    writeMembersCache(home, cache());
  });

  it("queue next skips marko's ticket with the reason, and --any-assignee takes it", async () => {
    // Presentation order is MEM-1, MEM-3, MEM-4, MEM-2; marko's MEM-1 is stepped over, and
    // MEM-3, assigned to "vp", is this machine's member's own (names match case-insensitively).
    const answer = await cliJson("queue", "next");
    expect(answer.next.identifier).toBe("MEM-3");
    expect(answer.skipped).toHaveLength(1);
    expect(answer.skipped[0]).toMatchObject({
      identifier: "MEM-1",
      eligibility: "assigned_to_other_member",
      reason: "MEM-1 is assigned to marko, another member.",
      detail: { assignee: "marko", memberId: MARKO_MEMBER },
    });

    const text = await cli("queue", "next");
    expect(text.stdout).toContain("skipped  MEM-1     (assigned to marko)");
    expect(text.stdout).toContain("next     MEM-3");

    expect((await cliJson("queue", "next", "--any-assignee")).next.identifier).toBe("MEM-1");
    // A listing is not a pickup answer: it shows the plan as it is.
    const listing = await cliJson("queue", "ls", "--effective");
    expect(listing.effective.find((r: any) => r.identifier === "MEM-1").eligibility).toBe("eligible");
  });

  it("MCP next_task applies the same rule, and anyAssignee turns it off", async () => {
    const answer = toolPayload(await mcp.call("next_task", { ws: WS })) as any;
    expect(answer.next.identifier).toBe("MEM-3");
    expect(answer.skipped[0].eligibility).toBe("assigned_to_other_member");
    const any = toolPayload(await mcp.call("next_task", { ws: WS, anyAssignee: true })) as any;
    expect(any.next.identifier).toBe("MEM-1");
  });

  it("ls --mine and inbox --mine leave out marko's work and say so; self, unassigned and agents stay", async () => {
    const mine = (await cliJson("ls", "--mine")).map((i: any) => i.identifier);
    expect(mine.sort()).toEqual(["MEM-2", "MEM-3", "MEM-4"]);
    const lsText = await cli("ls", "--mine");
    expect(lsText.stdout).toContain("1 assigned to marko not shown");
    expect(lsText.stdout).not.toContain("MEM-1");

    const inbox = await cliJson("inbox", "--mine");
    expect(inbox.ready.map((i: any) => i.identifier)).toEqual(["MEM-3", "MEM-4", "MEM-2"]);
    const inboxText = await cli("inbox", "--mine");
    expect(inboxText.stdout).toContain("1 assigned to marko not shown");

    // Without --mine, everything, as before.
    expect((await cliJson("ls")).map((i: any) => i.identifier).sort()).toEqual(["MEM-1", "MEM-2", "MEM-3", "MEM-4"]);
  });

  it("MCP list_tasks and inbox take mine", async () => {
    const listed = toolPayload(await mcp.call("list_tasks", { ws: WS, mine: true })) as any;
    expect(listed.items.map((i: any) => i.identifier).sort()).toEqual(["MEM-2", "MEM-3", "MEM-4"]);
    const inbox = toolPayload(await mcp.call("inbox", { ws: WS, mine: true })) as any;
    expect(inbox.ready.map((i: any) => i.identifier)).toEqual(["MEM-3", "MEM-4", "MEM-2"]);
    const all = toolPayload(await mcp.call("list_tasks", { ws: WS })) as any;
    expect(all.items).toHaveLength(4);
  });

  it("names the member behind each event, from its origin device", async () => {
    const events = toolPayload(await mcp.call("events_since", { ws: WS })) as any;
    const list = (Array.isArray(events) ? events : events.items ?? events) as any[];
    const remote = list.find((e) => e.dedupKey === "remote-1");
    expect(remote.member).toEqual({ memberId: MARKO_MEMBER, name: "marko", removed: false });
    const local = list.find((e) => e.dedupKey !== "remote-1");
    expect(local.member).toEqual({ memberId: VP_MEMBER, name: "VP", removed: false });
  });

  it("a claim keeps a member's assignment; a non-member assignee is replaced as before", async () => {
    const show = async (ref: string) => (await cliJson("show", ref)).issue as { assignee: string | null; checkoutAgent: string | null };

    // MEM-3 is VP's ("vp"): an agent's checkout leaves it VP's, held by the agent.
    expect((await cli("checkout", "MEM-3", "--agent", "claude-ab12")).status).toBe(0);
    expect(await show("MEM-3")).toMatchObject({ assignee: "vp", checkoutAgent: "claude-ab12" });
    // A steal by another agent keeps it too.
    const stolen = await cli("checkout", "MEM-3", "--agent", "codex-77", "--steal-if-stale", "0s");
    expect(stolen.status, stolen.stderr).toBe(0);
    expect(await show("MEM-3")).toMatchObject({ assignee: "vp", checkoutAgent: "codex-77" });
    // Released, it is still VP's, so marko's pickup still skips it.
    expect((await cli("release", "MEM-3", "--agent", "codex-77")).status).toBe(0);
    expect(await show("MEM-3")).toMatchObject({ assignee: "vp", checkoutAgent: null });

    // MEM-4's assignee is an agent's handle, no member: the claim writes the claimer, as always.
    expect((await cli("checkout", "MEM-4", "--agent", "agent-one")).status).toBe(0);
    expect(await show("MEM-4")).toMatchObject({ assignee: "agent-one", checkoutAgent: "agent-one" });
    expect((await cli("release", "MEM-4", "--agent", "agent-one")).status).toBe(0);
  });

  it("under strict ordering, checkout takes what next answers, past marko's earlier ticket", async () => {
    expect((await cli("settings", "set", "queue.policy", "strict")).status).toBe(0);
    expect((await cli("queue", "add", "MEM-1")).status).toBe(0);
    expect((await cli("queue", "add", "MEM-2")).status).toBe(0);
    expect((await cliJson("queue", "next")).next.identifier).toBe("MEM-2");
    const checkout = await cli("checkout", "MEM-2", "--agent", CONTRACT_AGENT);
    expect(checkout.status, checkout.stderr).toBe(0);
  });

  it("run continue takes what next would, never marko's ticket", async () => {
    // The plan is MEM-1 (marko's), MEM-2 (held now), then the unqueued MEM-3 and MEM-4.
    expect((await cli("run", "start", "--scope", "queue", "--actor", "runner")).status).toBe(0);
    const answer = await cliJson("run", "continue", "--actor", "runner");
    expect(answer.action).toBe("take");
    expect(answer.ref).toBe("MEM-3");
  });
});
