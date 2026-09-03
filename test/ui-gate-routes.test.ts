/**
 * Q2 (STA-144) — the `/api/gate` route family, over real HTTP against a real store.
 *
 * Q1 put the whole gate model in `core/store.ts` and gave it a CLI and three MCP tools.
 * The web UI had no way to reach any of it: `/api/action` is a closed set of `type`
 * branches and every one of them is a write the store would REFUSE on a gated issue.
 * These three routes are that missing surface, and nothing more — they call Q1's
 * methods, they re-word nothing, and every refusal below is the store's own sentence
 * arriving with its own code.
 *
 * Four things are worth pinning, and they are the four ways this goes wrong:
 *
 *   1. THE ROUTES ARE WRITES AND MUST BE GATED LIKE ONE. `/api/action` was the only
 *      POST this server had, and the method/Origin check was written as a comparison
 *      against that literal path. A new POST route that fell through it would be a
 *      cross-origin-writable endpoint on a loopback server that holds the whole tracker.
 *   2. REFUSALS ARRIVE AS REFUSALS. A gate is a policy surface: "you cannot gate a leaf"
 *      and "a comment is required" are the product, not errors to swallow. They must
 *      reach the page as 409 with the store's `code`, exactly as every other refusal on
 *      this server does.
 *   3. THE RESPONSE REFRESHES THE PANEL. Each route answers with the same payload
 *      `/api/issue` sends, so the detail panel can render the result of the click
 *      without a second round trip that could observe a different database state.
 *   4. `/api/agent-context` IS UNTOUCHED. `test/ui-agent-context.test.ts` asserts deep
 *      equality between that route and the MCP `get_task` tool. Nothing here may add a
 *      field to it, and the assertion at the bottom of this file says so out loud.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace, openWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let dbPath: string;

interface Envelope {
  error: string;
  message: string;
  code: string;
  retryable: boolean;
}

/** POST a gate route the way the browser does: same-origin, JSON, token header. */
async function gate(
  route: "request" | "approve" | "request-changes",
  body: Record<string, unknown>,
  init: { origin?: string | null; method?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "x-staple-token": token,
    "content-type": "application/json",
  };
  const sendOrigin = init.origin === undefined ? origin : init.origin;
  if (sendOrigin) headers.origin = sendOrigin;
  const res = await fetch(`${origin}/api/gate/${route}`, {
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function detail(ref: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${origin}/api/issue?ref=${ref}`, { headers: { "x-staple-token": token } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * A fresh epic with two children, per test. Gates are stateful — one gate at a time
 * per issue, and approving is irreversible — so a shared fixture would make every
 * test depend on the order the others ran in.
 */
function scenario(name: string): { epic: string; a: string; b: string } {
  // The SAME database the server is serving — a second connection, not a second
  // workspace. The server resolves refs against one file, so an epic created
  // anywhere else is a 404 rather than a fixture.
  const ws = openWorkspace(dbPath);
  const epic = ws.store.createIssue({ title: `${name} epic` });
  const a = ws.store.createIssue({ title: `${name} child a`, parent: epic.identifier });
  const b = ws.store.createIssue({ title: `${name} child b`, parent: epic.identifier });
  ws.store.db.close();
  return { epic: epic.identifier, a: a.identifier, b: b.identifier };
}

/** The shared fixture, plus the one leaf every "you cannot gate this" test points at. */
let fixture: { epic: string; a: string; b: string; leaf: string };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-gate-routes-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const ws = initWorkspace({ global: true, slug: "gates" });
  dbPath = ws.dbPath;
  const epic = ws.store.createIssue({ title: "The epic under test" });
  const a = ws.store.createIssue({ title: "child a", parent: epic.identifier });
  const b = ws.store.createIssue({ title: "child b", parent: epic.identifier });
  const leaf = ws.store.createIssue({ title: "a leaf with no children" });
  fixture = { epic: epic.identifier, a: a.identifier, b: b.identifier, leaf: leaf.identifier };
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the routes are gated exactly like /api/action", () => {
  it("refuses an unauthenticated caller before it decides anything else", async () => {
    const res = await fetch(`${origin}/api/gate/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ ref: fixture.epic }),
    });
    expect(res.status).toBe(401);
    // Auth precedes method and Origin so an unauthenticated caller cannot map the
    // surface by telling 401 from 403 from 405.
    expect(((await res.json()) as Envelope).code).toBe("unauthorized");
  });

  it("refuses a cross-origin POST", async () => {
    const res = await gate("approve", { ref: fixture.epic }, { origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("refuses GET — these are writes and only writes", async () => {
    const res = await fetch(`${origin}/api/gate/approve?ref=${fixture.epic}`, {
      headers: { "x-staple-token": token },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("404s an unknown member of the family rather than treating it as a gate write", async () => {
    const res = await fetch(`${origin}/api/gate/obliterate`, {
      method: "POST",
      headers: { "x-staple-token": token, "content-type": "application/json", origin },
      body: JSON.stringify({ ref: fixture.epic }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/gate/request", () => {
  it("parks the parent, names the owner, and queues the children", async () => {
    const ref = scenario("req-ok");
    const res = await gate("request", { ref: ref.epic, owner: "VP", comment: "please review" });

    expect(res.status).toBe(200);
    // The refreshed detail payload, so the panel can redraw from the response.
    expect((res.body.issue as { status: string }).status).toBe("awaiting_approval");
    expect(res.body.gate).toMatchObject({ state: "pending", owner: "VP" });

    // ...and the children are now queued behind it, by the store's own derivation.
    const after = await detail(ref.a);
    expect(after.queuedBy).toMatchObject({ identifier: ref.epic, owner: "VP" });
  });

  it("refuses a leaf in the store's own words, pointing at in_review instead", async () => {
    const res = await gate("request", { ref: fixture.leaf, owner: "VP" });
    expect(res.status).toBe(409);
    const envelope = res.body as unknown as Envelope;
    expect(envelope.code).toBe("validation");
    expect(envelope.message).toContain("nothing to queue");
    expect(envelope.message).toContain("in_review");
  });

  it("refuses a gate with no owner — a gate nobody owns is a gate nobody opens", async () => {
    const ref = scenario("req-no-owner");
    const res = await gate("request", { ref: ref.epic, owner: "   " });
    expect(res.status).toBe(409);
    expect((res.body as unknown as Envelope).code).toBe("validation");
  });

  it("refuses a second gate while the first is still pending", async () => {
    const ref = scenario("req-twice");
    expect((await gate("request", { ref: ref.epic, owner: "VP" })).status).toBe(200);
    const again = await gate("request", { ref: ref.epic, owner: "kim" });
    expect(again.status).toBe(409);
    expect((again.body as unknown as Envelope).code).toBe("conflict");
  });
});

describe("POST /api/gate/approve", () => {
  it("without children, releases the whole subtree and re-derives the parent", async () => {
    const ref = scenario("appr-all");
    await gate("request", { ref: ref.epic, owner: "VP" });

    const res = await gate("approve", { ref: ref.epic });
    expect(res.status).toBe(200);
    expect((res.body.gate as { state: string }).state).toBe("approved");
    expect((res.body.issue as { status: string }).status).not.toBe("awaiting_approval");

    for (const child of [ref.a, ref.b]) {
      expect((await detail(child)).queuedBy).toBeNull();
    }
  });

  it("with children, releases ONLY those and leaves the parent parked", async () => {
    const ref = scenario("appr-some");
    await gate("request", { ref: ref.epic, owner: "VP" });

    const res = await gate("approve", { ref: ref.epic, children: [ref.a] });
    expect(res.status).toBe(200);
    // The gate is still doing its job — this is granular approval, not the end of review.
    expect((res.body.issue as { status: string }).status).toBe("awaiting_approval");
    expect((res.body.gate as { state: string }).state).toBe("pending");

    expect((await detail(ref.a)).queuedBy).toBeNull();
    expect((await detail(ref.b)).queuedBy).toMatchObject({ identifier: ref.epic });
  });

  it("refuses a child that is not underneath the gate", async () => {
    const ref = scenario("appr-stranger");
    const other = scenario("appr-stranger-other");
    await gate("request", { ref: ref.epic, owner: "VP" });

    const res = await gate("approve", { ref: ref.epic, children: [other.a] });
    expect(res.status).toBe(409);
    expect((res.body as unknown as Envelope).message).toContain("not underneath");
  });

  it("refuses an issue with no gate to approve", async () => {
    const ref = scenario("appr-none");
    const res = await gate("approve", { ref: ref.epic });
    expect(res.status).toBe(409);
    expect((res.body as unknown as Envelope).code).toBe("conflict");
  });
});

describe("POST /api/gate/request-changes", () => {
  it("sends the parent back to todo and keeps the children queued", async () => {
    const ref = scenario("rc-ok");
    await gate("request", { ref: ref.epic, owner: "VP" });

    const res = await gate("request-changes", { ref: ref.epic, comment: "the schema is wrong" });
    expect(res.status).toBe(200);
    expect((res.body.issue as { status: string }).status).toBe("todo");
    expect((res.body.gate as { state: string }).state).toBe("changes_requested");
    // No automatic re-checkout: the work becomes available to ANYONE.
    expect((res.body.issue as { checkoutAgent: string | null }).checkoutAgent).toBeNull();

    // VP's decision: an objection is not a release. The queue stands.
    expect((await detail(ref.a)).queuedBy).toMatchObject({ identifier: ref.epic });
  });

  it("stores the objection as a real comment, not just event payload", async () => {
    const ref = scenario("rc-comment");
    await gate("request", { ref: ref.epic, owner: "VP" });
    await gate("request-changes", { ref: ref.epic, comment: "needs a migration test" });

    const comments = (await detail(ref.epic)).comments as Array<{ body: string }>;
    expect(comments.some((c) => c.body.includes("needs a migration test"))).toBe(true);
  });

  it("refuses an empty comment — the objection IS the product", async () => {
    const ref = scenario("rc-empty");
    await gate("request", { ref: ref.epic, owner: "VP" });

    for (const comment of ["", "   ", undefined]) {
      const res = await gate("request-changes", { ref: ref.epic, comment });
      expect(res.status).toBe(409);
      expect((res.body as unknown as Envelope).code).toBe("validation");
    }
  });

  it("refuses an issue with no gate awaiting a decision", async () => {
    const ref = scenario("rc-none");
    const res = await gate("request-changes", { ref: ref.epic, comment: "no" });
    expect(res.status).toBe(409);
    expect((res.body as unknown as Envelope).code).toBe("conflict");
  });
});

describe("/api/issue carries what the checklist needs, and /api/agent-context does not", () => {
  /** `childrenQueued` is a list of rows since STA-154 — see the type in lib/types.ts. */
  const queue = async (
    ref: string,
  ): Promise<Array<{ identifier: string; depth: number; title: string; status: string }>> =>
    (await detail(ref)).childrenQueued as Array<{
      identifier: string;
      depth: number;
      title: string;
      status: string;
    }>;

  it("lists the open descendants this gate is holding, with the depth to indent by", async () => {
    const ref = scenario("children-queued");
    await gate("request", { ref: ref.epic, owner: "VP" });

    const before = await queue(ref.epic);
    expect(before.map((row) => row.identifier)).toEqual([ref.a, ref.b]);
    // Direct children of the gate holder are depth 1, and every row carries enough
    // of itself to be rendered without a second fetch.
    expect(before[0]).toMatchObject({ identifier: ref.a, depth: 1, status: "backlog" });
    expect(before[0]!.title).toContain("child a");

    // A released child DROPS OUT, which is how the checklist shrinks — rule (c).
    await gate("approve", { ref: ref.epic, children: [ref.a] });
    expect((await queue(ref.epic)).map((row) => row.identifier)).toEqual([ref.b]);
  });

  /**
   * STA-154 (1). VP's snapshot listed two DONE children of STA-119 in the checklist
   * and counted them, which is why the queue was unreadable. The store decides this
   * now, and this pins that the route carries the store's answer rather than its own.
   */
  it("leaves resolved descendants out of the checklist entirely", async () => {
    const ref = scenario("children-resolved");
    // Straight through the store, on the same file the server serves — the same
    // second connection `scenario` uses. Getting to `done` through /api/action would
    // be three more round trips to arrange a fixture, not a test of anything.
    const ws = openWorkspace(dbPath);
    ws.store.updateIssue(ref.a, { assignee: "someone" }, "someone");
    ws.store.updateIssue(ref.a, { status: "in_progress" }, "someone");
    ws.store.updateIssue(ref.a, { status: "done" }, "someone");
    ws.store.db.close();
    await gate("request", { ref: ref.epic, owner: "VP" });

    expect((await queue(ref.epic)).map((row) => row.identifier)).toEqual([ref.b]);
  });

  it("is an empty list rather than a missing field when nothing is queued", async () => {
    const ref = scenario("children-none");
    expect((await detail(ref.epic)).childrenQueued).toEqual([]);
  });

  it("leaves /api/agent-context alone — it is pinned byte-for-byte against get_task", async () => {
    const ref = scenario("context-untouched");
    await gate("request", { ref: ref.epic, owner: "VP" });
    const res = await fetch(`${origin}/api/agent-context?ref=${ref.epic}`, {
      headers: { "x-staple-token": token },
    });
    const context = (await res.json()) as Record<string, unknown>;
    // `gate` and `queuedBy` are Q1's and belong there; `childrenQueued` is a UI
    // affordance and stays on the UI's own route.
    expect(context).not.toHaveProperty("childrenQueued");
    expect(context).not.toHaveProperty("workspace");
    expect(context).toHaveProperty("gate");
  });
});
