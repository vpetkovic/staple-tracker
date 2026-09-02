/**
 * O6 (STA-138) — the dependency counts `/api/issues` now carries.
 *
 * The row badges replace a text caption that was built from `unresolvedBlockers`, a field
 * only `/api/inbox` ever sent. The tree does not read the inbox for row CONTENT — it reads
 * it for the pickup index (rank / ready / blocked) and nothing else — so the badges needed
 * the same facts on the list payload, plus the half nobody had anywhere: what a task BLOCKS.
 *
 * Three things are worth pinning, and they are the three ways this goes wrong:
 *
 *   1. RESOLVED EDGES MUST NOT COUNT. A blocker that is done is not blocking anything, and a
 *      dependent that is cancelled is not waiting on anything. A badge reading "blocked by 4"
 *      on a task whose four blockers all shipped is worse than no badge — it is a reason not
 *      to pick the task up, and it is false.
 *   2. THE FIELD IS ADDITIVE. Everything `/api/issues` sent before must still be there and
 *      still be shaped the same way, or every consumer of the row breaks at once.
 *   3. `/api/issue` AND `/api/agent-context` ARE UNTOUCHED. `test/ui-agent-context.test.ts`
 *      asserts deep equality between that route and the MCP `get_task` tool; a stray field
 *      on either would break the contract this ticket has no business touching.
 *
 * Run against a REAL store over REAL HTTP, like `ui-create-edit.test.ts`, because the whole
 * claim is about a SQL join over the relations index and a hand-written fixture would keep
 * passing after somebody rewrote it.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

interface Deps {
  blockedBy: string[];
  blocks: string[];
}

interface Row {
  workspace: string;
  issue: { identifier: string };
  claim: unknown;
  deps: Deps;
}

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
const ref: Record<string, string> = {};

async function issues(): Promise<Row[]> {
  const res = await fetch(`${origin}/api/issues`, { headers: { "x-staple-token": token } });
  expect(res.status).toBe(200);
  return (await res.json()) as Row[];
}

function depsOf(rows: Row[], identifier: string | undefined): Deps {
  const row = rows.find((r) => r.issue.identifier === identifier);
  expect(row, `no row for ${identifier}`).toBeDefined();
  return row!.deps;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-deps-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "deps" });

  /**
   * The shape, deliberately not symmetric:
   *
   *   OPEN_A, OPEN_B, GONE  ->  block  TARGET       (GONE is done)
   *   TARGET               ->  blocks WAITER, DEAD  (DEAD is cancelled)
   *   LONELY               ->  no edges at all
   *
   * so TARGET's honest answer is `blockedBy: 2, blocks: 1` and every other combination in
   * the fixture is a way of getting it wrong.
   */
  const openA = ws.store.createIssue({ title: "Open blocker A" });
  const openB = ws.store.createIssue({ title: "Open blocker B" });
  const gone = ws.store.createIssue({ title: "Blocker that already shipped" });
  const target = ws.store.createIssue({ title: "The task under test" });
  const waiter = ws.store.createIssue({ title: "Open dependent" });
  const dead = ws.store.createIssue({ title: "Cancelled dependent" });
  const lonely = ws.store.createIssue({ title: "No relations whatsoever" });
  for (const [key, issue] of Object.entries({ openA, openB, gone, target, waiter, dead, lonely })) {
    ref[key] = issue.identifier;
  }

  ws.store.setBlockedBy(target.identifier, [openA.identifier, openB.identifier, gone.identifier], "test");
  ws.store.setBlockedBy(waiter.identifier, [target.identifier], "test");
  ws.store.setBlockedBy(dead.identifier, [target.identifier], "test");

  ws.store.updateIssue(gone.id, { status: "done" });
  ws.store.updateIssue(dead.id, { status: "cancelled" });
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: ws.dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("/api/issues carries dependency identifiers", () => {
  it("counts only the blockers that are still open", async () => {
    const deps = depsOf(await issues(), ref.target);
    expect(deps.blockedBy).toEqual([ref.openA, ref.openB].sort());
    // The done blocker is an edge that exists and does not block. A badge that counted it
    // would tell a reader not to pick up a task that is in fact pickable.
    expect(deps.blockedBy).not.toContain(ref.gone);
  });

  it("counts only the dependents that are still open", async () => {
    const deps = depsOf(await issues(), ref.target);
    expect(deps.blocks).toEqual([ref.waiter]);
    expect(deps.blocks).not.toContain(ref.dead);
  });

  it("gives every row the field, empty rather than missing", async () => {
    const rows = await issues();
    // An absent field and an empty one are the same to `?.length`, and they are NOT the same
    // to a reader debugging why a badge did not render. Every row gets both arrays.
    for (const row of rows) {
      expect(Array.isArray(row.deps.blockedBy)).toBe(true);
      expect(Array.isArray(row.deps.blocks)).toBe(true);
    }
    expect(depsOf(rows, ref.lonely)).toEqual({ blockedBy: [], blocks: [] });
    // A resolved blocker still knows what it USED to block, because the dependent is open.
    expect(depsOf(rows, ref.gone).blocks).toEqual([ref.target]);
  });

  it("is ADDITIVE — the fields the row already had are untouched", async () => {
    const row = (await issues()).find((r) => r.issue.identifier === ref.target)!;
    expect(Object.keys(row).sort()).toEqual(["claim", "deps", "issue", "worklog", "workspace"]);
    expect(row.workspace).toBe("deps");
    expect(row.claim).toBeNull();
  });

  it("leaves /api/issue and /api/agent-context alone", async () => {
    // Those two are pinned against the MCP `get_task` tool by ui-agent-context.test.ts.
    // This ticket adds a list-payload field and must not leak into either.
    for (const path of ["/api/issue", "/api/agent-context"]) {
      const res = await fetch(`${origin}${path}?ref=${ref.target}`, {
        headers: { "x-staple-token": token },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty("deps");
    }
  });
});
